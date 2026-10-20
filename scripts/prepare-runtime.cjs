const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { binaryPath } = require("../src/services/assistant.cjs");
const root = path.resolve(__dirname, "..");
// Prepares this computer's architecture; pass arm64 or x64 to package for the
// other kind of Mac.
const arch = process.argv[2] || process.arch;
// onnxruntime-node stopped shipping Intel Mac binaries after 1.23.2. Its native
// binding takes the same calls from the newer JavaScript, so Intel builds use
// that binary; the release workflow runs real Whisper on it.
const INTEL_ONNXRUNTIME = {
  resolved:
    "https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.23.2.tgz",
  integrity:
    "sha512-OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw==",
};
const matches = (data, integrity) => {
  const dash = integrity.indexOf("-");
  return (
    crypto
      .createHash(integrity.slice(0, dash))
      .update(data)
      .digest("base64") === integrity.slice(dash + 1)
  );
};
// Unpacks `inner` from an npm tarball into `dest`, after checking the tarball
// against its integrity hash. Downloads are kept in build/ for the next run.
async function unpack({ resolved, integrity }, dest, inner = "package") {
  const file = path.join(
    root,
    "build",
    "downloads",
    path.basename(new URL(resolved).pathname),
  );
  if (!fs.existsSync(file) || !matches(fs.readFileSync(file), integrity)) {
    const response = await fetch(resolved);
    if (!response.ok) throw new Error(`Download failed: ${resolved}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (!matches(data, integrity))
      throw new Error(`Integrity check failed: ${resolved}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    file,
    "-C",
    dest,
    `--strip-components=${inner.split("/").length}`,
    inner,
  ]);
  console.log(`Unpacked ${path.relative(root, dest)}`);
}
(async () => {
  // npm installs only this computer's native packages. Packaging for the other
  // Mac needs that Mac's, at the versions the lockfile pins.
  const { packages } = require("../package-lock.json");
  for (const [dir, entry] of Object.entries(packages)) {
    if (
      entry.dev ||
      !entry.os?.includes(process.platform) ||
      !entry.cpu?.includes(arch) ||
      fs.existsSync(path.join(root, dir, "package.json"))
    )
      continue;
    await unpack(entry, path.join(root, dir));
  }
  const onnxruntime = path.join(
    root,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    process.platform,
    arch,
  );
  if (!fs.existsSync(path.join(onnxruntime, "onnxruntime_binding.node"))) {
    if (process.platform !== "darwin" || arch !== "x64")
      throw new Error(`onnxruntime-node has no ${process.platform}-${arch} binary`);
    await unpack(INTEL_ONNXRUNTIME, onnxruntime, "package/bin/napi-v6/darwin/x64");
  }
  const target = path.join(root, "build", "codex");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    binaryPath(arch),
    path.join(target, process.platform === "win32" ? "codex.exe" : "codex"),
  );
  if (process.platform !== "win32")
    fs.chmodSync(path.join(target, "codex"), 0o755);
  const license = path.join(root, "assets", "licenses", "Codex-LICENSE");
  if (fs.existsSync(license))
    fs.copyFileSync(license, path.join(target, "LICENSE"));
  console.log(`Prepared the ${process.platform}-${arch} AI and speech runtime`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
