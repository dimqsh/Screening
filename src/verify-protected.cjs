// Exercises the actual Buddy UI through AppKit, then records its presentation
// from a separate process. Synthetic content only; never disables protection
// while real notes or answers are shown.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const execFile = require("node:util").promisify(require("node:child_process").execFile);
const { BrowserWindow, screen } = require("electron");

module.exports = async function verifyProtected(ctx) {
  if (process.platform !== "darwin") throw new Error("Protected presentation verification requires macOS.");
  const { buddy, buddyPresentation: presentation, state, interview, publish,
    setDock, setHidden, change, ask, delay, artifactDir } = ctx;
  assert.ok(presentation, "Native presentation was not created");
  const nativeInput = require("../bin/presentation-input-test.node");
  const js = (code) => buddy.webContents.executeJavaScript(code);
  const saved = {
    bounds: buddy.getBounds(), dock: interview.state.settings.dock,
    ready: interview.state.whisper.ready, connected: interview.state.ai.connected,
    accessPrompted: interview.state.settings.accessPrompted, notes: state.notes,
    protection: state.protection, hidden: state.hidden,
  };
  const checks = [];
  const mark = (message) => {
    checks.push(message);
    console.log(`Protected presentation: ${message}`);
  };
  let fixture, recorder;
  const send = (event) => nativeInput.send(buddy.getNativeWindowHandle(), JSON.stringify(event));
  async function click(selector) {
    const point = await js(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      if (!r.width || !r.height) throw new Error("Control is not visible");
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    buddy.setIgnoreMouseEvents(false);
    send({ type: "mouseMoved", ...point });
    await delay(80);
    const hit = send({ type: "mouseDown", ...point });
    await delay(50);
    send({ type: "mouseUp", ...point });
    await delay(250);
    assert.match(hit, /RenderWidgetHostView/, `AppKit did not hit Chromium: ${hit}`);
  }
  try {
    interview.state.whisper.ready = true;
    interview.state.ai.connected = true;
    interview.state.settings.accessPrompted = true;
    change("notes", "");
    await setDock("float");
    setHidden(false);
    ask();
    await delay(600);
    // Keep geometry stable when the physical cursor is elsewhere: synthesized
    // in-process mouse events intentionally do not move the user's cursor.
    await js("if(document.getElementById('pin').getAttribute('aria-pressed')!=='true') document.getElementById('pin').click()");
    await delay(250);
    await presentation.refresh();
    let status = presentation.status();
    assert.ok(status.visible && status.ready && status.protected && status.sourceSuppressed &&
      status.layerHosted && status.aligned,
      JSON.stringify(status));
    mark("Protected host ordered onscreen and ready, source suppressed, geometry aligned");

    await js(`window.__nativeInputEvents=[];
      for(const type of ['mousedown','mouseup','click'])
        document.addEventListener(type,e=>window.__nativeInputEvents.push({
          type,x:e.clientX,y:e.clientY,target:e.target.id,tab:e.target.closest('[data-tab]')?.dataset.tab
        }),true)`);
    await click('[data-tab="notes"]');
    assert.equal(await js("document.querySelector('.view.active').id"), "view-notes",
      JSON.stringify(await js("window.__nativeInputEvents")));
    await click("#notes");
    assert.equal(await js("document.activeElement.id"), "notes");
    // Use the native input-method entry point for text. Invented key codes
    // do not represent Unicode consistently across the user's input sources.
    const responder = send({ type: "text", text: "Buddy Ж" });
    assert.match(responder, /RenderWidgetHostView/);
    await delay(500);
    const typed = await js("document.getElementById('notes').value");
    // As in the ordinary verifier, the user may also type on this live desktop
    // while Buddy briefly owns the keyboard. Our exact sequence must be intact.
    assert.ok(typed.startsWith("Buddy Ж"), JSON.stringify(typed));
    assert.equal(state.notes, typed);
    mark("Native mouse hit testing, tabs, text focus, Unicode text input and notes IPC");
    send({ type: "keyDown", text: "a", keyCode: 0, command: true });
    send({ type: "keyUp", text: "a", keyCode: 0, command: true });
    await delay(100);
    const selection = await js("(()=>{const n=document.getElementById('notes');return [n.selectionStart,n.selectionEnd]})()");
    assert.deepEqual(selection, [0, typed.length]);
    mark("Native Command+A text selection");
    await js("document.getElementById('notes').blur()");
    await delay(100);

    const before = presentation.status().frames;
    setHidden(true);
    await delay(150);
    assert.equal(presentation.status().visible, false, JSON.stringify({
      status: presentation.status(), hidden: state.hidden, visible: buddy.isVisible(),
    }));
    setHidden(false);
    await delay(300);
    await presentation.refresh();
    buddy.setBounds({ ...buddy.getBounds(), width: 600, height: 580 });
    await delay(350);
    await presentation.refresh();
    status = presentation.status();
    assert.ok(status.visible && status.aligned && status.frames > before);
    assert.equal(status.width, Math.round(buddy.getBounds().width * screen.getDisplayMatching(buddy.getBounds()).scaleFactor));
    await setDock("notch");
    await delay(300);
    assert.ok(presentation.status().aligned);
    mark("Hide/show, resize, float and notch placement");

    const spacesBefore = presentation.status().spaceChanges;
    const fullscreen = await execFile(
      path.join(__dirname, "../bin/presentation-fullscreen-test"), [], { timeout: 20000 });
    assert.deepEqual(JSON.parse(fullscreen.stdout), {
      enteredFullscreen: true, leftFullscreen: true,
    });
    await delay(300);
    await presentation.refresh();
    status = presentation.status();
    assert.ok(status.spaceChanges > spacesBefore, "No real Space change reached the presentation");
    assert.ok(status.visible && status.ready && status.protected && status.sourceSuppressed && status.layerHosted &&
      status.onActiveSpace && !status.outputObscured && !status.failed, JSON.stringify(status));
    // Native flags verify lifecycle only; they cannot prove physical pixels
    // are visible because the protected layer is excluded from screenshots.
    mark("Protected presentation lifecycle survives a fullscreen Space transition");

    state.testing = true;
    state.testCard = true;
    const display = screen.getPrimaryDisplay();
    const bounds = {
      x: Math.round(display.workArea.x + (display.workArea.width - 510) / 2),
      y: Math.round(display.workArea.y + (display.workArea.height - 520) / 2),
      width: 470, height: 520,
    };
    buddy.setBounds(bounds);
    // A green strip beside Buddy stays in the capture throughout, proving that
    // zero marker counts are not a blank/stalled recorder.
    fixture = new BrowserWindow({
      ...bounds, width: 510, show: false, frame: false, focusable: false,
      backgroundColor: "#101018", skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    fixture.setAlwaysOnTop(true, "screen-saver");
    fixture.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    fixture.setContentProtection(false);
    await fixture.loadURL("data:text/html," + encodeURIComponent(
      '<style>body{margin:0;background:#101018}i{position:fixed;right:0;top:0;width:40px;height:100%;background:#00ff00;animation:tick .3s steps(1) infinite}@keyframes tick{50%{background:#00cc00}}</style><i></i>',
    ));
    fixture.showInactive();
    buddy.moveTop();
    change("protection", true);
    publish();
    await delay(700);
    await presentation.refresh();
    await fs.writeFile(path.join(artifactDir, "capture-control-source.png"),
      (await fixture.webContents.capturePage()).toPNG());
    await execFile(path.join(__dirname, "../bin/capture-cgdisplay"), [
      display.id, bounds.x - display.bounds.x, bounds.y - display.bounds.y, 510, 520, display.scaleFactor,
      path.join(artifactDir, "cg-control-protected.png"),
    ].map(String), { timeout: 10000 });
    assert.ok(presentation.status().visible && presentation.status().protected);
    const frames = [];
    let stderr = "", raw = "";
    recorder = spawn(path.join(__dirname, "../bin/capture-cgdisplay"), [
      display.id, bounds.x - display.bounds.x, bounds.y - display.bounds.y,
      bounds.width + 40, bounds.height, display.scaleFactor,
    ].map(String), { stdio: ["ignore", "pipe", "pipe"] });
    recorder.stdout.on("data", (chunk) => {
      raw += chunk;
      let newline;
      while ((newline = raw.indexOf("\n")) >= 0) {
        const line = raw.slice(0, newline);
        raw = raw.slice(newline + 1);
        frames.push(JSON.parse(line));
      }
    });
    recorder.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      recorder.once("error", reject);
      recorder.once("exit", (code) => resolve(code));
    });
    const firstFrameDeadline = Date.now() + 5000;
    while (!frames.length) {
      if (Date.now() > firstFrameDeadline) throw new Error("Recorder did not deliver its first frame.");
      await delay(20);
    }
    const phaseOrigin = frames[0].elapsed;
    await delay(1800);
    await js("document.querySelector('#test-view .probe').style.width='50%'");
    await presentation.refresh();
    await delay(1500);
    change("protection", false);
    await delay(1100);
    change("protection", true);
    const code = await done;
    const result = { code, stderr, frames, status: presentation.status(), checks };
    await fs.writeFile(path.join(artifactDir, "protected-presentation.json"), JSON.stringify(result, null, 2));
    assert.equal(code, 0, stderr);
    assert.ok(frames.length > 5, "Recorder did not return enough frames");
    assert.ok(frames.every((frame) => frame.green > 1000), "Independent green control disappeared");
    const early = frames.filter((f) => f.elapsed < phaseOrigin + 1.5);
    const fresh = frames.filter((f) => f.elapsed > phaseOrigin + 2.1 && f.elapsed < phaseOrigin + 3.1);
    const off = frames.filter((f) => f.elapsed > phaseOrigin + 3.6 && f.elapsed < phaseOrigin + 4.2);
    const restored = frames.filter((f) => f.elapsed > phaseOrigin + 4.8);
    for (const [phase, values] of [["initial", early], ["fresh", fresh], ["restored", restored]]) {
      assert.ok(values.length, `Missing ${phase} protected frames`);
      assert.ok(values.every((f) => f.markerPixels === 0), `${phase} protected content leaked`);
    }
    assert.ok(off.length && off.every((f) => f.markerPixels > 1000), "Missing positive unprotected control");
    mark("External CGDisplayStream: initially protected, fresh content, off/on, continuous green control");
    await fs.writeFile(path.join(artifactDir, "protected-presentation.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ protectedPresentation: "passed", checks, capturedFrames: frames.length }));
  } finally {
    if (recorder && recorder.exitCode === null) recorder.kill();
    fixture?.destroy();
    state.testing = false;
    state.testCard = false;
    interview.state.whisper.ready = saved.ready;
    interview.state.ai.connected = saved.connected;
    interview.state.settings.accessPrompted = saved.accessPrompted;
    change("protection", saved.protection);
    change("notes", saved.notes);
    await setDock(saved.dock);
    buddy.setBounds(saved.bounds);
    setHidden(saved.hidden);
    publish();
  }
};
