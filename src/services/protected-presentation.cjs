// The native companion draws protected pixels and passes all input through to
// Buddy's original Chromium views. No input/IME emulation or disk frames.
function protectPresentation(window, binary, onError) {
  const native = require(binary);
  const handle = native.attach(window.getNativeWindowHandle());
  let stopped = false;
  let timer;
  let inFlight = null;
  let failed = false;
  let paused = false;
  let diagnosticFrames = 0;

  async function refresh() {
    if (stopped || failed || window.isDestroyed()) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        let deadline;
        const image = await Promise.race([
          // Allow Chromium's page to render even when the companion occludes
          // its NSWindow. The original native layer remains fully transparent.
          window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true }),
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Buddy's display frame timed out.")), 4000);
          }),
        ]).finally(() => clearTimeout(deadline));
        if (stopped || failed || window.isDestroyed()) return;
        if (image.isEmpty()) throw new Error("Buddy did not produce a display frame.");
        const { width, height } = image.getSize();
        native.frame(handle, image.toBitmap(), width, height);
        const status = native.status(handle);
        if (process.env.SCREENING_DISPLAY_DIAGNOSTICS === "1" && ++diagnosticFrames % 60 === 0) {
          const pixels = image.toBitmap();
          let nontransparent = 0;
          for (let index = 3; index < pixels.length; index += 4)
            if (pixels[index]) nontransparent++;
          console.error(JSON.stringify({
            displayDiagnostics: true, time: new Date().toISOString(),
            pid: process.pid, bounds: window.getBounds(),
            width, height, nontransparent, status,
          }));
        }
        if (!status.sourceSuppressed)
          throw new Error("Buddy's protected presentation lost its source view.");
        if (!status.layerHosted)
          throw new Error("Buddy's protected display layer was detached.");
      } catch (error) {
        if (!stopped) {
          failed = true;
          window.hide();
          native.close(handle);
          onError(new Error(`Buddy's protected display stopped: ${error.message}`));
        }
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }
  async function tick() {
    if (stopped || failed) return;
    if (!paused && window.isVisible()) await refresh();
    sync();
    // One frame in flight; slow capture or rendering never creates a queue.
    if (!stopped && !failed) timer = setTimeout(tick, 33);
  }
  const sync = (visible) => {
    if (!stopped && !failed) {
      native.sync(handle, typeof visible === "boolean" ? visible : window.isVisible());
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    native.close(handle);
  };
  window.webContents.once("did-finish-load", () => {
    refresh().then(tick);
  });
  window.webContents.on("render-process-gone", () => {
    failed = true;
    stop();
    window.hide();
    onError(new Error("Buddy's renderer stopped. Reopen Screening to restore its protected display."));
  });
  window.on("show", () => sync(true));
  window.on("hide", () => sync(false));
  for (const event of ["move", "resize"]) window.on(event, () => sync());
  window.once("closed", stop);
  return {
    refresh,
    sync,
    stop,
    get failed() { return failed; },
    setProtection(enabled) {
      if (!stopped && !failed) native.protect(handle, enabled);
    },
    async prepareCaptureTest(prepareSyntheticContent) {
      paused = true;
      try {
        await inFlight;
        await prepareSyntheticContent();
        if (stopped || failed) throw new Error("Buddy's protected display is unavailable.");
        native.clear(handle);
        native.protect(handle, false);
        await refresh();
        if (failed) throw new Error("Buddy's synthetic test frame failed.");
      } finally {
        paused = false;
      }
    },
    releaseKeyboard() {
      if (!stopped && !failed) native.releaseKeyboard(handle);
    },
    takeKeyboard() {
      if (!stopped && !failed) native.takeKeyboard(handle);
    },
    status: () => ({ ...native.status(handle), failed, stopped }),
    getMediaSourceId: () => `window:${native.status(handle).windowNumber}:0`,
  };
}

module.exports = { protectPresentation };
