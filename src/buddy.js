// Buddy: the whole app, driven by the shared interview snapshot.
const api = window.captureLab;
const { deriveBuddy, listTurns, buddyMood, buddyActivity } = window.buddyModel;
const $ = (id) => document.getElementById(id);
const island = $("island");
const panel = $("panel");
const reading = $("answer");
const input = $("question-input");
const bars = [...document.querySelectorAll("#wave i")];
const faces = [...document.querySelectorAll(".face")];
const CHIP_LABELS = { system: "Call audio", microphone: "Microphone" };
const FIELDS = "#question-input, #notes, #context";
const BAR_GAIN = [0.5, 0.82, 1, 0.74, 0.46];
const HOVER_OPEN_MS = 220;
const HOVER_CLOSE_MS = 500;
const ANSWER_OPEN_MS = 60000;
const SETUP_OPEN_MS = 30000;
const LABELS = {
  setup: "Set up Screening",
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking…",
  answer: "Answer ready",
  error: "No answer",
};

let current = null;
let view = null;
let turns = [];
let tab = "answer";
let turnIndex = null;
let pointerInside = false;
let hovered = false;
let pinned = false;
let composing = false;
let picking = false;
let suppressed = false;
let hoverTimer = null;
let leaveTimer = null;
let autoUntil = 0;
let seenTurn = null;
let mutedTurn = null;
let lastMode = null;
let dismissedId = null;
let setupGreeted = false;
let stick = true;
let answerKey = "";
let answerTurnId = null;
let transcriptKey = "";
let lastIssue = null;
let contextDirty = false;
let notesTimer = null;
let notesDirty = false;
let flash = { text: "", until: 0 };

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
// Buddy refreshes every second; these write to the page only when a value
// changes, so an idle Buddy costs no style or paint work.
function show(el, visible) {
  if (el.hidden === visible) el.hidden = !visible;
}
function attr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function prop(el, key, value) {
  if (el[key] !== value) el[key] = value;
}
function setVar(el, name, value) {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}
const mac = () => (current?.platform || "darwin") === "darwin";
const combo = (keys) =>
  mac()
    ? keys.replace("Ctrl ", "⌘").replace("Shift ", "⇧").replace("Enter", "↩")
    : keys.replaceAll(" ", "+");

// The same light formatting as before: paragraphs, bold, inline code, fences.
function renderAnswer(target, text, pending) {
  target.replaceChildren();
  for (const block of text.split(/(```[\s\S]*?(?:```|$))/g)) {
    if (!block) continue;
    if (block.startsWith("```")) {
      const newline = block.indexOf("\n");
      let code = newline > -1 ? block.slice(newline + 1) : block.slice(3);
      if (code.endsWith("```")) code = code.slice(0, -3);
      const pre = document.createElement("pre");
      const content = document.createElement("code");
      content.textContent = code.replace(/\n$/, "");
      pre.append(content);
      target.append(pre);
      continue;
    }
    for (const paragraph of block.split(/\n\s*\n/)) {
      if (!paragraph.trim()) continue;
      const p = document.createElement("p");
      for (const token of paragraph.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
        if (token.startsWith("**") && token.endsWith("**")) {
          const strong = document.createElement("strong");
          strong.textContent = token.slice(2, -2);
          p.append(strong);
        } else if (token.startsWith("`") && token.endsWith("`")) {
          const code = document.createElement("code");
          code.textContent = token.slice(1, -1);
          p.append(code);
        } else p.append(document.createTextNode(token));
      }
      target.append(p);
    }
  }
  if (pending) {
    const caret = document.createElement("span");
    caret.className = "caret";
    (target.lastElementChild?.tagName === "P"
      ? target.lastElementChild
      : target
    ).append(caret);
  }
  if (stick) target.scrollTop = target.scrollHeight;
}
reading.addEventListener("scroll", () => {
  stick = reading.scrollHeight - reading.scrollTop - reading.clientHeight < 28;
});

