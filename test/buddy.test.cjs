const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNotch,
  estimateNotch,
  islandLayout,
  floatingLayout,
} = require("../src/services/notch.cjs");
const {
  deriveBuddy,
  formatElapsed,
  listTurns,
  buddyMood,
  buddyActivity,
} = require("../src/buddy-model.js");
const { trayMenu, findItem } = require("../src/tray-menu.cjs");

const notched = {
  id: 1,
  internal: true,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 945 },
};
const plain = {
  id: 2,
  internal: false,
  bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -175, width: 1920, height: 1055 },
};

test("helper output with a notch becomes a notch rectangle", () => {
  const notch = parseNotch(
    '{"hasNotch":true,"notch":{"x":666,"y":0,"width":180,"height":32}}',
  );
  assert.deepEqual(notch, { hasNotch: true, x: 666, width: 180, height: 32 });
});
test("helper output without a notch and invalid output are handled", () => {
  assert.deepEqual(parseNotch('{"hasNotch":false}'), { hasNotch: false });
  assert.equal(parseNotch("not json"), null);
  assert.equal(parseNotch('{"hasNotch":true,"notch":{"width":"x"}}'), null);
});
test("a tall menu bar on an internal Mac display implies a centered notch", () => {
  const notch = estimateNotch(notched, "darwin");
  assert.equal(notch.hasNotch, true);
  assert.equal(notch.width, 180);
  assert.equal(notch.height, 32);
  assert.equal(notch.x, (1512 - 180) / 2);
});
test("external displays, short menu bars and Windows have no notch", () => {
  assert.equal(estimateNotch(plain, "darwin").hasNotch, false);
  assert.equal(
    estimateNotch(
      { ...notched, workArea: { ...notched.workArea, y: 25 } },
      "darwin",
    ).hasNotch,
    false,
  );
  assert.equal(estimateNotch(notched, "win32").hasNotch, false);
});
test("island window is centered on the notch at the top of the display", () => {
  const { window, layout } = islandLayout({
    display: notched,
    notch: { hasNotch: true, x: 666, width: 180, height: 32 },
  });
  assert.equal(window.y, 0);
  assert.equal(window.width, 760);
  assert.equal(window.height, 660);
  assert.equal(window.x + window.width / 2, 666 + 90);
  assert.equal(layout.hasNotch, true);
  assert.equal(layout.notchWidth, 180);
  assert.equal(layout.notchHeight, 32);
  assert.equal(layout.notchLeft, (760 - 180) / 2);
});
test("without a notch the island is a pill centered on the display", () => {
  const { window, layout } = islandLayout({
    display: plain,
    notch: { hasNotch: false },
  });
  assert.equal(window.y, -200);
  assert.equal(window.x + window.width / 2, -1920 + 960);
  assert.equal(layout.hasNotch, false);
  assert.equal(layout.notchWidth, 0);
  assert.equal(layout.notchHeight, 30);
});
test("island window shrinks to fit a narrow display", () => {
  const { window } = islandLayout({
    display: { ...plain, bounds: { x: 10, y: 0, width: 500, height: 300 } },
    notch: { hasNotch: false },
  });
  assert.equal(window.width, 500);
  assert.equal(window.height, 300);
  assert.equal(window.x, 10);
});

function snapshot(overrides = {}) {
  const base = {
    buddy: { enabled: true },
    protection: true,
    interview: {
      settings: { locale: "en" },
      recording: false,
      startedAt: null,
      transcript: [],
      messages: [],
      whisper: { ready: true },
      ai: { connected: true, busy: false },
    },
  };
  return {
    ...base,
    ...overrides,
    interview: { ...base.interview, ...(overrides.interview || {}) },
  };
}

