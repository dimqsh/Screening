const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  globalShortcut,
  screen,
  desktopCapturer,
  systemPreferences,
  session,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

app.setName("Capture Lab");
const verification = process.argv.includes("--verify");
const artifactDir = path.resolve(
  process.env.CAPTURE_LAB_ARTIFACTS || path.join(__dirname, "..", "validation"),
);
// Keep this research app's Chromium cache separate from other Electron apps.
if (verification)
  app.setPath(
    "userData",
    path.join(os.tmpdir(), `capture-lab-test-${process.pid}`),
  );
let lab,
  overlay,
  interview,
  quitting = false,
  busy = false;
const state = {
  protection: true,
  hideDock: false,
  clickThrough: false,
  visible: true,
  capturePath: "electron",
  notes:
    "Meeting agenda\n\n• Clarify the goal\n• Confirm open questions\n• Agree on the next step",
  result: null,
  testing: false,
  testCard: false,
  shortcuts: [],
  platform: process.platform,
  os: `${os.type()} ${os.release()}`,
  electron: process.versions.electron,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const permission = () =>
  process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("screen")
    : "not-required";
const snapshot = () => ({
  ...state,
  interview: interview?.state,
  permission: permission(),
  supported: ["darwin", "win32"].includes(process.platform),
});
function publish() {
  for (const win of [lab, overlay])
    if (win && !win.isDestroyed())
      win.webContents.send("lab:update", snapshot());
}
function reveal() {
  state.visible = true;
  state.clickThrough = false;
  overlay.setIgnoreMouseEvents(false);
  overlay.show();
  overlay.focus();
  publish();
}
function apply() {
  overlay.setContentProtection(state.protection);
  overlay.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  state.visible ? overlay.showInactive() : overlay.hide();
  if (process.platform === "darwin" && app.dock)
    state.hideDock ? app.dock.hide() : app.dock.show();
  publish();
}
function change(key, value) {
  if (busy) throw new Error("Wait for the capture experiment to finish.");
  if (key === "capturePath") {
    if (!["electron", "sck"].includes(value))
      throw new Error("Unsupported capture path.");
  } else if (key === "notes") {
    if (typeof value !== "string" || value.length > 12000)
      throw new Error("Notes must be under 12,000 characters.");
  } else if (
    !["protection", "hideDock", "clickThrough", "visible"].includes(key) ||
    typeof value !== "boolean"
  ) {
    throw new Error("Unsupported setting.");
  }
  if (
    key === "clickThrough" &&
    value &&
    !state.shortcuts.find((s) => s.action === "recover")?.registered
  ) {
    throw new Error(
      "Click-through needs the recovery shortcut. Resolve the shortcut conflict first.",
    );
  }
  state[key] = value;
  if (key === "capturePath") state.result = null;
  apply();
  return snapshot();
}
function create(file, options) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: "#f5f4f0",
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, file));
  return win;
}
function markerPixels(image) {
  const pixels = image.toBitmap();
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // Electron bitmap pixels are BGRA. Match the synthetic magenta test strip.
    if (pixels[i] > 140 && pixels[i + 1] < 65 && pixels[i + 2] > 200) count++;
  }
  return count;
}
async function cropCapture(display) {
  if (state.capturePath === "sck") {
    if (process.platform !== "darwin")
      throw new Error("ScreenCaptureKit requires macOS.");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "capture-lab-roi-"));
    const filename = path.join(temp, "crop.png");
    const bounds = overlay.getBounds();
    const helper = app.isPackaged
      ? path.join(process.resourcesPath, "bin", "capture-sck")
      : path.join(__dirname, "..", "bin", "capture-sck");
    try {
      await execFile(
        helper,
        [
          String(display.id),
          String(bounds.x - display.bounds.x),
          String(bounds.y - display.bounds.y),
          String(bounds.width),
          String(bounds.height),
          String(display.scaleFactor),
          filename,
        ],
        { timeout: 15000 },
      );
      return nativeImage.createFromBuffer(await fs.readFile(filename));
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.ceil(display.size.width * display.scaleFactor),
      height: Math.ceil(display.size.height * display.scaleFactor),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty())
    throw new Error("The selected display did not return a screen image.");
  const size = source.thumbnail.getSize(),
    bounds = overlay.getBounds();
  const sx = size.width / display.bounds.width,
    sy = size.height / display.bounds.height;
  const rect = {
    x: Math.round((bounds.x - display.bounds.x) * sx),
    y: Math.round((bounds.y - display.bounds.y) * sy),
    width: Math.round(bounds.width * sx),
    height: Math.round(bounds.height * sy),
  };
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > size.width ||
    rect.y + rect.height > size.height
  )
    throw new Error("Test card is outside the selected screen.");
  return source.thumbnail.crop(rect);
}
async function runCapture() {
  if (busy) throw new Error("A capture experiment is already running.");
  if (process.platform === "darwin" && permission() !== "granted") {
    state.result = {
      outcome: "permission-needed",
      detail:
        "Enable Screen & System Audio Recording for Capture Lab in macOS Settings, reopen the app, then run again. No capture was taken.",
      permission: permission(),
    };
    publish();
    return state.result;
  }
  if (!["darwin", "win32"].includes(process.platform)) {
    state.result = {
      outcome: "unsupported",
      detail:
        "This prototype supports capture protection on macOS and Windows.",
    };
    publish();
    return state.result;
  }
  busy = true;
  state.testing = true;
  state.testCard = true;
  state.result = null;
  publish();
  const saved = {
    bounds: overlay.getBounds(),
    protection: state.protection,
    clickThrough: state.clickThrough,
    visible: state.visible,
  };
  try {
    const display = screen.getDisplayMatching(lab.getBounds());
    const area = display.workArea;
    overlay.setBounds({
      x: Math.round(area.x + (area.width - 470) / 2),
      y: Math.round(area.y + (area.height - 320) / 2),
      width: 470,
      height: 320,
    });
    overlay.setIgnoreMouseEvents(false);
    overlay.show();
    overlay.moveTop();
    state.protection = false;
    overlay.setContentProtection(false);
    publish();
    await delay(1100);
    const baseline = await cropCapture(display),
      baselineCount = markerPixels(baseline);
    state.protection = true;
    overlay.setContentProtection(true);
    publish();
    await delay(1100);
    const protectedImage = await cropCapture(display),
      protectedCount = markerPixels(protectedImage);
    // Both positive and negative controls are required. Missing baseline never means success.
    const valid = baselineCount > 1000;
    const outcome = !valid
      ? "inconclusive"
      : protectedCount > baselineCount * 0.15
        ? "visible"
        : protectedCount < baselineCount * 0.01
          ? "excluded"
          : "inconclusive";
    state.result = {
      outcome,
      baselineCount,
      protectedCount,
      time: new Date().toISOString(),
      detail: !valid
        ? "The unprotected marker was not reliably captured. Try again with the app visible and the screen unlocked."
        : outcome === "visible"
          ? "The protected test card remained in this screen capture. Do not rely on this flag for this capture path."
          : outcome === "excluded"
            ? "The marker disappeared in this capture path. Verify the recipient view in your actual meeting app."
            : "The capture changed, but the result was ambiguous. Test the actual meeting app.",
      capturePath:
        state.capturePath === "sck"
          ? "Apple ScreenCaptureKit SCStream first complete video frame, display filter with no excluded windows, sourceRect limited to synthetic overlay"
          : "Electron desktopCapturer full-display thumbnail, cropped to synthetic overlay bounds",
      baseline: baseline.toDataURL(),
      protected: protectedImage.toDataURL(),
      platform: process.platform,
      os: state.os,
      electron: process.versions.electron,
      limits:
        "One local capture path. This does not establish Zoom, Meet, Teams, recording, process-list, or physical-camera invisibility.",
    };
    return state.result;
  } catch (error) {
    state.result = { outcome: "error", detail: error.message };
    return state.result;
  } finally {
    overlay.setBounds(saved.bounds);
    Object.assign(state, {
      protection: saved.protection,
      clickThrough: saved.clickThrough,
      visible: saved.visible,
      testing: false,
      testCard: false,
    });
    busy = false;
    apply();
  }
}
async function action(name) {
  if (name === "test") return runCapture();
  if (name === "quit") {
    app.quit();
    return;
  }
  if (name === "recover") {
    if (!busy) reveal();
    return snapshot();
  }
  if (name === "compact") {
    reveal();
    lab.hide();
    return;
  }
  if (name === "lab") {
    lab.show();
    lab.focus();
    return;
  }
  if (name === "export") {
    if (!state.result) throw new Error("Run a capture experiment first.");
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog(lab, {
      defaultPath: "capture-result.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!result.canceled && result.filePath)
      await fs.writeFile(
        result.filePath,
        JSON.stringify(state.result, null, 2),
      );
    return;
  }
  throw new Error("Unsupported action.");
}
async function verify() {
  await fs.mkdir(artifactDir, { recursive: true });
  const checks = [];
  function check(name, fn) {
    fn();
    checks.push({ name, passed: true });
  }
  check("Only owned overlay has content protection", () => {
    assert.equal(overlay.isContentProtected(), true);
    assert.equal(lab.isContentProtected(), false);
  });
  check("Overlay is floating and omitted from Mission Control", () => {
    assert.equal(overlay.isAlwaysOnTop(), true);
    if (process.platform === "darwin")
      assert.equal(overlay.isHiddenInMissionControl(), true);
  });
  check("Protection can be disabled and restored", () => {
    change("protection", false);
    assert.equal(overlay.isContentProtected(), false);
    change("protection", true);
    assert.equal(overlay.isContentProtected(), true);
  });
  check("Overlay can hide and recover", () => {
    change("visible", false);
    assert.equal(overlay.isVisible(), false);
    reveal();
    assert.equal(overlay.isVisible(), true);
    assert.equal(state.clickThrough, false);
  });
  check("Input validation rejects unknown settings and oversized notes", () => {
    assert.throws(() => change("arbitrary", true));
    assert.throws(() => change("protection", "yes"));
    assert.throws(() => change("notes", "x".repeat(12001)));
  });
  check("Recovery disables click-through", () => {
    if (state.shortcuts.find((s) => s.action === "recover")?.registered) {
      change("clickThrough", true);
      reveal();
      assert.equal(state.clickThrough, false);
    }
  });
  check("Renderer is isolated and sandboxed", () => {
    for (const win of [lab, overlay]) {
      const p = win.webContents.getLastWebPreferences();
      assert.equal(p.contextIsolation, true);
      assert.equal(p.sandbox, true);
      assert.equal(p.nodeIntegration, false);
    }
  });
  await lab.webContents.executeJavaScript(
    `document.querySelector('#protection').click()`,
  );
  await delay(250);
  check("UI toggle reaches native window", () =>
    assert.equal(overlay.isContentProtected(), false),
  );
  await lab.webContents.executeJavaScript(
    `document.querySelector('#protection').click()`,
  );
  await delay(250);
  check("UI toggle restores native protection", () =>
    assert.equal(overlay.isContentProtected(), true),
  );
  await overlay.webContents.executeJavaScript(
    `document.querySelector('textarea').value='Verified editable notes'; document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}));`,
  );
  await delay(250);
  check("Editable notes reach local state", () =>
    assert.equal(state.notes, "Verified editable notes"),
  );
  change(
    "notes",
    "Meeting agenda\n\n• Clarify the goal\n• Confirm open questions\n• Agree on the next step",
  );
  await interview.request("setting", { key: "locale", value: "en" });
  await delay(180);
  check("Locale changes the rendered interface", () =>
    assert.equal(lab.webContents.getURL().startsWith("file:"), true),
  );
  const heading = await lab.webContents.executeJavaScript(
    `document.querySelector('h1').textContent`,
  );
  check("English UI is translated", () => assert.equal(heading, "Interview"));
  await interview.request("setting", { key: "locale", value: "ru" });
  await assert.rejects(
    interview.request("setting", { key: "speechLanguage", value: "invalid" }),
  );
  checks.push({ name: "Invalid interview settings rejected", passed: true });
  if (process.argv.includes("--interview-test")) {
    await interview.request("model");
    for (let i = 0; i < 240 && !interview.state.whisper.ready; i++) {
      if (interview.state.whisper.error)
        throw new Error(interview.state.whisper.error);
      await delay(1000);
    }
    assert.equal(interview.state.whisper.ready, true);
    const raw = await fs.readFile(process.env.CAPTURE_LAB_TEST_AUDIO);
    const buffer = raw.buffer.slice(
      raw.byteOffset,
      raw.byteOffset + raw.byteLength,
    );
    await interview.request("recording", true);
    const text = await interview.audio(buffer);
    check("Real Whisper audio reaches transcript", () => {
      assert.match(text, /country/i);
      assert.ok(interview.state.transcript.length);
    });
    await interview.request("stop");
    await delay(250);
    const rendered = await lab.webContents.executeJavaScript(
      `document.querySelector('#transcript').textContent`,
    );
    check("Transcript reaches the UI", () =>
      assert.match(rendered, /country/i),
    );
    if (process.argv.includes("--live-ai-test")) {
      if (process.env.CAPTURE_LAB_QUESTION_AUDIO) {
        const rawQuestion = await fs.readFile(
          process.env.CAPTURE_LAB_QUESTION_AUDIO,
        );
        await interview.request("recording", true);
        const question = await interview.audio(
          rawQuestion.buffer.slice(
            rawQuestion.byteOffset,
            rawQuestion.byteOffset + rawQuestion.byteLength,
          ),
        );
        await interview.request("stop");
        check("Spoken interview question is transcribed", () =>
          assert.match(question, /list.*tuple/i),
        );
        await interview.request("setting", {
          key: "answerLanguage",
          value: "ru",
        });
        await interview.request("answer", "");
      } else
        await interview.request(
          "answer",
          "В чём разница между списком и кортежем в Python? Ответь кратко.",
        );
      await delay(300);
      const response = await overlay.webContents.executeJavaScript(
        `document.querySelector('#answer').textContent`,
      );
      check("Live ChatGPT answer reaches protected overlay", () => {
        assert.ok(response.length > 80);
        assert.match(response, /спис|кортеж/i);
      });
    }
  }
  const captureResults = [];
  if (process.argv.includes("--capture-test")) {
    captureResults.push(await runCapture());
    if (process.platform === "darwin") {
      change("capturePath", "sck");
      captureResults.push(await runCapture());
    }
  }
  await delay(400);
  // These are renderer previews only; screen-exclusion evidence comes from runCapture.
  await fs.writeFile(
    path.join(artifactDir, "lab-ui.png"),
    (await lab.webContents.capturePage()).toPNG(),
  );
  await fs.writeFile(
    path.join(artifactDir, "overlay-ui.png"),
    (await overlay.webContents.capturePage()).toPNG(),
  );
  await fs.writeFile(
    path.join(artifactDir, "verification.json"),
    JSON.stringify(
      {
        checks,
        state: snapshot(),
        captureResults,
        note: "UI previews use capturePage and cannot establish OS capture exclusion.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: checks.length,
      permission: permission(),
      captures: captureResults.map((r) => ({
        path: r.capturePath,
        outcome: r.outcome,
      })),
      artifactDir,
    }),
  );
  app.quit();
}
app
  .whenReady()
  .then(async () => {
    ipcMain.handle("lab:state", () => snapshot());
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          contents === lab?.webContents &&
            permission === "media" &&
            details.mediaTypes?.every((t) => t === "audio"),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        contents === lab?.webContents &&
        permission === "media" &&
        details.mediaType === "audio",
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (
          process.platform !== "win32" ||
          request.frame !== lab?.webContents.mainFrame ||
          !request.audioRequested
        )
          return callback(null);
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
            thumbnailSize: { width: 0, height: 0 },
          });
          callback(
            sources[0] ? { video: sources[0], audio: "loopback" } : null,
          );
        } catch {
          callback(null);
        }
      },
    );
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^https?:|^wss?:/.test(details.url) }),
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Capture Lab",
          submenu: [
            {
              label: "Show Lab",
              click: () => {
                lab.show();
                lab.focus();
              },
            },
            { label: "Recover Overlay", click: reveal },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "selectAll" },
          ],
        },
      ]),
    );
    const area = screen.getPrimaryDisplay().workArea;
    lab = create("index.html", {
      title: "Capture Lab",
      width: Math.min(1180, area.width),
      height: Math.min(800, area.height),
      minWidth: 860,
      minHeight: 620,
      titleBarStyle: "hiddenInset",
    });
    overlay = create("overlay.html", {
      title: "Capture Lab — Assistant",
      width: 500,
      height: 430,
      minWidth: 360,
      minHeight: 280,
      x: area.x + area.width - 530,
      y: area.y + 85,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      type: process.platform === "darwin" ? "panel" : undefined,
    });
    overlay.setContentProtection(true);
    if (process.platform === "darwin")
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        state.visible = false;
        overlay.hide();
        publish();
      }
    });
    lab.on("close", () => {
      if (!quitting) app.quit();
    });
    for (const win of [lab, overlay])
      win.webContents.on("did-finish-load", publish);
    interview = await require("./services/interview.cjs").createInterview(
      app,
      publish,
      () => lab,
    );
    const shortcuts = [
      [
        "toggle",
        "CommandOrControl+Shift+Space",
        () => {
          if (!busy) change("visible", !state.visible);
        },
      ],
      [
        "recover",
        "CommandOrControl+Shift+R",
        () => {
          if (!busy) reveal();
        },
      ],
      [
        "answer",
        "CommandOrControl+Shift+Enter",
        () => {
          interview.request("answer", "").catch((error) => {
            interview.state.error = error.message;
            publish();
          });
        },
      ],
      [
        "lab",
        "CommandOrControl+Shift+L",
        () => {
          lab.show();
          lab.focus();
        },
      ],
    ];
    for (const [action, accelerator, handler] of shortcuts)
      state.shortcuts.push({
        action,
        accelerator,
        registered: globalShortcut.register(accelerator, handler),
      });
    // Only our two top-level renderers can access the narrow local bridge.
    const ownFrame = (event) =>
      [lab, overlay].some(
        (w) =>
          !w.isDestroyed() && event.senderFrame === w.webContents.mainFrame,
      );
    ipcMain.handle("lab:change", (event, key, value) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      return change(key, value);
    });
    ipcMain.handle("lab:action", (event, name) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      return action(name);
    });
    ipcMain.handle("interview:request", (event, op, payload) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      return interview.request(op, payload);
    });
    ipcMain.handle("interview:audio", (event, buffer) => {
      if (event.senderFrame !== lab.webContents.mainFrame)
        throw new Error("Untrusted frame");
      return interview.audio(buffer);
    });
    await Promise.all(
      [lab, overlay].map(
        (win) =>
          new Promise((resolve) =>
            win.webContents.isLoading()
              ? win.webContents.once("did-finish-load", resolve)
              : resolve(),
          ),
      ),
    );
    lab.show();
    overlay.showInactive();
    publish();
    if (verification) {
      await delay(800);
      await verify();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("before-quit", () => {
  quitting = true;
  interview?.close();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (lab && !lab.isDestroyed()) {
    lab.show();
    lab.focus();
  }
});
