const api = window.captureLab;
const $ = (id) => document.getElementById(id);
let current,
  locale = "ru",
  lastTranscript = "",
  lastAnswer = null,
  lastQuestion = null,
  lastResult = null,
  errorTimer,
  contextDirty = false;
const t = (key) => window.copy[locale]?.[key] || window.copy.en[key] || key;
function error(message) {
  const target = $("error");
  target.textContent = message;
  target.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => (target.hidden = true), 15000);
}
$("error")?.addEventListener("click", () => {
  $("error").hidden = true;
});
const safe =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      error(e.message);
    }
  };
function translate() {
  document.documentElement.lang = locale;
  document
    .querySelectorAll("[data-i18n]")
    .forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document
    .querySelectorAll("[data-placeholder-i18n]")
    .forEach((el) => (el.placeholder = t(el.dataset.placeholderI18n)));
  document.querySelectorAll("[data-title-i18n]").forEach((el) => {
    el.title = t(el.dataset.titleI18n);
    el.setAttribute("aria-label", el.title);
  });
  const names = {
    ru: "Русский",
    en: "English",
    kk: "Қазақша",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    zh: "中文",
    ja: "日本語",
    uk: "Українська",
    tr: "Türkçe",
  };
  document.querySelectorAll(".language-select").forEach((select) => {
    const selected = current?.interview?.settings[select.id] || "auto";
    select.replaceChildren(
      ...Object.entries({
        auto: select.id === "answerLanguage" ? t("sameLanguage") : t("auto"),
        ...names,
      }).map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    select.value = selected;
  });
  lastAnswer = null;
  lastTranscript = "";
  lastResult = null;
}
function setText(id, text) {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
}
function showView(view) {
  document
    .querySelectorAll(".view")
    .forEach((el) => el.classList.toggle("active", el.id === `view-${view}`));
  document
    .querySelectorAll("[data-view]")
    .forEach((el) => el.classList.toggle("active", el.dataset.view === view));
}
for (const el of document.querySelectorAll("[data-view]"))
  el.addEventListener("click", () => showView(el.dataset.view));
for (const el of document.querySelectorAll("[data-action]"))
  el.addEventListener(
    "click",
    safe(() => api.action(el.dataset.action)),
  );
for (const key of ["protection", "hideDock", "clickThrough"])
  $(key)?.addEventListener(
    "change",
    safe((e) => api.change(key, e.target.checked)),
  );
for (const key of [
  "locale",
  "speechLanguage",
  "answerLanguage",
  "style",
  "autoAnswer",
])
  $(key)?.addEventListener(
    "change",
    safe(async (e) => {
      if (key === "speechLanguage" && current.interview.recording) {
        e.target.value = current.interview.settings.speechLanguage;
        throw new Error(t("stopToChange"));
      }
      await api.request("setting", {
        key,
        value: e.target.type === "checkbox" ? e.target.checked : e.target.value,
      });
    }),
  );
$("capturePath")?.addEventListener(
  "change",
  safe((e) => api.change("capturePath", e.target.value)),
);
$("notes")?.addEventListener(
  "input",
  safe((e) => api.change("notes", e.target.value)),
);
$("visibility")?.addEventListener(
  "click",
  safe(() => api.change("visible", !current.visible)),
);
$("hide")?.addEventListener(
  "click",
  safe(() => api.change("visible", false)),
);
$("test")?.addEventListener(
  "click",
  safe(() => api.action("test")),
);
$("export")?.addEventListener(
  "click",
  safe(() => api.action("export")),
);
for (const id of ["load-model", "prepare-model"])
  $(id)?.addEventListener(
    "click",
    safe(() => api.request("model")),
  );
$("login")?.addEventListener(
  "click",
  safe(() => api.request("login")),
);
$("check-account")?.addEventListener(
  "click",
  safe(() => api.request("account")),
);
$("account-shortcut")?.addEventListener("click", () => showView("settings"));
$("clear-session")?.addEventListener(
  "click",
  safe(() => api.request("clear")),
);
$("export-session")?.addEventListener(
  "click",
  safe(() => api.request("export")),
);
$("cancel-answer")?.addEventListener(
  "click",
  safe(() => api.request("cancel")),
);
$("candidate-context")?.addEventListener("input", () => (contextDirty = true));
$("overlay-ask")?.addEventListener(
  "click",
  safe(() => api.request("answer", "")),
);
$("overlay-stop")?.addEventListener(
  "click",
  safe(() => api.request("stop")),
);
$("save-context")?.addEventListener(
  "click",
  safe(async () => {
    await api.request("setting", {
      key: "context",
      value: $("candidate-context").value,
    });
    contextDirty = false;
    setText("context-saved", t("saved"));
  }),
);
$("copy-answer")?.addEventListener(
  "click",
  safe(async () => {
    if (current.interview.ai.answer) {
      await navigator.clipboard.writeText(current.interview.ai.answer);
      $("copy-answer").title = t("copied");
    }
  }),
);
$("question-form")?.addEventListener(
  "submit",
  safe(async (e) => {
    e.preventDefault();
    const question = $("question").value.trim();
    if (!question && !current.interview.transcript.length)
      throw new Error(t("noSpeech"));
    await api.request("answer", question);
  }),
);
$("question")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("question-form").requestSubmit();
  }
});
$("record")?.addEventListener(
  "click",
  safe(async () => {
    if (current.interview.recording) {
      if (window.audioCapture.active()) await window.audioCapture.stop();
      else await api.request("stop");
      return;
    }
    if (!current.interview.whisper.ready) {
      showView("settings");
      throw new Error(t("modelRequired"));
    }
    const source = $("audio-source").value;
    if (source === "system" && current.platform === "darwin")
      await api.request("system-start");
    else await window.audioCapture.start(source);
  }),
);
window.addEventListener("audioerror", (e) => error(e.detail));
for (const tab of document.querySelectorAll("[data-overlay-tab]"))
  tab.addEventListener("click", () => {
    document
      .querySelectorAll("[data-overlay-tab]")
      .forEach((el) => el.classList.toggle("active", el === tab));
    $("overlay-answer-pane").hidden = tab.dataset.overlayTab !== "answer";
    $("overlay-notes-pane").hidden = tab.dataset.overlayTab !== "notes";
  });
