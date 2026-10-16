const fs = require("node:fs");
const path = require("node:path");
const { binaryPath } = require("../src/services/assistant.cjs");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "build", "codex");
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(
  binaryPath(),
  path.join(target, process.platform === "win32" ? "codex.exe" : "codex"),
);
if (process.platform !== "win32")
  fs.chmodSync(path.join(target, "codex"), 0o755);
const license = path.join(root, "assets", "licenses", "Codex-LICENSE");
if (fs.existsSync(license))
  fs.copyFileSync(license, path.join(target, "LICENSE"));
console.log("Prepared platform AI runtime");