test("buddy is off when the switch is off", () => {
  assert.equal(deriveBuddy(snapshot({ buddy: { enabled: false } })).mode, "off");
});
test("buddy asks for setup until Whisper and the account are ready", () => {
  assert.equal(
    deriveBuddy(snapshot({ interview: { whisper: { ready: false } } })).mode,
    "setup",
  );
  assert.equal(
    deriveBuddy(snapshot({ interview: { ai: { connected: false, busy: false } } }))
      .mode,
    "setup",
  );
});
test("buddy is idle when ready and quiet", () => {
  const view = deriveBuddy(snapshot());
  assert.equal(view.mode, "idle");
  assert.equal(view.recording, false);
  assert.equal(view.elapsed, "00:00");
});
test("buddy listens while recording and reports the elapsed time", () => {
  const view = deriveBuddy(
    snapshot({
      interview: {
        recording: true,
        startedAt: 1000,
        transcript: [{ text: "first" }, { text: "Tell me about a conflict" }],
      },
    }),
    { now: 1000 + 83 * 1000 },
  );
  assert.equal(view.mode, "listening");
  assert.equal(view.recording, true);
  assert.equal(view.elapsed, "01:23");
  assert.equal(view.lastLine, "Tell me about a conflict");
});
test("buddy thinks when an answer was requested and no text has arrived", () => {
  const view = deriveBuddy(
    snapshot({
      interview: {
        recording: true,
        ai: { connected: true, busy: true },
        messages: [
          { id: 1, role: "user", text: "What is a queue?" },
          { id: 2, role: "assistant", text: "", status: "pending" },
        ],
      },
    }),
  );
  assert.equal(view.mode, "thinking");
  assert.equal(view.question, "What is a queue?");
});
test("buddy shows the latest answer while it streams and after it completes", () => {
  const streaming = deriveBuddy(
    snapshot({
      interview: {
        ai: { connected: true, busy: true },
        messages: [
          { id: 1, role: "user", text: "What is a queue?" },
          { id: 2, role: "assistant", text: "A queue is", status: "pending" },
        ],
      },
    }),
  );
  assert.equal(streaming.mode, "answer");
  assert.equal(streaming.answerPending, true);
  assert.equal(streaming.answer, "A queue is");
  assert.equal(streaming.answerId, 2);
  const done = deriveBuddy(
    snapshot({
      interview: {
        recording: true,
        messages: [
          { id: 1, role: "user", text: "What is a queue?" },
          { id: 2, role: "assistant", text: "A queue is FIFO.", status: "done" },
        ],
      },
    }),
  );
  assert.equal(done.mode, "answer");
  assert.equal(done.answerPending, false);
  assert.equal(done.recording, true);
});
test("a dismissed answer gives way to listening or idle", () => {
  const messages = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "A", status: "done" },
  ];
  assert.equal(
    deriveBuddy(snapshot({ interview: { messages, recording: true } }), {
      dismissedId: 2,
    }).mode,
    "listening",
  );
  assert.equal(
    deriveBuddy(snapshot({ interview: { messages } }), { dismissedId: 2 }).mode,
    "idle",
  );
});
test("a failed answer is reported until dismissed", () => {
  const messages = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "", status: "error", error: "Sign in" },
  ];
  const view = deriveBuddy(snapshot({ interview: { messages } }));
  assert.equal(view.mode, "error");
  assert.equal(view.error, "Sign in");
  assert.equal(
    deriveBuddy(snapshot({ interview: { messages } }), { dismissedId: 2 }).mode,
    "idle",
  );
});
test("elapsed time formats minutes and seconds and never goes negative", () => {
  assert.equal(formatElapsed(0), "00:00");
  assert.equal(formatElapsed(59999), "00:59");
  assert.equal(formatElapsed(3600000), "60:00");
  assert.equal(formatElapsed(-5), "00:00");
});

