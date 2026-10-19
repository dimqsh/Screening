const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNotch,
  estimateNotch,
  islandLayout,
} = require("../src/services/notch.cjs");
const { deriveBuddy, formatElapsed } = require("../src/buddy-model.js");

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
  assert.equal(window.width, 620);
  assert.equal(window.height, 460);
  assert.equal(window.x + window.width / 2, 666 + 90);
  assert.equal(layout.hasNotch, true);
  assert.equal(layout.notchWidth, 180);
  assert.equal(layout.notchHeight, 32);
  assert.equal(layout.notchLeft, (620 - 180) / 2);
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
