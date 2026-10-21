// ONNX Runtime publishes no macOS x86_64 build after 1.23, and Transformers.js
// needs onnxruntime-node 1.30, so Intel Macs get the same version built from
// source. Runs on any Mac; on Apple silicon it cross-compiles.
//   node scripts/build-onnxruntime.cjs --build    build into build/onnxruntime-darwin-x64
//   node scripts/build-onnxruntime.cjs --install  copy it into node_modules/onnxruntime-node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = require.resolve("onnxruntime-node/package.json");
const version = require(pkg).version;
const work = process.env.ONNXRUNTIME_WORK || path.join(root, "build", "onnxruntime");
const out = path.join(root, "build", "onnxruntime-darwin-x64");
const target = path.join(path.dirname(pkg), "bin", "napi-v6", "darwin", "x64");
const FILES = ["onnxruntime_binding.node", "libonnxruntime.1.dylib"];
// Without this the libraries require the macOS of the build machine.
const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0" };
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: "inherit" });
const has = (command) => {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (process.platform !== "darwin") throw new Error("This builds the macOS x86_64 runtime.");
if (process.argv.includes("--build")) {
  const src = path.join(work, "src");
  if (!fs.existsSync(src)) {
    run("git", ["clone", "--depth", "1", "--branch", `v${version}`,
      "https://github.com/microsoft/onnxruntime.git", src]);
    run("git", ["submodule", "update", "--init", "--depth", "1", "cmake/external/onnx"], src);
  }
  run("python3", [
    path.join(src, "tools", "ci_build", "build.py"),
    "--build_dir", path.join(work, "build"), "--config", "Release",
    "--build_shared_lib", "--build_nodejs", "--skip_nodejs_tests", "--skip_tests",
    "--skip_submodule_sync", "--parallel", "--compile_no_warning_as_error",
    "--osx_arch", "x86_64", "--apple_deploy_target", "14.0",
    "--cmake_generator", has("ninja") ? "Ninja" : "Unix Makefiles",
    // Homebrew's abseil or protobuf are for the host CPU; build them all here.
    "--cmake_extra_defines", "FETCHCONTENT_TRY_FIND_PACKAGE_MODE=NEVER",
    "CMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local", "onnxruntime_BUILD_UNIT_TESTS=OFF",
    "CMAKE_OSX_DEPLOYMENT_TARGET=14.0",
  ], src);
  const built = path.join(src, "js", "node", "bin", "napi-v6", "darwin", "x64");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(built, file), path.join(out, file));
  console.log(`Built ONNX Runtime ${version} for darwin-x64 in ${out}`);
}
if (process.argv.includes("--install")) {
  fs.mkdirSync(target, { recursive: true });
  for (const file of FILES) fs.copyFileSync(path.join(out, file), path.join(target, file));
  console.log(`Installed ONNX Runtime ${version} for darwin-x64 into ${target}`);
}
