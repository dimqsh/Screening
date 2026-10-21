const fs = require("node:fs");
const path = require("node:path");
const { binaryPath } = require("../src/services/assistant.cjs");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "build", "codex");
// --arch x64 or --arch arm64 copies that Mac's runtime; the default is this machine's.
const arch = process.argv.includes("--arch")
  ? process.argv[process.argv.indexOf("--arch") + 1]
  : process.arch;
let source;
try {
  source = binaryPath(arch);
} catch {
  const version = require("@openai/codex/package.json").version;
  throw new Error(
    `The ${process.platform}-${arch} Codex runtime is not installed. Run: ` +
      `npm install --no-save --force @openai/codex-${process.platform}-${arch}@npm:@openai/codex@${version}-${process.platform}-${arch}`,
  );
}
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(
  source,
  path.join(target, process.platform === "win32" ? "codex.exe" : "codex"),
);
if (process.platform !== "win32")
  fs.chmodSync(path.join(target, "codex"), 0o755);
const license = path.join(root, "assets", "licenses", "Codex-LICENSE");
if (fs.existsSync(license))
  fs.copyFileSync(license, path.join(target, "LICENSE"));
console.log(`Prepared the ${process.platform}-${arch} AI runtime`);
