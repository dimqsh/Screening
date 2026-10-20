const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { LiveSpeech } = require("../src/services/live-speech.cjs");
const { Transcription } = require("../src/services/transcription.cjs");
const { SPEECH_MODELS } = require("../src/services/speech-model.cjs");
const { createResampler } = require("../src/segmenter.js");
const { hasLiveSpeech } = require("../src/services/macos.cjs");
const { trayMenu } = require("../src/tray-menu.cjs");
const { deriveBuddy, buddyActivity, speechReady } = require("../src/buddy-model.js");

// A stand-in for the live-speech helper: it answers like the Swift program.
function fakeHelper(script) {
  const runs = [];
  const run = (helper, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.written = [];
    child.stdin.on("data", (chunk) => child.written.push(chunk.length));
    child.say = (line) => child.stdout.write(JSON.stringify(line) + "\n");
    child.exit = (code = 0) => {
      child.exitCode = code;
      setImmediate(() => child.emit("close", code, null));
    };
    child.kill = () => child.exit(null);
    child.stdin.on("finish", () => script.onEnd?.(child));
    runs.push({ args, child });
    setImmediate(() => script.onStart?.(child, args));
    return child;
  };
  return { run, runs };
}
const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("Apple's words arrive as they change, then settle as final text", async () => {
  const helper = fakeHelper({
    onStart: (child) => {
      child.say({ type: "ready", locale: "en-US", model: "speech" });
      child.say({ type: "partial", text: "Ask not" });
      child.say({ type: "partial", text: "Ask not what your" });
    },
    onEnd: (child) => {
      child.say({ type: "final", text: "Ask not what your country can do for you." });
      child.exit(0);
    },
  });
  const live = new LiveSpeech("/bin/live-speech", { run: helper.run });
  const seen = [];
  const ready = await live.start("en", {
    onPartial: (text) => seen.push(["partial", text]),
    onFinal: (text) => seen.push(["final", text]),
  });
  assert.equal(ready.locale, "en-US");
  assert.deepEqual(helper.runs[0].args, ["--locale", "en"]);
  live.write(new Float32Array(1600));
  await wait();
  assert.deepEqual(helper.runs[0].child.written, [6400]);
  await live.stop();
  assert.deepEqual(seen, [
    ["partial", "Ask not"],
    ["partial", "Ask not what your"],
    ["final", "Ask not what your country can do for you."],
  ]);
  assert.equal(live.child, null);
});

test("a language Apple does not support is reported once and remembered", async () => {
  const helper = fakeHelper({
    onStart: (child, args) => {
      child.say(args[1] === "kk" ? { locale: null } : { locale: "ru-RU", model: "dictation", installed: false });
      child.exit(0);
    },
  });
  const live = new LiveSpeech("/bin/live-speech", { run: helper.run });
  assert.equal(await live.check("kk"), null);
  assert.equal(await live.check("kk"), null);
  assert.deepEqual(await live.check("ru"), { locale: "ru-RU", model: "dictation", installed: false });
  assert.equal(helper.runs.length, 2);
});

test("a helper that fails before it is ready rejects with its message", async () => {
  const helper = fakeHelper({
    onStart: (child) => {
      child.stderr.write("Apple's speech recognition does not support kk.\n");
      child.exit(3);
    },
  });
  const live = new LiveSpeech("/bin/live-speech", { run: helper.run });
  await assert.rejects(live.start("kk"), /does not support kk/);
  assert.equal(live.child, null);
});

