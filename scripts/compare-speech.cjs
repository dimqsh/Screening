// Compares Apple's live transcription with Screening's Whisper pipeline on
// the same audio, in real time: each sample is written in 100 ms chunks, as
// call audio arrives, then 3 s of silence. The numbers in the README's "Live
// transcript" section come from this script.
//
//   node scripts/compare-speech.cjs apple             needs bin/live-speech (macOS 26)
//   node scripts/compare-speech.cjs whisper fast      needs the downloaded model
//   node scripts/compare-speech.cjs whisper accurate
//
// Run apple first: Whisper's word lag uses Apple's word timings for the same
// audio. Samples are spoken by macOS voices into build/speech-compare/, next
// to build/jfk.f32 from scripts/prepare-speech-test.cjs.
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { Transcription } = require("../src/services/transcription.cjs");
const { SPEECH_MODELS } = require("../src/services/speech-model.cjs");
const { createSegmenter } = require("../src/segmenter.js");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "build", "speech-compare");
const cache =
  process.env.CAPTURE_LAB_MODEL_CACHE ||
  path.join(process.env.HOME, "Library", "Application Support", "Capture Lab", "models");
const SAMPLES = {
  en: ["Samantha", "Tell me about a time you had to debug a difficult production issue. What steps did you take, and what did you learn from it? How would you design a rate limiter for a public API?"],
  ru: ["Milena", "Расскажите о проекте, которым вы больше всего гордитесь. Какие технические решения вы принимали и почему? Как бы вы спроектировали ограничение запросов для публичного API?"],
  es: ["Mónica", "Háblame de un proyecto del que estés orgulloso. ¿Qué decisiones técnicas tomaste y por qué? ¿Cómo diseñarías un limitador de peticiones para una API pública?"],
  de: ["Anna", "Erzählen Sie mir von einem Projekt, auf das Sie stolz sind. Welche technischen Entscheidungen haben Sie getroffen und warum? Wie würden Sie eine Ratenbegrenzung für eine öffentliche API entwerfen?"],
  uk: ["Lesya", "Розкажіть про проєкт, яким ви найбільше пишаєтеся. Які технічні рішення ви ухвалювали і чому? Як би ви спроєктували обмеження запитів для публічного API?"],
  kk: ["Aru", "Өзіңіз мақтан тұтатын жоба туралы айтып беріңіз. Қандай техникалық шешімдер қабылдадыңыз және неге? Ашық API үшін сұраулар шектеуін қалай жобалар едіңіз?"],
};
const REFERENCE = {
  jfk: "And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.",
  ...Object.fromEntries(Object.entries(SAMPLES).map(([name, [, text]]) => [name, text])),
};
const NAMES = ["jfk", ...Object.keys(SAMPLES)];
const language = (name) => (name === "jfk" ? "en" : name);

// 16 kHz mono float32, with half a second of silence before the speech.
function audio(name) {
  const file = name === "jfk" ? path.join(root, "build", "jfk.f32") : path.join(out, `${name}.f32`);
  if (!fs.existsSync(file) && name !== "jfk") {
    const wav = path.join(out, `${name}.wav`);
    execFileSync("say", ["-v", SAMPLES[name][0], "-o", wav, "--data-format=LEF32@16000", SAMPLES[name][1]]);
    const bytes = fs.readFileSync(wav);
    let offset = 12,
      data;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString("ascii", offset, offset + 4) === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    fs.writeFileSync(file, Buffer.concat([Buffer.alloc(16000 * 2), data]));
  }
  const raw = fs.readFileSync(file);
  const samples = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const padded = new Float32Array(samples.length + 16000 * 3);
  padded.set(samples);
  return padded;
}
// Chunk i is written once its 100 ms have "happened".
async function realtime(samples, write, onStart) {
  const start = performance.now();
  onStart(start);
  for (let i = 0; i * 1600 < samples.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, start + (i + 1) * 100 - performance.now())));
    write(samples.subarray(i * 1600, (i + 1) * 1600));
  }
}
const words = (text) =>
  text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
function wordErrorRate(reference, hypothesis) {
  const r = words(reference),
    h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN;
};
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