// Opening rules: hover, pin, typing and the picker open the full island; a new
// answer opens a quiet reading view on its own.
function manual() {
  return pinned || hovered || composing || picking;
}
function isOpen() {
  if (suppressed && !composing) return false;
  const now = Date.now();
  const auto = seenTurn !== mutedTurn && now < autoUntil;
  return manual() || auto || now < flash.until;
}
function layout() {
  const open = isOpen();
  island.classList.toggle("open", open);
  island.classList.toggle(
    "glance",
    open && !manual() && view?.mode !== "setup",
  );
  attr(island, "data-hover", String(hovered));
  attr(island, "data-pinned", String(pinned));
  const bar = current?.buddy?.layout?.notchHeight || 30;
  const height = open
    ? Math.min(bar + panel.offsetHeight, window.innerHeight - 80)
    : bar;
  setVar(island, "--h", `${Math.round(height)}px`);
}
new ResizeObserver(layout).observe(panel);

function bloom() {
  island.classList.remove("bloom");
  void island.offsetWidth;
  island.classList.add("bloom");
}
island.addEventListener("animationend", (event) => {
  if (event.animationName === "bloom") island.classList.remove("bloom");
});

function followAnswers(next) {
  const shown = ["thinking", "answer", "error"].includes(next.mode);
  const live =
    next.mode === "thinking" || (next.mode === "answer" && next.answerPending);
  if (!shown) {
    autoUntil = 0;
    seenTurn = null;
  } else {
    const turn = next.answerId ?? "busy";
    if (turn !== seenTurn) {
      seenTurn = turn;
      stick = true;
      suppressed = false;
      // A new answer brings the Answer tab forward unless you are typing elsewhere.
      if (!composing || document.activeElement === input) tab = "answer";
      turnIndex = null;
      autoUntil = live ? Infinity : Date.now() + ANSWER_OPEN_MS;
    } else if (live) autoUntil = Infinity;
    else if (autoUntil === Infinity) autoUntil = Date.now() + ANSWER_OPEN_MS;
  }
  if (next.mode === "answer" && lastMode !== "answer") bloom();
  if (next.mode === "setup" && !setupGreeted) {
    setupGreeted = true;
    flash = { text: "", until: Date.now() + SETUP_OPEN_MS };
  }
  lastMode = next.mode;
}

function keys(target) {
  const platform = String(current?.platform);
  if (target.dataset.platform === platform) return;
  target.dataset.platform = platform;
  const rows = [
    [combo("Ctrl Shift Enter"), "answer what was just said"],
    [combo("Ctrl Shift Space"), "ask"],
    [combo("Ctrl Shift L"), "listen"],
    [combo("Ctrl Shift B"), "show or hide Buddy"],
  ];
  target.replaceChildren(
    ...rows.map(([keysText, label]) => {
      const item = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = keysText;
      item.append(kbd, document.createTextNode(label));
      return item;
    }),
  );
}

function activeView() {
  if (view?.mode === "setup") return "setup";
  if (picking) return "picker";
  return tab;
}

