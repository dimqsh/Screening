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
// --arch x64 or --arch arm64 builds for that Mac; the default is this one.
const requested = process.argv[process.argv.indexOf("--arch") + 1];
const target = process.argv.includes("--arch") ? requested : process.arch;
if (!["arm64", "x64"].includes(target)) throw new Error(`Unsupported --arch ${target}`);
const arch = target === "arm64" ? "arm64" : "x86_64";
fs.mkdirSync(path.join(root, "bin"), { recursive: true });
// Core Audio process taps arrived in macOS 14.2; the rest run on 14.0.
const helpers = { "capture-sck": "14.0", "audio-sck": "14.0", "audio-tap": "14.2", "notch-info": "14.0" };
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
}
execFileSync("xcrun", [
  "clang", "-O2", "-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations",
  "-target", `${arch}-apple-macosx14.0`,
  "-framework", "AppKit", "-framework", "CoreGraphics",
  "-framework", "CoreVideo", "-framework", "IOSurface",
  path.join(__dirname, "capture-cgdisplay.m"),
  "-o", path.join(root, "bin", "capture-cgdisplay"),
], { stdio: "inherit" });
