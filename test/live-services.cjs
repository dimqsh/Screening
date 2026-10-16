const path = require("node:path");
const fs = require("node:fs");
const { Assistant } = require("../src/services/assistant.cjs");
const { Transcription } = require("../src/services/transcription.cjs");
const cache = path.resolve(
  process.env.CAPTURE_LAB_MODEL_CACHE || "../model-cache",
);
if (process.argv.includes("--ai")) {
  (async () => {
    const ai = new Assistant((s) =>
      console.log(
        JSON.stringify({ status: s.status, busy: s.busy, error: s.error }),
      ),
    );
    await ai.status();
    const answer = await ai.answer({
      question:
        "Explain HTTP idempotency in an interview, with one short example.",
      language: "en",
    });
    console.log(JSON.stringify({ answer }));
    ai.close();
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
} else {
  let started = false;
  const stt = new Transcription(
    cache,
    async (s) => {
      if (s.progress !== null)
        console.log(
          JSON.stringify({
            status: s.status,
            file: s.file,
            progress: Math.round(s.progress),
          }),
        );
      if (s.ready && !started) {
        started = true;
        try {
          const raw = fs.readFileSync(process.argv[2]);
          const samples = new Float32Array(
            raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
          );
          const start = Date.now();
          const text = await stt.transcribe(samples, process.argv[3] || "auto");
          console.log(
            JSON.stringify({ text, milliseconds: Date.now() - start }),
          );
          stt.close();
        } catch (e) {
          console.error(e);
          stt.close();
          process.exitCode = 1;
        }
      }
    },
    () => {},
  );
  stt.load();
}