test("setup reports download progress and a pending browser sign-in", () => {
  const view = deriveBuddy(
    snapshot({
      interview: {
        whisper: { ready: false, status: "loading", progress: 42 },
        ai: { connected: false, busy: false, status: "signing-in" },
      },
    }),
  );
  assert.equal(view.mode, "setup");
  assert.equal(view.modelLoading, true);
  assert.equal(view.modelProgress, 42);
  assert.equal(view.signingIn, true);
});
test("conversation turns pair each question with its answer", () => {
  const turns = listTurns([
    { id: 1, role: "user", text: "Q1", attachment: { name: "Editor" } },
    { id: 2, role: "assistant", text: "A1", status: "done" },
    { id: 3, role: "user", text: "Q2" },
    { id: 4, role: "assistant", text: "", status: "pending" },
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((turn) => [turn.question, turn.answer, turn.status, turn.id]),
    [
      ["Q1", "A1", "done", 2],
      ["Q2", "", "pending", 4],
    ],
  );
  assert.equal(turns[0].attachment, "Editor");
  assert.deepEqual(listTurns([]), []);
});

function menuState(overrides = {}) {
  const s = snapshot(overrides);
  return {
    ...s,
    buddyVisible: overrides.buddyVisible ?? true,
    audioControl: { busy: false, ...(overrides.audioControl || {}) },
    interview: {
      ...s.interview,
      settings: {
        interviewType: "general",
        style: "concise",
        autoAnswer: false,
        includeNotes: false,
        speechLanguage: "en",
        answerLanguage: "en",
        source: "system",
        ...(overrides.interview?.settings || {}),
      },
    },
  };
}
const labels = (items) =>
  items.flatMap((item) => [item.label, ...labels(item.submenu || [])]);

test("menu offers both listening sources when ready and quiet", () => {
  const menu = trayMenu(menuState(), "darwin");
  assert.equal(menu[0].label, "Ready");
  assert.equal(menu[0].enabled, false);
  assert.equal(findItem(menu, "listen-system").enabled, true);
  assert.equal(findItem(menu, "listen-system").label, "Listen to Call Audio");
  assert.equal(
    findItem(menu, "listen-system").accelerator,
    "CommandOrControl+Shift+L",
  );
  assert.equal(findItem(menu, "listen-microphone").accelerator, undefined);
  assert.equal(findItem(menu, "stop"), null);
  assert.equal(findItem(menu, "quit").label, "Quit Screening");
  assert.ok(!labels(menu).some((label) => /[а-яё]/i.test(label || "")));
});
test("menu offers Stop Listening while recording", () => {
  const menu = trayMenu(
    menuState({ interview: { recording: true, source: "microphone" } }),
    "darwin",
  );
  assert.equal(findItem(menu, "stop").label, "Stop Listening");
  assert.equal(findItem(menu, "listen-system"), null);
  assert.equal(menu[0].label, "Listening to your microphone");
});
test("menu blocks listening and answering until setup is done", () => {
  const menu = trayMenu(
    menuState({
      interview: {
        whisper: { ready: false, status: "idle" },
        ai: { connected: false, busy: false, status: "signed-out" },
      },
    }),
    "darwin",
  );
  assert.match(menu[0].label, /Finish setup/);
  assert.equal(findItem(menu, "listen-system").enabled, false);
  assert.equal(findItem(menu, "answer").enabled, false);
  assert.equal(findItem(menu, "model").label, "Download Speech Model…");
  assert.equal(findItem(menu, "model").enabled, true);
  assert.equal(findItem(menu, "login").label, "Sign In with ChatGPT…");
});
test("menu shows model download progress and a signed-in account", () => {
  const menu = trayMenu(
    menuState({
      interview: { whisper: { ready: false, status: "loading", progress: 42 } },
    }),
    "darwin",
  );
  assert.equal(findItem(menu, "model").label, "Downloading Speech Model… 42%");
  assert.equal(findItem(menu, "model").enabled, false);
  assert.equal(findItem(menu, "login").label, "Signed In to ChatGPT");
  assert.equal(findItem(menu, "login").enabled, false);
});
test("menu settings reflect the saved choices", () => {
  const menu = trayMenu(
    menuState({
      protection: false,
      buddyVisible: false,
      interview: {
        settings: { interviewType: "coding", autoAnswer: true, style: "detailed" },
      },
    }),
    "darwin",
  );
  assert.equal(findItem(menu, "setting:interviewType:coding").checked, true);
  assert.equal(findItem(menu, "setting:interviewType:general").checked, false);
  assert.equal(findItem(menu, "setting:style:detailed").checked, true);
  assert.equal(findItem(menu, "setting:autoAnswer").checked, true);
  assert.equal(findItem(menu, "setting:speechLanguage:en").checked, true);
  assert.equal(findItem(menu, "protection").checked, false);
  assert.equal(findItem(menu, "toggle-buddy").label, "Show Buddy");
});

const {
  modelFiles,
  SPEECH_MODEL,
  SPEECH_MODELS,
  defaultModelKey,
  speechModel,
} = require("../src/services/speech-model.cjs");
const { Transcription } = require("../src/services/transcription.cjs");
test("model files follow the dtype naming used by Transformers.js", () => {
  const base = modelFiles("/cache", { id: "onnx-community/whisper-base", dtype: "q8" });
  // Paths use the platform separator, so the expected files are joined too.
  const { join } = require("node:path");
  const onnx = join("/cache", "onnx-community", "whisper-base", "onnx");
  assert.deepEqual(base, [
    join(onnx, "encoder_model_quantized.onnx"),
    join(onnx, "decoder_model_merged_quantized.onnx"),
  ]);
  const q4 = modelFiles("/cache", { id: "onnx-community/whisper-small", dtype: "q4" });
  assert.match(q4[0], /whisper-small[\\/]onnx[\\/]encoder_model_q4\.onnx$/);
  assert.throws(() => modelFiles("/cache", { id: "x/y", dtype: "unknown" }));
});
test("the speech model is multilingual and says how big its download is", () => {
  assert.match(SPEECH_MODEL.id, /^onnx-community\/whisper-(?!.*\.en$)/);
  assert.ok(Number.isInteger(SPEECH_MODEL.downloadMB) && SPEECH_MODEL.downloadMB > 0);
  assert.equal(modelFiles("/c").length, 2);
});

test("Apple Silicon with 16 GB or more defaults to the accurate model", () => {
  const GB = 1024 ** 3;
  assert.equal(defaultModelKey("darwin", "arm64", 16 * GB), "accurate");
  assert.equal(defaultModelKey("darwin", "arm64", 18 * GB), "accurate");
  // The accurate model holds about 2.4 GB while listening; on 8 GB it swaps.
  assert.equal(defaultModelKey("darwin", "arm64", 8 * GB), "fast");
  assert.equal(defaultModelKey("darwin", "x64", 32 * GB), "fast");
  assert.equal(defaultModelKey("win32", "x64", 32 * GB), "fast");
  assert.ok(SPEECH_MODELS.accurate.downloadMB > SPEECH_MODELS.fast.downloadMB);
  assert.equal(speechModel("fast"), SPEECH_MODELS.fast);
  assert.equal(speechModel("nonsense"), speechModel(defaultModelKey()));
  for (const model of Object.values(SPEECH_MODELS))
    assert.equal(modelFiles("/c", model).length, 2);
});
test("switching the speech model unloads the old one until the new one loads", () => {
  const changes = [];
  const stt = new Transcription("/tmp/none", (state) => changes.push({ ...state }), () => {}, () => {}, SPEECH_MODELS.fast);
  stt.state.ready = true;
  stt.state.status = "ready";
  assert.equal(stt.setModel(SPEECH_MODELS.fast), false);
  assert.equal(stt.setModel(SPEECH_MODELS.accurate), true);
  assert.equal(stt.model, SPEECH_MODELS.accurate);
  assert.equal(stt.state.ready, false);
  assert.equal(stt.state.status, "idle");
  assert.ok(changes.length);
});
test("menu offers the speech model choice with download sizes", () => {
  const menu = trayMenu(
    menuState({ interview: { settings: { speechModel: "accurate" } } }),
    "darwin",
  );
  const accurate = findItem(menu, "setting:speechModel:accurate");
  assert.equal(accurate.checked, true);
  assert.match(accurate.label, /Accurate.*(MB|GB)/);
  assert.equal(findItem(menu, "setting:speechModel:fast").checked, false);
  const recording = trayMenu(
    menuState({ interview: { recording: true, settings: { speechModel: "fast" } } }),
    "darwin",
  );
  const submenu = recording.find((item) => item.label === "Speech Model");
  assert.equal(submenu.enabled, false);
});

test("model files support a different dtype for encoder and decoder", () => {
  const files = modelFiles("/c", {
    id: "onnx-community/whisper-large-v3-turbo",
    dtype: { encoder_model: "q8", decoder_model_merged: "q4" },
  });
  assert.match(files[0], /encoder_model_quantized\.onnx$/);
  assert.match(files[1], /decoder_model_merged_q4\.onnx$/);
});

// A stand-in for the Whisper worker thread, so loading and unloading can be
// tested without a model.
function fakeWorkers() {
  const created = [];
  const create = () => {
    const worker = {
      messages: [],
      listeners: {},
      terminated: false,
      on(event, fn) {
        this.listeners[event] = fn;
      },
      postMessage(message) {
        this.messages.push(message);
      },
      terminate() {
        this.terminated = true;
      },
      emit(message) {
        this.listeners.message?.(message);
      },
    };
    created.push(worker);
    return worker;
  };
  return { created, create };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a downloaded model is marked ready without loading it into memory", () => {
  const workers = fakeWorkers();
  const stt = new Transcription("/tmp/none", () => {}, () => {}, () => {}, SPEECH_MODELS.fast, {
    createWorker: workers.create,
  });
  stt.markDownloaded();
  assert.equal(stt.state.ready, true);
  assert.equal(stt.loaded, false);
  assert.equal(workers.created.length, 0);
});
test("transcribing loads the model on demand and idle time unloads it", async () => {
  const workers = fakeWorkers();
  const texts = [];
  const stt = new Transcription("/tmp/none", () => {}, (text) => texts.push(text), () => {}, SPEECH_MODELS.fast, {
    createWorker: workers.create,
    idleMs: 30,
  });
  stt.markDownloaded();
  const job = stt.transcribe(new Float32Array(16000));
  assert.equal(workers.created.length, 1);
  const worker = workers.created[0];
  worker.emit({ type: "ready" });
  assert.equal(stt.loaded, true);
  const id = worker.messages.find((m) => m.type === "transcribe").id;
  worker.emit({ type: "text", id, text: "hello" });
  assert.equal(await job, "hello");
  await wait(60);
  assert.equal(worker.terminated, true);
  assert.equal(stt.loaded, false);
  assert.equal(stt.state.ready, true);
  stt.close();
});
test("listening keeps the model warm until it stops", async () => {
  const workers = fakeWorkers();
  const stt = new Transcription("/tmp/none", () => {}, () => {}, () => {}, SPEECH_MODELS.fast, {
    createWorker: workers.create,
    idleMs: 30,
  });
  stt.markDownloaded();
  stt.keepWarm(true);
  assert.equal(workers.created.length, 1);
  workers.created[0].emit({ type: "ready" });
  await wait(60);
  assert.equal(workers.created[0].terminated, false);
  stt.keepWarm(false);
  await wait(60);
  assert.equal(workers.created[0].terminated, true);
  stt.close();
});
test("an unload waits for transcriptions still in progress", async () => {
  const workers = fakeWorkers();
  const stt = new Transcription("/tmp/none", () => {}, () => {}, () => {}, SPEECH_MODELS.fast, {
    createWorker: workers.create,
    idleMs: 20,
  });
  stt.markDownloaded();
  const job = stt.transcribe(new Float32Array(16000));
  const worker = workers.created[0];
  worker.emit({ type: "ready" });
  await wait(50);
  assert.equal(worker.terminated, false);
  const id = worker.messages.find((m) => m.type === "transcribe").id;
  worker.emit({ type: "text", id, text: "" });
  await job;
  await wait(50);
  assert.equal(worker.terminated, true);
  stt.close();
});

