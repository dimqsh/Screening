const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
if (process.platform !== "darwin") {
  console.log(
    "ScreenCaptureKit helper is macOS-only; Electron path remains available.",
  );
  process.exit(0);
}
const root = path.resolve(__dirname, "..");
const arch = process.arch === "arm64" ? "arm64" : "x86_64";
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    `${arch}-apple-macosx14.0`,
    path.join(__dirname, "capture-sck.swift"),
    "-o",
    path.join(root, "bin/capture-sck"),
  ],
  { stdio: "inherit" },
);
execFileSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-O",
    "-target",
    `${arch}-apple-macosx14.0`,
    path.join(__dirname, "audio-sck.swift"),
    "-o",
    path.join(root, "bin/audio-sck"),
  ],
  { stdio: "inherit" },
);