function renderAnswerView() {
  const thinkingWithoutTurn = view.mode === "thinking" && !turns.length;
  const index =
    turnIndex === null
      ? turns.length - 1
      : Math.min(turnIndex, turns.length - 1);
  const turn = turns[index];
  show($("empty"), !turn && !thinkingWithoutTurn);
  setText(
    $("empty-text"),
    `Type below, or press ${combo("Ctrl Shift Enter")} and Buddy answers what the interviewer just said.`,
  );
  const question = turn
    ? turn.question + (turn.attachment ? `  ·  ${turn.attachment}` : "")
    : "";
  setText($("question"), question);
  show($("question"), Boolean(question));
  const waiting =
    thinkingWithoutTurn || (turn?.status === "pending" && !turn.answer);
  show($("shimmer"), waiting);
  const failed = turn && !turn.answer && turn.status === "error";
  const stopped = turn && !turn.answer && turn.status === "stopped";
  show(reading, Boolean(turn && (turn.answer || failed || stopped)));
  reading.classList.toggle("failed", Boolean(failed || stopped));
  const key = turn
    ? `${turn.id}:${turn.status}:${turn.answer}:${turn.error}`
    : "";
  if (key !== answerKey) {
    answerKey = key;
    // Follow a streaming answer; start a finished one from its first line.
    if (turn && turn.id !== answerTurnId) {
      answerTurnId = turn.id;
      stick = turn.status === "pending";
      reading.scrollTop = 0;
    }
    if (turn?.answer) renderAnswer(reading, turn.answer, turn.status === "pending");
    else if (failed) reading.textContent = turn.error || "Buddy could not answer. Try again.";
    else if (stopped) reading.textContent = "You stopped this answer.";
    else reading.replaceChildren();
  }
  show($("answer-foot"), Boolean(turn?.answer) || turns.length > 1);
  show($("copy"), Boolean(turn?.answer));
  show($("turns"), turns.length > 1);
  setText($("turn-count"), turn ? `${index + 1} of ${turns.length}` : "");
  prop($("prev"), "disabled", Boolean(index <= 0));
  prop($("next"), "disabled", Boolean(index >= turns.length - 1));
  prop($("copy"), "disabled", Boolean(!turn?.answer));
}

function renderTranscript() {
  const transcript = current.interview.transcript || [];
  const key = JSON.stringify(transcript.map((item) => item.id));
  if (key === transcriptKey) return;
  transcriptKey = key;
  const target = $("transcript");
  if (!transcript.length) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = current.interview.recording
      ? "Listening. The first line appears in a few seconds."
      : "Nothing heard yet. Press Call audio or Microphone to start.";
    target.replaceChildren(empty);
    return;
  }
  target.replaceChildren(
    ...transcript.map((item) => {
      const row = document.createElement("div");
      row.className = "line";
      const time = document.createElement("time");
      time.textContent = new Date(item.time).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
      const text = document.createElement("p");
      text.textContent = item.text;
      row.append(time, text);
      return row;
    }),
  );
  target.scrollTop = target.scrollHeight;
}

function downloadSize() {
  const mb = current?.speechModel?.downloadMB;
  if (!mb) return "";
  return mb >= 1000 ? ` ${(mb / 1000).toFixed(1)} GB` : ` ${mb} MB`;
}

function renderSetup() {
  const whisper = current.interview.whisper;
  const ai = current.interview.ai;
  $("step-model").classList.toggle("done", Boolean(whisper.ready));
  $("step-account").classList.toggle("done", Boolean(ai.connected));
  show($("model"), !whisper.ready);
  prop($("model"), "disabled", Boolean(whisper.status === "loading"));
  setText(
    $("model"),
    whisper.status === "loading" ? "Downloading…" : "Download",
  );
  const progress = $("model-progress");
  show(progress, whisper.status === "loading");
  progress.classList.toggle("indeterminate", !Number.isFinite(whisper.progress));
  if (Number.isFinite(whisper.progress))
    setVar(progress, "--progress", `${whisper.progress}%`);
  setText(
    $("model-text"),
    whisper.ready
      ? "Ready. Speech stays on this computer."
      : `Turns the call into text on this computer. One${downloadSize()} download.`,
  );
  show($("login"), !ai.connected);
  prop($("login"), "disabled", Boolean(ai.status === "signing-in"));
  setText($("login"), ai.status === "signing-in" ? "Waiting…" : "Sign in");
  setText(
    $("account-text"),
    ai.connected
      ? "Signed in. Answers use your ChatGPT plan."
      : ai.status === "signing-in"
        ? "Finish signing in in your browser, then come back."
        : "Answers come from your ChatGPT plan. Sign in once in your browser.",
  );
  keys($("setup-keys"));
}