// A stand-in for LiveSpeech, to test how Transcription chooses an engine.
function fakeLive(info = { locale: "en-US", model: "speech", installed: true }) {
  const live = {
    written: 0,
    installs: [],
    handlers: null,
    check: async () => info,
    install: async (language) => live.installs.push(language),
    start: async (language, handlers) => {
      live.handlers = handlers;
      return { type: "ready" };
    },
    write: (samples) => (live.written += samples.length),
    stop: async () => live.handlers.onFinal("For your country."),
    close() {},
  };
  return live;
}
function transcription(live) {
  const texts = [];
  const sent = [];
  const stt = new Transcription("/tmp/none", () => {}, (text) => texts.push(text), () => {}, SPEECH_MODELS.fast, {
    live,
    createWorker: () => ({ on() {}, postMessage: (m) => sent.push(m), terminate() {} }),
  });
  stt.markDownloaded();
  return { stt, texts, sent };
}
const speech = (seconds) => {
  const out = new Float32Array(16000 * seconds);
  for (let i = 0; i < out.length; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return out;
};

test("listening uses Apple when it has the language, with live words before final ones", async () => {
  const live = fakeLive();
  const { stt, texts } = transcription(live);
  await stt.begin("en");
  assert.equal(stt.state.engine, "apple");
  stt.push(new Float32Array(1600));
  assert.equal(live.written, 1600);
  live.handlers.onPartial("Ask what you");
  assert.equal(stt.state.partial, "Ask what you");
  assert.deepEqual(texts, []);
  live.handlers.onFinal("Ask what you can do.");
  assert.equal(stt.state.partial, "");
  assert.deepEqual(texts, ["Ask what you can do."]);
  await stt.end();
  assert.deepEqual(texts, ["Ask what you can do.", "For your country."]);
  assert.equal(stt.state.engine, null);
  stt.close();
});

test("Whisper listens while Apple downloads a language, and for languages Apple lacks", async () => {
  const downloading = fakeLive({ locale: "ru-RU", model: "dictation", installed: false });
  const { stt, sent } = transcription(downloading);
  await stt.begin("ru");
  assert.equal(stt.state.engine, "whisper");
  assert.deepEqual(downloading.installs, ["ru"]);
  stt.push(speech(2));
  stt.push(new Float32Array(16000));
  assert.equal(downloading.written, 0);
  assert.equal(sent.filter((m) => m.type === "transcribe").length, 1);
  assert.equal(sent.find((m) => m.type === "transcribe").language, "ru");
  await stt.end();
  stt.close();

  const missing = transcription(fakeLive(null));
  await missing.stt.begin("kk");
  assert.equal(missing.stt.state.engine, "whisper");
  await missing.stt.end();
  missing.stt.close();

  const chosen = fakeLive();
  const whisperOnly = transcription(chosen);
  await whisperOnly.stt.begin("en", { live: false });
  assert.equal(whisperOnly.stt.state.engine, "whisper");
  assert.equal(chosen.handlers, null);
  await whisperOnly.stt.end();
  whisperOnly.stt.close();
});

test("an answer asked for mid-sentence waits for Apple to settle the sentence", async () => {
  const live = fakeLive();
  live.settle = () => setImmediate(() => live.handlers.onFinal("How would you scale it?"));
  const { stt, texts } = transcription(live);
  await stt.settle();
  await stt.begin("en");
  live.handlers.onPartial("How would you");
  await stt.settle();
  assert.deepEqual(texts, ["How would you scale it?"]);
  assert.equal(stt.state.partial, "");
  // Nothing pending: no wait.
  live.settle = () => assert.fail("nothing to settle");
  await stt.settle();
  await stt.end();
  stt.close();
});

test("Whisper takes over if Apple's helper stops during a session", async () => {
  const live = fakeLive();
  const { stt, sent } = transcription(live);
  await stt.begin("en");
  live.handlers.onExit(new Error("crashed"));
  assert.equal(stt.state.engine, "whisper");
  assert.match(stt.state.error, /crashed/);
  stt.push(speech(2));
  await stt.end();
  assert.equal(sent.filter((m) => m.type === "transcribe").length, 1);
  stt.close();
});

// A new install: Whisper has not been downloaded.
function withoutWhisper(live) {
  const texts = [];
  const stt = new Transcription("/tmp/none", () => {}, (text) => texts.push(text), () => {}, SPEECH_MODELS.accurate, {
    live,
    createWorker: () => assert.fail("Whisper is not on disk"),
  });
  return { stt, texts };
}
const interviewOf = (stt, settings) => ({
  settings: { speechEngine: "apple", speechLanguage: "en", ...settings },
  whisper: stt.state,
});

test("Apple's live transcription lets a new install listen without Whisper", async () => {
  const live = fakeLive();
  const { stt, texts } = withoutWhisper(live);
  assert.equal(speechReady(interviewOf(stt)), false);
  await stt.checkLive("en");
  assert.equal(speechReady(interviewOf(stt)), true);
  assert.equal(deriveBuddy({ buddy: { enabled: true }, interview: { ...interviewOf(stt), ai: { connected: true } } }).mode, "idle");
  await stt.begin("en");
  assert.equal(stt.state.engine, "apple");
  live.handlers.onFinal("Tell me about yourself.");
  await stt.end();
  assert.deepEqual(texts, ["Tell me about yourself.", "For your country."]);
  stt.close();
});

test("without Whisper, a language or choice Apple cannot serve sends setup back to Whisper", async () => {
  const kazakh = withoutWhisper(fakeLive(null));
  await kazakh.stt.checkLive("kk");
  assert.equal(speechReady(interviewOf(kazakh.stt, { speechLanguage: "kk" })), false);
  await assert.rejects(kazakh.stt.begin("kk"), /Download the speech model before listening/);
  kazakh.stt.close();

  const english = withoutWhisper(fakeLive());
  await english.stt.checkLive("en");
  assert.equal(speechReady(interviewOf(english.stt, { speechEngine: "whisper" })), false);
  await assert.rejects(english.stt.begin("en", { live: false }), /Download the speech model/);
  english.stt.close();

  // Windows and macOS before 26 have no live transcription at all.
  const older = withoutWhisper(null);
  assert.equal(await older.stt.checkLive("en"), null);
  assert.equal(speechReady(interviewOf(older.stt)), false);
  older.stt.close();
});

test("if Apple stops mid-session without Whisper, Buddy says so once and stays quiet", async () => {
  const live = fakeLive();
  const { stt, texts } = withoutWhisper(live);
  await stt.begin("en");
  live.handlers.onExit(new Error("crashed"));
  assert.equal(stt.state.engine, null);
  assert.match(stt.state.error, /Apple speech stopped: crashed/);
  assert.match(stt.state.error, /Whisper/);
  const error = stt.state.error;
  stt.push(speech(2));
  stt.push(new Float32Array(16000));
  await wait();
  assert.equal(stt.state.error, error);
  assert.equal(live.written, 0);
  await stt.end();
  assert.deepEqual(texts, []);
  stt.close();
});

test("an Apple language download shows progress from its start", async () => {
  let finish;
  const live = fakeLive({ locale: "es-ES", model: "speech", installed: false });
  live.install = () => new Promise((resolve) => (finish = resolve));
  const { stt } = withoutWhisper(live);
  await stt.checkLive("es", { install: true });
  assert.equal(stt.state.liveProgress, 0);
  live.check = async () => ({ locale: "es-ES", model: "speech", installed: true });
  finish();
  await wait();
  assert.equal(stt.state.liveProgress, null);
  assert.equal(speechReady(interviewOf(stt, { speechLanguage: "es" })), true);
  stt.close();
});

test("audio comes down to 16 kHz as one continuous signal across chunks", () => {
  for (const rate of [48000, 44100]) {
    const resample = createResampler(rate);
    const input = new Float32Array(rate);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 100 * i) / rate);
    const out = [];
    for (let i = 0; i < input.length; i += 4096) out.push(...resample(input.subarray(i, i + 4096)));
    assert.ok(Math.abs(out.length - 16000) <= 1, `${rate}: ${out.length} samples`);
    let error = 0;
    for (let j = 0; j < out.length; j++) error = Math.max(error, Math.abs(out[j] - Math.sin((2 * Math.PI * 100 * j) / 16000)));
    assert.ok(error < 0.001, `${rate}: error ${error}`);
  }
});

