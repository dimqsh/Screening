const {
  app,
  utilityProcess,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  globalShortcut,
  screen,
  desktopCapturer,
  systemPreferences,
  session,
  nativeImage,
  clipboard,
  dialog,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const notchGeometry = require("./services/notch.cjs");
const { trayMenu, KEYS } = require("./tray-menu.cjs");
const { formatElapsed } = require("./buddy-model.js");
const { speechModel } = require("./services/speech-model.cjs");
const { lightSnapshot, engineSnapshot } = require("./services/snapshot.cjs");
const { hasAudioTap, hasSystemPicker } = require("./services/macos.cjs");

app.setName("Screening");
// Preserve settings and the model cache from versions named Capture Lab.
app.setPath("userData", path.join(app.getPath("appData"), "Capture Lab"));
const verification = process.argv.includes("--verify");
if (!verification && !app.requestSingleInstanceLock()) app.exit(0);
const artifactDir = path.resolve(
  process.env.CAPTURE_LAB_ARTIFACTS || path.join(__dirname, "..", "validation"),
);
if (verification)
  app.setPath(
    "userData",
    path.join(os.tmpdir(), `capture-lab-test-${process.pid}`),
  );

// Buddy is the only visible window. The engine is a hidden audio host.
let buddy,
  buddyPresentation,
  engine,
  tray,
  interview,
  audioRouting,
  buddyLayout = null,
  trayKey = "",
  trayRecording = null,
  quitting = false,
  busy = false;
const audioControl = { busy: false, peak: 0, phase: null };
// Counts keyboard hand-offs so verification can check Buddy's own behavior.
const keyboard = { taken: 0, released: 0, focusableOnTake: false };
const state = {
  protection: true,
  hidden: false,
  notes: "",
  result: null,
  testing: false,
  testCard: false,
  testWindow: "buddy",
  shortcuts: [],
  platform: process.platform,
  os: `${os.type()} ${os.release()}`,
  electron: process.versions.electron,
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (win) => win && !win.isDestroyed();
const permission = () =>
  process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("screen")
    : "not-required";
const buddyShown = () => (state.testing ? true : !state.hidden);
// Microphone and call-audio access on macOS. Call audio uses a Core Audio
// tap, whose permission only the tap helper can read, so that answer is
// cached and re-read in the background at most every 15 seconds. Before
// macOS 14.2 call audio goes through ScreenCaptureKit and screen recording.
let accessCache = null;
let callAudio = { status: "not-determined", at: 0, reading: null };
function readCallAudio() {
  if (!hasAudioTap()) return Promise.resolve();
  callAudio.reading ??= execFile(helperPath("audio-tap"), ["--status"], { timeout: 5000 })
    .then(({ stdout }) => stdout.trim(), () => "")
    .then((value) => {
      const status = ["granted", "denied"].includes(value) ? value : "not-determined";
      const changed = status !== callAudio.status;
      callAudio = { status, at: Date.now(), reading: null };
      if (changed) {
        accessCache = null;
        publish();
      }
    });
  return callAudio.reading;
}
function access() {
  if (process.platform !== "darwin") return null;
  if (accessCache && Date.now() - accessCache.at < 2000) return accessCache.value;
  if (Date.now() - callAudio.at > 15000) readCallAudio();
  const value = {
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    audio: hasAudioTap() ? callAudio.status : permission(),
  };
  accessCache = { at: Date.now(), value };
  return value;
}
const SETTINGS_PANE = "x-apple.systempreferences:com.apple.preference.security";
// Asks for everything Buddy needs in one go: the microphone, then call audio.
// Both prompts have an Allow button. macOS cannot ask twice, so a denied item
// opens its page; System Audio Recording Only sits on the screen recording page.
async function allowAccess() {
  if (process.platform !== "darwin") return;
  if (systemPreferences.getMediaAccessStatus("microphone") === "not-determined")
    await systemPreferences.askForMediaAccess("microphone");
  if (hasAudioTap())
    await execFile(helperPath("audio-tap"), ["--request"], { timeout: 120000 }).catch(() => {});
  else if (permission() !== "granted")
    await desktopCapturer
      .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
      .catch(() => {});
  await readCallAudio();
  accessCache = null;
  const now = access();
  if (now.microphone === "denied")
    await shell.openExternal(`${SETTINGS_PANE}?Privacy_Microphone`);
  else if (now.audio !== "granted")
    await shell.openExternal(`${SETTINGS_PANE}?Privacy_ScreenCapture`);
  await interview.request("setting", { key: "accessPrompted", value: true });
  publish();
}
// Buddy may start a window capture only right after the person presses
// Snapshot, and the system picker then lets them choose what to share.
let pickingUntil = 0;
const buddyPicking = (contents) =>
  contents === buddy?.webContents && Date.now() < pickingUntil;
const snapshot = () => ({
  ...state,
  buddy: { enabled: !state.hidden, layout: buddyLayout },
  buddyVisible: !state.hidden,
  permissions: access(),
  speechModel: speechModel(interview?.state.settings.speechModel),
  interview: interview?.state,
  audioControl,
  permission: permission(),
  // Verification keeps Buddy's own window list, which a test can click.
  systemPicker: hasSystemPicker() && !verification,
  supported: ["darwin", "win32"].includes(process.platform),
});
// Each window gets only what it uses: Buddy no full images, the engine one flag.
function publish() {
  const value = snapshot();
  if (alive(buddy)) buddy.webContents.send("lab:update", lightSnapshot(value));
  if (alive(engine))
    engine.webContents.send("lab:update", engineSnapshot(value));
  syncBuddy();
  syncTray(value);
}
function publishAudioLevel(value) {
  if (!Number.isFinite(value)) return;
  const level = Math.max(0, Math.min(1, value));
  audioControl.peak = Math.max(audioControl.peak, level);
  if (alive(buddy)) buddy.webContents.send("audio:level-update", level);
}
function report(error) {
  if (interview) {
    interview.state.error = error.message;
    publish();
  } else console.error(error);
}
const attempt = (fn) => () => Promise.resolve().then(fn).catch(report);

// Whisper runs in its own process at a lower CPU priority, so the meeting app
// and Buddy stay responsive while it transcribes, and killing it on unload
// returns all of its memory to the system.
function createSpeechWorker(workerData) {
  const child = utilityProcess.fork(
    path.join(__dirname, "services", "whisper-worker.cjs"),
    [JSON.stringify(workerData)],
    { serviceName: "Screening speech", stdio: "ignore" },
  );
  const listeners = { message: [], error: [] };
  let stopped = false;
  child.once("spawn", () => {
    try {
      os.setPriority(child.pid, 10);
    } catch {
      /* Priority is a refinement; transcription works without it. */
    }
  });
  child.on("message", (message) =>
    listeners.message.forEach((listener) => listener(message)),
  );
  child.on("exit", (code) => {
    if (!stopped && code !== 0)
      listeners.error.forEach((listener) =>
        listener(new Error(`The speech process stopped (code ${code}).`)),
      );
  });
  return {
    on: (event, listener) => listeners[event]?.push(listener),
    postMessage: (message) => child.postMessage(message),
    terminate: () => {
      stopped = true;
      child.kill();
    },
  };
}
function helperPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", name)
    : path.join(__dirname, "..", "bin", name);
}
function syncBuddy() {
  if (!alive(buddy)) return;
  if (buddyPresentation?.failed) {
    buddy.hide();
    return;
  }
  const show = buddyShown();
  if (show && !buddy.isVisible()) buddy.showInactive();
  else if (!show && buddy.isVisible()) {
    releaseKeyboard();
    buddy.hide();
    // Return with clicks passing through, whatever the pointer was doing.
    buddy.setIgnoreMouseEvents(true, { forward: true });
  }
  buddyPresentation?.sync(show);
}
// The camera housing of a display never moves, so the helper runs once per
// display: a new display or resolution gets its own run. Callers share one
// pending run.
let notchCache = null;
function notchFor(display) {
  const key = `${display.id}:${display.bounds.width}x${display.bounds.height}@${display.scaleFactor}`;
  if (notchCache?.key !== key)
    notchCache = {
      key,
      notch: notchGeometry.detectNotch({
        display,
        helper: process.platform === "darwin" ? helperPath("notch-info") : null,
        run: execFile,
      }),
    };
  return notchCache.notch;
}
let placedBounds = null;
function setBuddyBounds(bounds) {
  placedBounds = bounds;
  buddy.setBounds(bounds);
}
async function placeBuddy() {
  const settings = interview?.state.settings;
  if (settings?.dock === "float") {
    const position = settings.position;
    const display = position
      ? screen.getDisplayNearestPoint(position)
      : screen.getPrimaryDisplay();
    const placed = notchGeometry.floatingLayout({ display, position });
    buddyLayout = placed.layout;
    if (alive(buddy) && !state.testing) setBuddyBounds(placed.window);
    return placed.window;
  }
  const display = screen.getPrimaryDisplay();
  const notch = await notchFor(display);
  const placed = notchGeometry.islandLayout({ display, notch });
  buddyLayout = placed.layout;
  if (alive(buddy) && !state.testing) setBuddyBounds(placed.window);
  return placed.window;
}
// Dragging Buddy by its top bar follows the cursor; letting go after a move
// detaches it from the notch and remembers where it was left.
let drag = null;
function startDrag() {
  endDrag(false);
  const cursor = screen.getCursorScreenPoint();
  const bounds = buddy.getBounds();
  drag = {
    dx: cursor.x - bounds.x,
    dy: cursor.y - bounds.y,
    start: cursor,
    moved: false,
    timer: setInterval(() => {
      const point = screen.getCursorScreenPoint();
      if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 4)
        return;
      drag.moved = true;
      buddy.setPosition(point.x - drag.dx, point.y - drag.dy);
    }, 16),
    // A drag can never outlive a lost pointer-up for long.
    limit: setTimeout(() => endDrag(true), 20000),
  };
}
async function endDrag(save = true) {
  if (!drag) return;
  clearInterval(drag.timer);
  clearTimeout(drag.limit);
  const moved = drag.moved;
  drag = null;
  if (!save || !moved) return;
  const bounds = buddy.getBounds();
  const x = bounds.x + Math.round((bounds.width - notchGeometry.FLOAT.width) / 2);
  await interview.request("setting", { key: "position", value: { x, y: bounds.y } });
  await interview.request("setting", { key: "dock", value: "float" });
  await placeBuddy();
  publish();
}
async function setDock(dock) {
  await interview.request("setting", { key: "dock", value: dock });
  await placeBuddy();
  publish();
}
function setHidden(hidden) {
  state.hidden = hidden;
  publish();
}
function ask() {
  setHidden(false);
  buddy.webContents.send("buddy:ask");
}
// Buddy takes the keyboard only while a text field is in use. On macOS the
// panel is non-activating, so the meeting app stays the active app.
function takeKeyboard() {
  if (!alive(buddy) || !buddy.isVisible()) return;
  buddy.setFocusable(true);
  keyboard.taken++;
  keyboard.focusableOnTake = buddy.isFocusable();
  // makeKeyAndOrderFront in Electron's panel focus path can stall subsequent
  // resized capturePage frames. The protected companion already owns stacking.
  if (buddyPresentation) buddyPresentation.takeKeyboard();
  else {
    buddy.focus();
    buddy.webContents.focus();
  }
}
function releaseKeyboard() {
  if (!alive(buddy) || !buddy.isFocusable()) return;
  keyboard.released++;
  const focused = buddy.isFocused();
  buddy.setFocusable(false);
  // Release key status without disturbing the protected companion's display.
  if (focused && buddy.isVisible()) {
    if (buddyPresentation) buddyPresentation.releaseKeyboard();
    else {
      buddy.hide();
      buddy.showInactive();
    }
  }
}