const { lightSnapshot, engineSnapshot } = require("../src/services/snapshot.cjs");
test("Buddy's snapshot carries previews and names, not full images", () => {
  const big = "data:image/png;base64," + "A".repeat(2_000_000);
  const value = {
    protection: true,
    interview: {
      recording: false,
      settings: { locale: "en" },
      messages: [
        { id: 1, role: "user", text: "Q", attachment: { name: "Editor", dataUrl: big } },
        { id: 2, role: "assistant", text: "A", status: "done" },
      ],
      attachment: { name: "Terminal", dataUrl: big, preview: "data:image/jpeg;base64,xyz", width: 1600, height: 1000 },
      transcript: [],
    },
  };
  const light = lightSnapshot(value);
  const size = JSON.stringify(light).length;
  assert.ok(size < 10_000, `snapshot is ${size} bytes`);
  assert.equal(light.interview.messages[0].attachment.name, "Editor");
  assert.equal(light.interview.messages[0].attachment.dataUrl, undefined);
  assert.equal(light.interview.attachment.preview, "data:image/jpeg;base64,xyz");
  assert.equal(light.interview.attachment.dataUrl, undefined);
  assert.equal(value.interview.attachment.dataUrl, big);
  assert.deepEqual(engineSnapshot(value), { interview: { recording: false } });
});

