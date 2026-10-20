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
// macOS 15+ SDKs mark CGDisplayStream unavailable, so capture-legacy targets macOS 13.
const helpers = {
  "capture-sck": "14.0",
  "capture-legacy": "13.0",
  "audio-sck": "14.0",
  "notch-info": "14.0",
};
for (const [helper, macos] of Object.entries(helpers))
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-target",
      `${arch}-apple-macosx${macos}`,
      path.join(__dirname, `${helper}.swift`),
      "-o",
      path.join(root, "bin", helper),
    ],
    { stdio: "inherit" },
  );
