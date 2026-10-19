// Buddy: reads the shared interview snapshot and shows it at the notch.
const api = window.captureLab;
const { deriveBuddy } = window.buddyModel;
const $ = (id) => document.getElementById(id);
const island = $("island");
const panel = $("panel");
const reading = $("answer");
const bars = [...document.querySelectorAll("#wave i")];
const BAR_GAIN = [0.5, 0.82, 1, 0.74, 0.46];
const HOVER_OPEN_MS = 220;
const HOVER_CLOSE_MS = 500;
const ANSWER_OPEN_MS = 60000;
const LABELS = {
  setup: "buddySetup",
  idle: "buddyIdle",
  listening: "buddyListening",
  thinking: "buddyThinking",
  answer: "buddyAnswer",
  error: "buddyError",
};

let current = null;
let view = null;
let locale = "en";
let pointerInside = false;
let hovered = false;
let pinned = false;
let suppressed = false;
let hoverTimer = null;
let leaveTimer = null;
let autoUntil = 0;
let seenTurn = null;
let lastMode = null;
let dismissedId = null;
let mutedTurn = null;
let stick = true;
let answerKey = "";
let flash = { text: "", until: 0 };
let level = 0;

const t = (key) => window.copy?.[locale]?.[key] || window.copy?.en?.[key] || key;
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function show(el, visible) {
  el.hidden = !visible;
}

// The same light formatting as the chat: paragraphs, bold, inline code, fences.
function renderAnswer(text, pending) {
  reading.replaceChildren();
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
      reading.append(pre);
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
      reading.append(p);
    }
  }
  if (pending) {
    const caret = document.createElement("span");
    caret.className = "caret";
    (reading.lastElementChild?.tagName === "P"
      ? reading.lastElementChild
      : reading
    ).append(caret);
  }
  if (stick) reading.scrollTop = reading.scrollHeight;
}
reading.addEventListener("scroll", () => {
  stick = reading.scrollHeight - reading.scrollTop - reading.clientHeight < 28;
});

function isOpen() {
  if (suppressed) return false;
  const now = Date.now();
  const auto = seenTurn !== mutedTurn && now < autoUntil;
  return pinned || hovered || auto || now < flash.until;
}
function layout() {
  const open = isOpen();
  island.classList.toggle("open", open);
  island.dataset.hover = String(hovered);
  island.dataset.pinned = String(pinned);
  const bar = current?.buddy?.layout?.notchHeight || 30;
  const height = open
    ? Math.min(bar + panel.offsetHeight, window.innerHeight - 28)
    : bar;
  island.style.setProperty("--h", `${Math.round(height)}px`);
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

// New answers open the island on their own; it closes a minute after they finish.
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
      autoUntil = live ? Infinity : Date.now() + ANSWER_OPEN_MS;
    } else if (live) autoUntil = Infinity;
    else if (autoUntil === Infinity) autoUntil = Date.now() + ANSWER_OPEN_MS;
  }
  if (next.mode === "answer" && lastMode !== "answer") bloom();
  lastMode = next.mode;
}

function keys(platform) {
  const mac = platform === "darwin";
  const row = [
    [mac ? "⌘ ⇧ ↩" : "Ctrl Shift Enter", t("buddyKeyAnswer")],
    [mac ? "⌘ ⇧ B" : "Ctrl Shift B", t("buddyKeyHide")],
    [mac ? "⌘ ⇧ H" : "Ctrl Shift H", t("buddyKeyHideAll")],
  ];
  $("keys").replaceChildren(
    ...row.map(([combo, label]) => {
      const item = document.createElement("span");
      const kbd = document.createElement("kbd");
      kbd.textContent = combo;
      item.append(kbd, document.createTextNode(label));
      return item;
    }),
  );
}