function render(snapshot) {
  if (!snapshot) return;
  current = snapshot;
  const testing = snapshot.testCard && snapshot.testWindow === "buddy";
  show($("test-view"), testing);
  show(island, !testing);
  const interview = snapshot.interview;
  if (!interview) return;

  const geometry = snapshot.buddy?.layout;
  if (geometry) {
    setVar(island, "--notch-w", `${geometry.notchWidth}px`);
    setVar(island, "--notch-h", `${geometry.notchHeight}px`);
    setVar(island, "--notch-left", `${geometry.notchLeft}px`);
    island.classList.toggle("notched", geometry.hasNotch);
  }

  view = deriveBuddy(snapshot, { dismissedId });
  turns = listTurns(interview.messages || []);
  followAnswers(view);
  const mode = view.mode;
  attr(island, "data-mode", mode);
  island.classList.toggle("active", mode !== "idle" || view.recording);
  island.classList.toggle("recording", view.recording);
  island.classList.toggle("streaming", view.answerPending);
  if (!view.recording) setLevel(0);

  const label =
    mode === "answer" && view.answerPending ? "Answering…" : LABELS[mode] || "Ready";
  setText($("label"), label);
  setText($("title"), label);
  setText($("meta"), view.recording ? view.elapsed : "");
  setText($("timer"), view.elapsed);
  const shield = $("shield");
  attr(shield, "data-protected", String(view.protection));
  const shieldTitle = view.protection
    ? "Hidden from screen sharing"
    : "Visible to screen sharing";
  prop(shield, "title", shieldTitle);
  attr(shield, "aria-label", shieldTitle);

  const pinTitle = pinned ? "Hide automatically" : "Keep open";
  for (const id of ["orb", "pin"]) {
    attr($(id), "aria-pressed", String(pinned));
    prop($(id), "title", pinTitle);
    attr($(id), "aria-label", pinTitle);
  }
  prop($("dismiss"), "title", "Close");
  attr($("dismiss"), "aria-label", "Close");

  const settings = interview.settings;
  // Buddy's face and what it is doing
  const mood = buddyMood(view);
  for (const face of faces)
    if (!face.closest(".setup-hero")) attr(face, "data-mood", mood);
  for (const row of buddyActivity(view)) {
    const item = document.querySelector(`#activity [data-step="${row.key}"]`);
    item.classList.toggle("active", row.active);
    setText(item.querySelector("span"), row.text);
  }

  // Listening chips: each starts its own source; the live one stops it.
  const audioBusy = Boolean(snapshot.audioControl?.busy);
  for (const chip of document.querySelectorAll("[data-source]")) {
    const live = interview.recording && interview.source === chip.dataset.source;
    chip.classList.toggle("live", live);
    prop(
      chip,
      "disabled",
      Boolean(
        audioBusy ||
          !interview.whisper.ready ||
          (interview.recording && !live),
      ),
    );
    setText(
      chip.querySelector(".chip-label"),
      live
        ? audioBusy
          ? "Finishing…"
          : "Stop"
        : audioBusy && chip.dataset.source === interview.settings.source
          ? "Starting…"
          : CHIP_LABELS[chip.dataset.source],
    );
  }
  show($("hero"), mode !== "setup");
  const protection = $("protection");
  attr(protection, "data-protected", String(view.protection));
  prop(protection, "title", shieldTitle);
  attr(protection, "aria-label", shieldTitle);

  // Views
  const active = activeView();
  for (const section of document.querySelectorAll(".view"))
    section.classList.toggle("active", section.id === `view-${active}`);
  show($("tabs"), active !== "setup");
  for (const button of document.querySelectorAll("[data-tab]"))
    attr(button, "aria-selected", String(button.dataset.tab === tab));
  prop($("new-session"), "disabled", Boolean(interview.ai.busy || !interview.messages.length));
  show($("composer"), mode !== "setup");
  if (active === "setup") renderSetup();
  if (active === "answer") renderAnswerView();
  renderTranscript();
  prop($("answer-now"), "disabled", Boolean(interview.ai.busy || !interview.ai.connected || !interview.transcript.length));
  // Unsaved notes are never overwritten by a snapshot that has not caught up.
  if (!notesDirty && document.activeElement !== $("notes"))
    prop($("notes"), "value", snapshot.notes);
  prop($("includeNotes"), "checked", Boolean(settings.includeNotes));
  if (!contextDirty && document.activeElement !== $("context"))
    prop($("context"), "value", settings.context || "");

  // Composer
  const attachment = interview.attachment;
  show($("attachment"), Boolean(attachment));
  if (attachment) {
    const preview = attachment.preview || "";
    if ($("attachment-image").getAttribute("src") !== preview)
      $("attachment-image").src = preview;
    setText($("attachment-name"), attachment.name);
  }
  prop($("send"), "disabled", Boolean(interview.ai.busy || !interview.ai.connected));
  prop($("snapshot"), "disabled", Boolean(interview.ai.busy));

  // Errors from the shared state show once, inside the island.
  const issue = interview.error || interview.ai.error || interview.whisper.error;
  if (issue && issue !== lastIssue) {
    lastIssue = issue;
    if (!turns.some((turn) => turn.error === issue)) notify(issue);
  } else if (!issue) lastIssue = null;
  const flashing = Date.now() < flash.until && flash.text;
  show($("toast"), Boolean(flashing));
  if (flashing) setText($("toast"), flash.text);

  layout();
}

