/* Audio remains PCM in memory. No recording file or network upload is created. */
window.audioCapture = (() => {
  let context,
    stream,
    processor,
    sink,
    source,
    segmenter,
    sending = Promise.resolve(),
    stopping = false,
    lastLevelAt = 0;
  const downsample = (input, from) => {
    const ratio = from / 16000,
      out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio,
        left = Math.floor(pos),
        mix = pos - left;
      out[i] =
        input[left] * (1 - mix) +
        (input[Math.min(left + 1, input.length - 1)] || 0) * mix;
    }
    return out;
  };
  // Each phrase goes to Whisper as soon as the speaker pauses.
  function send(phrase) {
    const output = downsample(phrase, context.sampleRate);
    if (output.length < 1600) return;
    sending = sending
      .then(() => window.captureLab.audio(output.buffer))
      .catch((e) =>
        window.dispatchEvent(new CustomEvent("audioerror", { detail: e.message })),
      );
  }
  async function flush() {
    segmenter?.flush();
    await sending;
  }
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      stream?.getTracks().forEach((t) => t.stop());
      processor?.disconnect();
      source?.disconnect();
      sink?.disconnect();
      if (context) {
        await flush().catch(() => {});
        await context.close();
      }
      await window.captureLab.request("stop");
    } finally {
      context = null;
      stream = null;
      segmenter = null;
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
      segmenter = window.Segmenter.createSegmenter({
        rate: context.sampleRate,
        onSegment: send,
      });
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
        segmenter.push(event.data);
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
