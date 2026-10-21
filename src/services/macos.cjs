const os = require("node:os");

// Darwin 23.2 is macOS 14.2, the first with Core Audio process taps, so call
// audio needs only System Audio Recording. Darwin 24 is macOS 15, where the
// system window picker lets a snapshot skip screen recording access.
function darwin(release) {
  const [major = 0, minor = 0] = String(release).split(".").map(Number);
  return { major, minor };
}

function hasAudioTap(platform = process.platform, release = os.release()) {
  if (platform !== "darwin") return false;
  const { major, minor } = darwin(release);
  return major > 23 || (major === 23 && minor >= 2);
}

function hasSystemPicker(platform = process.platform, release = os.release()) {
  return platform === "darwin" && darwin(release).major >= 24;
}

// Darwin 25 is macOS 26, the first with SpeechAnalyzer: live, word-by-word
// transcription on the Mac.
function hasLiveSpeech(platform = process.platform, release = os.release()) {
  return platform === "darwin" && darwin(release).major >= 25;
}

module.exports = { hasAudioTap, hasSystemPicker, hasLiveSpeech };
