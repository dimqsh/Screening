const api = window.captureLab;
const $ = (id) => document.getElementById(id);
let current,
  locale = "ru",
  lastTranscript = "",
  lastAnswer = null,
  lastQuestion = null,
  lastResult = null,
  lastAttachment = null,
  errorTimer,
  contextDirty = false,
  lastAudioAt = 0,
  draftTimer,
  draftDirty = false;
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
  if ($("chat")) $("chat").replaceChildren();
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
  "interviewType",
  "notesEnabled",
  "includeNotes",
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
$("captureWindow")?.addEventListener(
  "change",
  safe((e) => api.change("captureWindow", e.target.value)),
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
  safe(() => api.action("hide-all")),
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
$("open-compact-settings")?.addEventListener("click", () =>
  $("compact-settings").showModal(),
);
$("close-compact-settings")?.addEventListener("click", () =>
  $("compact-settings").close(),
);
async function clearConversation() {
  if (current.interview.ai.busy) throw new Error(t("thinking"));
  clearTimeout(draftTimer);
  draftDirty = false;
  if ($("question")) $("question").value = "";
  await api.request("clear");
}
$("new-chat")?.addEventListener("click", safe(clearConversation));
$("clear-session")?.addEventListener("click", safe(clearConversation));
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
  safe(() => api.request("audio-stop")),
);
$("save-context")?.addEventListener(
  "click",
  safe(async () => {
    await api.request("setting", {
      key: "context",
      value: $("candidate-context").value,
    });
    ((contextDirty = false), (lastAudioAt = 0));
    setText("context-saved", t("saved"));
  }),
);
async function copyText(text, button) {
  if (!text) return;
  await api.request("clipboard-write", text);
  if (button) {
    const old = button.textContent;
    const hasIcon = Boolean(button.querySelector("svg"));
    button.title = t("copied");
    if (!hasIcon) button.textContent = t("copied");
    setTimeout(() => {
      if (button.isConnected && !hasIcon) button.textContent = old;
    }, 1600);
  }
  setText("copy-status", t("copied"));
}
$("copy-answer")?.addEventListener(
  "click",
  safe((e) => copyText(current.interview.ai.answer, e.currentTarget)),
);
$("paste-question")?.addEventListener(
  "click",
  safe(async () => {
    const text = await api.request("clipboard-read");
    const field = $("question");
    const available =
      16000 -
      (field.value.length - (field.selectionEnd - field.selectionStart));
    field.setRangeText(
      text.slice(0, available),
      field.selectionStart,
      field.selectionEnd,
      "end",
    );
    field.focus();
    queueDraft();
  }),
);
$("question-form")?.addEventListener(
  "submit",
  safe(async (e) => {
    e.preventDefault();
    const field = $("question");
    if (current.interview.ai.busy) throw new Error(t("thinking"));
    if (!current.interview.ai.connected) throw new Error(t("disconnected"));
    const previousMessages = current.interview.messages.length;
    const question = field.value.trim();
    if (
      !question &&
      !current.interview.attachment &&
      current.interview.whisper.pending
    )
      throw new Error(t("processing"));
    if (
      !question &&
      !current.interview.transcript.length &&
      !current.interview.attachment
    )
      throw new Error(t("noSpeech"));
    clearTimeout(draftTimer);
    draftDirty = false;
    field.value = "";
    await api.request("draft", "");
    try {
      await api.request("answer", question);
    } catch (e) {
      if (
        !field.value &&
        current.interview.messages.length === previousMessages
      ) {
        field.value = question;
        await api.request("draft", question);
      }
      throw e;
    }
  }),
);
let pickerBusy = false;
async function loadWindows() {
  const list = $("window-list");
  list.replaceChildren();
  setText("picker-status", t("loadingWindows"));
  $("refresh-windows").disabled = true;
  try {
    const sources = await api.request("windows");
    for (const source of sources) {
      const button = document.createElement("button");
      button.className = "window-option";
      const img = document.createElement("img");
      img.src = source.thumbnail;
      img.alt = "";
      const title = document.createElement("span");
      title.textContent = source.name;
      button.append(img, title);
      button.title = source.name;
      button.addEventListener(
        "click",
        safe(async () => {
          if (pickerBusy) return;
          pickerBusy = true;
          setText("picker-status", t("takingSnapshot"));
          try {
            await api.request("window-capture", source.id);
            $("window-picker").close();
            $("question").focus();
          } catch (error) {
            setText("picker-status", error.message);
          } finally {
            pickerBusy = false;
          }
        }),
      );
      list.append(button);
    }
    setText(
      "picker-status",
      sources.length ? t("snapshotLocal") : t("noWindows"),
    );
  } catch (e) {
    setText("picker-status", e.message);
  } finally {
    $("refresh-windows").disabled = false;
  }
}
$("choose-window")?.addEventListener(
  "click",
  safe(async () => {
    $("window-picker").showModal();
    await loadWindows();
  }),
);
$("refresh-windows")?.addEventListener("click", safe(loadWindows));
$("close-picker")?.addEventListener("click", () => $("window-picker").close());
$("remove-attachment")?.addEventListener(
  "click",
  safe(() => api.request("remove-attachment")),
);
$("preview-attachment")?.addEventListener("click", () => {
  $("full-image").src = current.interview.attachment.dataUrl;
  $("image-preview").showModal();
});
$("close-image")?.addEventListener("click", () => $("image-preview").close());
for (const button of document.querySelectorAll("[data-session-tab]"))
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-session-tab]")
      .forEach((el) => el.classList.toggle("active", el === button));
    $("session-transcript").hidden = button.dataset.sessionTab !== "transcript";
    $("session-notes").hidden = button.dataset.sessionTab !== "notes";
  });