function change(key, value) {
  if (busy) throw new Error("Wait for the capture test to finish.");
  if (key === "notes") {
    if (typeof value !== "string" || value.length > 12000)
      throw new Error("Notes must be under 12,000 characters.");
    state.notes = value;
    publish();
    return lightSnapshot(snapshot());
  }
  if (key !== "protection" || typeof value !== "boolean")
    throw new Error("Unsupported setting.");
  state.protection = value;
  apply();
  return lightSnapshot(snapshot());
}
function apply() {
  for (const win of [buddy, engine])
    if (alive(win)) win.setContentProtection(state.protection);
  buddyPresentation?.setProtection(state.protection);
  publish();
}

async function audio(op, kind) {
  if (audioControl.busy)
    throw new Error("Audio is starting or stopping. Wait a moment.");
  if (op === "start") {
    if (!["microphone", "system"].includes(kind))
      throw new Error("Invalid audio source");
    if (!interview.state.whisper.ready)
      throw new Error("Download the speech model before listening.");
    if (interview.state.recording) throw new Error("Already listening.");
    audioControl.peak = 0;
    await interview.request("setting", { key: "source", value: kind });
  } else if (op !== "stop") throw new Error("Unknown audio operation");
  audioControl.phase = op === "start" ? "starting" : "stopping";
  audioControl.busy = true;
  publish();
  try {
    if (op === "stop") {
      if (process.platform === "darwin" && interview.state.source === "system")
        await interview.request("stop");
      else await audioRouting.command("stop");
    } else if (process.platform === "darwin" && kind === "system")
      await interview.request("system-start");
    else await audioRouting.command("start", kind);
  } finally {
    audioControl.busy = false;
    audioControl.phase = null;
    publish();
  }
}
const toggleListening = () =>
  interview.state.recording
    ? audio("stop")
    : audio("start", interview.state.settings.source);

