const { Worker } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { SPEECH_MODEL } = require("./speech-model.cjs");
// Whisper runs in a worker thread that is loaded only while it is needed:
// listening keeps it warm, and it unloads after a quiet period. A loaded model
// holds 0.7 GB (fast) to 2.4 GB (accurate), so an idle app should not keep it.
const IDLE_UNLOAD_MS = 90000;
const sameModel = (a, b) =>
  a.id === b.id && JSON.stringify(a.dtype) === JSON.stringify(b.dtype);
class Transcription {
  constructor(
    cacheDir,
    onChange,
    onText,
    onLevel = () => {},
    model = SPEECH_MODEL,
    { createWorker, idleMs = IDLE_UNLOAD_MS } = {},
  ) {
    this.cacheDir = cacheDir;
    this.model = model;
    this.onChange = onChange;
    this.onText = onText;
    this.onLevel = onLevel;
    this.createWorker =
      createWorker ||
      ((workerData) =>
        new Worker(path.join(__dirname, "whisper-worker.cjs"), { workerData }));
    this.idleMs = idleMs;
    this.worker = null;
    this.loaded = false;
    this.warm = false;
    this.idleTimer = null;
    this.native = null;
    this.pending = new Map();
    this.nextId = 0;
    this.generation = 0;
    this.state = {
      status: "idle",
      ready: false,
      progress: null,
      file: "",
      error: null,
      pending: 0,
      recording: false,
      source: null,
    };
  }
  update(patch) {
    Object.assign(this.state, patch);
    this.onChange?.(this.state);
  }
  // The model is on disk; it loads on first use.
  markDownloaded() {
    this.update({ ready: true, status: "ready", error: null });
  }
  load() {
    this.cancelUnload();
    if (this.worker) {
      if (this.loaded) this.update({ status: "ready" });
      return;
    }
    if (!this.state.ready) fs.mkdirSync(this.cacheDir, { recursive: true });
    this.update({ status: "loading", error: null });
    const worker = this.createWorker({ cacheDir: this.cacheDir, model: this.model });
    this.worker = worker;
    worker.on("message", (msg) => {
      if (worker !== this.worker) return;
      if (msg.type === "progress")
        this.update({
          status: "loading",
          progress: msg.progress ?? null,
          file: msg.file || "",
        });
      if (msg.type === "ready") {
        this.loaded = true;
        this.update({
          status: "ready",
          ready: true,
          progress: 100,
          error: null,
        });
        this.scheduleUnload();
      }
      if (msg.type === "text" || msg.type === "error") {
        const job = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this.update({ pending: this.pending.size });
        if (msg.type === "error") {
          this.update({
            error: msg.error,
            status: "error",
            ...(msg.id === undefined ? { ready: false } : {}),
          });
          job?.reject(new Error(msg.error));
          if (msg.id === undefined) {
            worker.terminate();
            this.worker = null;
            this.loaded = false;
          }
        } else {
          job?.resolve(msg.text);
          if (msg.text && job?.generation === this.generation)
            this.onText?.(msg.text);
        }
        this.scheduleUnload();
      }
    });
    worker.on("error", (e) => {
      if (worker !== this.worker) return;
      this.update({ status: "error", ready: false, error: e.message });
      for (const job of this.pending.values()) job.reject(e);
      this.pending.clear();
      this.worker = null;
      this.loaded = false;
    });
    worker.postMessage({ type: "load" });
  }
  // Listening keeps the model loaded; stopping lets it unload after a while.
  keepWarm(on) {
    this.warm = on;
    if (on) {
      if (this.state.ready) this.load();
    } else this.scheduleUnload();
  }
  cancelUnload() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
  scheduleUnload() {
    this.cancelUnload();
    if (this.warm || !this.worker || !this.loaded) return;
    this.idleTimer = setTimeout(() => this.unload(), this.idleMs);
    this.idleTimer.unref?.();
  }
  unload() {
    if (this.warm || !this.worker) return;
    if (this.pending.size) return this.scheduleUnload();
    this.cancelUnload();
    this.worker.terminate();
    this.worker = null;
    this.loaded = false;
    this.update({ status: this.state.ready ? "ready" : "idle" });
  }
  // Unloads the current model so the next load() uses the new one.
  setModel(model) {
    if (sameModel(model, this.model)) return false;
    this.cancelUnload();
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    for (const job of this.pending.values())
      job.reject(new Error("The speech model changed."));
    this.pending.clear();
    this.model = model;
    this.update({
      status: "idle",
      ready: false,
      progress: null,
      file: "",
      error: null,
      pending: 0,
    });
    return true;
  }
  transcribe(samples, language = "auto") {
    if (!this.state.ready)
      return Promise.reject(new Error("Download/load Whisper first."));
    if (
      !(samples instanceof Float32Array) ||
      samples.length < 1600 ||
      samples.length > 16000 * 30
    )
      return Promise.reject(
        new Error("Expected 0.1–30 seconds of mono 16 kHz audio."),
      );
    if (this.pending.size >= 3)
      return Promise.reject(
        new Error("Whisper is behind. Stop recording or use shorter sessions."),
      );
    for (const v of samples)
      if (!Number.isFinite(v))
        return Promise.reject(new Error("Invalid audio sample"));
    if (!this.worker) this.load();
    this.cancelUnload();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, generation: this.generation });
      this.update({ pending: this.pending.size });
      this.worker.postMessage(
        { type: "transcribe", id, samples: samples.buffer, language },
        [samples.buffer],
      );
    });
  }
  async startNative(helper, language) {
    if (process.platform !== "darwin")
      throw new Error("Native audio requires macOS");
    if (!this.state.ready) throw new Error("Load Whisper first.");
    if (this.native) throw new Error("Recording already started.");
    // The helper writes a small block per audio device cycle. Blocks are kept
    // as they come and joined once per 8 s segment, not on every block.
    let parts = [],
      size = 0,
      diagnostic = "",
      ready = false,
      lastLevelAt = 0;
    const child = spawn(helper, [], { stdio: ["ignore", "pipe", "pipe"] });
    this.native = child;
    this.update({ recording: false, source: "system", error: null });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "Call audio did not start. Check Screening under System Audio Recording Only in Privacy & Security.",
          ),
        );
      }, 15000);
      child.stdout.on("data", (chunk) => {
        if (Date.now() - lastLevelAt > 200 && chunk.length >= 4) {
          let energy = 0,
            count = 0;
          for (let i = 0; i + 4 <= chunk.length; i += 64) {
            const sample = chunk.readFloatLE(i);
            if (Number.isFinite(sample)) {
              energy += sample * sample;
              count++;
            }
          }
          this.onLevel(
            Math.min(1, Math.sqrt(energy / Math.max(1, count)) * 12),
          );
          lastLevelAt = Date.now();
        }
        parts.push(chunk);
        size += chunk.length;
        const bytes = 16000 * 8 * 4;
        if (size < bytes) return;
        let data = Buffer.concat(parts, size);
        while (data.length >= bytes) {
          const segment = data.subarray(0, bytes);
          data = data.subarray(bytes);
          this.transcribe(
            new Float32Array(new Uint8Array(segment).buffer),
            language,
          ).catch((e) => this.update({ error: e.message }));
        }
        parts = data.length ? [data] : [];
        size = data.length;
      });
      child.stderr.on("data", (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-4000);
        if (!ready && diagnostic.includes("SCREENING_AUDIO_READY")) {
          ready = true;
          clearTimeout(timer);
          this.update({ recording: true, source: "system", error: null });
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        this.native = null;
        this.update({ recording: false, error: error.message });
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.native = null;
        const data = Buffer.concat(parts, size);
        if (data.length >= 16000 * 4) {
          const copy = new Uint8Array(
            data.subarray(0, data.length - (data.length % 4)),
          ).buffer;
          this.transcribe(new Float32Array(copy), language).catch(() => {});
        }
        const message =
          diagnostic.replace("SCREENING_AUDIO_READY", "").trim().slice(-400) ||
          "Call audio stopped. Check Screening under System Audio Recording Only in Privacy & Security.";
        this.update({
          recording: false,
          ...((code && code !== 0) || !ready ? { error: message } : {}),
        });
        this.onLevel(0);
        if (!ready) reject(new Error(message));
      });
    });
  }
  async stop() {
    const child = this.native;
    if (child)
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    this.update({ recording: false, source: null });
  }
  clear() {
    this.generation++;
  }
  close() {
    this.cancelUnload();
    this.native?.kill();
    this.worker?.terminate();
    for (const job of this.pending.values()) job.reject(new Error("Closed"));
    this.pending.clear();
  }
}
module.exports = { Transcription };
