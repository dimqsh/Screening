const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { clipboard } = require("electron");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, timeout = 20000) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeout)
      throw new Error("Compact audio transition timed out");
    await delay(100);
  }
}
module.exports = async ({
  lab,
  overlay,
  interview,
  action,
  audioControl,
  artifactDir,
  check,
}) => {
  const controls = await overlay.webContents.executeJavaScript(
    `['record','audio-source','chat','question-form','question','choose-window','paste-question','notes','load-model','login'].every(id => document.getElementById(id))`,
  );
  check(
    "Compact window contains audio, chat, snapshot, paste and setup controls",
    () => assert.equal(controls, true),
  );
  const previous = {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
  };
  const image = clipboard.readImage();
  if (!image.isEmpty()) previous.image = image;
  try {
    clipboard.writeText("Compact: Привет\n    return 42");
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#question').value=''; document.querySelector('#paste-question').click()`,
    );
    await delay(250);
    const pasted = await overlay.webContents.executeJavaScript(
      `document.querySelector('#question').value`,
    );
    check("Compact paste works through the owned IPC bridge", () =>
      assert.equal(pasted, "Compact: Привет\n    return 42"),
    );
    const shared = await lab.webContents.executeJavaScript(
      `document.querySelector('#question').value`,
    );
    check(
      "Question draft is shared when switching between the two windows",
      () => assert.equal(shared, pasted),
    );
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#question').value='';document.querySelector('#question').dispatchEvent(new Event('input',{bubbles:true}))`,
    );
    await delay(200);
  } finally {
    clipboard.write(previous);
  }
  if (!interview.state.whisper.ready)
    throw new Error("Compact audio test requires --interview-test");
  const raw = await fs.readFile(process.env.CAPTURE_LAB_TEST_AUDIO);
  const previousCount = interview.state.transcript.length;
  // Test input only: a known public recording enters a real MediaStream and AudioWorklet.
  // This does not establish access to a physical microphone.
  await lab.webContents.executeJavaScript(
    `window.__originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(raw.toString("base64"))}), c=>c.charCodeAt(0));
      const samples = new Float32Array(bytes.buffer);
      const ctx = new AudioContext({sampleRate:16000}); window.__fixtureAudioContext = ctx;
      const buffer=ctx.createBuffer(1,samples.length,16000); buffer.copyToChannel(samples,0);
      const source=ctx.createBufferSource();source.buffer=buffer;
      const destination=ctx.createMediaStreamDestination(); source.connect(destination);
      await ctx.resume(); source.start(); return destination.stream;
    }; void 0;`,
    true,
  );
  try {
    await action("compact");
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#audio-source').value='microphone'; document.querySelector('#record').click()`,
    );
    await until(() => interview.state.recording && !audioControl.busy);
    check(
      "Compact record starts shared audio while workspace stays hidden",
      () => {
        assert.equal(lab.isVisible(), false);
        assert.equal(interview.state.source, "microphone");
      },
    );
    await delay(1500);
    lab.close();
    check(
      "Closing the workspace keeps the audio owner and compact controls alive",
      () => {
        assert.equal(lab.isDestroyed(), false);
        assert.equal(overlay.isVisible(), true);
        assert.equal(interview.state.recording, true);
      },
    );
    await action("hide-all");
    check("Emergency hide removes both windows while audio continues", () => {
      assert.equal(lab.isVisible(), false);
      assert.equal(overlay.isVisible(), false);
      assert.equal(interview.state.recording, true);
    });
    await delay(1500);
    await action("recover");
    await delay(1500);
    const level = await overlay.webContents.executeJavaScript(
      `document.querySelector('#audio-level').value`,
    );
    check("Audio samples reach the compact input meter", () =>
      assert.ok(audioControl.peak > 0.02 || level > 0.02),
    );
    await overlay.webContents.executeJavaScript(
      `document.querySelector('#record').click()`,
    );
    await until(() => !interview.state.recording && !audioControl.busy);
    const active = await lab.webContents.executeJavaScript(
      `window.audioCapture.active()`,
    );
    const tail = interview.state.transcript
      .slice(previousCount)
      .map((t) => t.text)
      .join(" ");
    check(
      "Stopping in compact flushes sub-eight-second speech through real Whisper",
      () => {
        assert.equal(active, false);
        assert.match(tail, /fellow|Americans|country/i);
      },
    );
    const compactText = await overlay.webContents.executeJavaScript(
      `document.querySelector('#transcript').textContent`,
    );
    check("Transcript is available in the compact window", () =>
      assert.match(compactText, /fellow|Americans|country/i),
    );
    await fs.writeFile(
      path.join(artifactDir, "compact-audio-ui.png"),
      (await overlay.webContents.capturePage()).toPNG(),
    );
  } finally {
    await lab.webContents.executeJavaScript(
      `navigator.mediaDevices.getUserMedia=window.__originalGetUserMedia; window.__fixtureAudioContext?.close(); delete window.__fixtureAudioContext; delete window.__originalGetUserMedia;`,
    );
    await action("lab");
  }
  const bounds = overlay.getBounds();
  overlay.setSize(420, 580);
  await delay(150);
  const fit = await overlay.webContents.executeJavaScript(
    `({width:document.documentElement.scrollWidth<=innerWidth,composer:document.querySelector('#question-form').getBoundingClientRect().bottom<innerHeight,chat:document.querySelector('#chat').clientHeight>60})`,
  );
  check(
    "Compact minimum size keeps audio, chat and composer accessible",
    () => {
      assert.equal(fit.width, true);
      assert.equal(fit.composer, true);
      assert.equal(fit.chat, true);
    },
  );
  await fs.writeFile(
    path.join(artifactDir, "compact-minimum-ui.png"),
    (await overlay.webContents.capturePage()).toPNG(),
  );
  overlay.setBounds(bounds);
};
