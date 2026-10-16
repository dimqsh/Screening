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
  clipboard,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);

app.setName("Screening");
// Preserve the 0.2.0 settings and model cache when upgrading to the new product name.
app.setPath("userData", path.join(app.getPath("appData"), "Capture Lab"));
const verification = process.argv.includes("--verify");
if (!verification && !app.requestSingleInstanceLock()) app.exit(0);
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
let audioRouting;
const audioControl = { busy: false, peak: 0, phase: null };
const state = {
  protection: true,
  hideDock: false,
  clickThrough: false,
  visible: true,
  capturePath: "electron",
  captureWindow: "overlay",
  notes: "",
  result: null,
  testing: false,
  testCard: false,
  testWindow: "overlay",
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
  audioControl,
  permission: permission(),
  supported: ["darwin", "win32"].includes(process.platform),
});
function publish() {
  for (const win of [lab, overlay])
    if (win && !win.isDestroyed())
      win.webContents.send("lab:update", snapshot());
}
function publishAudioLevel(value) {
  if (!Number.isFinite(value)) return;
  const level = Math.max(0, Math.min(1, value));
  audioControl.peak = Math.max(audioControl.peak, level);
  for (const win of [lab, overlay])
    if (win && !win.isDestroyed())
      win.webContents.send("audio:level-update", level);
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
  for (const win of [lab, overlay]) win?.setContentProtection(state.protection);
  overlay.setIgnoreMouseEvents(state.clickThrough, { forward: true });
  state.visible ? overlay.showInactive() : overlay.hide();
  if (process.platform === "darwin" && app.dock)
    state.hideDock ? app.dock.hide() : app.dock.show();
  publish();
}
function change(key, value) {
  if (busy) throw new Error("Wait for the capture experiment to finish.");
  if (key === "captureWindow") {
    if (!["overlay", "workspace"].includes(value))
      throw new Error("Unsupported test window.");
  } else if (key === "capturePath") {
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
  if (key === "notes") publish();
  else apply();
  return snapshot();
}
function create(file, options) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: "#f5f4f0",
    icon: path.join(__dirname, "..", "assets", "brand", "screening.png"),
    ...options,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.setContentProtection(state.protection);
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
async function cropCapture(display, target = overlay) {
  if (state.capturePath === "sck") {
    if (process.platform !== "darwin")
      throw new Error("ScreenCaptureKit requires macOS.");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "capture-lab-roi-"));
    const filename = path.join(temp, "crop.png");
    const bounds = target.getBounds();
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
    bounds = target.getBounds();
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
async function runCapture(targetName = state.captureWindow) {
  if (busy) throw new Error("A capture experiment is already running.");
  if (process.platform === "darwin" && permission() !== "granted") {
    state.result = {
      outcome: "permission-needed",
      detail:
        "Enable Screen & System Audio Recording for Screening, reopen the app and retry.",
      permission: permission(),
    };
    publish();
    return state.result;
  }
  if (!["darwin", "win32"].includes(process.platform)) {
    state.result = {
      outcome: "unsupported",
      detail: "Capture protection is supported on macOS and Windows.",
    };
    publish();
    return state.result;
  }
  const target = targetName === "workspace" ? lab : overlay;
  const saved = {
    bounds: target.getBounds(),
    protection: state.protection,
    clickThrough: state.clickThrough,
    visible: state.visible,
    labVisible: lab.isVisible(),
  };
  busy = true;
  state.testing = true;
  state.testCard = true;
  state.testWindow = targetName;
  state.result = null;
  publish();
  try {
    const display = screen.getDisplayMatching(lab.getBounds()),
      area = display.workArea;
    if (targetName === "workspace") overlay.hide();
    const width = targetName === "workspace" ? Math.min(1100, area.width) : 470;
    const height =
      targetName === "workspace" ? Math.min(740, area.height) : 520;
    target.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    });
    target.setIgnoreMouseEvents(false);
    target.show();
    target.moveTop();
    // Only the synthetic target is unprotected. The other application window stays protected.
    target.setContentProtection(false);
    await delay(1100);
    const baseline = await cropCapture(display, target),
      baselineCount = markerPixels(baseline);
    target.setContentProtection(true);
    await delay(1100);
    const protectedImage = await cropCapture(display, target),
      protectedCount = markerPixels(protectedImage);
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
      window: targetName,
      time: new Date().toISOString(),
      detail: !valid
        ? "The unprotected marker was not reliably captured. Retry with the screen unlocked."
        : outcome === "visible"
          ? "The protected window remained visible in this capture path. Do not rely on it here."
          : outcome === "excluded"
            ? "The synthetic marker disappeared in this capture path. Verify the actual recipient view for your meeting app."
            : "The capture changed, but the result was ambiguous.",
      capturePath:
        state.capturePath === "sck"
          ? "Apple ScreenCaptureKit SCStream, no excluded windows, synthetic window ROI"
          : "Electron desktopCapturer full-display thumbnail cropped to synthetic window bounds",
      baseline: baseline.toDataURL(),
      protected: protectedImage.toDataURL(),
      platform: process.platform,
      os: state.os,
      electron: state.electron,
      limits:
        "One local path for the selected window. This does not establish every meeting app, recorder, process detector, remote desktop or physical camera.",
    };
    return state.result;
  } catch (error) {
    state.result = {
      outcome: "error",
      detail: error.message,
      window: targetName,
    };
    return state.result;
  } finally {
    target.setBounds(saved.bounds);
    Object.assign(state, {
      protection: saved.protection,
      clickThrough: saved.clickThrough,
      visible: saved.visible,
      testing: false,
      testCard: false,
      testWindow: "overlay",
    });
    busy = false;
    apply();
    if (!saved.labVisible) lab.hide();
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
  if (name === "hide-all") {
    lab.hide();
    overlay.hide();
    state.visible = false;
    publish();
    return;
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
  check("Both application windows have content protection", () => {
    assert.equal(overlay.isContentProtected(), true);
    assert.equal(lab.isContentProtected(), true);
  });
  check("Overlay is floating and omitted from Mission Control", () => {
    assert.equal(overlay.isAlwaysOnTop(), true);
    if (process.platform === "darwin")
      assert.equal(overlay.isHiddenInMissionControl(), true);
  });
  check("Protection can be disabled and restored", () => {
    change("protection", false);
    assert.equal(overlay.isContentProtected(), false);
    assert.equal(lab.isContentProtected(), false);
    change("protection", true);
    assert.equal(lab.isContentProtected(), true);
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
    `document.querySelector('#notes').value='Verified editable notes'; document.querySelector('#notes').dispatchEvent(new Event('input',{bubbles:true}));`,
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
        `document.querySelector('#chat').textContent`,
      );
      check("Live ChatGPT answer reaches protected overlay", () => {
        assert.ok(response.length > 80);
        assert.match(response, /спис|кортеж/i);
      });
    }
  }
  if (process.argv.includes("--compact-test")) {
    await require("./verify-compact.cjs")({
      lab,
      overlay,
      interview,
      action,
      audioControl,
      artifactDir,
      check,
    });
  }
  if (
    process.argv.includes("--system-audio-test") &&
    process.platform === "darwin"
  ) {
    await interview.request("clear");
    await action("compact");
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#audio-source').value='system';document.querySelector('#record').click()`,
    );
    for (
      let i = 0;
      i < 200 && (!interview.state.recording || audioControl.busy);
      i++
    )
      await delay(100);
    assert.equal(interview.state.recording, true);
    await fs.writeFile(path.join(artifactDir, "native-audio-ready"), "ready");
    await delay(14500);
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#record').click()`,
    );
    for (
      let i = 0;
      i < 200 &&
      (interview.state.recording ||
        audioControl.busy ||
        interview.state.whisper.pending);
      i++
    )
      await delay(100);
    check("Compact system audio captures real external playback", () => {
      assert.equal(interview.state.recording, false);
      assert.ok(audioControl.peak > 0.02);
      assert.match(
        interview.state.transcript.map((t) => t.text).join(" "),
        /country|fellow|Americans/i,
      );
    });
    await action("lab");
  }
  if (process.argv.includes("--screening-test")) {
    await interview.request("setting", { key: "notesEnabled", value: false });
    await delay(120);
    const hiddenNotes = await overlay.webContents.executeJavaScript(
      `document.querySelector('[data-overlay-tab="notes"]').hidden`,
    );
    check("Notes can be disabled and remain reachable for re-enabling", () => {
      assert.equal(hiddenNotes, false);
      assert.ok(state.notes.length);
    });
    await interview.request("setting", { key: "notesEnabled", value: true });
    await delay(100);
    check("Notes can be restored", () =>
      assert.equal(interview.state.settings.notesEnabled, true),
    );
    const previousClipboard = clipboard.readText();
    try {
      clipboard.writeText("Unicode paste: Привет\n    return 42");
      await lab.webContents.executeJavaScript(
        `document.querySelector('#question').value=''; document.querySelector('#paste-question').click()`,
      );
      await delay(200);
      const pasted = await lab.webContents.executeJavaScript(
        `document.querySelector('#question').value`,
      );
      check("Paste button preserves Unicode and indentation", () =>
        assert.equal(pasted, "Unicode paste: Привет\n    return 42"),
      );
      await lab.webContents.executeJavaScript(
        `document.querySelector('#question').value='';document.querySelector('#question').dispatchEvent(new Event('input',{bubbles:true}))`,
      );
      await assert.rejects(
        interview.request("window-capture", "window:unknown:0"),
      );
      checks.push({ name: "Unknown window capture is rejected", passed: true });
      if (process.argv.includes("--vision-test")) {
        const fixture = new BrowserWindow({
          width: 820,
          height: 520,
          title: "Screening coding fixture",
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await fixture.loadURL(
          "data:text/html;charset=utf-8," +
            encodeURIComponent(
              '<!doctype html><html><head><title>Screening coding fixture</title></head><body style="font:22px -apple-system,Segoe UI,sans-serif;padding:35px;background:#fff;color:#182333"><p style="font-size:12px;color:#777">SYNTHETIC INTERVIEW TASK</p><h1 style="font-size:30px">Pair sum</h1><p>Write a Python function that returns all unique pairs<br>from this list whose sum is 31.</p><pre style="padding:24px;background:#eff2f7;border-radius:8px">[4, 8, 15, 16, 23, 42]</pre><p>Use each list element at most once per pair.</p></body></html>',
            ),
        );
        try {
          fixture.show();
          await delay(800);
          let selected;
          for (let attempt = 0; attempt < 8 && !selected; attempt++) {
            selected = await overlay.webContents.executeJavaScript(
              `window.captureLab.request('windows').then(sources=>sources.find(source=>source.name==='Screening coding fixture'))`,
            );
            if (!selected) await delay(350);
          }
          await action("compact");
          async function sendCompactQuestion(question) {
            const previous = interview.state.messages.length;
            await overlay.webContents.executeJavaScript(
              `document.querySelector('#question').value=${JSON.stringify(question)};document.querySelector('#question-form').requestSubmit()`,
            );
            for (
              let i = 0;
              i < 220 &&
              (interview.state.messages.length === previous ||
                interview.state.ai.busy);
              i++
            )
              await delay(500);
            assert.equal(interview.state.messages.length, previous + 2);
            if (interview.state.ai.error)
              throw new Error(interview.state.ai.error);
          }
          assert.ok(
            selected,
            "Synthetic window is available to the real OS picker",
          );
          await overlay.webContents.executeJavaScript(
            `document.querySelector('#choose-window').click()`,
          );
          let pickerReady = false;
          for (let attempt = 0; attempt < 8 && !pickerReady; attempt++) {
            await delay(450);
            pickerReady = await overlay.webContents.executeJavaScript(
              `Array.from(document.querySelectorAll('#window-list .window-option')).some(button=>button.title==='Screening coding fixture')`,
            );
            if (!pickerReady)
              await overlay.webContents.executeJavaScript(
                `document.querySelector('#refresh-windows').click()`,
              );
          }
          assert.equal(pickerReady, true);
          // Only the synthetic entry is retained in the public validation screenshot.
          await overlay.webContents.executeJavaScript(
            `document.querySelectorAll('#window-list .window-option').forEach(button=>{if(button.title!=='Screening coding fixture')button.remove()})`,
          );
          await fs.writeFile(
            path.join(artifactDir, "window-picker.png"),
            (await overlay.webContents.capturePage()).toPNG(),
          );
          await overlay.webContents.executeJavaScript(
            `document.querySelector('#window-list .window-option').click()`,
          );
          for (let i = 0; i < 100 && !interview.state.attachment; i++)
            await delay(100);
          check("Selected window creates a single readable attachment", () => {
            assert.ok(
              interview.state.attachment.dataUrl.startsWith(
                "data:image/png;base64,",
              ),
            );
            assert.ok(interview.state.attachment.width >= 800);
          });
          await overlay.webContents.executeJavaScript(
            `window.captureLab.request("remove-attachment")`,
          );
          check("Pending screenshot can be removed before sending", () =>
            assert.equal(interview.state.attachment, null),
          );
          await overlay.webContents.executeJavaScript(
            `window.captureLab.request("window-capture",${JSON.stringify(selected.id)})`,
          );
          await interview.request("clear");
          await overlay.webContents.executeJavaScript(
            `window.captureLab.request("window-capture",${JSON.stringify(selected.id)})`,
          );
          await interview.request("setting", {
            key: "interviewType",
            value: "coding",
          });
          await interview.request("setting", {
            key: "answerLanguage",
            value: "ru",
          });
          await sendCompactQuestion(
            "Прочитай задачу на прикреплённом снимке. Реши её на Python и перечисли найденные пары.",
          );
          check("Live ChatGPT reads the selected window image", () => {
            assert.match(
              interview.state.ai.answer,
              /8[\s\S]{0,20}23|23[\s\S]{0,20}8/,
            );
            assert.match(
              interview.state.ai.answer,
              /15[\s\S]{0,20}16|16[\s\S]{0,20}15/,
            );
            assert.match(interview.state.ai.answer, /```/);
            assert.equal(interview.state.attachment, null);
          });
          await sendCompactQuestion(
            "Теперь измени целевую сумму на 46. Используй тот же исходный список. Какие пары получатся?",
          );
          check("Follow-up uses the preceding conversation", () => {
            assert.equal(interview.state.messages.length, 4);
            assert.match(
              interview.state.ai.answer,
              /4[\s\S]{0,20}42|42[\s\S]{0,20}4/,
            );
          });
          await delay(200);
          const count = await overlay.webContents.executeJavaScript(
            `document.querySelectorAll('#chat .chat-message').length`,
          );
          check("Compact chat renders both questions and both answers", () =>
            assert.equal(count, 4),
          );
          const expectedCode = await overlay.webContents.executeJavaScript(
            `document.querySelector('#chat .code-block pre').textContent`,
          );
          await overlay.webContents.executeJavaScript(
            `document.querySelector('#chat .code-block button').click()`,
          );
          await delay(150);
          check("Compact copy preserves the exact displayed code", () =>
            assert.equal(clipboard.readText(), expectedCode),
          );
          await overlay.webContents.executeJavaScript(
            `document.querySelector('#chat .assistant').scrollIntoView({block:'start'})`,
          );
          await delay(200);
          await fs.writeFile(
            path.join(artifactDir, "chat-answer.png"),
            (await overlay.webContents.capturePage()).toPNG(),
          );
        } finally {
          fixture.destroy();
          await action("lab");
        }
      }
    } finally {
      clipboard.writeText(previousClipboard);
    }
    const normalBounds = lab.getBounds();
    lab.setSize(960, 700);
    await delay(200);
    const fits = await lab.webContents.executeJavaScript(
      `({page: document.documentElement.scrollWidth <= innerWidth, composer: document.querySelector('#question-form').getBoundingClientRect().right <= innerWidth, chat: document.querySelector('#chat').clientHeight > 100})`,
    );
    check("Minimum workspace size fits the chat and composer", () => {
      assert.equal(fits.page, true);
      assert.equal(fits.composer, true);
      assert.equal(fits.chat, true);
    });
    await fs.writeFile(
      path.join(artifactDir, "minimum-ui.png"),
      (await lab.webContents.capturePage()).toPNG(),
    );
    lab.setBounds(normalBounds);
  }
  const captureResults = [];
  if (process.argv.includes("--capture-test")) {
    for (const window of ["overlay", "workspace"])
      captureResults.push(await runCapture(window));
    if (process.platform === "darwin") {
      change("capturePath", "sck");
      for (const window of ["overlay", "workspace"])
        captureResults.push(await runCapture(window));
    }
  }
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
  const previewWarnings = [];
  for (const [name, win] of [
    ["lab-ui.png", lab],
    ["overlay-ui.png", overlay],
  ]) {
    let timeout;
    try {
      win.webContents.invalidate();
      const image = await Promise.race([
        win.webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("UI preview timed out")),
            5000,
          );
        }),
      ]);
      await fs.writeFile(path.join(artifactDir, name), image.toPNG());
    } catch (error) {
      previewWarnings.push({ name, error: error.message });
    } finally {
      clearTimeout(timeout);
    }
  }
  if (previewWarnings.length)
    await fs.writeFile(
      path.join(artifactDir, "preview-warnings.json"),
      JSON.stringify(previewWarnings, null, 2),
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
  if (!process.argv.includes("--keep-open")) app.quit();
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
          label: "Screening",
          submenu: [
            {
              label: "Show Screening",
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
      title: "Screening",
      width: Math.min(1180, area.width),
      height: Math.min(840, area.height),
      minWidth: 960,
      minHeight: 700,
      titleBarStyle: "hiddenInset",
    });
    const compactHeight = Math.min(720, area.height - 30);
    overlay = create("overlay.html", {
      title: "Screening — Assistant",
      width: 540,
      height: compactHeight,
      minWidth: 420,
      minHeight: 580,
      x: area.x + area.width - 570,
      y: area.y + 15,
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
    lab.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        action("compact");
      }
    });
    for (const win of [lab, overlay])
      win.webContents.on("did-finish-load", publish);
    interview = await require("./services/interview.cjs").createInterview(
      app,
      publish,
      () => lab,
      {
        windowCapture:
          new (require("./services/window-capture.cjs").WindowCapture)(() => [
            lab.getMediaSourceId(),
            overlay.getMediaSourceId(),
          ]),
        getNotes: () => state.notes,
        onLevel: publishAudioLevel,
        onDraft: (value) => {
          for (const win of [lab, overlay])
            if (win && !win.isDestroyed())
              win.webContents.send("draft:update", value);
        },
      },
    );
    audioRouting = new (require("./services/audio-routing.cjs").AudioRouting)(
      (command) => lab.webContents.send("audio:command", command),
    );
    const shortcuts = [
      ["hide-all", "CommandOrControl+Shift+H", () => action("hide-all")],
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
    ipcMain.on("audio:level", (event, value) => {
      if (
        event.senderFrame === lab.webContents.mainFrame &&
        interview.state.recording &&
        typeof value === "number"
      )
        publishAudioLevel(value);
    });
    ipcMain.handle("audio:complete", (event, id, error) => {
      if (event.senderFrame !== lab.webContents.mainFrame)
        throw new Error("Untrusted audio owner");
      audioRouting.complete(id, error);
    });
    ipcMain.handle("interview:request", async (event, op, payload) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      if (op === "audio-start" || op === "audio-stop") {
        if (audioControl.busy)
          throw new Error("Audio is starting or stopping. Wait a moment.");
        if (op === "audio-start" && !["microphone", "system"].includes(payload))
          throw new Error("Invalid audio source");
        if (op === "audio-start" && !interview.state.whisper.ready)
          throw new Error("Set up Whisper before starting audio.");
        if (op === "audio-start" && interview.state.recording)
          throw new Error("Audio is already running.");
        if (op === "audio-start") audioControl.peak = 0;
        audioControl.phase = op === "audio-start" ? "starting" : "stopping";
        audioControl.busy = true;
        publish();
        try {
          if (op === "audio-stop") {
            if (
              process.platform === "darwin" &&
              interview.state.source === "system"
            )
              await interview.request("stop");
            else await audioRouting.command("stop");
          } else if (process.platform === "darwin" && payload === "system")
            await interview.request("system-start");
          else await audioRouting.command("start", payload);
        } finally {
          audioControl.busy = false;
          audioControl.phase = null;
          publish();
        }
        return;
      }
      if (
        ["recording", "stop"].includes(op) &&
        event.senderFrame !== lab.webContents.mainFrame
      )
        throw new Error("Use shared audio controls.");
      if (op === "clipboard-read") return clipboard.readText().slice(0, 16000);
      if (op === "clipboard-write") {
        if (typeof payload !== "string" || payload.length > 64000)
          throw new Error("Invalid clipboard text");
        clipboard.writeText(payload);
        return;
      }
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
    if (verification) {
      lab.show();
      overlay.showInactive();
    } else {
      lab.hide();
      reveal();
    }
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
  audioRouting?.close();
  interview?.close();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (lab && !lab.isDestroyed()) {
    if (lab.isVisible()) lab.focus();
    else reveal();
  }
});

app.on("second-instance", () => {
  if (lab && !lab.isDestroyed()) {
    if (lab.isVisible()) lab.focus();
    else reveal();
  }
});