test("Buddy's face follows what it is doing", () => {
  const mood = (overrides, options) => buddyMood(deriveBuddy(snapshot(overrides), options));
  assert.equal(mood({ buddy: { enabled: false } }), "sleepy");
  assert.equal(mood({ interview: { whisper: { ready: false } } }), "sleepy");
  assert.equal(mood({}), "idle");
  assert.equal(mood({ interview: { recording: true, startedAt: 1 } }), "listening");
  const pending = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "", status: "pending" },
  ];
  assert.equal(mood({ interview: { messages: pending, ai: { connected: true, busy: true } } }), "thinking");
  const streaming = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "Part", status: "pending" },
  ];
  assert.equal(mood({ interview: { messages: streaming, ai: { connected: true, busy: true } } }), "reading");
  const done = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "All", status: "done" },
  ];
  assert.equal(mood({ interview: { messages: done } }), "happy");
  const failed = [
    { id: 1, role: "user", text: "Q" },
    { id: 2, role: "assistant", text: "", status: "error", error: "x" },
  ];
  assert.equal(mood({ interview: { messages: failed } }), "worried");
});
test("Buddy's activity shows listen, hear and answer with the current step lit", () => {
  const idle = buddyActivity(deriveBuddy(snapshot()));
  assert.deepEqual(idle.map((row) => row.key), ["listen", "hear", "answer"]);
  assert.equal(idle.find((row) => row.active).key, "listen");
  assert.equal(idle[0].text, "Ready to listen");
  const listening = buddyActivity(
    deriveBuddy(
      snapshot({
        interview: {
          recording: true,
          source: "microphone",
          startedAt: 1000,
          transcript: [{ text: "Walk me through your last project" }],
        },
      }),
      { now: 1000 + 65000 },
    ),
  );
  assert.equal(listening[0].text, "Listening to your mic · 01:05");
  assert.match(listening[1].text, /Walk me through your last project/);
  assert.equal(listening.find((row) => row.active).key, "hear");
  const thinking = buddyActivity(
    deriveBuddy(
      snapshot({
        interview: {
          ai: { connected: true, busy: true },
          messages: [
            { id: 1, role: "user", text: "Q" },
            { id: 2, role: "assistant", text: "", status: "pending" },
          ],
        },
      }),
    ),
  );
  assert.equal(thinking[2].text, "Thinking…");
  assert.equal(thinking.find((row) => row.active).key, "answer");
  assert.equal(thinking.filter((row) => row.active).length, 1);
});