function renderAnswer(text) {
  const target = $("answer");
  target.replaceChildren();
  if (!text) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const h = document.createElement("h3");
    h.textContent = t("answerEmpty");
    const p = document.createElement("p");
    p.textContent = document.body.classList.contains("overlay")
      ? t("overlayEmpty")
      : t("answerHint");
    empty.append(h, p);
    target.append(empty);
    return;
  }
  for (const paragraph of text.split(/\n\s*\n/)) {
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
function render(s) {
  current = s;
  const interview = s.interview;
  if (!interview) return;
  const settings = interview.settings;
  if (locale !== settings.locale || !document.body.dataset.translated) {
    locale = settings.locale;
    translate();
    document.body.dataset.translated = "true";
  }
  for (const key of ["protection", "hideDock", "clickThrough"])
    if ($(key)) $(key).checked = s[key];
  for (const key of ["locale", "speechLanguage", "answerLanguage", "style"])
    if ($(key) && document.activeElement !== $(key))
      $(key).value = settings[key];
  if ($("autoAnswer")) $("autoAnswer").checked = settings.autoAnswer;
  if (
    $("candidate-context") &&
    !contextDirty &&
    document.activeElement !== $("candidate-context")
  )
    $("candidate-context").value = settings.context;
  if ($("notes") && document.activeElement !== $("notes"))
    $("notes").value = s.notes;
  setText("visibility", t(s.visible ? "hideOverlay" : "showOverlay"));
  setText("overlay-status", t(s.protection ? "protected" : "unprotected"));
  if ($("notes-view")) {
    $("notes-view").hidden = s.testCard;
    $("test-view").hidden = !s.testCard;
  }
  const missingShortcuts = s.shortcuts.some((shortcut) => !shortcut.registered);
  if ($("view-settings")) {
    let warning = $("shortcut-warning");
    if (!warning) {
      warning = document.createElement("p");
      warning.id = "shortcut-warning";
      warning.className = "help";
      $("view-settings").append(warning);
    }
    warning.hidden = !missingShortcuts;
    warning.textContent = t("shortcutWarning");
  }
  const ai = interview.ai,
    w = interview.whisper;
  const accountText = t(
    ai.status === "signing-in"
      ? "signingIn"
      : ai.connected
        ? "connected"
        : ai.status === "checking"
          ? "checking"
          : "disconnected",
  );
  setText("account-label", accountText);
  setText("account-status", accountText);
  if ($("login")) {
    $("login").disabled = ai.status === "signing-in";
    $("login-hint").hidden = ai.status !== "signing-in";
  }
  setText(
    "model-label",
    t(
      w.ready
        ? "modelReady"
        : w.status === "loading"
          ? "modelLoading"
          : "loadModel",
    ),
  );
  for (const id of ["load-model", "prepare-model"])
    if ($(id)) {
      $(id).disabled = w.ready || w.status === "loading";
      $(id).textContent = t(
        w.ready
          ? "loaded"
          : w.status === "loading"
            ? "modelLoading"
            : "loadModel",
      );
    }
  if ($("model-dot")) $("model-dot").classList.toggle("ready", w.ready);
  if ($("model-progress")) {
    $("model-progress").hidden = w.status !== "loading";
    if (w.progress !== null) $("model-progress").value = w.progress;
    else $("model-progress").removeAttribute("value");
  }
  setText(
    "session-label",
    t(interview.recording ? "listening" : "readyToStart"),
  );
  setText("processing", w.pending ? t("processing") : "");
  if ($("record-dot"))
    $("record-dot").classList.toggle("recording", interview.recording);
  setText("record-label", t(interview.recording ? "stop" : "start"));
  if ($("record")) {
    $("record").classList.toggle("is-recording", interview.recording);
    $("record").disabled = !w.ready;
  }
  if ($("audio-source")) $("audio-source").disabled = interview.recording;
  if ($("speechLanguage")) $("speechLanguage").disabled = interview.recording;
  setText("overlay-recording", interview.recording ? t("listening") : "");
  if (!interview.recording && window.audioCapture?.active())
    window.audioCapture.stop().catch((e) => error(e.message));
  if ($("overlay-stop")) $("overlay-stop").hidden = !interview.recording;
  if ($("overlay-ask"))
    $("overlay-ask").disabled =
      ai.busy || !ai.connected || !interview.transcript.length;
  const transcriptKey = JSON.stringify(interview.transcript);
  if ($("transcript") && lastTranscript !== transcriptKey) {
    lastTranscript = transcriptKey;
    const target = $("transcript");
    if (interview.transcript.length) {
      target.replaceChildren();
      for (const item of interview.transcript) {
        const row = document.createElement("article");
        row.className = "transcript-item";
        const time = document.createElement("time");
        time.textContent = new Date(item.time).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        const p = document.createElement("p");
        p.textContent = item.text;
        row.append(time, p);
        target.append(row);
      }
      target.scrollTop = target.scrollHeight;
    } else {
      target.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const h = document.createElement("h3");
      h.textContent = t("speechEmpty");
      const p = document.createElement("p");
      p.textContent = t("speechHint");
      empty.append(h, p);
      target.append(empty);
    }
  }
  if (lastAnswer !== ai.answer) {
    lastAnswer = ai.answer;
    renderAnswer(ai.answer);
  }
  if (lastQuestion !== ai.question) {
    lastQuestion = ai.question;
    setText("answered-question", ai.question);
    $("answered-question").hidden = !ai.question;
  }
  setText("ai-status", ai.busy ? t("thinking") : "");
  if ($("cancel-answer")) $("cancel-answer").hidden = !ai.busy;
  if ($("ask")) $("ask").disabled = ai.busy || !ai.connected;
  if ($("clear-session")) $("clear-session").disabled = ai.busy;
  if ($("copy-answer")) $("copy-answer").disabled = !ai.answer;
  const issue = interview.error || ai.error || w.error;
  if (issue && issue !== document.body.dataset.error) {
    document.body.dataset.error = issue;
    error(issue);
  } else if (!issue) delete document.body.dataset.error;
  if ($("capturePath")) {
    $("capturePath").value = s.capturePath;
    $("capturePath").querySelector("[value=sck]").disabled =
      s.platform !== "darwin";
  }
  if ($("hideDock")) $("hideDock").disabled = s.platform !== "darwin";
  setText("environment", `${s.os} · Electron ${s.electron}`);
  setText("permission", `${t("screenPermission")}: ${s.permission}`);
  if ($("test")) {
    $("test").disabled = s.testing;
    setText("test", t(s.testing ? "testing" : "runTest"));
  }
  if ($("export")) $("export").disabled = !s.result;
  const resultKey = JSON.stringify(s.result);
  if ($("result") && lastResult !== resultKey) {
    lastResult = resultKey;
    const result = s.result;
    $("result").replaceChildren();
    const strong = document.createElement("strong");
    strong.textContent = t(
      result
        ? {
            "permission-needed": "permissionNeeded",
            unsupported: "inconclusive",
          }[result.outcome] || result.outcome
        : "notTested",
    );
    const span = document.createElement("span");
    span.textContent = result
      ? result.outcome === "error" || result.outcome === "permission-needed"
        ? result.detail
        : t("captureDetail")
      : t("testHint");
    $("result").append(strong, span);
    for (const [id, data] of [
      ["baseline", result?.baseline],
      ["protected", result?.protected],
    ])
      if (data) {
        const img = document.createElement("img");
        img.src = data;
        img.alt = id;
        $(id).replaceChildren(img);
      }
  }
}
setInterval(() => {
  if (current?.interview.recording && $("elapsed")) {
    const seconds = Math.floor(
      (Date.now() - current.interview.startedAt) / 1000,
    );
    setText(
      "elapsed",
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
    );
  }
}, 1000);
api.subscribe(render);
api
  .state()
  .then(render)
  .catch((e) => error(e.message));
