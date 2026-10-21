const ort = require("onnxruntime-node");
const fs = require("node:fs");
const path = require("node:path");
class SpeechGate {
  async load() {
    this.session = await ort.InferenceSession.create(
      new Uint8Array(
        fs.readFileSync(
          path.join(
            __dirname,
            "..",
            "..",
            "assets",
            "models",
            "silero_vad.onnx",
          ),
        ),
      ),
      {
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        executionProviders: ["cpu"],
      },
    );
  }
  async hasSpeech(samples) {
    let state = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]);
    let context = new Float32Array(64),
      voiced = 0,
      consecutive = 0,
      longest = 0;
    const sr = new ort.Tensor("int64", BigInt64Array.of(16000n), []);
    for (let offset = 0; offset < samples.length; offset += 512) {
      const frame = new Float32Array(576);
      frame.set(context);
      frame.set(samples.subarray(offset, offset + 512), 64);
      const out = await this.session.run({
        input: new ort.Tensor("float32", frame, [1, 576]),
        state,
        sr,
      });
      state = out.stateN;
      context = frame.slice(-64);
      if (out.output.data[0] > 0.5) {
        voiced++;
        consecutive++;
        longest = Math.max(longest, consecutive);
      } else consecutive = 0;
      // Both counts only grow, so the rest of the chunk cannot change this.
      if (voiced >= 8 && longest >= 4) return true;
    }
    return false;
  }
}
module.exports = { SpeechGate };
