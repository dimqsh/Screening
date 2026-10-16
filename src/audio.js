/* Audio remains PCM in memory. No recording file or network upload is created. */
window.audioCapture = (() => {
  let context,
    stream,
    processor,
    sink,
    source,
    samples = [],
    count = 0,
    stopping = false;
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
  async function flush() {
    if (!count) return;
    const input = new Float32Array(count);
    let offset = 0;
    for (const chunk of samples) {
      input.set(chunk, offset);
      offset += chunk.length;
    }
    samples = [];
    count = 0;
    const output = downsample(input, context.sampleRate);
    if (output.length >= 1600) await window.captureLab.audio(output.buffer);
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
      samples = [];
      count = 0;
      await window.captureLab.request("recording", true);
      processor.port.onmessage = (event) => {
        samples.push(event.data);
        count += event.data.length;
        if (count >= context.sampleRate * 8)
          flush().catch((e) =>
            window.dispatchEvent(
              new CustomEvent("audioerror", { detail: e.message }),
            ),
          );
      };
      stream.getAudioTracks()[0].addEventListener("ended", () => stop());
      await context.resume();
    } catch (e) {
      await stop();
      throw e;
    }
  }
  return { start, stop, active: () => !!context };
})();
