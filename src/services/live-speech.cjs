const { spawn } = require("node:child_process");
// Apple's on-device speech recognition (macOS 26+) through the live-speech
// helper. Words arrive while someone is still talking: a "partial" line holds
// the words so far, which may still change, and a "final" line settles them.
// Whisper only sees whole phrases, so its text appears after each pause.
function readLines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        onLine(JSON.parse(line));
      } catch {
        /* Not a line from the helper. */
      }
    }
  });
}
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
class LiveSpeech {
  constructor(helper, { run = spawn, readyMs = 20000 } = {}) {
    this.helper = helper;
    this.run = run;
    this.readyMs = readyMs;
    this.child = null;
    this.checks = new Map();
  }
  // What Apple offers for a language: { locale, model, installed }, or null
  // when it does not support the language (Kazakh, automatic detection).
  check(language) {
    if (!this.checks.has(language))
      this.checks.set(
        language,
        this.command(["--check", language], () => {}, 15000).then(
          (lines) => (lines[0]?.locale ? lines[0] : null),
          () => null,
        ),
      );
    return this.checks.get(language);
  }
  // Apple downloads each language once, for every app on the Mac.
  async install(language, onProgress = () => {}) {
    try {
      await this.command(["--install", language], (line) => {
        if (line.type === "progress") onProgress(line.progress);
      });
    } finally {
      this.checks.delete(language);
    }
  }
  command(args, onLine = () => {}, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const child = this.run(this.helper, args, { stdio: ["ignore", "pipe", "pipe"] });
      const lines = [];
      let diagnostic = "";
      const timer = timeoutMs && setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      readLines(child.stdout, (line) => {
        lines.push(line);
        onLine(line);
      });
      child.stderr.on("data", (chunk) => (diagnostic = (diagnostic + chunk).slice(-2000)));
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(lines);
        else reject(new Error(diagnostic.trim() || `Apple speech stopped (code ${code}).`));
      });
    });
  }
  // Resolves once Apple is listening. Audio written before that waits in the pipe.
  start(language, { onPartial = () => {}, onFinal = () => {}, onExit = () => {} } = {}) {
    if (this.child) return Promise.reject(new Error("Live transcription already started."));
    const child = this.run(this.helper, ["--locale", language], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let diagnostic = "",
      ready = false;
    // Writing after the helper exits is reported by "close", not by a throw.
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => (diagnostic = (diagnostic + chunk).slice(-2000)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Apple speech did not start."));
      }, this.readyMs);
      readLines(child.stdout, (line) => {
        if (line.type === "ready" && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(line);
        } else if (line.type === "partial") onPartial(line.text || "");
        else if (line.type === "final") onFinal(line.text || "");
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!ready) reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        const error =
          code || signal
            ? new Error(diagnostic.trim().slice(-400) || `Apple speech stopped (code ${code ?? signal}).`)
            : null;
        if (!ready) reject(error || new Error("Apple speech stopped before it started."));
        else onExit(error);
      });
    });
  }
  write(samples) {
    const stdin = this.child?.stdin;
    if (stdin?.writable)
      stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }
  // Apple settles the words heard so far; they arrive as a final line.
  settle() {
    if (this.child && !exited(this.child)) this.child.kill("SIGUSR1");
  }
  // Closing the input makes Apple settle the last words, then the helper exits.
  stop() {
    const child = this.child;
    if (!child || exited(child)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  }
  close() {
    this.child?.kill("SIGKILL");
  }
}
module.exports = { LiveSpeech, readLines };