let levelNow = -1;
function setLevel(value) {
  if (value === levelNow) return;
  levelNow = value;
  setVar(island, "--level", value.toFixed(3));
  bars.forEach((bar, i) => {
    const jitter = value > 0.01 ? 0.75 + Math.random() * 0.5 : 1;
    const height = 3 + Math.min(11, value * 16 * BAR_GAIN[i] * jitter);
    bar.style.height = `${height.toFixed(1)}px`;
  });
}
api.onLevel((value) => {
  if (current?.interview?.recording) setLevel(Math.max(0, Math.min(1, value)));
});

function notify(message) {
  flash = { text: message, until: Date.now() + 6000 };
  render(current);
  setTimeout(() => render(current), 6100);
}
const safe =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (error) {
      notify(error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
  };

// Pointer: the island takes clicks only while the pointer is over it.
function setInside(inside) {
  if (inside === pointerInside) return;
  pointerInside = inside;
  api.buddyMouse(inside);
  clearTimeout(hoverTimer);
  clearTimeout(leaveTimer);
  if (inside)
    hoverTimer = setTimeout(() => {
      hovered = true;
      render(current);
    }, HOVER_OPEN_MS);
  else
    leaveTimer = setTimeout(() => {
      hovered = false;
      suppressed = false;
      render(current);
    }, HOVER_CLOSE_MS);
}
document.addEventListener("mousemove", (event) =>
  setInside(Boolean(event.target.closest?.("#island"))),
);
document.addEventListener("mouseleave", () => setInside(false));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  clearTimeout(hoverTimer);
  clearTimeout(leaveTimer);
  pointerInside = false;
  hovered = false;
  suppressed = false;
});

// Keyboard: Buddy asks for focus only while one of its text fields is in use.
function startTyping(field) {
  if (!composing) {
    composing = true;
    suppressed = false;
    api.keyboard(true);
    render(current);
  }
  requestAnimationFrame(() => field.focus());
}
function stopTyping() {
  if (!composing) return;
  composing = false;
  api.keyboard(false);
  render(current);
}
document.addEventListener("pointerdown", (event) => {
  const field = event.target.closest?.(FIELDS);
  if (field) startTyping(field);
});
document.addEventListener("focusout", () =>
  setTimeout(() => {
    if (!document.activeElement?.matches?.(FIELDS)) stopTyping();
  }, 0),
);
api.onAsk(() => {
  picking = false;
  tab = "answer";
  startTyping(input);
});