function create(file, options) {
  const win = new BrowserWindow({
    show: false,
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

// Capture experiment: the same A/B marker test as earlier versions, for Buddy.
function markerPixels(image) {
  const pixels = image.toBitmap();
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    // Electron bitmap pixels are BGRA. Match the synthetic magenta test strip.
    if (pixels[i] > 140 && pixels[i + 1] < 65 && pixels[i + 2] > 200) count++;
  }
  return count;
}
async function cropCapture(display, target, capturePath) {
  if (capturePath === "sck" || capturePath === "cgdisplay") {
    if (process.platform !== "darwin")
      throw new Error("ScreenCaptureKit requires macOS.");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "capture-lab-roi-"));
    const filename = path.join(temp, "crop.png");
    const bounds = target.getBounds();
    try {
      await execFile(
        helperPath(capturePath === "sck" ? "capture-sck" : "capture-cgdisplay"),
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
async function runCapture(capturePath = "electron") {
  if (busy) throw new Error("A capture test is already running.");
  if (process.platform === "darwin" && permission() !== "granted") {
    state.result = {
      outcome: "permission-needed",
      detail:
        "Allow Screening in System Settings → Privacy & Security → Screen & System Audio Recording, then reopen the app.",
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
  const saved = { bounds: buddy.getBounds(), protection: state.protection };
  busy = true;
  state.testing = true;
  state.testCard = true;
  state.result = null;
  publish();
  try {
    const display = screen.getPrimaryDisplay(),
      area = display.workArea;
    const width = 470,
      height = 520;
    buddy.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
    });
    buddy.setIgnoreMouseEvents(false);
    buddy.showInactive();
    buddy.moveTop();
    const prepareSyntheticContent = () => buddy.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const check = () => {
          if (!document.getElementById('test-view').hidden &&
              document.getElementById('island').hidden)
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          else if (Date.now() > deadline) reject(new Error('Synthetic card did not render.'));
          else setTimeout(check, 20);
        };
        check();
      })
    `);
    if (buddyPresentation) await buddyPresentation.prepareCaptureTest(prepareSyntheticContent);
    else await prepareSyntheticContent();
    // Only Buddy, showing a synthetic card, is briefly unprotected.
    buddy.setContentProtection(false);
    await delay(1100);
    const baseline = await cropCapture(display, buddy, capturePath),
      baselineCount = markerPixels(baseline);
    buddy.setContentProtection(true);
    buddyPresentation?.setProtection(true);
    await delay(1100);
    const protectedImage = await cropCapture(display, buddy, capturePath),
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
      window: "buddy",
      time: new Date().toISOString(),
      detail: !valid
        ? "The unprotected marker was not reliably captured. Retry with the screen unlocked."
        : outcome === "visible"
          ? "Buddy stayed visible in this capture path. Do not rely on it here."
          : outcome === "excluded"
            ? "Buddy disappeared from this capture path. Check what the other person sees in your meeting app."
            : "The capture changed, but the result was ambiguous.",
      capturePath:
        capturePath === "cgdisplay"
          ? "Apple CGDisplayStream, independent process, synthetic window ROI"
          : capturePath === "sck"
          ? "Apple ScreenCaptureKit SCStream, no excluded windows, synthetic window ROI"
          : "Electron desktopCapturer full-display thumbnail cropped to synthetic window bounds",
      baseline: baseline.toDataURL(),
      protected: protectedImage.toDataURL(),
      platform: process.platform,
      os: state.os,
      electron: state.electron,
      limits:
        "One local path. This does not establish every meeting app, recorder, process detector, remote desktop or physical camera.",
    };
    return state.result;
  } catch (error) {
    state.result = { outcome: "error", detail: error.message, window: "buddy" };
    return state.result;
  } finally {
    buddy.setBounds(saved.bounds);
    Object.assign(state, {
      protection: saved.protection,
      testing: false,
      testCard: false,
    });
    busy = false;
    apply();
    buddy.setIgnoreMouseEvents(true, { forward: true });
  }
}
async function captureTest() {
  const paths =
    process.platform === "darwin" ? ["electron", "sck", "cgdisplay"] : ["electron"];
  const results = [];
  for (const capturePath of paths) results.push(await runCapture(capturePath));
  const hidden = results.every((r) => r.outcome === "excluded");
  if (process.platform === "darwin") app.focus({ steal: true });
  await dialog.showMessageBox({
    type: hidden ? "info" : "warning",
    message: hidden
      ? "Buddy was hidden from screen capture."
      : "Buddy was not hidden in every test.",
    detail: results
      .map(
        (r) =>
          `${r.capturePath?.includes("CGDisplayStream") ? "CGDisplayStream" :
            r.capturePath?.startsWith("Apple") ? "ScreenCaptureKit" : "Screen capture"}: ${r.detail}`,
      )
      .join("\n\n"),
  });
  return results;
}

// Menu-bar icon and menu.
function trayImage(recording) {
  if (process.platform !== "darwin")
    return nativeImage.createFromPath(
      path.join(__dirname, "..", "assets", "tray", "tray-windows.png"),
    );
  const image = nativeImage.createFromPath(
    path.join(
      __dirname,
      "..",
      "assets",
      "tray",
      recording ? "trayRecordingTemplate.png" : "trayTemplate.png",
    ),
  );
  image.setTemplateImage(true);
  return image;
}
async function runMenu(id) {
  const [kind, key, value] = id.split(":");
  if (kind === "setting") {
    const current = interview.state.settings[key];
    return interview.request("setting", {
      key,
      value: value === undefined ? !current : value,
    });
  }
  const actions = {
    "listen-system": () => audio("start", "system"),
    "listen-microphone": () => audio("start", "microphone"),
    stop: () => audio("stop"),
    answer: () => interview.request("answer", ""),
    ask,
    "toggle-buddy": () => setHidden(!state.hidden),
    "allow-access": allowAccess,
    "toggle-dock": () =>
      setDock(interview.state.settings.dock === "float" ? "notch" : "float"),
    protection: () => change("protection", !state.protection),
    "capture-test": captureTest,
    model: () => interview.request("model"),
    login: () => interview.request("login"),
    account: () => interview.request("account"),
    export: () => interview.request("export"),
    clear: () => interview.request("clear"),
    quit: () => app.quit(),
  };
  if (!actions[id]) throw new Error(`Unknown menu item ${id}`);
  return actions[id]();
}
function electronMenu(items) {
  return items.map(({ id, submenu, ...item }) => ({
    ...item,
    ...(id ? { id, click: () => runMenu(id).catch(report) } : {}),
    ...(submenu ? { submenu: electronMenu(submenu) } : {}),
  }));
}
function syncTray(value) {
  if (!tray || tray.isDestroyed()) return;
  const recording = Boolean(value.interview?.recording);
  if (recording !== trayRecording) {
    trayRecording = recording;
    tray.setImage(trayImage(recording));
    if (!recording && process.platform === "darwin") {
      trayTitle = "";
      tray.setTitle("");
    }
  }
  const items = trayMenu(value, process.platform);
  const key = JSON.stringify(items);
  if (key === trayKey) return;
  trayKey = key;
  tray.setContextMenu(Menu.buildFromTemplate(electronMenu(items)));
  tray.setToolTip(`Screening · ${items[0].label}`);
}
let trayTitle = "";
function tickTray() {
  if (!tray || tray.isDestroyed() || process.platform !== "darwin") return;
  const current = interview?.state;
  const title =
    current?.recording && current.startedAt
      ? formatElapsed(Date.now() - current.startedAt)
      : "";
  if (title === trayTitle) return;
  trayTitle = title;
  tray.setTitle(title, { fontType: "monospacedDigit" });
}

app
  .whenReady()
  .then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    // The notch and call-audio helpers run together while the menu and the
    // engine are set up; Buddy's first look still knows the call audio answer.
    const firstPlacement = placeBuddy();
    const callAudioRead = readCallAudio();
    ipcMain.handle("lab:state", (event) =>
      event.senderFrame === engine?.webContents.mainFrame
        ? engineSnapshot(snapshot())
        : lightSnapshot(snapshot()),
    );
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        callback(
          permission === "media" &&
            ((contents === engine?.webContents &&
              details.mediaTypes?.every((t) => t === "audio")) ||
              // A window capture asks for media with no camera or microphone.
              (buddyPicking(contents) && !details.mediaTypes?.length)),
        );
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        permission === "media" &&
        ((contents === engine?.webContents && details.mediaType === "audio") ||
          buddyPicking(contents)),
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        if (
          process.platform !== "win32" ||
          request.frame !== engine?.webContents.mainFrame ||
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
      // On macOS 15+ Buddy's snapshots go through the system window picker.
      { useSystemPicker: true },
    );
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: /^https?:|^wss?:/.test(details.url) }),
    );
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Screening",
          submenu: [
            { label: "Show Buddy", click: ask },
            { type: "separator" },
            {
              label: "Test Screen Sharing Protection…",
              click: attempt(captureTest),
            },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        { role: "editMenu" },
      ]),
    );

    engine = create("engine.html", {
      title: "Screening audio engine",
      width: 320,
      height: 200,
      skipTaskbar: true,
      focusable: false,
    });
    const [buddyBounds] = await Promise.all([firstPlacement, callAudioRead]);
    buddy = create("buddy.html", {
      title: "Screening — Buddy",
      ...buddyBounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // The meeting app keeps keyboard focus until a Buddy text field is used.
      focusable: false,
      acceptFirstMouse: true,
      // Frameless windows may then sit over the menu bar, next to the notch.
      enableLargerThanScreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      type: process.platform === "darwin" ? "panel" : undefined,
    });
    buddy.setAlwaysOnTop(true, "screen-saver");
    buddy.setIgnoreMouseEvents(true, { forward: true });
    if (process.platform === "darwin")
      buddy.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === "darwin") {
      buddyPresentation = require("./services/protected-presentation.cjs").protectPresentation(
        buddy, helperPath("protected-presentation.node"), report,
      );
      buddyPresentation.setProtection(state.protection);
    }
    buddy.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        setHidden(true);
      }
    });
    buddy.on("blur", () => {
      if (alive(buddy) && buddy.isFocusable()) buddy.setFocusable(false);
    });
    for (const event of [
      "display-metrics-changed",
      "display-added",
      "display-removed",
    ])
      screen.on(event, () => placeBuddy().then(publish).catch(console.error));
    buddy.webContents.on("did-finish-load", publish);

    interview = await require("./services/interview.cjs").createInterview(
      app,
      publish,
      () => undefined,
      {
        windowCapture:
          new (require("./services/window-capture.cjs").WindowCapture)(() => [
            buddy.getMediaSourceId(),
            ...(buddyPresentation ? [buddyPresentation.getMediaSourceId()] : []),
            engine.getMediaSourceId(),
          ]),
        getNotes: () => state.notes,
        onLevel: publishAudioLevel,
        createSpeechWorker,
      },
    );
    // Saved settings may say Buddy floats somewhere; place it there now.
    await placeBuddy();
    audioRouting = new (require("./services/audio-routing.cjs").AudioRouting)(
      (command) => engine.webContents.send("audio:command", command),
    );

    tray = new Tray(trayImage(false));
    trayRecording = false;
    // Windows opens tray menus with a right-click; a left-click toggles Buddy.
    if (process.platform === "win32")
      tray.on("click", () => setHidden(!state.hidden));
    setInterval(tickTray, 1000);

    const shortcuts = [
      ["buddy", KEYS.buddy, () => setHidden(!state.hidden)],
      ["ask", KEYS.ask, ask],
      ["answer", KEYS.answer, attempt(() => interview.request("answer", ""))],
      ["listen", KEYS.listen, attempt(toggleListening)],
    ];
    for (const [action, accelerator, handler] of shortcuts)
      state.shortcuts.push({
        action,
        accelerator,
        registered: globalShortcut.register(accelerator, handler),
      });

    // Only Buddy and the engine can use the local bridge; only the engine owns audio.
    const ownFrame = (event) =>
      [buddy, engine].some(
        (w) => alive(w) && event.senderFrame === w.webContents.mainFrame,
      );
    const fromEngine = (event) =>
      event.senderFrame === engine.webContents.mainFrame;
    ipcMain.handle("lab:change", (event, key, value) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      return change(key, value);
    });
    ipcMain.handle("lab:action", (event, name) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      if (name === "hide") return setHidden(true);
      throw new Error("Unsupported action.");
    });
    // Outside the island, clicks pass through to the apps below.
    ipcMain.on("buddy:mouse", (event, inside) => {
      if (event.senderFrame !== buddy.webContents.mainFrame || state.testing)
        return;
      buddy.setIgnoreMouseEvents(!inside, { forward: true });
    });
    ipcMain.on("buddy:drag", (event, phase) => {
      if (event.senderFrame !== buddy.webContents.mainFrame || state.testing)
        return;
      if (phase === "start") startDrag();
      else endDrag(true).catch(report);
    });
    ipcMain.on("buddy:keyboard", (event, on) => {
      if (event.senderFrame !== buddy.webContents.mainFrame) return;
      on ? takeKeyboard() : releaseKeyboard();
    });
    ipcMain.on("audio:level", (event, value) => {
      if (
        fromEngine(event) &&
        interview.state.recording &&
        typeof value === "number"
      )
        publishAudioLevel(value);
    });
    ipcMain.handle("audio:complete", (event, id, error) => {
      if (!fromEngine(event)) throw new Error("Untrusted audio owner");
      audioRouting.complete(id, error);
    });
    ipcMain.handle("interview:request", async (event, op, payload) => {
      if (!ownFrame(event)) throw new Error("Untrusted frame");
      if (op === "audio-start") return audio("start", payload);
      if (op === "allow-access") return allowAccess();
      if (op === "pick-window") {
        if (event.senderFrame !== buddy?.webContents.mainFrame)
          throw new Error("Only Buddy can take a snapshot.");
        pickingUntil = Date.now() + 120000;
        return;
      }
      if (op === "window-image") pickingUntil = 0;
      if (op === "audio-stop") return audio("stop");
      if (["recording", "stop", "audio-error"].includes(op)) {
        if (!fromEngine(event))
          throw new Error("Only the audio engine can do this.");
        if (op === "audio-error") {
          interview.state.error = String(payload).slice(0, 500);
          publish();
          return;
        }
      }
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
      if (!fromEngine(event)) throw new Error("Untrusted frame");
      return interview.audio(buffer);
    });
    await Promise.all(
      [buddy, engine].map(
        (win) =>
          new Promise((resolve) =>
            win.webContents.isLoading()
              ? win.webContents.once("did-finish-load", resolve)
              : resolve(),
          ),
      ),
    );
    publish();
    if (!verification) ask();
    if (verification) {
      await delay(800);
      await require("./verify.cjs")({
        app,
        buddy,
        buddyPresentation,
        engine,
        tray,
        interview,
        state,
        audioControl,
        keyboard,
        artifactDir,
        layout: () => buddyLayout,
        publish,
        change,
        setHidden,
        ask,
        audio,
        runCapture,
        permission,
        setDock,
        access,
        delay,
      });
      if (!process.argv.includes("--keep-open")) app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
app.on("before-quit", () => {
  quitting = true;
  buddyPresentation?.stop();
  audioRouting?.close();
  interview?.close();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
for (const event of ["activate", "second-instance"])
  app.on(event, () => {
    if (alive(buddy)) ask();
  });