test("a floating Buddy starts at the top right and stays fully on screen", () => {
  const display = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 37, width: 1512, height: 945 },
  };
  const first = floatingLayout({ display });
  assert.equal(first.window.width, 520);
  assert.equal(first.window.y, 37 + 24);
  assert.equal(first.window.x + first.window.width, 1512 - 24);
  assert.equal(first.layout.floating, true);
  assert.equal(first.layout.compact, true);
  assert.equal(first.layout.hasNotch, false);
  const placed = floatingLayout({ display, position: { x: 300, y: 200 } });
  assert.deepEqual([placed.window.x, placed.window.y], [300, 200]);
  const offscreen = floatingLayout({ display, position: { x: 5000, y: -400 } });
  assert.equal(offscreen.window.x, 1512 - offscreen.window.width);
  assert.equal(offscreen.window.y, 37);
});
test("narrow screens use the compact layout at the notch too", () => {
  const wide = islandLayout({ display: notched, notch: { hasNotch: true, x: 666, width: 180, height: 32 } });
  assert.equal(wide.layout.compact, false);
  const small = islandLayout({
    display: { ...plain, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 25, width: 1280, height: 775 } },
    notch: { hasNotch: false },
  });
  assert.equal(small.layout.compact, true);
});
test("menu offers floating Buddy and snapping it back", () => {
  const docked = trayMenu(menuState(), "darwin");
  assert.equal(findItem(docked, "toggle-dock").label, "Float Buddy");
  const floating = trayMenu(menuState({ interview: { settings: { dock: "float" } } }), "darwin");
  assert.equal(findItem(floating, "toggle-dock").label, "Snap Buddy to the Notch");
});

