// Runs as an Electron utility process in the app (its own process, at a lower
// CPU priority) or as a worker thread. Both talk through the same small port.
const threads = require("node:worker_threads");
const utility = process.parentPort;
const port = utility
  ? {
      postMessage: (message) => utility.postMessage(message),
      on: (_event, listener) => utility.on("message", (event) => listener(event.data)),
    }
  : threads.parentPort;
const workerData = utility
  ? JSON.parse(process.argv[process.argv.length - 1])
  : threads.workerData;
const os = require("node:os");
const { SpeechGate } = require("./speech-gate.cjs");
const { SPEECH_MODEL } = require("./speech-model.cjs");
const MODEL = workerData.model || SPEECH_MODEL;
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
    MODEL.id,
    {
      device: "cpu",
      dtype: MODEL.dtype,
      session_options: {
        intraOpNumThreads: Math.min(4, os.availableParallelism()),
        interOpNumThreads: 1,
        // Measured: same speed, 400–600 MB less held after transcribing.
        enableCpuMemArena: false,
      },
      progress_callback: (data) => {
        if (Date.now() - last > 150 || data.status === "ready") {
          last = Date.now();
          port.postMessage({
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
  port.postMessage({ type: "ready" });
  return recognizer;
}
let queue = Promise.resolve();
port.on("message", (data) => {
  queue = queue.then(async () => {
    try {
      const model = await load();
      if (data.type === "load") return;
      const samples = new Float32Array(data.samples);
      let energy = 0;
      for (const s of samples) energy += s * s;
      if (Math.sqrt(energy / samples.length) < 0.0025) {
        port.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      if (!(await speechGate.hasSpeech(samples))) {
        port.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      // The encoder is the expensive part, so it runs once per chunk and its
      // output feeds both the first decoder step and the full decode.
      const features = await model.processor(samples);
      const config = model.model.generation_config;
      const { encoder_outputs } =
        await model.model._prepare_encoder_decoder_kwargs_for_generation({
          inputs_tensor: features.input_features,
          model_inputs: { ...features },
          model_input_name: "input_features",
          generation_config: config,
        });
      // One decoder step supplies both no-speech confidence and language logits.
      const output = await model.model({
        ...features,
        encoder_outputs,
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
      const noSpeechProbability = Number.isInteger(noSpeechId)
        ? Math.exp(logits.data[offset + noSpeechId] - maximum) / sum
        : 0;
      if (noSpeechProbability > 0.6) {
        port.postMessage({ type: "text", id: data.id, text: "" });
        return;
      }
      let language = data.language;
      if (!language || language === "auto") {
        let score = -Infinity;
        language = "en";
        for (const [token, id] of Object.entries(config.lang_to_id)) {
          const value = logits.data[offset + id];
          if (value > score) {
            score = value;
            language = token.slice(2, -2);
          }
        }
      }
      const ids = await model.model.generate({
        inputs: features.input_features,
        encoder_outputs,
        language,
        task: "transcribe",
        return_timestamps: false,
        max_new_tokens: 180,
      });
      const [text] = model.tokenizer.batch_decode(ids, {
        skip_special_tokens: true,
      });
      port.postMessage({ type: "text", id: data.id, text: text.trim() });
    } catch (e) {
      port.postMessage({ type: "error", id: data.id, error: e.message });
    }
  });
});
