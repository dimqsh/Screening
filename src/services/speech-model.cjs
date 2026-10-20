// The local speech models, in one place. The worker loads one, the startup
// check finds it on disk, and setup and the menu show its download size.
const path = require("node:path");
const os = require("node:os");

// File suffixes Transformers.js uses for each ONNX dtype.
const SUFFIX = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  int8: "_int8",
  uint8: "_uint8",
  q4: "_q4",
  q4f16: "_q4f16",
};

const SPEECH_MODELS = {
  // 8-bit encoder, 4-bit decoder: as accurate as all 4-bit on our tests and
  // about a third faster on Apple Silicon (3.5 s per 8 s chunk on an M3 Pro).
  accurate: {
    key: "accurate",
    label: "Accurate",
    id: "onnx-community/whisper-large-v3-turbo",
    dtype: { encoder_model: "q8", decoder_model_merged: "q4" },
    downloadMB: 979,
  },
  fast: {
    key: "fast",
    label: "Fast",
    id: "onnx-community/whisper-base",
    dtype: "q8",
    downloadMB: 77,
  },
};

// The accurate model needs Apple Silicon to keep up with live speech, and
// enough memory: it holds about 2.4 GB while listening, so 8 GB Macs swap.
const ACCURATE_MIN_MEMORY = 15.5 * 1024 ** 3;
function defaultModelKey(
  platform = process.platform,
  arch = process.arch,
  memory = os.totalmem(),
) {
  return platform === "darwin" && arch === "arm64" && memory >= ACCURATE_MIN_MEMORY
    ? "accurate"
    : "fast";
}
function speechModel(key) {
  return SPEECH_MODELS[key] || SPEECH_MODELS[defaultModelKey()];
}
const SPEECH_MODEL = speechModel(defaultModelKey());

function modelFiles(cacheDir, model = SPEECH_MODEL) {
  const [owner, name] = model.id.split("/");
  return ["encoder_model", "decoder_model_merged"].map((file) => {
    const dtype = typeof model.dtype === "string" ? model.dtype : model.dtype[file];
    const suffix = SUFFIX[dtype];
    if (suffix === undefined) throw new Error(`Unknown model dtype ${dtype}`);
    return path.join(cacheDir, owner, name, "onnx", `${file}${suffix}.onnx`);
  });
}
const formatSize = (mb) =>
  mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;

module.exports = {
  SPEECH_MODEL,
  SPEECH_MODELS,
  defaultModelKey,
  speechModel,
  modelFiles,
  formatSize,
};