function applyDraft(value) {
  const field = $("question");
  if (field && !draftDirty && field.value !== value) field.value = value;
}
function queueDraft() {
  draftDirty = true;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(
    safe(async () => {
      const value = $("question").value;
      await api.request("draft", value);
      if ($("question").value === value) draftDirty = false;
    }),
    150,
  );
}
$("question")?.addEventListener("input", queueDraft);
api.onDraft(applyDraft);
$("question")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    $("question-form").requestSubmit();
  }
});
$("record")?.addEventListener(
  "click",
  safe(async () => {
    if (current.interview.recording) return api.request("audio-stop");
    if (!current.interview.whisper.ready) {
      await api.request("model");
      setText("compact-hint", t("prepareFirst"));
      return;
    }
    await api.request("audio-start", $("audio-source").value);
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
    if ($("overlay-transcript-pane"))
      $("overlay-transcript-pane").hidden =
        tab.dataset.overlayTab !== "transcript";
  });
function renderText(target, text) {
  target.replaceChildren();
  for (const block of text.split(/(```[\s\S]*?(?:```|$))/g)) {
    if (!block) continue;
    if (block.startsWith("```")) {
      const newline = block.indexOf("\n");
      const language = newline > -1 ? block.slice(3, newline).trim() : "";
      let code = newline > -1 ? block.slice(newline + 1) : block.slice(3);
      if (code.endsWith("```")) code = code.slice(0, -3);
      code = code.replace(/\n$/, "");
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      const header = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = language.slice(0, 40) || t("code");
      const copy = document.createElement("button");
      copy.className = "text-button";
      copy.textContent = t("copyCode");
      copy.addEventListener(
        "click",
        safe(() => copyText(code, copy)),
      );
      header.append(label, copy);
      const pre = document.createElement("pre");
      const content = document.createElement("code");
      content.textContent = code;
      pre.append(content);
      wrap.append(header, pre);
      target.append(wrap);
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
}
function emptyState(title, hint) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const img = document.createElement("img");
  img.className = "empty-logo";
  img.src = "../assets/brand/screening.png";
  img.alt = "";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = hint;
  empty.append(img, h, p);
  return empty;
}
function renderAnswer(text) {
  const target = $("answer");
  if (!target) return;
  if (text) renderText(target, text);
  else target.replaceChildren(emptyState(t("answerEmpty"), t("overlayEmpty")));
}
function renderChat(messages) {
  const target = $("chat");
  if (!target) return;
  const atBottom =
    target.scrollHeight - target.scrollTop - target.clientHeight < 80;
  if (!messages.length) {
    if (!target.querySelector(".empty-state"))
      target.replaceChildren(emptyState(t("chatEmpty"), t("chatHint")));
    return;
  }
  target.querySelector(".empty-state")?.remove();
  const ids = new Set(messages.map((m) => String(m.id)));
  for (const row of target.children) if (!ids.has(row.dataset.id)) row.remove();
  for (const message of messages) {
    let row = target.querySelector(`[data-id="${message.id}"]`);
    const key = JSON.stringify([
      message.text,
      message.status,
      message.error,
      message.attachment,
    ]);
    if (row?.dataset.key === key) continue;
    if (!row) {
      row = document.createElement("article");
      row.dataset.id = message.id;
      target.append(row);
    }
    row.dataset.key = key;
    row.className = `chat-message ${message.role}`;
    row.replaceChildren();
    const head = document.createElement("div");
    head.className = "message-heading";
    const name = document.createElement("strong");
    name.textContent = message.role === "user" ? t("you") : "Screening";
    const copy = document.createElement("button");
    copy.className = "text-button message-copy";
    copy.textContent = t("copyMessage");
    copy.disabled = !message.text;
    copy.addEventListener(
      "click",
      safe(() => copyText(message.text, copy)),
    );
    head.append(name, copy);
    row.append(head);
    if (message.attachment) {
      const figure = document.createElement("figure");
      figure.className = "message-attachment";
      if (message.attachment.dataUrl) {
        const img = document.createElement("img");
        img.src = message.attachment.dataUrl;
        img.alt = message.attachment.name;
        figure.append(img);
      }
      const label = document.createElement("figcaption");
      label.textContent = message.attachment.name;
      figure.append(label);
      row.append(figure);
    }
    const text = document.createElement("div");
    text.className = "answer-text";
    renderText(text, message.text);
    row.append(text);
    if (message.status === "pending" && !message.text) {
      const pending = document.createElement("p");
      pending.className = "message-status";
      pending.textContent = t("thinking");
      row.append(pending);
    }
    if (message.error || message.status === "stopped") {
      const issue = document.createElement("p");
      issue.className = "message-status";
      issue.textContent = message.error || t("answerStopped");
      row.append(issue);
    }
  }
  if (atBottom) target.scrollTop = target.scrollHeight;
}
function render(s) {
  current = s;
  const interview = s.interview;
  if (!interview) return;
  const settings = interview.settings;
  applyDraft(interview.draft || "");
  if (locale !== settings.locale || !document.body.dataset.translated) {
    locale = settings.locale;
    translate();
    document.body.dataset.translated = "true";
  }
  for (const key of ["protection", "hideDock", "clickThrough"])
    if ($(key)) $(key).checked = s[key];
  for (const key of [
    "locale",
    "speechLanguage",
    "answerLanguage",
    "style",
    "interviewType",
  ])
    if ($(key) && document.activeElement !== $(key))
      $(key).value = settings[key];
  for (const key of ["autoAnswer", "notesEnabled", "includeNotes"])
    if ($(key)) $(key).checked = settings[key];
  if ($("notes-editor")) $("notes-editor").hidden = !settings.notesEnabled;
  if ($("notes-disabled")) $("notes-disabled").hidden = settings.notesEnabled;
  renderChat(interview.messages || []);
  if ($("attachment")) {
    $("attachment").hidden = !interview.attachment;
    if (lastAttachment !== interview.attachment?.dataUrl) {
      lastAttachment = interview.attachment?.dataUrl;
      if (interview.attachment) {
        $("attachment-image").src = interview.attachment.dataUrl;
        setText("attachment-name", interview.attachment.name);
      } else $("attachment-image").removeAttribute("src");
    }
    $("choose-window").disabled = aiBusy(interview);
  }
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
  setText(
    "workspace-protection",
    t(s.protection ? "protected" : "unprotected"),
  );
  for (const id of ["overlay-status", "workspace-protection"])
    if ($(id)) $(id).dataset.protected = String(s.protection);
  if ($("notes-view")) {
    const testing = s.testCard && s.testWindow !== "workspace";
    $("notes-view").hidden = testing;
    $("test-view").hidden = !testing;
  }
  if ($("workspace-test-view")) {
    const testing = s.testCard && s.testWindow === "workspace";
    $("workspace-test-view").hidden = !testing;
    document.body.classList.toggle("test-workspace", testing);
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
  if ($("compact-setup")) {
    $("compact-setup").hidden = w.ready && ai.connected;
    $("load-model").hidden = w.ready;
    $("login").hidden = ai.connected;
  }
  if ($("compact-hint"))
    setText(
      "compact-hint",
      t(interview.recording ? "recordingHint" : "compactReadyHint"),
    );
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
  setText(
    "record-label",
    t(
      s.audioControl?.busy
        ? s.audioControl.phase === "stopping"
          ? "stoppingAudio"
          : "audioChanging"
        : interview.recording
          ? "stop"
          : w.status === "loading"
            ? "modelLoading"
            : !w.ready
              ? "loadModel"
              : "start",
    ),
  );
  if ($("record")) {
    $("record").classList.toggle("is-recording", interview.recording);
    $("record").disabled =
      Boolean(s.audioControl?.busy) || w.status === "loading";
  }
  if ($("audio-source")) {
    $("audio-source").disabled =
      interview.recording || Boolean(s.audioControl?.busy);
    if (interview.recording && interview.source)
      $("audio-source").value = interview.source;
  }
  if (!interview.recording && $("audio-level")) $("audio-level").value = 0;
  if ($("speechLanguage")) $("speechLanguage").disabled = interview.recording;
  setText("overlay-recording", interview.recording ? t("listening") : "");
  if (!interview.recording && window.audioCapture?.active())
    window.audioCapture.stop().catch((e) => error(e.message));
  if ($("overlay-stop")) $("overlay-stop").hidden = !interview.recording;
  if ($("overlay-ask"))
    $("overlay-ask").disabled =
      ai.busy ||
      !ai.connected ||
      s.audioControl?.busy ||
      w.pending > 0 ||
      (!interview.transcript.length && !interview.attachment);
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
  if ($("answered-question") && lastQuestion !== ai.question) {
    lastQuestion = ai.question;
    setText("answered-question", ai.question);
    $("answered-question").hidden = !ai.question;
  }
  setText("ai-status", ai.busy ? t("thinking") : "");
  if ($("cancel-answer")) $("cancel-answer").hidden = !ai.busy;
  if ($("ask")) $("ask").disabled = ai.busy || !ai.connected;
  if ($("clear-session")) $("clear-session").disabled = ai.busy;
  if ($("new-chat")) $("new-chat").disabled = ai.busy;
  if ($("copy-answer")) $("copy-answer").disabled = !ai.answer;
  const issue = interview.error || ai.error || w.error;
  if (issue && issue !== document.body.dataset.error) {
    document.body.dataset.error = issue;
    error(issue);
  } else if (!issue) delete document.body.dataset.error;
  if ($("captureWindow")) $("captureWindow").value = s.captureWindow;
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
api.onLevel((value) => {
  if ($("audio-level")) $("audio-level").value = value;
  if (value > 0.02) lastAudioAt = Date.now();
});
setInterval(() => {
  if (current?.interview.recording && $("elapsed")) {
    if ($("compact-hint"))
      setText(
        "compact-hint",
        t(
          Date.now() - Math.max(lastAudioAt, current.interview.startedAt) >
            10000
            ? "noAudioHint"
            : "recordingHint",
        ),
      );
    const seconds = Math.floor(
      (Date.now() - current.interview.startedAt) / 1000,
    );
    setText(
      "elapsed",
      `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`,
    );
  }
}, 1000);
function aiBusy(interview) {
  return interview.ai.busy;
}
api.subscribe(render);
api
  .state()
  .then(render)
  .catch((e) => error(e.message));
