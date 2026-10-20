// Cuts live audio into phrases at natural pauses, so each phrase reaches
// Whisper about half a second after the speaker stops, instead of waiting for
// a fixed eight-second block. Used by the audio engine (microphone) and the
// main process (call audio).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Segmenter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function createSegmenter({
    rate,
    onSegment,
    pauseSeconds = 0.6, // a pause this long after enough speech ends a phrase
    minSpeechSeconds = 1.2, // shorter speech waits for a longer pause
    longPauseSeconds = 1.4, // ends even a short phrase ("Yes.")
    maxSeconds = 10, // a phrase never grows past this
  }) {
    const frame = Math.max(1, Math.round(rate * 0.03));
    let chunks = [],
      count = 0,
      voiced = 0,
      quiet = 0,
      floor = 0.003,
      partial = new Float32Array(0);

    function emit() {
      const out = new Float32Array(count);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      const speech = voiced;
      chunks = [];
      count = 0;
      voiced = 0;
      quiet = 0;
      if (speech >= rate * 0.3) onSegment(out);
    }

    function frameDone(samples) {
      let energy = 0;
      for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
      const rms = Math.sqrt(energy / samples.length);
      const speaking = rms > Math.max(0.006, floor * 3);
      // The noise floor drops quickly and rises only on frames without speech,
      // so a long answer never starts to count as background noise.
      if (rms < floor) floor = floor * 0.9 + rms * 0.1;
      else if (!speaking) floor += (rms - floor) * 0.01;
      chunks.push(samples);
      count += samples.length;
      if (speaking) {
        voiced += samples.length;
        quiet = 0;
      } else quiet += samples.length;
      // Before any speech, keep only a short lead-in instead of the silence.
      if (!voiced && count > rate * 0.6) {
        while (count - chunks[0].length >= rate * 0.3) count -= chunks.shift().length;
        return;
      }
      if (
        count >= rate * maxSeconds ||
        (voiced >= rate * minSpeechSeconds && quiet >= rate * pauseSeconds) ||
        (voiced && quiet >= rate * longPauseSeconds)
      )
        emit();
    }

    return {
      push(samples) {
        let input = samples;
        if (partial.length) {
          input = new Float32Array(partial.length + samples.length);
          input.set(partial);
          input.set(samples, partial.length);
        }
        let i = 0;
        for (; i + frame <= input.length; i += frame)
          frameDone(input.slice(i, i + frame));
        partial = input.slice(i);
      },
      // Stop: whatever speech is left becomes the last phrase.
      flush() {
        if (partial.length) {
          chunks.push(partial);
          count += partial.length;
          partial = new Float32Array(0);
        }
        if (count) emit();
      },
    };
  }
  return { createSegmenter };
});
