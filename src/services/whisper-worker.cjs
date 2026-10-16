const { parentPort, workerData } = require("node:worker_threads");
const os = require("node:os");
const { SpeechGate } = require("./speech-gate.cjs");
const speechGate = new SpeechGate();
let recognizer, TensorClass;
async function load() {
  if (recognizer) return recognizer;
  const { pipeline, env, Tensor } = await import("@huggingface/transformers");
  TensorClass = Tensor;
  env.cacheDir = workerData.cacheDir;
  env.allowLocalModels = false;
  env.backends.onnx.wasm.numThreads = Math.min(4, os.availableParallelism());
  let last = 0;
  recognizer = await pipeline(
    "automatic-speech-recognition",
    "onnx-community/whisper-base",
    {
      device: "cpu",
      dtype: "q8",
      session_options: {
        intraOpNumThreads: Math.min(4, os.availableParallelism()),
        interOpNumThreads: 1,
      },
      progress_callback: (data) => {
        if (Date.now() - last > 150 || data.status === "ready") {
          last = Date.now();
          parentPort.postMessage({
            type: "progress",
            status: data.status,
            file: data.file,
            progress: data.progress,
          });
        }
      },
    },
  );
  await speechGate.load();
  parentPort.postMessage({ type: "ready" });
  return recognizer;
}
let queue = Promise.resolve();
parentPort.on("message", (data) => {
  queue = queue.then(async () => {
    try {
      const model = await load();
      if (data.type === "load") return;
      const samples = new Float32Array(data.samples);
      let energy = 0;
      for (const s of samples) energy += s * s;
      if (Math.sqrt(energy / samples.length) < 0.0025) {
        parentPort.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      if (!(await speechGate.hasSpeech(samples))) {
        parentPort.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      const options = {
        task: "transcribe",
        return_timestamps: false,
        chunk_length_s: 25,
        stride_length_s: 3,
        max_new_tokens: 180,
      };
      // One decoder step supplies both no-speech confidence and language logits.
      const features = await model.processor(samples);
      const config = model.model.generation_config;
      const output = await model.model({
        ...features,
        decoder_input_ids: new TensorClass(
          "int64",
          BigInt64Array.of(BigInt(config.decoder_start_token_id)),
          [1, 1],
        ),
      });
      const logits = output.logits,
        offset = logits.data.length - logits.dims.at(-1);
      let maximum = -Infinity,
        sum = 0;
      for (let i = offset; i < logits.data.length; i++)
        maximum = Math.max(maximum, logits.data[i]);
      for (let i = offset; i < logits.data.length; i++)
        sum += Math.exp(logits.data[i] - maximum);
      const noSpeechId = model.tokenizer.convert_tokens_to_ids("<|nospeech|>");
      const noSpeechProbability =
        Math.exp(logits.data[offset + noSpeechId] - maximum) / sum;
      if (noSpeechProbability > 0.6) {
        parentPort.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      if (data.language && data.language !== "auto")
        options.language = data.language;
      else {
        let best = "en",
          score = -Infinity;
        for (const [token, id] of Object.entries(config.lang_to_id)) {
          const value = logits.data[offset + id];
          if (value > score) {
            score = value;
            best = token.slice(2, -2);
          }
        }
        options.language = best;
      }
      const result = await model(samples, options);
      parentPort.postMessage({
        type: "text",
        id: data.id,
        text: result.text.trim(),
      });
    } catch (e) {
      parentPort.postMessage({ type: "error", id: data.id, error: e.message });
    }
  });
});