// Apple: when each word first shows, from its final word timings.
async function apple(name) {
  const child = spawn(path.join(root, "bin", "live-speech"), ["--locale", language(name), "--words"]);
  const events = [];
  let start = null,
    buffer = "",
    stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => child.on("close", resolve));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (line.type === "ready") resolve(line);
        else if (start !== null) events.push({ ...line, at: (performance.now() - start) / 1000 });
      }
    });
    closed.then((code) => reject(new Error(`exit ${code}: ${stderr.trim()}`)));
  });
  try {
    await ready;
  } catch (error) {
    return { name, error: error.message };
  }
  await realtime(audio(name), (chunk) => child.stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), (t) => (start = t));
  child.stdin.end();
  await closed;
  const finals = events.filter((e) => e.type === "final" && e.text);
  const timeline = finals.flatMap((e) => (e.words || []).filter((w) => w[0].trim()));
  const seen = [];
  let settled = 0;
  for (const e of events) {
    const visible = e.type === "final" ? (settled += words(e.text).length) : settled + words(e.text).length;
    for (let k = seen.length; k < Math.min(visible, timeline.length); k++) seen[k] = e.at;
  }
  const lags = seen.map((at, k) => at - timeline[k][2]);
  const text = finals.map((e) => e.text).join(" ");
  return { name, text, timeline, wer: wordErrorRate(REFERENCE[name], text), first: lags[0], median: quantile(lags, 0.5), p90: quantile(lags, 0.9), settled: mean(finals.map((e) => e.at - e.end)) };
}

// Whisper: phrases cut at pauses, as Screening does; a word shows when the
// phrase holding it is transcribed.
async function whisper(key) {
  let loaded;
  const ready = new Promise((resolve) => (loaded = resolve));
  const stt = new Transcription(cache, (s) => s.status === "ready" && stt.loaded && loaded(), () => {}, () => {}, SPEECH_MODELS[key]);
  stt.markDownloaded();
  stt.load();
  await ready;
  const apples = fs.existsSync(path.join(out, "apple.json")) ? JSON.parse(fs.readFileSync(path.join(out, "apple.json"))) : [];
  const results = [];
  const send = stt.send.bind(stt);
  for (const name of NAMES) {
    let start = performance.now(),
      cut = null;
    const now = () => (performance.now() - start) / 1000;
    const arrivals = [];
    stt.send = (samples, lang) => {
      const phrase = cut;
      return send(samples, lang).then((text) => arrivals.push({ ...phrase, at: now(), text: text || "" }));
    };
    const segmenter = createSegmenter({
      rate: 16000,
      onSegment: (phrase) => {
        // Where speech ended: the last loud 30 ms frame.
        let last = 0;
        for (let i = 0; i + 480 <= phrase.length; i += 480) {
          let energy = 0;
          for (let j = i; j < i + 480; j++) energy += phrase[j] ** 2;
          if (Math.sqrt(energy / 480) > 0.01) last = i + 480;
        }
        cut = { cutAt: now(), speechEnd: now() - (phrase.length - last) / 16000 };
        stt.feed(phrase, language(name));
      },
    });
    await realtime(audio(name), (chunk) => segmenter.push(chunk.slice()), (t) => (start = t));
    segmenter.flush();
    while (stt.feeding || stt.waiting || stt.pending.size) await new Promise((resolve) => setTimeout(resolve, 50));
    const text = arrivals.map((a) => a.text).join(" ");
    const timeline = apples.find((a) => a.name === name)?.timeline || [];
    const lags = timeline
      .map(([, , end]) => {
        const arrival = arrivals.find((a) => a.cutAt >= end);
        return arrival ? arrival.at - end : NaN;
      })
      .filter(Number.isFinite);
    results.push({ name, text, wer: wordErrorRate(REFERENCE[name], text), first: lags[0], median: quantile(lags, 0.5), p90: quantile(lags, 0.9), settled: mean(arrivals.map((a) => a.at - a.speechEnd)) });
  }
  stt.close();
  return results;
}

(async () => {
  const [engine, key] = process.argv.slice(2);
  if (engine !== "apple" && !SPEECH_MODELS[key]) throw new Error("Usage: compare-speech.cjs apple | whisper fast|accurate");
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  if (engine === "apple") for (const name of NAMES) results.push(await apple(name));
  else results.push(...(await whisper(key)));
  fs.writeFileSync(path.join(out, `${engine}${key ? "-" + key : ""}.json`), JSON.stringify(results, null, 1));
  const s = (x) => (Number.isFinite(x) ? x.toFixed(2) : "–");
  console.log("| Sample | Words wrong | First word | Word lag, median / p90 | Settled after speech | Text |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const r of results)
    console.log(`| ${r.name} | ${r.error ? "–" : Math.round(r.wer * 100) + "%"} | ${s(r.first)} | ${s(r.median)} / ${s(r.p90)} | ${s(r.settled)} | ${r.error || r.text} |`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
