const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { safeStorage, dialog } = require("electron");
const { Assistant } = require("./assistant.cjs");
const { Transcription } = require("./transcription.cjs");
const { LiveSpeech } = require("./live-speech.cjs");
const { hasAudioTap, hasLiveSpeech } = require("./macos.cjs");
const {
  modelFiles,
  speechModel,
  defaultModelKey,
  SPEECH_MODELS,
} = require("./speech-model.cjs");
const LANGUAGE_CODES = [
  "auto",
  "ru",
  "en",
  "kk",
  "es",
  "fr",
  "de",
  "zh",
  "ja",
  "uk",
  "tr",
];
async function createInterview(
  app,
  publish,
  parent,
  {
    windowCapture,
    getNotes = () => "",
    onLevel = () => {},
    onDraft = () => {},
    createSpeechWorker,
  } = {},
) {
  // English by default for new installs; saved choices from older versions win.
  const settings = {
    speechLanguage: "en",
    answerLanguage: "en",
    autoAnswer: false,
    style: "concise",
    answerSpeed: "fast",
    context: "",
    interviewType: "general",
    notesEnabled: true,
    includeNotes: false,
    source: "system",
    // Apple's live transcription where macOS has it for the language.
    speechEngine: "apple",
    speechModel: defaultModelKey(),
    dock: "notch",
    position: null,
    accessPrompted: false,
  };
  const location = path.join(app.getPath("userData"), "settings.json");
  try {
    const saved = JSON.parse(await fs.readFile(location, "utf8"));
    for (const k of [
      "speechLanguage",
      "answerLanguage",
      "autoAnswer",
      "style",
      "answerSpeed",
      "interviewType",
      "notesEnabled",
      "includeNotes",
      "source",
      "speechEngine",
      "speechModel",
      "dock",
      "position",
      "accessPrompted",
    ])
      if (validSetting(k, saved[k])) settings[k] = saved[k];
    if (saved.contextEncrypted && safeStorage.isEncryptionAvailable())
      settings.context = safeStorage.decryptString(
        Buffer.from(saved.contextEncrypted, "base64"),
      );
  } catch {
    /* First launch has no settings. */
  }
  let autoTimer = null,
    sessionId = 0,
    closed = false;
  const state = {
    settings,
    transcript: [],
    messages: [],
    draft: "",
    attachment: null,
    recording: false,
    source: null,
    error: null,
    startedAt: null,
  };
  const update = () => {
    if (!closed) publish();
  };
  let activeTurn = null;
  let messageId = 0;
  const ai = new Assistant((value) => {
    if (activeTurn) {
      activeTurn.text = value.answer;
      activeTurn.status = value.busy
        ? "pending"
        : ai.canceled
          ? "stopped"
          : value.error
            ? "error"
            : "done";
      activeTurn.error = value.error;
    }
    update();
  }, {
    // Screening's own Codex home, outside the per-run test data, so answers
    // never load the person's Codex config, plugins, MCP servers or hooks.
    home:
      process.env.SCREENING_CODEX_HOME ||
      path.join(app.getPath("appData"), "Capture Lab", "codex"),
  });
  state.ai = ai.state;
  const helper = (name) =>
    app.isPackaged
      ? path.join(process.resourcesPath, "bin", name)
      : path.join(__dirname, "..", "..", "bin", name);
  const live =
    hasLiveSpeech() && existsSync(helper("live-speech"))
      ? new LiveSpeech(helper("live-speech"))
      : null;
  const whisper = new Transcription(
    process.env.CAPTURE_LAB_MODEL_CACHE ||
      path.join(app.getPath("userData"), "models"),
    (s) => {
      if (s.source === "system") state.recording = s.recording;
      update();
    },
    (text) => {
      state.transcript.push({
        id: ++sessionId,
        text,
        time: new Date().toISOString(),
      });
      if (state.transcript.length > 120) state.transcript.shift();
      update();
      clearTimeout(autoTimer);
      // Phrases now arrive as people pause, so a pause alone is not the end of
      // a question. A question mark answers almost at once; otherwise Buddy
      // waits a little longer for more speech.
      if (settings.autoAnswer)
        autoTimer = setTimeout(
          () => {
            if (!ai.state.busy && ai.state.connected && !state.attachment)
              answer("").catch((e) => {
                state.error = e.message;
                update();
              });
          },
          /[?？]\s*$/.test(text) ? 600 : 2500,
        );
    },
    onLevel,
    speechModel(settings.speechModel),
    { createWorker: createSpeechWorker, live },
  );
  state.whisper = whisper.state;
  const listenOptions = () => ({ live: settings.speechEngine === "apple" });
  // A model already on disk counts as ready; it loads into memory on first use.
  async function markIfDownloaded() {
    try {
      for (const file of modelFiles(whisper.cacheDir, whisper.model))
        await fs.access(file);
      whisper.markDownloaded();
    } catch {
      /* Setup offers the download. */
    }
  }
  await ai.status();
  await markIfDownloaded();
  // What Apple offers for the speech language; the menu shows it.
  whisper.checkLive(settings.speechLanguage).catch(() => {});
  let saveQueue = Promise.resolve();
  async function save() {
    const { context, ...saved } = settings;
    if (context && safeStorage.isEncryptionAvailable())
      saved.contextEncrypted = safeStorage
        .encryptString(context)
        .toString("base64");
    saveQueue = saveQueue.then(async () => {
      await fs.mkdir(path.dirname(location), { recursive: true });
      await fs.writeFile(location + ".tmp", JSON.stringify(saved), {
        mode: 0o600,
      });
      await fs.rename(location + ".tmp", location);
    });
    return saveQueue;
  }
  function validSetting(key, value) {
    if (["speechLanguage", "answerLanguage"].includes(key))
      return LANGUAGE_CODES.includes(value);
    if (key === "source") return ["system", "microphone"].includes(value);
    if (key === "speechEngine") return ["apple", "whisper"].includes(value);
    if (key === "speechModel") return Object.hasOwn(SPEECH_MODELS, value);
    if (key === "dock") return ["notch", "float"].includes(value);
    if (key === "position")
      return (
        value !== null &&
        typeof value === "object" &&
        [value.x, value.y].every(
          (n) => Number.isFinite(n) && Math.abs(n) < 100000,
        )
      );
    if (["autoAnswer", "notesEnabled", "includeNotes", "accessPrompted"].includes(key))
      return typeof value === "boolean";
    if (key === "interviewType")
      return [
        "general",
        "coding",
        "system",
        "behavioral",
        "case",
        "hr",
      ].includes(value);
    if (key === "style") return ["concise", "detailed"].includes(value);
    if (key === "answerSpeed") return ["fast", "best"].includes(value);
    if (key === "context")
      return typeof value === "string" && value.length <= 16000;
    return false;
  }
  // The question is what was said in the last 45 seconds, at most 10 phrases.
  function recentSpeech() {
    const last = state.transcript.at(-1);
    if (!last) return "";
    const since = Date.parse(last.time) - 45000;
    return state.transcript
      .slice(-10)
      .filter((t) => Date.parse(t.time) >= since)
      .map((t) => t.text)
      .join("\n");
  }
  async function answer(question) {
    state.error = null;
    clearTimeout(autoTimer);
    if (typeof question !== "string" || question.length > 16000)
      throw new Error("Invalid question");
    if (ai.state.busy) throw new Error("Stop the current answer first.");
    if (!ai.state.connected) throw new Error("Sign in with ChatGPT first.");
    const attachment = state.attachment;
    if (!question.trim() && !attachment) await whisper.settle();
    const input =
      question.trim() ||
      (attachment
        ? "Help me answer the task in this screenshot."
        : recentSpeech());
    if (!input)
      throw new Error(
        "Type a question, record speech, or attach a window screenshot first.",
      );
    const history = state.messages
      .filter((m) => m.status !== "error" && m.text)
      .map(({ role, text }) => ({ role, text }));
    const time = new Date().toISOString();
    state.messages.push({
      id: ++messageId,
      role: "user",
      text: input,
      time,
      attachment: attachment
        ? { name: attachment.name, dataUrl: attachment.dataUrl }
        : null,
    });
    activeTurn = {
      id: ++messageId,
      role: "assistant",
      text: "",
      time,
      status: "pending",
      error: null,
    };
    state.messages.push(activeTurn);
    if (state.messages.length > 60)
      state.messages.splice(0, state.messages.length - 60);
    // Bound image memory while keeping the text history useful for follow-ups.
    const images = state.messages.filter((m) => m.attachment?.dataUrl);
    for (const old of images.slice(0, -6)) delete old.attachment.dataUrl;
    state.attachment = null;
    update();
    try {
      return await ai.answer({
        question: input,
        context: settings.context,
        language: settings.answerLanguage,
        style: settings.style,
        speed: settings.answerSpeed,
        history,
        interviewType: settings.interviewType,
        notes: settings.notesEnabled && settings.includeNotes ? getNotes() : "",
        image: attachment
          ? Buffer.from(attachment.dataUrl.split(",")[1], "base64")
          : null,
      });
    } catch (error) {
      activeTurn.status = "error";
      activeTurn.error = error.message;
      throw error;
    } finally {
      if (activeTurn.status === "pending")
        activeTurn.status = ai.canceled ? "stopped" : "done";
      activeTurn = null;
      update();
    }
  }
  async function request(op, payload) {
    if (op === "draft") {
      if (typeof payload !== "string" || payload.length > 16000)
        throw new Error("Invalid draft");
      state.draft = payload;
      onDraft(payload);
      return;
    }
    if (op === "setting") {
      if (!payload || !validSetting(payload.key, payload.value))
        throw new Error("Invalid setting");
      if (
        ["speechModel", "speechEngine", "speechLanguage"].includes(payload.key) &&
        state.recording
      )
        throw new Error("Stop listening to change how speech is transcribed.");
      settings[payload.key] = payload.value;
      await save();
      if (
        payload.key === "speechModel" &&
        whisper.setModel(speechModel(payload.value))
      )
        await markIfDownloaded();
      // Choosing a language Apple supports downloads it for next time.
      if (["speechLanguage", "speechEngine"].includes(payload.key))
        await whisper.checkLive(settings.speechLanguage, {
          install: settings.speechEngine === "apple",
        });
      update();
      return;
    }
    if (op === "windows") return windowCapture.list();
    if (op === "window-capture") {
      if (ai.state.busy)
        throw new Error("Stop the answer before attaching a screenshot.");
      const attachment = await windowCapture.capture(payload);
      state.attachment = attachment;
      update();
      return;
    }
    if (op === "window-image") {
      if (ai.state.busy)
        throw new Error("Stop the answer before attaching a screenshot.");
      state.attachment = windowCapture.fromImage(payload);
      update();
      return;
    }
    if (op === "remove-attachment") {
      state.attachment = null;
      update();
      return;
    }
    if (op === "model") return whisper.load();
    if (op === "login") return ai.login();
    if (op === "account") return ai.status();
    if (op === "answer") return answer(payload || "");
    if (op === "cancel") {
      if (activeTurn) activeTurn.status = "stopped";
      return ai.cancel();
    }
    if (op === "clear") {
      if (ai.state.busy) throw new Error("Stop the answer first.");
      clearTimeout(autoTimer);
      whisper.clear();
      state.transcript = [];
      state.messages = [];
      state.draft = "";
      state.attachment = null;
      state.error = null;
      ai.update({ answer: "", question: "", error: null });
      update();
      return;
    }
    if (op === "recording") {
      const active = typeof payload === "boolean" ? payload : payload?.active;
      const source =
        typeof payload === "boolean" ? "microphone" : payload?.source;
      if (
        typeof active !== "boolean" ||
        (active && !["microphone", "system"].includes(source))
      )
        throw new Error("Invalid recording state");
      if (active && !whisper.state.ready)
        throw new Error("Load Whisper first.");
      if (active) await whisper.begin(settings.speechLanguage, listenOptions());
      else await whisper.end();
      // Whisper loads only when this session needs it.
      whisper.keepWarm(active && whisper.state.engine === "whisper");
      state.recording = active;
      state.source = active ? source : null;
      state.startedAt = active ? Date.now() : state.startedAt;
      update();
      return;
    }
    if (op === "system-start") {
      if (state.recording) throw new Error("Stop the current recording first.");
      state.source = "system";
      state.startedAt = Date.now();
      // A Core Audio tap needs only System Audio Recording; ScreenCaptureKit,
      // used before macOS 14.2, needs screen recording.
      await whisper.startNative(
        helper(hasAudioTap() ? "audio-tap" : "audio-sck"),
        settings.speechLanguage,
        listenOptions(),
      );
      whisper.keepWarm(whisper.state.engine === "whisper");
      return;
    }
    if (op === "stop") {
      await whisper.stop();
      whisper.keepWarm(false);
      state.recording = false;
      state.source = null;
      update();
      return;
    }
    if (op === "export") {
      const result = await dialog.showSaveDialog(parent(), {
        defaultPath: `interview-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!result.canceled && result.filePath) {
        const text = state.transcript
          .map((t) => `[${t.time}] ${t.text}`)
          .join("\n\n");
        await fs.writeFile(
          result.filePath,
          text +
            "\n\n" +
            state.messages
              .map(
                (m) =>
                  `${m.role === "user" ? "You" : "Screening"}:\n${m.text}${m.attachment ? `\n[Window screenshot: ${m.attachment.name}]` : ""}`,
              )
              .join("\n\n") +
            (settings.notesEnabled ? `\n\nNotes:\n${getNotes()}` : ""),
        );
      }
      return;
    }
    throw new Error("Unknown interview operation");
  }
  return {
    state,
    request,
    audio: (buffer) => {
      if (!state.recording) throw new Error("Recording is stopped.");
      if (!(buffer instanceof ArrayBuffer))
        throw new Error("Invalid audio buffer");
      whisper.push(new Float32Array(buffer));
    },
    close() {
      closed = true;
      clearTimeout(autoTimer);
      whisper.close();
      ai.close();
    },
  };
}
module.exports = { createInterview };