function render(snapshot) {
  if (!snapshot) return;
  current = snapshot;
  const settings = snapshot.interview?.settings;
  if (settings?.locale && settings.locale !== locale) locale = settings.locale;
  document.documentElement.lang = locale;

  const testing = snapshot.testCard && snapshot.testWindow === "buddy";
  show($("test-view"), testing);
  show(island, !testing);

  const geometry = snapshot.buddy?.layout;
  if (geometry) {
    island.style.setProperty("--notch-w", `${geometry.notchWidth}px`);
    island.style.setProperty("--notch-h", `${geometry.notchHeight}px`);
    island.style.setProperty("--notch-left", `${geometry.notchLeft}px`);
    island.classList.toggle("notched", geometry.hasNotch);
  }

  view = deriveBuddy(snapshot, { dismissedId });
  followAnswers(view);
  const mode = view.mode;
  island.dataset.mode = mode;
  island.classList.toggle("active", mode !== "idle" || view.recording);
  island.classList.toggle("recording", view.recording);
  island.classList.toggle("streaming", view.answerPending);
  if (!view.recording) setLevel(0);

  const label =
    mode === "answer" && view.answerPending
      ? t("buddyAnswering")
      : t(LABELS[mode] || "buddyIdle");
  setText($("label"), label);
  setText($("title"), label);
  setText($("meta"), view.recording ? view.elapsed : "");
  setText($("timer"), view.elapsed);
  const shield = $("shield");
  shield.dataset.protected = String(view.protection);
  shield.setAttribute(
    "aria-label",
    t(view.protection ? "buddyProtected" : "buddyUnprotected"),
  );
  shield.title = shield.getAttribute("aria-label");

  const orbTitle = t(pinned ? "buddyUnpin" : "buddyPin");
  for (const id of ["orb", "pin"]) {
    $(id).setAttribute("aria-pressed", String(pinned));
    $(id).title = orbTitle;
    $(id).setAttribute("aria-label", orbTitle);
  }
  const dismissTitle = t(
    mode === "answer" || mode === "error" ? "buddyDismiss" : "close",
  );
  $("dismiss").title = dismissTitle;
  $("dismiss").setAttribute("aria-label", dismissTitle);

  const turn = ["thinking", "answer", "error"].includes(mode);
  setText($("question"), turn ? view.question : "");
  show($("question"), turn && Boolean(view.question));
  show($("shimmer"), mode === "thinking");

  show(reading, mode === "answer");
  if (mode === "answer") {
    const key = `${view.answerId}:${view.answerPending}:${view.answer}`;
    if (key !== answerKey) {
      answerKey = key;
      renderAnswer(view.answer, view.answerPending);
    }
  } else answerKey = "";

  show($("heard"), mode === "listening");
  setText($("heard-label"), t("buddyLastHeard"));
  setText($("heard-text"), view.lastLine || t("buddyNothingHeard"));

  let detail = "";
  if (mode === "setup")
    detail = [
      view.needsWhisper && t("buddyNeedsWhisper"),
      view.needsAccount && t("buddyNeedsAccount"),
    ]
      .filter(Boolean)
      .join("\n");
  else if (mode === "idle") detail = t("buddyIdleHint");
  else if (mode === "error") detail = view.error || t("buddyErrorHint");
  const flashing = Date.now() < flash.until;
  setText($("detail"), flashing ? flash.text : detail);
  $("detail").classList.toggle("alert", flashing || mode === "error");
  show($("detail"), Boolean(flashing ? flash.text : detail));

  const busy = Boolean(snapshot.interview?.ai?.busy);
  const canAnswer = mode === "listening" || (mode === "idle" && view.lastLine);
  show($("answer-now"), Boolean(canAnswer));
  $("answer-now").disabled = busy;
  setText($("answer-now-label"), t("buddyAnswerNow"));
  show($("copy"), mode === "answer");
  if (!$("copy").dataset.copied) setText($("copy-label"), t("buddyCopy"));
  show($("open-app"), ["setup", "idle", "error"].includes(mode));
  setText($("open-label"), t("buddyOpen"));
  show($("hide-buddy"), ["setup", "idle", "listening"].includes(mode));
  setText($("hide-label"), t("buddyHide"));
  show($("keys"), mode === "idle");
  if (mode === "idle") keys(snapshot.platform);

  layout();
}

function setLevel(value) {
  level = value;
  island.style.setProperty("--level", value.toFixed(3));
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
      notify(error.message);
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
      layout();
    }, HOVER_OPEN_MS);
  else
    leaveTimer = setTimeout(() => {
      hovered = false;
      suppressed = false;
      layout();
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
  // Closing "Thinking…" keeps this turn quiet instead of reopening for its answer.
  if (view?.mode === "thinking") mutedTurn = seenTurn;
  pinned = false;
  hovered = false;
  autoUntil = 0;
  flash.until = 0;
  suppressed = true;
  render(current);
});
$("answer-now").addEventListener(
  "click",
  safe(() => api.request("answer", "")),
);
$("copy").addEventListener(
  "click",
  safe(async () => {
    if (!view?.answer) return;
    await api.request("clipboard-write", view.answer);
    const button = $("copy");
    button.dataset.copied = "true";
    setText($("copy-label"), t("buddyCopied"));
    setTimeout(() => {
      delete button.dataset.copied;
      setText($("copy-label"), t("buddyCopy"));
    }, 1600);
  }),
);
$("open-app").addEventListener(
  "click",
  safe(() => api.action("lab")),
);
$("hide-buddy").addEventListener(
  "click",
  safe(() => api.request("setting", { key: "buddy", value: false })),
);

// Keeps the timer moving and closes the island when an answer's minute is up.
setInterval(() => {
  if (current) render(current);
}, 1000);
api.subscribe(render);
api
  .state()
  .then(render)
  .catch((error) => notify(error.message));
