// The menu-bar menu, built from the shared snapshot. Pure, so it is unit tested;
// main.cjs turns item ids into actions.
const { SPEECH_MODELS, formatSize } = require("./services/speech-model.cjs");
const KEYS = {
  listen: "CommandOrControl+Shift+L",
  answer: "CommandOrControl+Shift+Enter",
  ask: "CommandOrControl+Shift+Space",
  buddy: "CommandOrControl+Shift+B",
};
const INTERVIEW_TYPES = [
  ["general", "Any Interview"],
  ["coding", "Coding"],
  ["system", "System Design"],
  ["behavioral", "Behavioral"],
  ["case", "Case or Product"],
  ["hr", "HR or Recruiter"],
];
const ANSWER_LENGTHS = [
  ["concise", "Short and Speakable"],
  ["detailed", "With Explanation"],
];
const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["zh", "Chinese"],
  ["fr", "French"],
  ["de", "German"],
  ["ja", "Japanese"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["kk", "Kazakh"],
  ["tr", "Turkish"],
];

function status(snapshot) {
  const interview = snapshot.interview;
  if (!interview) return "Starting…";
  const missing = [
    !interview.whisper?.ready && "speech model",
    !interview.ai?.connected && "ChatGPT sign-in",
  ].filter(Boolean);
  if (missing.length) return `Finish setup: ${missing.join(" and ")}`;
  if (interview.ai.busy) return "Answering…";
  if (interview.recording)
    return interview.source === "microphone"
      ? "Listening to your microphone"
      : "Listening to call audio";
  return "Ready";
}

function modelItem(whisper = {}) {
  if (whisper.ready)
    return { id: "model", label: "Speech Model Ready", enabled: false };
  if (whisper.status === "loading") {
    const progress = Number.isFinite(whisper.progress)
      ? ` ${Math.round(whisper.progress)}%`
      : "";
    return {
      id: "model",
      label: `Downloading Speech Model…${progress}`,
      enabled: false,
    };
  }
  return { id: "model", label: "Download Speech Model…", enabled: true };
}

function accountItems(ai = {}) {
  if (ai.connected)
    return [{ id: "login", label: "Signed In to ChatGPT", enabled: false }];
  if (ai.status === "signing-in")
    return [
      { id: "login", label: "Waiting for Browser Sign-In…", enabled: false },
    ];
  return [
    { id: "login", label: "Sign In with ChatGPT…", enabled: true },
    { id: "account", label: "Check Sign-In Again" },
  ];
}

function trayMenu(snapshot, platform = process.platform) {
  const interview = snapshot.interview || {};
  const settings = interview.settings || {};
  const ready = Boolean(interview.whisper?.ready);
  const connected = Boolean(interview.ai?.connected);
  const answering = Boolean(interview.ai?.busy);
  const audioBusy = Boolean(snapshot.audioControl?.busy);
  const preferred = settings.source === "microphone" ? "microphone" : "system";
  const radio = (key, options) =>
    options.map(([value, label]) => ({
      id: `setting:${key}:${value}`,
      label,
      type: "radio",
      checked: settings[key] === value,
    }));
  const listening = interview.recording
    ? [
        {
          id: "stop",
          label: "Stop Listening",
          accelerator: KEYS.listen,
          enabled: !audioBusy,
        },
      ]
    : [
        {
          id: "listen-system",
          label: "Listen to Call Audio",
          accelerator: preferred === "system" ? KEYS.listen : undefined,
          enabled: ready && !audioBusy,
        },
        {
          id: "listen-microphone",
          label: "Listen to Microphone",
          accelerator: preferred === "microphone" ? KEYS.listen : undefined,
          enabled: ready && !audioBusy,
        },
      ];
  return [
    { label: status(snapshot), enabled: false },
    { type: "separator" },
    ...listening,
    {
      id: "answer",
      label: "Answer What Was Just Said",
      accelerator: KEYS.answer,
      enabled: connected && !answering,
    },
    { id: "ask", label: "Ask Buddy…", accelerator: KEYS.ask },
    {
      id: "toggle-buddy",
      label: snapshot.buddyVisible ? "Hide Buddy" : "Show Buddy",
      accelerator: KEYS.buddy,
    },
    {
      id: "toggle-dock",
      label: settings.dock === "float" ? "Snap Buddy to the Notch" : "Float Buddy",
    },
    { type: "separator" },
    { label: "Interview Type", submenu: radio("interviewType", INTERVIEW_TYPES) },
    { label: "Answer Length", submenu: radio("style", ANSWER_LENGTHS) },
    {
      id: "setting:autoAnswer",
      label: "Answer Automatically",
      type: "checkbox",
      checked: Boolean(settings.autoAnswer),
    },
    {
      id: "setting:includeNotes",
      label: "Use Notes in Answers",
      type: "checkbox",
      checked: Boolean(settings.includeNotes),
    },
    {
      label: "Speech Language",
      enabled: !interview.recording,
      submenu: radio("speechLanguage", [
        ["auto", "Detect Automatically"],
        ...LANGUAGES,
      ]),
    },
    {
      label: "Answer Language",
      submenu: radio("answerLanguage", [
        ["auto", "Same as the Question"],
        ...LANGUAGES,
      ]),
    },
    {
      label: "Speech Model",
      enabled: !interview.recording && interview.whisper?.status !== "loading",
      submenu: radio(
        "speechModel",
        Object.values(SPEECH_MODELS).map((model) => [
          model.key,
          `${model.label} · ${formatSize(model.downloadMB)}`,
        ]),
      ),
    },
    { type: "separator" },
    {
      id: "protection",
      label: "Hide From Screen Sharing",
      type: "checkbox",
      checked: snapshot.protection !== false,
    },
    {
      id: "capture-test",
      label: "Test Screen Sharing Protection…",
      enabled: !snapshot.testing,
    },
    { type: "separator" },
    ...(snapshot.permissions &&
    (snapshot.permissions.microphone !== "granted" ||
      snapshot.permissions.screen !== "granted")
      ? [{ id: "allow-access", label: "Allow Microphone and Screen…" }]
      : []),
    modelItem(interview.whisper),
    ...accountItems(interview.ai),
    { type: "separator" },
    { id: "export", label: "Export Session…" },
    { id: "clear", label: "New Session", enabled: !answering },
    { type: "separator" },
    {
      id: "quit",
      label: platform === "win32" ? "Exit Screening" : "Quit Screening",
      accelerator: "CommandOrControl+Q",
    },
  ];
}

function findItem(items, id) {
  for (const item of items) {
    if (item.id === id) return item;
    const found = item.submenu && findItem(item.submenu, id);
    if (found) return found;
  }
  return null;
}

module.exports = { trayMenu, findItem, KEYS };
