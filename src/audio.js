/* Audio remains PCM in memory. No recording file or network upload is created. */
window.audioCapture = (() => {
  let context,
    stream,
    processor,
    sink,
    source,
    resample,
    sending = Promise.resolve(),
    stopping = false,
    lastLevelAt = 0;
  // Audio streams to the main process as it arrives (about every 85 ms), so
  // Apple's live transcription can write words while they are spoken. For
  // Whisper, the main process cuts the stream into phrases.
  function send(samples) {
    const output = resample(samples);
    if (!output.length) return;
    sending = sending
      .then(() => window.captureLab.audio(output.buffer))
      .catch((e) =>
        window.dispatchEvent(new CustomEvent("audioerror", { detail: e.message })),
      );
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      stream?.getTracks().forEach((t) => t.stop());
      if (processor) processor.port.onmessage = null;
      processor?.disconnect();
      source?.disconnect();
      sink?.disconnect();
      if (context) {
        await sending.catch(() => {});
        await context.close();
      }
      await window.captureLab.request("stop");
    } finally {
      context = null;
      stream = null;
      resample = null;
      stopping = false;
    }
  }
  async function start(kind) {
    if (context) throw new Error("Audio is already running");
    try {
      stream =
        kind === "system"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: true,
            })
          : await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
      if (!stream.getAudioTracks().length)
        throw new Error("No audio track. Choose a source with audio.");
      context = new AudioContext();
      await context.audioWorklet.addModule("audio-worklet.js");
      source = context.createMediaStreamSource(stream);
      processor = new AudioWorkletNode(context, "capture-processor");
      sink = context.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);
      resample = window.Segmenter.createResampler(context.sampleRate);
      await window.captureLab.request("recording", {
        active: true,
        source: kind,
      });
      processor.port.onmessage = (event) => {
        if (performance.now() - lastLevelAt > 200) {
          let energy = 0;
          for (let i = 0; i < event.data.length; i += 16)
            energy += event.data[i] ** 2;
          window.captureLab.level(
            Math.min(
              1,
              Math.sqrt(energy / Math.ceil(event.data.length / 16)) * 12,
            ),
          );
          lastLevelAt = performance.now();
        }
        send(event.data);
      };
      stream.getAudioTracks()[0].addEventListener("ended", () => stop());
      await context.resume();
    } catch (e) {
      await stop();
      throw e;
    }
  }
  window.captureLab.onAudioCommand(async ({ id, action, kind }) => {
    try {
      if (action === "start") await start(kind);
      else if (action === "stop") await stop();
      else throw new Error("Unknown audio command");
      await window.captureLab.audioComplete(id, null);
    } catch (error) {
      await window.captureLab.audioComplete(id, error.message);
    }
  });
  return { start, stop, active: () => !!context };
})();