test("live transcription needs macOS 26", () => {
  assert.equal(hasLiveSpeech("darwin", "24.6.0"), false);
  assert.equal(hasLiveSpeech("darwin", "25.0.0"), true);
  assert.equal(hasLiveSpeech("darwin", "27.0.0"), true);
  assert.equal(hasLiveSpeech("win32", "10.0.26100"), false);
});

function menu(whisper, settings) {
  return trayMenu(
    {
      interview: {
        settings: { speechLanguage: "en", speechEngine: "apple", ...settings },
        whisper: { ready: true, ...whisper },
        ai: { connected: true },
      },
    },
    "darwin",
  );
}
const submenu = (items) => items.find((item) => item.label === "Transcription");
test("the menu offers Apple's live transcript on Macs that have it", () => {
  assert.equal(submenu(menu({ liveSupported: false })), undefined);
  const live = submenu(menu({ liveSupported: true, live: { language: "en", installed: true } }));
  assert.equal(live.submenu[0].id, "setting:speechEngine:apple");
  assert.equal(live.submenu[0].checked, true);
  assert.equal(live.submenu.at(-1).label, "English Is Live");
  const kazakh = submenu(menu({ liveSupported: true, live: null }, { speechLanguage: "kk" }));
  assert.equal(kazakh.submenu.at(-1).label, "Kazakh Uses Whisper");
  const russian = submenu(
    menu({ liveSupported: true, live: { language: "ru", installed: false }, liveProgress: 0.4 }, { speechLanguage: "ru" }),
  );
  assert.equal(russian.submenu.at(-1).label, "Downloading Russian for Live… 40%");
  const whisper = submenu(menu({ liveSupported: true }, { speechEngine: "whisper" }));
  assert.equal(whisper.submenu.length, 2);
  assert.equal(whisper.submenu[1].checked, true);
  assert.equal(submenu(menu({ liveSupported: true }, {})).enabled, true);
});

test("Buddy shows Apple's words while they are spoken, and only while listening", () => {
  const view = (recording) =>
    deriveBuddy({
      buddy: { enabled: true },
      interview: {
        recording,
        startedAt: 0,
        transcript: [{ id: 1, text: "Tell me about yourself." }],
        messages: [],
        whisper: { ready: true, partial: "What was the hardest" },
        ai: { connected: true, busy: false },
      },
    });
  const hear = buddyActivity(view(true)).find((row) => row.key === "hear");
  assert.match(hear.text, /What was the hardest/);
  assert.equal(hear.active, true);
  assert.equal(view(false).partial, "");
  assert.match(view(false).lastLine, /Tell me about yourself/);
  const long = deriveBuddy({
    buddy: { enabled: true },
    interview: {
      recording: true,
      transcript: [],
      messages: [],
      whisper: { ready: true, partial: "Walk me through how you would design a rate limiter for a public API" },
      ai: { connected: true, busy: false },
    },
  });
  const newest = buddyActivity(long).find((row) => row.key === "hear").text;
  assert.match(newest, /^“….*public API”$/);
});
