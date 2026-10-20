const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// macOS remembers microphone and screen access by the app's signature. An
// ad-hoc signature is the hash of one build, so every update looked like a
// new app and asked again. Signing every build with the same certificate
// keeps what the user allowed.
const LOCAL = path.join(os.homedir(), ".screening-signing");

function certificate() {
  const p12 = process.env.SCREENING_SIGN_P12;
  if (p12)
    return {
      data: fs.existsSync(p12) ? fs.readFileSync(p12) : Buffer.from(p12, "base64"),
      password: process.env.SCREENING_SIGN_PASSWORD || "",
    };
  const file = path.join(LOCAL, "screening-signing.p12");
  if (!fs.existsSync(file)) return null;
  return {
    data: fs.readFileSync(file),
    password: fs.readFileSync(path.join(LOCAL, "password.txt"), "utf8").trim(),
  };
}

// The certificate goes into a throwaway keychain, so nothing is added to the
// login keychain and codesign never shows a password prompt.
function signWith(bundle, { data, password }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "screening-sign-"));
  const keychain = path.join(dir, "signing.keychain-db");
  const p12 = path.join(dir, "signing.p12");
  const secret = crypto.randomBytes(18).toString("hex");
  // Errors name only the step: the command line holds the passwords.
  const security = (...args) => {
    try {
      return execFileSync("/usr/bin/security", args, { stdio: "pipe" }).toString();
    } catch (error) {
      throw new Error(`security ${args[0]} failed: ${String(error.stderr || "").trim()}`);
    }
  };
  const searchList = security("list-keychains", "-d", "user")
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  try {
    fs.writeFileSync(p12, data, { mode: 0o600 });
    security("create-keychain", "-p", secret, keychain);
    security("set-keychain-settings", keychain);
    security("unlock-keychain", "-p", secret, keychain);
    security("import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign");
    security("set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", secret, keychain);
    const identity = /\b([0-9A-F]{40})\b/.exec(
      security("find-identity", "-p", "codesigning", keychain),
    )?.[1];
    if (!identity) throw new Error("The signing certificate has no code signing identity.");
    // codesign on macOS 15 (the CI runner) looks for the private key in the
    // search list even when it is given --keychain.
    security("list-keychains", "-d", "user", "-s", keychain, ...searchList);
    execFileSync(
      "/usr/bin/codesign",
      ["--force", "--deep", "--timestamp=none", "--keychain", keychain, "--sign", identity, bundle],
      { stdio: "inherit" },
    );
  } finally {
    try {
      security("delete-keychain", keychain);
    } catch {
      /* Already gone. */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    security("list-keychains", "-d", "user", "-s", ...searchList);
  }
}

module.exports = async function (context) {
  if (context.electronPlatformName !== "darwin") return;
  const bundle = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const signing = certificate();
  if (signing) signWith(bundle, signing);
  else if (process.env.GITHUB_ACTIONS)
    // A release signed differently would make every user allow access again.
    throw new Error(
      "Set the SCREENING_SIGN_P12 and SCREENING_SIGN_PASSWORD secrets to sign the release.",
    );
  else {
    console.warn("No signing certificate found; using an ad-hoc signature.");
    execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], {
      stdio: "inherit",
    });
  }
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
    stdio: "inherit",
  });
};
