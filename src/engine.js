// The engine has no UI. It reports capture errors and stops audio that the
// rest of the app no longer considers active.
window.addEventListener("audioerror", (event) =>
  window.captureLab.request("audio-error", String(event.detail || "")),
);
// Stop only on a real change from listening to not listening. Updates sent
// while a start is still in progress say "not listening" and must not stop it.
let wasRecording = false;
window.captureLab.subscribe((snapshot) => {
  const recording = Boolean(snapshot.interview?.recording);
  if (wasRecording && !recording && window.audioCapture.active())
    window.audioCapture.stop().catch(() => {});
  wasRecording = recording;
});
