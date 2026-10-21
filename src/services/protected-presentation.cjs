// The native companion draws protected pixels and passes all input through to
// Buddy's original Chromium views. No input/IME emulation or disk frames.
function protectPresentation(window, binary, onError) {
  const native = require(binary);
  const handle = native.attach(window.getNativeWindowHandle());
  let stopped = false;
  let inFlight = null;
  let failed = false;
  let paused = false;
  let subscribed = false;
  let diagnosticFrames = 0;
  // When the newest frame reached the native layer, so a slower explicit
  // capture never replaces it with an older picture.
  let presentedAt = 0;
  // Before Buddy's first paint a capture comes back empty; that is not a
  // display failure. Retry for up to two seconds before treating it as one.
  let firstFrameRetries = 40;
  // Pooled frame buffers are let go once Buddy has been still for a moment.
  let trimTimer = null;

  function fail(error) {
    if (stopped || failed) return;
    failed = true;
    clearInterval(syncTimer);
    unsubscribe();
    window.hide();
    native.close(handle);
    onError(new Error(`Buddy's protected display stopped: ${error.message}`));
  }
  function present(image) {
    if (image.isEmpty()) throw new Error("Buddy did not produce a display frame.");
    const { width, height } = image.getSize();
    native.frame(handle, image.toBitmap(), width, height);
    presentedAt = performance.now();
    clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      if (!stopped && !failed) native.trim(handle);
    }, 1500);
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
  }
  // An explicit frame: at load, on show, and when a test needs one now.
  async function refresh() {
    if (stopped || failed || window.isDestroyed()) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const requestedAt = performance.now();
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
        if (presentedAt > requestedAt && !paused) return;
        if (image.isEmpty() && !presentedAt && firstFrameRetries-- > 0) {
          setTimeout(refresh, 50);
          return;
        }
        present(image);
      } catch (error) {
        fail(error);
      }
    })();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }
  // Chromium hands over a frame only when Buddy's pixels change, so an idle
  // Buddy costs no captures; animations arrive at up to 30 frames a second.
  function onFrame(image) {
    if (stopped || failed || paused || window.isDestroyed()) return;
    try {
      present(image);
    } catch (error) {
      fail(error);
    }
  }
  function subscribe() {
    if (subscribed || stopped || failed || window.isDestroyed()) return;
    window.webContents.beginFrameSubscription(false, onFrame);
    subscribed = true;
  }
  function unsubscribe() {
    if (!subscribed) return;
    subscribed = false;
    if (!window.isDestroyed()) window.webContents.endFrameSubscription();
  }
  const sync = (visible) => {
    if (!stopped && !failed) {
      native.sync(handle, typeof visible === "boolean" ? visible : window.isVisible());
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(trimTimer);
    clearInterval(syncTimer);
    unsubscribe();
    native.close(handle);
  };
  window.webContents.once("did-finish-load", () => {
    // Subscribe first, so the first paint after load is never missed.
    subscribe();
    refresh();
  });
  window.webContents.on("render-process-gone", () => {
    failed = true;
    stop();
    window.hide();
    onError(new Error("Buddy's renderer stopped. Reopen Screening to restore its protected display."));
  });
  window.on("show", () => {
    sync(true);
    refresh();
  });
  window.on("hide", () => sync(false));
  for (const event of ["move", "resize"]) window.on(event, () => sync());
  // A Space transition can report Buddy hidden for a moment with no show
  // event after it; matching the window twice a second brings the protected
  // display back. One native call, no frame.
  const syncTimer = setInterval(() => sync(), 500);
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