test("first run asks once for microphone and call audio access", () => {
  const missing = snapshot({ permissions: { microphone: "not-determined", audio: "denied" } });
  const view = deriveBuddy(missing);
  assert.equal(view.mode, "setup");
  assert.equal(view.needsAccess, true);
  assert.equal(view.needsWhisper, false);
  const asked = snapshot({
    permissions: { microphone: "denied", audio: "denied" },
    interview: { settings: { accessPrompted: true } },
  });
  assert.equal(deriveBuddy(asked).mode, "idle");
  const granted = snapshot({ permissions: { microphone: "granted", audio: "granted" } });
  assert.equal(deriveBuddy(granted).mode, "idle");
  assert.equal(deriveBuddy(snapshot()).needsAccess, false);
});

test("menu offers access while the microphone or call audio is not allowed", () => {
  const missing = trayMenu(
    menuState({ permissions: { microphone: "granted", audio: "denied" } }),
    "darwin",
  );
  assert.equal(findItem(missing, "allow-access").label, "Allow Microphone and Call Audio…");
  const granted = trayMenu(
    menuState({ permissions: { microphone: "granted", audio: "granted" } }),
    "darwin",
  );
  assert.equal(findItem(granted, "allow-access"), null);
  assert.equal(findItem(trayMenu(menuState(), "win32"), "allow-access"), null);
});

const { hasAudioTap, hasSystemPicker } = require("../src/services/macos.cjs");
test("call audio uses a tap from macOS 14.2 and snapshots the picker from macOS 15", () => {
  assert.equal(hasAudioTap("darwin", "23.1.0"), false);
  assert.equal(hasAudioTap("darwin", "23.2.0"), true);
  assert.equal(hasAudioTap("darwin", "27.0.0"), true);
  assert.equal(hasAudioTap("win32", "10.0.26100"), false);
  assert.equal(hasSystemPicker("darwin", "23.6.0"), false);
  assert.equal(hasSystemPicker("darwin", "24.0.0"), true);
  assert.equal(hasSystemPicker("win32", "10.0.26100"), false);
});

const { createSegmenter } = require("../src/segmenter.js");
function tone(seconds, rate = 16000, level = 0.2) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = level * Math.sin((2 * Math.PI * 220 * i) / rate);
  return out;
}
const hush = (seconds, rate = 16000) => new Float32Array(Math.round(seconds * rate));
function phrases(parts, options = {}) {
  const seen = [];
  const segmenter = createSegmenter({ rate: 16000, onSegment: (s) => seen.push(s.length / 16000), ...options });
  // Feed in uneven blocks, as audio arrives in practice.
  for (const part of parts) for (let i = 0; i < part.length; i += 1000) segmenter.push(part.subarray(i, i + 1000));
  return { seen, segmenter };
}
test("live audio is cut into phrases at pauses, not fixed blocks", () => {
  const { seen } = phrases([tone(2), hush(0.8), tone(1.5), hush(0.8)]);
  assert.equal(seen.length, 2);
  assert.ok(seen[0] >= 2 && seen[0] < 3, `first phrase ${seen[0]} s`);
});
test("a short answer ends after a longer pause, and silence alone sends nothing", () => {
  assert.equal(phrases([tone(0.5), hush(0.8)]).seen.length, 0);
  assert.equal(phrases([tone(0.5), hush(1.6)]).seen.length, 1);
  assert.equal(phrases([hush(12)]).seen.length, 0);
});
test("a long stretch of speech is still cut every ten seconds", () => {
  const { seen } = phrases([tone(25)]);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s <= 10.03)); // cut on a 30 ms frame boundary
});
test("stopping sends the speech that is left", () => {
  const { seen, segmenter } = phrases([tone(1)]);
  assert.equal(seen.length, 0);
  segmenter.flush();
  assert.equal(seen.length, 1);
});
