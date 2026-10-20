const { Worker } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { SPEECH_MODEL } = require("./speech-model.cjs");
const { createSegmenter } = require("../segmenter.js");
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
    { createWorker, idleMs = IDLE_UNLOAD_MS, live = null } = {},
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
    this.live = live;
    this.session = null;
    this.ending = Promise.resolve();
    this.installing = new Map();
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
      // "apple" or "whisper" while listening.
      engine: null,
      // Apple's words so far in the current sentence; they may still change.
      partial: "",
      // Whether this Mac has Apple's live transcription at all, and what it
      // offers for the speech language: { language, locale, model, installed }.
      liveSupported: Boolean(live),
      live: null,
      liveProgress: null,
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
  // Live audio arrives phrase by phrase. While Whisper works on one phrase,
  // the next ones wait together, so a slower Mac gets longer pieces instead
  // of falling behind.
  feed(samples, language = "auto") {
    if (this.waiting) {
      const merged = new Float32Array(this.waiting.length + samples.length);
      merged.set(this.waiting);
      merged.set(samples, this.waiting.length);
      this.waiting = merged;
    } else this.waiting = samples;
    this.waitingLanguage = language;
    // Never more than Whisper's 30-second window in one piece.
    if (this.waiting.length > 16000 * 28) {
      const full = this.waiting;
      this.waiting = null;
      this.send(full, language);
    }
    this.drain();
  }
  drain() {
    if (this.feeding || !this.waiting) return;
    const samples = this.waiting;
    this.waiting = null;
    this.feeding = this.send(samples, this.waitingLanguage).finally(() => {
      this.feeding = null;
      this.drain();
    });
  }
  send(samples, language) {
    return this.transcribe(samples, language).catch((e) =>
      this.update({ error: e.message }),
    );
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
  // What Apple's live transcription offers for a language. A language Apple
  // supports but has not downloaded yet starts downloading, and Whisper
  // listens until it is ready.
  async checkLive(language, { install = false } = {}) {
    if (!this.live) return null;
    const found = await this.live.check(language);
    const info = found ? { language, ...found } : null;
    this.update({ live: info });
    if (info && !info.installed && install) this.installLive(language);
    return info;
  }
  installLive(language) {
    if (!this.installing.has(language)) {
      // Setup and the menu show the download from its start.
      this.update({ liveProgress: 0 });
      this.installing.set(
        language,
        this.live
          .install(language, (progress) => this.update({ liveProgress: progress }))
          .catch((e) => this.update({ error: `Apple speech download: ${e.message}` }))
          .finally(() => {
            this.installing.delete(language);
            this.update({ liveProgress: null });
            if (this.state.live?.language === language) this.checkLive(language);
          }),
      );
    }
    return this.installing.get(language);
  }
  // A listening session. Apple's live transcription writes words as they are
  // spoken; without it (older macOS, Kazakh, automatic language, or the
  // Whisper choice), speech is cut into phrases at pauses for Whisper.
  async begin(language, { live = true } = {}) {
    await this.ending;
    if (this.session) throw new Error("Recording already started.");
    const session = { language, engine: "whisper", segmenter: null, done: false };
    this.session = session;
    if (live && this.live) {
      try {
        if ((await this.checkLive(language, { install: true }))?.installed) {
          await this.live.start(language, {
            onPartial: (text) => !session.done && this.update({ partial: text }),
            onFinal: (text) => {
              if (session.done) return;
              this.update({ partial: "" });
              if (text) this.onText?.(text);
              session.settled?.();
            },
            // The helper stopped on its own: Whisper takes over when it is
            // on disk; otherwise the words stop until listening starts again.
            onExit: (error) => {
              if (session.done || session !== this.session) return;
              const reason = `Apple speech stopped${error ? `: ${error.message}` : ""}`;
              if (!this.state.ready) {
                session.engine = null;
                this.update({
                  engine: null,
                  partial: "",
                  error: `${reason}. Stop and listen again, or download Whisper so it can take over.`,
                });
                return;
              }
              this.useWhisper(session);
              if (error) this.update({ error: reason });
            },
          });
          session.engine = "apple";
        }
      } catch (error) {
        this.update({ error: `Apple speech is unavailable, using Whisper: ${error.message}` });
      }
    }
    if (session.engine === "whisper" && !this.state.ready) {
      this.session = null;
      throw new Error("Download the speech model before listening.");
    }
    if (session.engine === "whisper") this.useWhisper(session);
    else this.update({ engine: "apple", partial: "" });
  }
  useWhisper(session) {
    session.engine = "whisper";
    session.segmenter = createSegmenter({
      rate: 16000,
      onSegment: (phrase) => this.feed(phrase, session.language),
    });
    this.update({ engine: "whisper", partial: "" });
  }
  // An answer asked for now should include the sentence still being spoken:
  // Apple settles it, usually within a tenth of a second.
  settle(timeoutMs = 1500) {
    const session = this.session;
    if (session?.engine !== "apple" || !this.state.partial) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      session.settled = () => {
        clearTimeout(timer);
        session.settled = null;
        resolve();
      };
      this.live.settle();
    });
  }
  // 16 kHz mono audio from the call or the microphone, in any chunk size.
  push(samples) {
    const session = this.session;
    if (!session) return;
    if (session.engine === "apple") this.live.write(samples);
    else session.segmenter?.push(samples);
  }
  // Stopping keeps the last words: Apple settles them, Whisper gets the rest.
  end() {
    const session = this.session;
    if (!session) return this.ending;
    this.session = null;
    this.ending = (async () => {
      if (session.engine === "apple") await this.live.stop();
      else session.segmenter?.flush();
      session.done = true;
      this.update({ engine: null, partial: "" });
    })();
    return this.ending;
  }
  async startNative(helper, language, options) {
    if (process.platform !== "darwin")
      throw new Error("Native audio requires macOS");
    if (this.native) throw new Error("Recording already started.");
    this.update({ recording: false, source: "system", error: null });
    try {
      await this.begin(language, options);
    } catch (error) {
      this.update({ source: null });
      throw error;
    }
    let leftover = Buffer.alloc(0),
      diagnostic = "",
      ready = false,
      lastLevelAt = 0;
    const child = spawn(helper, [], { stdio: ["ignore", "pipe", "pipe"] });
    this.native = child;
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
        // Samples are 4-byte floats; a chunk can end in the middle of one.
        const bytes = Buffer.concat([leftover, chunk]);
        const whole = bytes.length - (bytes.length % 4);
        leftover = bytes.subarray(whole);
        if (whole)
          this.push(new Float32Array(new Uint8Array(bytes.subarray(0, whole)).buffer));
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
        this.end();
        this.update({ recording: false, error: error.message });
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        this.native = null;
        this.end();
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
    await this.end();
    this.update({ recording: false, source: null });
  }
  clear() {
    this.generation++;
    this.waiting = null;
    this.update({ partial: "" });
  }
  close() {
    this.cancelUnload();
    this.native?.kill();
    this.live?.close();
    this.worker?.terminate();
    for (const job of this.pending.values()) job.reject(new Error("Closed"));
    this.pending.clear();
  }
}
module.exports = { Transcription };
