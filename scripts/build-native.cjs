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
// Builds for this Mac; pass arm64 or x64 to build for the other one.
const target = process.argv[2] || process.arch;
const arch = { arm64: "arm64", x64: "x86_64" }[target];
if (!arch) throw new Error(`Unsupported Mac architecture: ${target}`);
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
for (const helper of ["capture-sck", "audio-sck", "notch-info"])
  execFileSync(
    "xcrun",
    [
      "swiftc",
      "-parse-as-library",
      "-O",
      "-target",
      `${arch}-apple-macosx14.0`,
      path.join(__dirname, `${helper}.swift`),
      "-o",
      path.join(root, "bin", helper),
    ],
    { stdio: "inherit" },
  );
