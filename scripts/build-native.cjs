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
// --presentation-tests adds the native helpers of the protected display test.
const target = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || process.arch;
const arch = { arm64: "arm64", x64: "x86_64" }[target];
if (!arch) throw new Error(`Unsupported Mac architecture: ${target}`);
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
// Core Audio process taps arrived in macOS 14.2, SpeechAnalyzer in macOS 26;
// macOS 15+ SDKs mark CGDisplayStream unavailable, so capture-legacy targets
// macOS 13; the rest run on 14.0.
const helpers = {
  "capture-sck": "14.0",
  "capture-legacy": "13.0",
  "audio-sck": "14.0",
  "audio-tap": "14.2",
  "notch-info": "14.0",
  "live-speech": "26.0",
};
const sdkVersion = (env) =>
  parseFloat(execFileSync("xcrun", ["--show-sdk-version"], { env }).toString());
// live-speech needs the macOS 26 SDK. When the default Xcode is older, use a
// newer one installed next to it; with none, Screening uses Whisper only.
function environmentFor(macos) {
  if (sdkVersion(process.env) >= parseFloat(macos)) return process.env;
  const apps = fs.existsSync("/Applications") ? fs.readdirSync("/Applications") : [];
  for (const app of apps.filter((name) => /^Xcode.*\.app$/.test(name)).sort().reverse()) {
    const env = { ...process.env, DEVELOPER_DIR: `/Applications/${app}/Contents/Developer` };
    try {
      if (sdkVersion(env) >= parseFloat(macos)) return env;
    } catch {
      /* Not a usable Xcode. */
    }
  }
  return null;
}
for (const [helper, macos] of Object.entries(helpers)) {
  const env = environmentFor(macos);
  if (!env) {
    console.warn(`Skipping ${helper}: it needs the macOS ${macos} SDK (Xcode 26 or newer).`);
    continue;
  }
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
    { stdio: "inherit", env },
  );
}
execFileSync("xcrun", [
  "clang++", "-std=c++17", "-O2", "-fobjc-arc", "-bundle",
  "-undefined", "dynamic_lookup", "-DNAPI_VERSION=8",
  "-target", `${arch}-apple-macosx14.0`,
  "-I", require("node-api-headers").include_dir,
  "-framework", "AppKit", "-framework", "AVFoundation",
  "-framework", "QuartzCore", "-framework", "CoreMedia", "-framework", "CoreVideo",
  path.join(__dirname, "protected-presentation.mm"),
  "-o", path.join(root, "bin", "protected-presentation.node"),
], { stdio: "inherit" });
if (process.argv.includes("--presentation-tests")) {
  execFileSync("xcrun", [
    "clang++", "-std=c++17", "-O2", "-fobjc-arc", "-bundle",
    "-undefined", "dynamic_lookup", "-DNAPI_VERSION=8",
    "-target", `${arch}-apple-macosx14.0`,
    "-I", require("node-api-headers").include_dir, "-framework", "AppKit",
    path.join(root, "test", "native-input.mm"),
    "-o", path.join(root, "bin", "presentation-input-test.node"),
  ], { stdio: "inherit" });
  execFileSync("xcrun", [
    "clang", "-O2", "-fobjc-arc", "-fblocks",
    "-target", `${arch}-apple-macosx14.0`, "-framework", "AppKit",
    path.join(root, "test", "fullscreen-host.m"),
    "-o", path.join(root, "bin", "presentation-fullscreen-test"),
  ], { stdio: "inherit" });
  execFileSync("xcrun", [
    "clang", "-O2", "-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations",
    "-target", `${arch}-apple-macosx14.0`,
    "-framework", "AppKit", "-framework", "CoreGraphics",
    "-framework", "CoreVideo", "-framework", "IOSurface",
    path.join(__dirname, "capture-cgdisplay.m"),
    "-o", path.join(root, "bin", "capture-cgdisplay"),
  ], { stdio: "inherit" });
}
