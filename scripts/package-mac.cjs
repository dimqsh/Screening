const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const target = path.resolve(
  process.argv[2] || path.join(root, "dist", "Capture Lab.app"),
);
if (process.platform !== "darwin")
  throw new Error("Run macOS packaging on macOS.");
if (fs.existsSync(target))
  throw new Error(`Destination already exists: ${target}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
execFileSync("/usr/bin/ditto", [
  path.join(root, "node_modules/electron/dist/Electron.app"),
  target,
]);
const contents = path.join(target, "Contents");
const appRoot = path.join(contents, "Resources", "app");
fs.mkdirSync(appRoot);
fs.cpSync(path.join(root, "src"), path.join(appRoot, "src"), {
  recursive: true,
});
fs.cpSync(path.join(root, "bin"), path.join(appRoot, "bin"), {
  recursive: true,
});
fs.copyFileSync(
  path.join(root, "package.json"),
  path.join(appRoot, "package.json"),
);
fs.rmSync(path.join(contents, "Resources", "default_app.asar"), {
  force: true,
});
const plist = path.join(contents, "Info.plist");
for (const [key, value] of Object.entries({
  CFBundleName: "Capture Lab",
  CFBundleDisplayName: "Capture Lab",
  CFBundleIdentifier: "local.capturelab.prototype",
  CFBundleShortVersionString: "0.1.0",
  CFBundleVersion: "1",
})) {
  try {
    execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :${key} ${value}`, plist],
      { stdio: "pipe" },
    );
  } catch {
    execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Add :${key} string ${value}`,
      plist,
    ]);
  }
}
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", target]);
console.log(target);