function insertText(field, text) {
  const start = field.selectionStart,
    end = field.selectionEnd;
  const room = field.maxLength - (field.value.length - (end - start));
  field.setRangeText(text.slice(0, Math.max(0, room)), start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
// A non-activating panel cannot rely on the app's Edit menu, so the usual
// clipboard keys are handled here through the local bridge.
document.addEventListener("keydown", (event) => {
  const field = event.target.closest?.(FIELDS);
  if (!field) return;
  const modifier = mac() ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    event.preventDefault();
    field.blur();
    return;
  }
  if (field === input && key === "enter" && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    $("composer").requestSubmit();
    return;
  }
  if (!modifier || event.altKey) return;
  if (key === "v") {
    event.preventDefault();
    safe(async () => insertText(field, await api.request("clipboard-read")))();
  } else if (key === "c" || key === "x") {
    const selected = field.value.slice(field.selectionStart, field.selectionEnd);
    if (!selected) return;
    event.preventDefault();
    safe(async () => {
      await api.request("clipboard-write", selected);
      if (key === "x") insertText(field, "");
    })();
  } else if (key === "a") {
    event.preventDefault();
    field.select();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
});

// Actions
function togglePin() {
  pinned = !pinned;
  if (pinned) suppressed = false;
  else hovered = pointerInside;
  render(current);
}
$("orb").addEventListener("click", togglePin);
$("pin").addEventListener("click", togglePin);
$("dismiss").addEventListener("click", () => {
  if (view && (view.mode === "answer" || view.mode === "error"))
    dismissedId = view.answerId;
  if (view?.mode === "thinking") mutedTurn = seenTurn;
  pinned = false;
  hovered = false;
  picking = false;
  autoUntil = 0;
  flash.until = 0;
  suppressed = true;
  if (composing) document.activeElement?.blur();
  render(current);
});
for (const button of document.querySelectorAll("[data-tab]"))
  button.addEventListener("click", () => {
    tab = button.dataset.tab;
    picking = false;
    render(current);
  });
// Each chip listens to its own source, so there is no separate source switch.
for (const chip of document.querySelectorAll("[data-source]"))
  chip.addEventListener(
    "click",
    safe(() =>
      current.interview.recording
        ? api.request("audio-stop")
        : api.request("audio-start", chip.dataset.source),
    ),
  );
$("model").addEventListener(
  "click",
  safe(() => api.request("model")),
);
$("login").addEventListener(
  "click",
  safe(() => api.request("login")),
);
$("new-session").addEventListener(
  "click",
  safe(async () => {
    input.value = "";
    turnIndex = null;
    await api.request("clear");
  }),
);
$("prev").addEventListener("click", () => {
  const index = turnIndex === null ? turns.length - 1 : turnIndex;
  turnIndex = Math.max(0, index - 1);
  stick = false;
  reading.scrollTop = 0;
  render(current);
});
$("next").addEventListener("click", () => {
  const index = (turnIndex === null ? turns.length - 1 : turnIndex) + 1;
  turnIndex = index >= turns.length - 1 ? null : index;
  reading.scrollTop = 0;
  render(current);
});
$("copy").addEventListener(
  "click",
  safe(async () => {
    const index = turnIndex === null ? turns.length - 1 : turnIndex;
    const text = turns[index]?.answer;
    if (!text) return;
    await api.request("clipboard-write", text);
    setText($("copy-label"), "Copied");
    setTimeout(() => setText($("copy-label"), "Copy"), 1600);
  }),
);
$("answer-now").addEventListener(
  "click",
  safe(() => api.request("answer", "")),
);
$("notes").addEventListener("input", () => {
  notesDirty = true;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(
    safe(async () => {
      const value = $("notes").value;
      await api.change("notes", value);
      if ($("notes").value === value) notesDirty = false;
    }),
    250,
  );
});
$("includeNotes").addEventListener(
  "change",
  safe((event) =>
    api.request("setting", { key: "includeNotes", value: event.target.checked }),
  ),
);
$("context").addEventListener("input", () => {
  contextDirty = true;
  setText($("context-status"), "Not saved yet.");
});
$("save-context").addEventListener(
  "click",
  safe(async () => {
    await api.request("setting", { key: "context", value: $("context").value });
    contextDirty = false;
    setText($("context-status"), "Saved and encrypted on this computer.");
  }),
);
$("paste").addEventListener(
  "click",
  safe(async () => {
    const text = await api.request("clipboard-read");
    startTyping(input);
    insertText(input, text);
  }),
);
$("composer").addEventListener(
  "submit",
  safe(async (event) => {
    event.preventDefault();
    const interview = current.interview;
    if (interview.ai.busy) throw new Error("Buddy is still answering.");
    if (!interview.ai.connected) throw new Error("Sign in with ChatGPT first.");
    const question = input.value.trim();
    if (!question && !interview.attachment && !interview.transcript.length)
      throw new Error("Type a question, snapshot a window, or start listening.");
    input.value = "";
    input.style.height = "";
    tab = "answer";
    turnIndex = null;
    input.blur();
    try {
      await api.request("answer", question);
    } catch (error) {
      if (!input.value) input.value = question;
      throw error;
    }
  }),
);

// Window snapshots
let pickerBusy = false;
async function loadWindows() {
  const list = $("window-list");
  list.replaceChildren();
  setText($("picker-status"), "Finding windows…");
  try {
    const sources = await api.request("windows");
    for (const source of sources) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "window-option";
      button.title = source.name;
      const img = document.createElement("img");
      img.src = source.thumbnail;
      img.alt = "";
      const name = document.createElement("span");
      name.textContent = source.name;
      button.append(img, name);
      button.addEventListener(
        "click",
        safe(async () => {
          if (pickerBusy) return;
          pickerBusy = true;
          setText($("picker-status"), "Taking the snapshot…");
          try {
            await api.request("window-capture", source.id);
            picking = false;
            startTyping(input);
          } finally {
            pickerBusy = false;
            render(current);
          }
        }),
      );
      list.append(button);
    }
    setText(
      $("picker-status"),
      sources.length
        ? "Nothing is sent until you send your next message."
        : "No windows found. Open the window you need, then try again.",
    );
  } catch (error) {
    setText($("picker-status"), error.message);
  }
  layout();
}
$("snapshot").addEventListener(
  "click",
  safe(async () => {
    picking = true;
    render(current);
    await loadWindows();
  }),
);
$("close-picker").addEventListener("click", () => {
  picking = false;
  render(current);
});
$("remove-attachment").addEventListener(
  "click",
  safe(() => api.request("remove-attachment")),
);

// Buddy blinks now and then. Each blink is one short transform.
function blink() {
  if (!document.hidden && current)
    for (const face of faces) face.classList.add("blink");
  setTimeout(() => faces.forEach((face) => face.classList.remove("blink")), 140);
  setTimeout(blink, 3200 + Math.random() * 3800);
}
setTimeout(blink, 2500);

// While the pointer is on Buddy, its eyes look toward it.
const LOOKING = new Set(["idle", "listening", "happy"]);
let lookFrame = 0;
function look(event) {
  if (lookFrame) return;
  lookFrame = requestAnimationFrame(() => {
    lookFrame = 0;
    for (const face of faces) {
      const box = face.getBoundingClientRect();
      if (!event || !pointerInside || !box.width || !LOOKING.has(face.dataset.mood)) {
        face.style.removeProperty("--look-x");
        face.style.removeProperty("--look-y");
        continue;
      }
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const length = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, length / 160) * 0.06;
      face.style.setProperty("--look-x", `${((dx / length) * reach).toFixed(3)}em`);
      face.style.setProperty("--look-y", `${((dy / length) * reach).toFixed(3)}em`);
    }
  });
}
document.addEventListener("mousemove", look);
document.addEventListener("mouseleave", () => look(null));

// Keeps the timer moving and closes the island when an answer's minute is up.
setInterval(() => {
  if (current) render(current);
}, 1000);
api.subscribe(render);
api
  .state()
  .then(render)
  .catch((error) => notify(error.message));
