// Verification for the Buddy-only app. Runs inside Electron with --verify.
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const {
  BrowserWindow,
  clipboard,
  screen,
  desktopCapturer,
} = require("electron");
const { FLOAT } = require("./services/notch.cjs");
const { speechReady } = require("./buddy-model.js");

const QUESTION = "Tell me about a time you disagreed with your manager.";
const STAR_ANSWER =
  "**Situation.** My manager wanted Kafka for order events. I thought it was more than we needed.\n\n" +
  "**What I did.** I ran both Kafka and SQS against our real load, about 2,000 events a minute, and showed that SQS met the latency target at a third of the cost.\n\n" +
  "**Result.** We shipped on SQS in two weeks. I wrote down when a move to Kafka would make sense, in case volume grows tenfold.";
const CODE_ANSWER =
  "Use a hash set and one pass, so it runs in O(n).\n\n```python\ndef pairs(nums, target):\n    seen, out = set(), []\n    for n in nums:\n        if target - n in seen:\n            out.append((target - n, n))\n        seen.add(n)\n    return out\n```\n\nFor `[4, 8, 15, 16, 23, 42]` and 31 this returns **(8, 23)** and **(15, 16)**.";

module.exports = async function verify(ctx) {
  const {
    app,
    buddy,
    engine,
    tray,
    interview,
    state,
    audioControl,
    keyboard,
    artifactDir,
    layout,
    publish,
    change,
    setHidden,
    audio,
    runCapture,
    permission,
    setDock,
    access,
    delay,
  } = ctx;
  const has = (flag) => process.argv.includes(flag);
  await fs.mkdir(artifactDir, { recursive: true });
  // Any script error in a window fails verification, even if every check passes.
  const scriptErrors = [];
  for (const [name, win] of [["Buddy", buddy], ["engine", engine]])
    win.webContents.on("console-message", (event, legacyLevel, legacyMessage) => {
      const level = event.level ?? legacyLevel;
      if (level === "error" || level === 3)
        scriptErrors.push(`${name}: ${event.message ?? legacyMessage}`);
    });
  const checks = [];
  function check(name, fn) {
    fn();
    checks.push({ name, passed: true });
  }
  // A failing script names itself and the renderer errors so far.
  const js = (code) =>
    buddy.webContents.executeJavaScript(code).catch((error) => {
      throw new Error(
        `${error.message}\n${code.slice(0, 160)}\n${scriptErrors.join("\n")}`,
      );
    });
  const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
  async function until(test, timeout = 20000, message = "Timed out") {
    const started = Date.now();
    while (!test()) {
      if (Date.now() - started > timeout) throw new Error(message);
      await delay(100);
    }
  }
  const shot = async (name) =>
    fs.writeFile(
      path.join(artifactDir, name),
      (await buddy.webContents.capturePage()).toPNG(),
    );
  const probe = () =>
    js(`(() => { const island = document.getElementById("island");
      return { mode: island.dataset.mode, open: island.classList.contains("open"),
        glance: island.classList.contains("glance"),
        floating: island.classList.contains("floating"),
        compact: island.classList.contains("compact"),
        accessStep: !document.getElementById("step-access").hidden,
        accessDone: document.getElementById("step-access").classList.contains("done"),
        speechDone: document.getElementById("step-model").classList.contains("done"),
        speechText: document.getElementById("model-text").textContent,
        speechOptional: !document.getElementById("model").classList.contains("primary"),
        manual: island.dataset.hover === "true" || island.dataset.pinned === "true",
        view: document.querySelector(".view.active")?.id,
        answer: document.getElementById("answer").textContent,
        live: document.querySelector("#transcript .line.live p")?.textContent || "",
        turns: document.getElementById("turn-count").textContent }; })()`);

  // Architecture
  check("Buddy is the only visible window", () => {
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    assert.equal(engine.isVisible(), false);
    assert.equal(buddy.isVisible(), true);
  });
  check("Buddy and the audio engine are sandboxed and isolated", () => {
    for (const win of [buddy, engine]) {
      const p = win.webContents.getLastWebPreferences();
      assert.equal(p.contextIsolation, true);
      assert.equal(p.sandbox, true);
      assert.equal(p.nodeIntegration, false);
    }
  });
  if (process.platform === "darwin")
    check("Screening has no Dock icon on macOS", () =>
      assert.equal(app.dock.isVisible(), false),
    );
  check("The menu-bar icon is present", () =>
    assert.equal(tray.isDestroyed(), false),
  );
  check("Buddy is protected, floating and does not take focus", () => {
    assert.equal(buddy.isContentProtected(), true);
    // The engine is never shown. Windows reports no capture affinity for a
    // window that was never shown, so its flag is checked on macOS only.
    if (process.platform === "darwin")
      assert.equal(engine.isContentProtected(), true);
    assert.equal(buddy.isAlwaysOnTop(), true);
    assert.equal(buddy.isFocusable(), false);
    if (process.platform === "darwin")
      assert.equal(buddy.isHiddenInMissionControl(), true);
  });
  check("Buddy sits on the notch band of the primary display", () => {
    const display = screen.getPrimaryDisplay();
    const bounds = buddy.getBounds();
    const geometry = layout();
    assert.equal(bounds.y, display.bounds.y);
    const notchCenter =
      bounds.x + geometry.notchLeft + geometry.notchWidth / 2;
    const displayCenter = display.bounds.x + display.bounds.width / 2;
    assert.ok(Math.abs(notchCenter - displayCenter) <= 2);
  });
  check("Protection can be disabled and restored", () => {
    change("protection", false);
    assert.equal(buddy.isContentProtected(), false);
    change("protection", true);
    assert.equal(buddy.isContentProtected(), true);
  });
  check("Input validation rejects unknown settings and oversized notes", () => {
    assert.throws(() => change("arbitrary", true));
    assert.throws(() => change("protection", "yes"));
    assert.throws(() => change("notes", "x".repeat(12001)));
  });
  await assert.rejects(
    interview.request("setting", { key: "speechLanguage", value: "invalid" }),
  );
  await assert.rejects(
    interview.request("setting", { key: "locale", value: "ru" }),
  );
  checks.push({
    name: "Invalid settings and the old interface language are rejected",
    passed: true,
  });
  check("New installs default to English speech and answers", () => {
    assert.equal(interview.state.settings.speechLanguage, "en");
    assert.equal(interview.state.settings.answerLanguage, "en");
  });
  const english = await js(
    `document.documentElement.lang === "en" && !/[а-яёәіңғүұқөһ]/i.test(document.body.innerText)`,
  );
  check("Buddy's interface is in English", () => assert.equal(english, true));
  setHidden(true);
  await delay(200);
  check("Hiding Buddy removes the only window", () =>
    assert.equal(buddy.isVisible(), false),
  );
  setHidden(false);
  await delay(250);
  check("Showing Buddy brings it back", () =>
    assert.equal(buddy.isVisible(), true),
  );

  // Synthetic scenes: shared state is patched for one screenshot, then restored.
  async function scene(name, patch, before = "") {
    const whisper = interview.state.whisper,
      ai = interview.state.ai;
    const saved = {
      ready: whisper.ready,
      connected: ai.connected,
      partial: whisper.partial,
      engine: whisper.engine,
      messages: interview.state.messages,
      transcript: interview.state.transcript,
      recording: interview.state.recording,
      startedAt: interview.state.startedAt,
      source: interview.state.source,
      settings: interview.state.settings,
    };
    whisper.ready = patch.ready ?? true;
    ai.connected = patch.connected ?? true;
    whisper.partial = patch.partial ?? "";
    whisper.engine = patch.partial ? "apple" : whisper.engine;
    const { ready, connected, partial, ...rest } = patch;
    Object.assign(interview.state, rest);
    publish();
    await delay(250);
    if (before) await js(before);
    for (let i = 0; i < 6; i++) {
      if (interview.state.recording)
        buddy.webContents.send("audio:level-update", 0.35 + (i % 3) * 0.2);
      await delay(150);
    }
    try {
      const result = await probe();
      if (name) await shot(`buddy-${name}.png`);
      return result;
    } finally {
      whisper.ready = saved.ready;
      ai.connected = saved.connected;
      whisper.partial = saved.partial;
      whisper.engine = saved.engine;
      const { ready: r, connected: c, partial: p, engine: e, ...others } = saved;
      Object.assign(interview.state, others);
      publish();
      await delay(400);
    }
  }
  const now = () => new Date().toISOString();
  const heard = [
    { id: 1, text: "Thanks for joining. Let's start with your background.", time: now() },
    { id: 2, text: QUESTION, time: now() },
  ];
  const pin = `document.getElementById("orb").click()`;
  // A fresh install asks for microphone and screen access in setup, once.
  const firstRun = access();
  if (firstRun) {
    const missing =
      firstRun.microphone !== "granted" || firstRun.audio !== "granted";
    const ready = await scene(null, { messages: [], transcript: [] });
    check("A fresh install asks for missing microphone or screen access", () =>
      assert.equal(ready.mode === "setup", missing),
    );
  }
  await interview.request("setting", { key: "accessPrompted", value: true });
  publish();
  await delay(200);
  const setup = await scene(
    "setup",
    { ready: false, connected: false, messages: [], transcript: [] },
    pin,
  );
  await js(pin);
  check("Setup walks through the speech model, ChatGPT and access", () => {
    assert.equal(setup.mode, "setup");
    assert.equal(setup.view, "view-setup");
    assert.equal(setup.open, true);
    assert.equal(setup.accessStep, Boolean(firstRun));
    if (firstRun)
      assert.equal(
        setup.accessDone,
        firstRun.microphone === "granted" && firstRun.audio === "granted",
      );
  });
  // On macOS 26, Apple's live transcription can stand in for Whisper.
  const appleOnly = speechReady({
    ...interview.state,
    whisper: { ...interview.state.whisper, ready: false },
  });
  check(
    appleOnly
      ? "Apple's live transcription finishes the speech step; Whisper is optional"
      : "Setup offers the speech model download",
    () => {
      assert.equal(setup.speechDone, appleOnly);
      assert.equal(setup.speechOptional, appleOnly);
      assert.match(setup.speechText, appleOnly ? /Apple .* live.*optional/ : /download/i);
    },
  );
  if (appleOnly) {
    const whisperChoice = await scene(
      "setup-whisper",
      {
        ready: false,
        connected: false,
        messages: [],
        transcript: [],
        settings: { ...interview.state.settings, speechEngine: "whisper" },
      },
      pin,
    );
    await js(pin);
    check("Choosing Whisper asks for its download again", () => {
      assert.equal(whisperChoice.mode, "setup");
      assert.equal(whisperChoice.speechDone, false);
      assert.equal(whisperChoice.speechOptional, false);
      assert.match(whisperChoice.speechText, /download/i);
    });
  }
  await click("dismiss");
  const idle = await scene("idle", { messages: [], transcript: [], recording: false });
  check("Idle Buddy stays collapsed at the notch", () => {
    assert.equal(idle.mode, "idle");
    assert.equal(idle.open, idle.manual);
  });
  const idleOpen = await scene(
    "idle-open",
    { messages: [], transcript: [], recording: false },
    pin,
  );
  await js(pin);
  check("Clicking the orb opens the full island", () => {
    assert.equal(idleOpen.open, true);
    assert.equal(idleOpen.glance, false);
    assert.equal(idleOpen.view, "view-answer");
  });
  const listening = await scene("listening", {
    messages: [],
    recording: true,
    source: "system",
    startedAt: Date.now() - 83000,
    transcript: heard,
  });
  check("Listening keeps Buddy collapsed with a live waveform", () => {
    assert.equal(listening.mode, "listening");
    assert.equal(listening.open, listening.manual);
  });
  const transcriptView = await scene(
    "transcript",
    {
      messages: [],
      recording: true,
      source: "system",
      startedAt: Date.now() - 83000,
      transcript: heard,
      // Apple's words for the sentence still being spoken.
      partial: "And how would you scale it to ten times the traffic",
    },
    `${pin}; document.querySelector('[data-tab="transcript"]').click()`,
  );
  await js(`${pin}; document.querySelector('[data-tab="answer"]').click()`);
  check("The transcript tab shows what was heard", () =>
    assert.equal(transcriptView.view, "view-transcript"),
  );
  check("Live words show under the transcript while someone speaks", () =>
    assert.equal(transcriptView.live, "And how would you scale it to ten times the traffic"),
  );
  const thinking = await scene("thinking", {
    transcript: heard,
    messages: [
      { id: 8001, role: "user", text: QUESTION },
      { id: 8002, role: "assistant", status: "pending", text: "" },
    ],
  });
  check("A requested answer opens Buddy's reading view while it thinks", () => {
    assert.equal(thinking.mode, "thinking");
    assert.equal(thinking.open, true);
    // The real pointer may rest on the island, which shows full controls instead.
    assert.equal(thinking.glance, !thinking.manual);
  });
  const answer = await scene("answer", {
    recording: true,
    source: "system",
    startedAt: Date.now() - 151000,
    transcript: heard,
    messages: [
      { id: 9001, role: "user", text: QUESTION },
      { id: 9002, role: "assistant", status: "done", text: STAR_ANSWER },
    ],
  });
  check("A new answer opens the reading view", () => {
    assert.equal(answer.mode, "answer");
    assert.equal(answer.open, true);
    assert.equal(answer.glance, !answer.manual);
    assert.match(answer.answer, /SQS/);
  });
  const full = await scene(
    "answer-full",
    {
      transcript: heard,
      messages: [
        { id: 9101, role: "user", text: QUESTION },
        { id: 9102, role: "assistant", status: "done", text: STAR_ANSWER },
        {
          id: 9103,
          role: "user",
          text: "Find all pairs that sum to 31 in [4, 8, 15, 16, 23, 42].",
          attachment: { name: "Coding task" },
        },
        { id: 9104, role: "assistant", status: "done", text: CODE_ANSWER },
      ],
    },
    pin,
  );
  await js(pin);
  check("Pinned Buddy shows controls, tabs and earlier answers", () => {
    assert.equal(full.glance, false);
    assert.equal(full.turns, "2 of 2");
    assert.match(full.answer, /def pairs/);
  });
  const after = await probe();
  check("Buddy closes when the answer is gone", () =>
    assert.equal(after.open, after.manual),
  );

  // Floating: Buddy leaves the notch for a small window, then snaps back.
  await setDock("float");
  const floating = await scene(
    "floating",
    {
      transcript: heard,
      messages: [
        { id: 9201, role: "user", text: QUESTION },
        { id: 9202, role: "assistant", status: "done", text: STAR_ANSWER },
      ],
    },
    pin,
  );
  await js(pin);
  const floatBounds = buddy.getBounds();
  check("Buddy floats off the notch as a small compact window", () => {
    const area = screen.getPrimaryDisplay().workArea;
    assert.equal(floatBounds.width, Math.min(FLOAT.width, area.width));
    assert.ok(floatBounds.x >= area.x);
    assert.ok(floatBounds.x + floatBounds.width <= area.x + area.width);
    assert.ok(floatBounds.y >= area.y);
    assert.equal(layout().floating, true);
    assert.equal(floating.floating, true);
    assert.equal(floating.compact, true);
    assert.equal(floating.open, true);
    assert.match(floating.answer, /SQS/);
  });
  await setDock("notch");
  await delay(250);
  const snapped = await probe();
  check("Buddy snaps back to the notch", () => {
    const display = screen.getPrimaryDisplay();
    const bounds = buddy.getBounds();
    assert.equal(bounds.y, display.bounds.y);
    assert.equal(layout().floating, false);
    assert.equal(snapped.floating, false);
    assert.equal(interview.state.settings.dock, "notch");
  });

  // Typing: Buddy takes the keyboard only while a text field is in use. The
  // composer exists only after setup, so these checks run in a ready state.
  const readiness = {
    ready: interview.state.whisper.ready,
    connected: interview.state.ai.connected,
  };
  interview.state.whisper.ready = true;
  interview.state.ai.connected = true;
  publish();
  await delay(300);
  await js(pin);
  const taken = keyboard.taken;
  await js(
    `document.getElementById("question-input").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`,
  );
  await delay(300);
  // Another app may take focus back on a live desktop, so the hand-off itself is checked.
  check("Using the composer lets Buddy take the keyboard", () => {
    assert.equal(keyboard.taken, taken + 1);
    assert.equal(keyboard.focusableOnTake, true);
  });
  await js(`document.getElementById("question-input").blur()`);
  await delay(300);
  check("Leaving the composer gives the keyboard back", () =>
    assert.equal(buddy.isFocusable(), false),
  );
  const previousClipboard = clipboard.readText();
  try {
    clipboard.writeText("Unicode paste: Привет\n    return 42");
    await js(`document.getElementById("question-input").value = ""`);
    await click("paste");
    await delay(250);
    const pasted = await js(`document.getElementById("question-input").value`);
    // Buddy holds the keyboard here, so typing elsewhere on a live desktop can
    // add characters after the paste; the pasted text itself must be exact.
    check("Paste keeps Unicode and indentation", () =>
      assert.ok(pasted.startsWith("Unicode paste: Привет\n    return 42")),
    );
  } finally {
    clipboard.writeText(previousClipboard);
    await js(`document.getElementById("question-input").value = ""`);
    await js(`document.getElementById("question-input").blur()`);
  }
  await js(`document.querySelector('[data-tab="notes"]').click();
    const notes = document.getElementById("notes");
    notes.value = "Ask about the on-call rotation";
    notes.dispatchEvent(new Event("input", { bubbles: true }));`);
  await delay(500);
  check("Notes typed in Buddy reach the session", () =>
    assert.equal(state.notes, "Ask about the on-call rotation"),
  );
  await js(`document.querySelector('[data-tab="you"]').click();
    document.getElementById("context").value = "Backend engineer, 6 years, Go and Postgres.";
    document.getElementById("context").dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("save-context").click();`);
  await delay(400);
  check("Your background saves from Buddy", () =>
    assert.equal(
      interview.state.settings.context,
      "Backend engineer, 6 years, Go and Postgres.",
    ),
  );
  await interview.request("setting", { key: "context", value: "" });
  change("notes", "");
  await js(`document.querySelector('[data-tab="answer"]').click()`);
  interview.state.whisper.ready = readiness.ready;
  interview.state.ai.connected = readiness.connected;
  publish();
  await assert.rejects(interview.request("window-capture", "window:unknown:0"));
  checks.push({ name: "Unknown window capture is rejected", passed: true });
  // A frame from the system window picker becomes the same kind of attachment.
  const frame = (await buddy.webContents.capturePage()).resize({ width: 2400 });
  await interview.request("window-image", { name: "Picked window", dataUrl: frame.toDataURL() });
  const picked = interview.state.attachment;
  await assert.rejects(interview.request("window-image", { name: "x", dataUrl: "data:text/html,hi" }));
  await interview.request("remove-attachment");
  check("A picked window frame becomes one sized attachment", () => {
    assert.equal(picked.name, "Picked window");
    assert.ok(picked.width <= 1600 && picked.height <= 1200);
    assert.ok(picked.dataUrl.startsWith("data:image/png;base64,"));
    assert.ok(picked.preview.startsWith("data:image/jpeg;base64,"));
  });
  await js(pin);
  await delay(200);

  if (has("--interview-test")) {
    await interview.request("model");
    for (let i = 0; i < 240 && !interview.state.whisper.ready; i++) {
      if (interview.state.whisper.error)
        throw new Error(interview.state.whisper.error);
      await delay(1000);
    }
    assert.equal(interview.state.whisper.ready, true);
    const raw = await fs.readFile(process.env.CAPTURE_LAB_TEST_AUDIO);
    // Apple's live transcription where this Mac has it, then Whisper, which
    // every Mac and Windows PC can use.
    const savedEngine = interview.state.settings.speechEngine;
    const engines = interview.state.whisper.live?.installed ? ["apple", "whisper"] : ["whisper"];
    const downloaded = interview.state.whisper.ready;
    for (const engine of engines) {
      await interview.request("setting", { key: "speechEngine", value: engine });
      await interview.request("clear");
      // Apple needs no Whisper model: listening starts as if none were on disk.
      if (engine === "apple") interview.state.whisper.ready = false;
      try {
        await interview.request("recording", true);
      } finally {
        interview.state.whisper.ready = downloaded;
      }
      const used = interview.state.whisper.engine;
      // The whole sample arrives at once; the words reach the transcript.
      await interview.audio(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
      let partial = "";
      await until(
        () => {
          partial ||= interview.state.whisper.partial;
          return interview.state.transcript.some((t) => /country/i.test(t.text));
        },
        60000,
        `${engine} did not transcribe the sample`,
      );
      await interview.request("stop");
      if (engine === "apple") {
        check("Apple's live transcription listens without Whisper and reaches the transcript", () => {
          assert.equal(used, "apple");
          assert.match(interview.state.transcript.map((t) => t.text).join(" "), /fellow Americans.*country/i);
        });
        check("Apple's words show before they are final", () => assert.match(partial, /\w/));
      } else
        check("Real Whisper audio reaches the transcript", () => {
          assert.equal(used, "whisper");
          assert.ok(interview.state.transcript.length);
        });
      check(`Stopping ${engine === "apple" ? "Apple's transcription" : "Whisper"} clears the live words`, () => {
        assert.equal(interview.state.whisper.partial, "");
        assert.equal(interview.state.whisper.engine, null);
      });
    }
    await interview.request("setting", { key: "speechEngine", value: savedEngine });
    await delay(300);
    const rendered = await js(`document.getElementById("transcript").textContent`);
    check("The transcript reaches Buddy", () => assert.match(rendered, /country/i));
    if (has("--live-ai-test")) {
      await interview.request(
        "answer",
        "What is the difference between a list and a tuple in Python? Answer briefly.",
      );
      await delay(400);
      const response = await js(`document.getElementById("answer").textContent`);
      check("A live ChatGPT answer reaches Buddy", () => {
        assert.ok(response.length > 80);
        assert.match(response, /tuple/i);
      });
    }
  }

  if (has("--audio-test")) {
    if (!interview.state.whisper.ready)
      throw new Error("The audio test requires --interview-test");
    await interview.request("clear");
    const raw = await fs.readFile(process.env.CAPTURE_LAB_TEST_AUDIO);
    const previousCount = interview.state.transcript.length;
    // Test input only: a public recording enters a real MediaStream and
    // AudioWorklet in the engine. It does not establish physical microphone access.
    await engine.webContents.executeJavaScript(
      `window.__originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async () => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(raw.toString("base64"))}), c => c.charCodeAt(0));
        const samples = new Float32Array(bytes.buffer);
        const ctx = new AudioContext({ sampleRate: 16000 }); window.__fixtureAudioContext = ctx;
        const buffer = ctx.createBuffer(1, samples.length, 16000); buffer.copyToChannel(samples, 0);
        const source = ctx.createBufferSource(); source.buffer = buffer;
        const destination = ctx.createMediaStreamDestination(); source.connect(destination);
        await ctx.resume(); source.start(); return destination.stream;
      }; void 0;`,
      true,
    );
    try {
      const micChip = `document.querySelector('[data-source="microphone"]').click()`;
      await js(micChip);
      await until(() => interview.state.recording && !audioControl.busy);
      check("Buddy's Microphone chip starts the hidden audio engine", () => {
        assert.equal(interview.state.source, "microphone");
        assert.equal(engine.isVisible(), false);
      });
      await delay(1500);
      setHidden(true);
      await delay(1500);
      check("Hiding Buddy keeps listening", () => {
        assert.equal(buddy.isVisible(), false);
        assert.equal(interview.state.recording, true);
      });
      setHidden(false);
      await delay(800);
      check("Audio level reaches Buddy", () => assert.ok(audioControl.peak > 0.02));
      if (interview.state.whisper.engine === "apple") {
        let words = "";
        for (let i = 0; i < 40 && !words; i++) {
          words = await js(`document.querySelector("#transcript .line.live p")?.textContent || ""`);
          if (!words) await delay(100);
        }
        check("Buddy shows the microphone's words while they are spoken", () =>
          assert.match(words, /\w/),
        );
      }
      await shot("buddy-listening-live.png");
      const live = await js(
        `document.querySelector('[data-source="microphone"]').classList.contains("live")`,
      );
      check("The live chip turns into Stop", () => assert.equal(live, true));
      await js(micChip);
      await until(() => !interview.state.recording && !audioControl.busy);
      await until(() => !interview.state.whisper.pending, 30000);
      const tail = interview.state.transcript
        .slice(previousCount)
        .map((item) => item.text)
        .join(" ");
      check("Stopping keeps the last words", () =>
        assert.match(tail, /fellow|Americans|country/i),
      );
      await delay(300);
      const shown = await js(`document.getElementById("transcript").textContent`);
      check("Live transcript is available in Buddy", () =>
        assert.match(shown, /fellow|Americans|country/i),
      );
    } finally {
      await engine.webContents.executeJavaScript(
        `navigator.mediaDevices.getUserMedia = window.__originalGetUserMedia; window.__fixtureAudioContext?.close(); delete window.__fixtureAudioContext; delete window.__originalGetUserMedia;`,
      );
    }
  }

  if (has("--system-audio-test") && process.platform === "darwin") {
    await interview.request("clear");
    const callChip = `document.querySelector('[data-source="system"]').click()`;
    await js(callChip);
    await until(() => interview.state.recording && !audioControl.busy);
    await fs.writeFile(path.join(artifactDir, "native-audio-ready"), "ready");
    await delay(14500);
    await js(callChip);
    await until(
      () =>
        !interview.state.recording &&
        !audioControl.busy &&
        !interview.state.whisper.pending,
      30000,
    );
    check("Call audio captures real external playback", () => {
      assert.ok(audioControl.peak > 0.02);
      assert.match(
        interview.state.transcript.map((t) => t.text).join(" "),
        /country|fellow|Americans/i,
      );
    });
  }

  if (has("--vision-test")) {
    const fixture = new BrowserWindow({
      width: 820,
      height: 520,
      title: "Screening coding fixture",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await fixture.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          '<!doctype html><html><head><title>Screening coding fixture</title></head><body style="font:22px -apple-system,Segoe UI,sans-serif;padding:35px;background:#fff;color:#182333"><p style="font-size:12px;color:#777">SYNTHETIC INTERVIEW TASK</p><h1 style="font-size:30px">Pair sum</h1><p>Write a Python function that returns all unique pairs<br>from this list whose sum is 31.</p><pre style="padding:24px;background:#eff2f7;border-radius:8px">[4, 8, 15, 16, 23, 42]</pre><p>Use each list element at most once per pair.</p></body></html>',
        ),
    );
    const previous = clipboard.readText();
    try {
      fixture.show();
      await delay(800);
      await interview.request("clear");
      await click("snapshot");
      let found = false;
      for (let i = 0; i < 10 && !found; i++) {
        await delay(450);
        found = await js(
          `[...document.querySelectorAll(".window-option")].some(b => b.title === "Screening coding fixture")`,
        );
      }
      assert.equal(found, true);
      // Only the synthetic entry is kept in the published screenshot.
      await js(
        `document.querySelectorAll(".window-option").forEach(b => { if (b.title !== "Screening coding fixture") b.remove() })`,
      );
      await shot("buddy-picker.png");
      await js(`document.querySelector(".window-option").click()`);
      await until(() => interview.state.attachment, 10000);
      check("A picked window becomes one readable attachment", () => {
        assert.ok(interview.state.attachment.dataUrl.startsWith("data:image/png;base64,"));
        assert.ok(interview.state.attachment.width >= 800);
      });
      await interview.request("setting", { key: "interviewType", value: "coding" });
      async function send(question) {
        const before = interview.state.messages.length;
        await js(`(() => { const field = document.getElementById("question-input");
          field.value = ${JSON.stringify(question)};
          document.getElementById("composer").requestSubmit(); })()`);
        await until(
          () =>
            interview.state.messages.length === before + 2 && !interview.state.ai.busy,
          120000,
          "No answer from ChatGPT",
        );
        if (interview.state.ai.error) throw new Error(interview.state.ai.error);
      }
      await send("Read the task in the attached snapshot. Solve it in Python and list the pairs.");
      check("Live ChatGPT reads the snapshot", () => {
        assert.match(interview.state.ai.answer, /8[\s\S]{0,20}23|23[\s\S]{0,20}8/);
        assert.match(interview.state.ai.answer, /15[\s\S]{0,20}16|16[\s\S]{0,20}15/);
        assert.match(interview.state.ai.answer, /```/);
        assert.equal(interview.state.attachment, null);
      });
      await send("Now change the target sum to 46 with the same list. Which pairs do you get?");
      check("A follow-up uses the earlier turn", () =>
        assert.match(interview.state.ai.answer, /4[\s\S]{0,20}42|42[\s\S]{0,20}4/),
      );
      await js(pin);
      await delay(400);
      const view = await probe();
      check("Buddy keeps both turns", () => assert.equal(view.turns, "2 of 2"));
      await click("copy");
      await delay(200);
      check("Copy takes the shown answer", () =>
        assert.equal(clipboard.readText(), interview.state.ai.answer),
      );
      await shot("buddy-vision-answer.png");
      await js(pin);
    } finally {
      clipboard.writeText(previous);
      fixture.destroy();
    }
  }

  const captureResults = [];
  if (has("--capture-test")) {
    captureResults.push(await runCapture("electron"));
    if (process.platform === "darwin") captureResults.push(await runCapture("sck"));
    // The menu bar as screen capture sees it: the icon is there, Buddy is not.
    const display = screen.getPrimaryDisplay();
    if (process.platform === "darwin") {
      const icon = tray.getBounds();
      check("The menu-bar icon has a place in the menu bar", () =>
        assert.ok(icon.width > 0 && icon.height > 0),
      );
    }
    await delay(600);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.ceil(display.size.width * display.scaleFactor),
        height: Math.ceil(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((s) => s.display_id === String(display.id));
    if (source && !source.thumbnail.isEmpty()) {
      const scale = source.thumbnail.getSize().width / display.bounds.width;
      await fs.writeFile(
        path.join(artifactDir, "menubar-capture.png"),
        source.thumbnail
          .crop({
            x: 0,
            y: 0,
            width: source.thumbnail.getSize().width,
            height: Math.round(80 * scale),
          })
          .toPNG(),
      );
      await shot("menubar-buddy.png");
    }
  }
  check("Buddy and the engine ran without script errors", () =>
    assert.deepEqual(scriptErrors, []),
  );
  await fs.writeFile(
    path.join(artifactDir, "verification.json"),
    JSON.stringify(
      {
        checks,
        shortcuts: state.shortcuts,
        captureResults,
        note: "Screenshots use capturePage and cannot establish OS capture exclusion.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: checks.length,
      permission: permission(),
      captures: captureResults.map((r) => ({ path: r.capturePath, outcome: r.outcome })),
      artifactDir,
    }),
  );
};
