#!/usr/bin/env node
/**
 * Din as the desktop on another Linux: puts "Din" on the login screen (GDM,
 * LightDM, SDDM), next to the desktop that's already there, built from this
 * checkout. DinOS doesn't need it; Din is its only desktop.
 *
 *   npm run session:install            build this checkout and add Din to the login screen
 *   npm run session:install -- --default   ...and make it the session you log in to
 *   npm run session:update             rebuild from the checkout and use that next login
 *   npm run session:update -- --profile   ...as a profiling build, whose measurements go to
 *                                      the journal (journalctl --user -g 'din perf|din-compositor:');
 *                                      a plain update goes back
 *   npm run session -- rollback        go back to the build before
 *   npm run session -- default         make Din the session you log in to
 *   npm run session -- restore         go back to the session you had before Din
 *   npm run session -- status [--json]
 *   npm run session:uninstall          take Din off the login screen and delete its builds
 *
 * Settings → About runs the same commands, from `npm run dev` or from the
 * session itself (electron/login-session.mts).
 *
 * The session runs a copy of a build, never the checkout: a half-made edit
 * or a bad pull can't keep you from logging in, and logging in only changes
 * when you update. The copies live in ~/.local/share/din/session:
 *
 *   releases/<id>/    one build: Electron, Din's host and pages (app/), the
 *                     compositor (bin/), din-fd (lib/), and the launchers
 *   current, previous the build that logging in runs, and the one before it
 *   source            this checkout, which updates are built from
 *   path              the PATH it was installed with, for building from the session
 *   previous-session  the login session you had before Din (name, then type)
 *   running           the build a session is running now, which isn't deleted
 *   crashes           how many times running Din has failed in a row
 *
 * The password is asked for once, by sudo, to install the files the login
 * screen reads, which no user can write:
 *
 *   /usr/local/bin/din-session               runs ~/.local/share/din/session/current/din-session
 *   /usr/share/wayland-sessions/din.desktop  the menu entry
 *   /etc/apparmor.d/din-session              only where AppArmor keeps apps out of user
 *                                            namespaces (Ubuntu 24.04 on), which Chromium's
 *                                            sandbox needs
 *
 * The session is Din's compositor (native/din-compositor) on the screen
 * running Din, as on DinOS, through the seat the display manager gives it.
 * If Din fails three times in a row soon after starting, the login screen
 * goes back to the session you had before, so a broken build can't lock you
 * out.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const SESSION = path.join(DATA_HOME, "din", "session");
const RELEASES = path.join(SESSION, "releases");

const WRAPPER = "/usr/local/bin/din-session";
const DESKTOP_FILE = "/usr/share/wayland-sessions/din.desktop";
const APPARMOR_PROFILE = "/etc/apparmor.d/din-session";
/** The session's name, as display managers and AccountsService know it. */
const SESSION_NAME = "din";

/** The compositor needs Rust 2024. */
const MIN_RUST = [1, 85];
/** pkg-config modules the compositor links against, with each package manager's package. */
const LIBRARIES = [
  { module: "libseat", apt: "libseat-dev", dnf: "libseat-devel", pacman: "seatd", zypper: "libseat-devel" },
  { module: "libinput", apt: "libinput-dev", dnf: "libinput-devel", pacman: "libinput", zypper: "libinput-devel" },
  { module: "libudev", apt: "libudev-dev", dnf: "systemd-devel", pacman: "systemd-libs", zypper: "libudev-devel" },
  { module: "gbm", apt: "libgbm-dev", dnf: "mesa-libgbm-devel", pacman: "mesa", zypper: "libgbm-devel" },
  { module: "libdrm", apt: "libdrm-dev", dnf: "libdrm-devel", pacman: "libdrm", zypper: "libdrm-devel" },
  { module: "xkbcommon", apt: "libxkbcommon-dev", dnf: "libxkbcommon-devel", pacman: "libxkbcommon", zypper: "libxkbcommon-devel" },
  { module: "pixman-1", apt: "libpixman-1-dev", dnf: "pixman-devel", pacman: "pixman", zypper: "libpixman-1-0-devel" },
];
/** Programs Din runs in the session that DinOS ships and other distributions may not, and what needs each. */
const RUNTIME_TOOLS = [
  { binary: "wlr-randr", purpose: "Settings → Displays", apt: "wlr-randr", dnf: "wlr-randr", pacman: "wlr-randr", zypper: "wlr-randr" },
];
const PACKAGE_MANAGERS = [
  { binary: "apt-get", key: "apt", install: "sudo apt-get install", pkgConfig: "pkg-config" },
  { binary: "dnf", key: "dnf", install: "sudo dnf install", pkgConfig: "pkgconf-pkg-config" },
  { binary: "pacman", key: "pacman", install: "sudo pacman -S --needed", pkgConfig: "pkgconf" },
  { binary: "zypper", key: "zypper", install: "sudo zypper install", pkgConfig: "pkg-config" },
];

class Failure extends Error {}

function log(message = "") {
  process.stdout.write(`${message}\n`);
}

function which(command) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** Children get a plain environment: Settings runs this through Electron as Node. */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Run a command, its output passed through; throws when it fails. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], env: childEnv(), ...options });
    child.on("error", (error) => reject(new Failure(`${command}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Failure(`${[command, ...args].join(" ")} failed (${signal ?? code})`));
    });
  });
}

/** A command's trimmed stdout, or null when it fails. */
function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: childEnv(), ...options });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
}

// ---------------------------------------------------------------------------
// Where Din can be a session
// ---------------------------------------------------------------------------

/** Why this computer can't have the session, or null when it can. */
function unsupported() {
  if (process.platform !== "linux") return "Din's session is for Linux.";
  if (fs.existsSync("/etc/NIXOS")) {
    return [
      "NixOS's /usr is read-only, so the login screen's menu is set in its configuration instead.",
      "DinOS is NixOS with Din as its desktop: see os/configuration.nix's din-shell for how it runs.",
    ].join("\n");
  }
  if (process.getuid?.() === 0) return "Run this as yourself, not root: the session is installed for your user.";
  return null;
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/** The checkout's commit and whether it has uncommitted changes. */
function checkoutRevision(dir = ROOT) {
  const commit = output("git", ["-C", dir, "rev-parse", "HEAD"]);
  if (!commit) return null;
  const status = output("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  return { commit, dirty: !!status };
}

function releaseInfo(link) {
  let dir;
  try {
    dir = fs.realpathSync(path.join(SESSION, link));
  } catch {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "release.json"), "utf8"));
  } catch {
    return { id: path.basename(dir) };
  }
}

function cargoBinary() {
  return which("cargo") ?? (fs.existsSync(path.join(os.homedir(), ".cargo/bin/cargo")) ? path.join(os.homedir(), ".cargo/bin/cargo") : null);
}

/** What's missing to build the compositor, as instructions; empty when nothing is. */
function missingBuildTools() {
  const problems = [];
  const manager = PACKAGE_MANAGERS.find((m) => which(m.binary));
  const cargo = cargoBinary();
  if (!cargo) {
    problems.push("Rust isn't installed. Install it from https://rustup.rs, then run this again.");
  } else {
    const version = /(\d+)\.(\d+)/.exec(output(cargo, ["--version"]) ?? "");
    const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0];
    if (major < MIN_RUST[0] || (major === MIN_RUST[0] && minor < MIN_RUST[1])) {
      problems.push(
        `Din's compositor needs Rust ${MIN_RUST.join(".")} or newer, and this is ${version ? version[0] : "unknown"}. ` +
          "Distributions often ship an older one: install Rust from https://rustup.rs (or `rustup update`).",
      );
    }
  }
  const missing = which("pkg-config")
    ? LIBRARIES.filter((lib) => spawnSync("pkg-config", ["--exists", lib.module]).status !== 0)
    : LIBRARIES;
  if (missing.length > 0) {
    if (manager) {
      const packages = [...new Set([...(which("pkg-config") ? [] : [manager.pkgConfig]), ...missing.map((lib) => lib[manager.key])])];
      problems.push(`The compositor needs these libraries' development files:\n  ${manager.install} ${packages.join(" ")}`);
    } else {
      problems.push(`The compositor needs pkg-config and these libraries' development files: ${missing.map((lib) => lib.module).join(", ")}`);
    }
  }
  return problems;
}

/** Say which programs Din uses in the session aren't installed; it runs without them, short of what they do. */
function warnMissingRuntimeTools() {
  const missing = RUNTIME_TOOLS.filter((tool) => !which(tool.binary));
  if (missing.length === 0) return;
  const manager = PACKAGE_MANAGERS.find((m) => which(m.binary));
  for (const tool of missing) log(`${tool.purpose} needs ${tool.binary}, which isn't installed.`);
  if (manager) log(`  ${manager.install} ${missing.map((tool) => tool[manager.key]).join(" ")}`);
}

/** Electron's own directory in node_modules, downloading it if npm skipped that. */
async function electronDist() {
  const require = createRequire(path.join(ROOT, "package.json"));
  const locate = () => {
    const binary = output(process.execPath, ["-e", "process.stdout.write(require('electron'))"], {
      cwd: ROOT,
      env: childEnv({ ELECTRON_RUN_AS_NODE: "1" }),
    });
    return binary && fs.existsSync(binary) ? path.dirname(binary) : null;
  };
  let dist = locate();
  if (!dist) {
    log("Downloading Electron…");
    await run(process.execPath, [require.resolve("electron/install.js")], { cwd: ROOT, env: childEnv({ ELECTRON_RUN_AS_NODE: "1" }) });
    dist = locate();
  }
  if (!dist) throw new Failure("Electron isn't installed in node_modules. Run `npm install`.");
  return dist;
}

/**
 * Close Electron's main process to debuggers, as DinOS does (its
 * electron-hardened): flips the EnableNodeCliInspectArguments fuse, a byte
 * after a sentinel in the binary.
 */
function hardenElectron(binary) {
  const data = fs.readFileSync(binary);
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  const at = data.indexOf(sentinel);
  const fuses = at + sentinel.length;
  const inspect = fuses + 2 + 3;
  if (at < 0 || data.indexOf(sentinel, at + 1) >= 0 || data[fuses] !== 1 || data[fuses + 1] <= 3 || !"01".includes(String.fromCharCode(data[inspect]))) {
    log("Electron's fuses aren't where they're expected; leaving its inspector fuse alone.");
    return;
  }
  data[inspect] = "0".charCodeAt(0);
  fs.writeFileSync(binary, data);
}

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
}

/** The session: Din's compositor on the screen, running Din. */
function sessionScript({ profile }) {
  return `#!/bin/sh
# Din, as a login session: Din's compositor on the screen, running Din (the
# launcher beside this). Written by Din's scripts/session.mjs.
here=$(dirname "$(readlink -f "$0")")
session=$(dirname "$(dirname "$here")")
release=$(basename "$here")

export XDG_CURRENT_DESKTOP=Din XDG_SESSION_DESKTOP=din DESKTOP_SESSION=din
# Din is the whole desktop (electron/native-display.mts, desktop-settings.mts).
export DIN_DESKTOP_SESSION=1
# Which build this is, for Settings → About.
export DIN_SESSION_RELEASE="$release"
export DIN_COMPOSITOR="$here/bin/din-compositor"
export DIN_FD_ADDON="$here/lib/libdin_fd.so"
${profile ? `# A profiling build: the shell's measurements and the compositor's stats go to
# stderr, and from there to the journal.
export DIN_PROFILE=1 DIN_COMPOSITOR_STATS=1
` : ""}
# The pointer the compositor draws before Din sets its own, from GSettings.
if command -v gsettings >/dev/null 2>&1; then
  theme=$(gsettings get org.gnome.desktop.interface cursor-theme 2>/dev/null | tr -d "'")
  size=$(gsettings get org.gnome.desktop.interface cursor-size 2>/dev/null | sed 's/.* //')
  [ -n "$theme" ] && export XCURSOR_THEME="$theme"
  case "$size" in ""|*[!0-9]*) ;; *) export XCURSOR_SIZE="$size" ;; esac
fi

# The login screen's session, through AccountsService.
accounts() {
  busctl --system "$@" org.freedesktop.Accounts "/org/freedesktop/Accounts/User$(id -u)" org.freedesktop.Accounts.User 2>/dev/null
}
# LightDM leaves Session empty and goes by XSession.
current_session() {
  name=$(accounts get-property Session | sed -n 's/^s "\\(.*\\)"$/\\1/p')
  [ -n "$name" ] || name=$(accounts get-property XSession | sed -n 's/^s "\\(.*\\)"$/\\1/p')
  echo "$name"
}

echo "$release" > "$session/running"
started=$(date +%s)
"$here/bin/din-compositor" session -- "$here/din"
status=$?
rm -f "$session/running"

# Uninstalled from inside this session: the rest goes now it's over.
if [ -e "$session/uninstalled" ]; then
  rm -rf "$session"
  exit "$status"
fi

# Failing soon after starting, three times running, puts the session that
# was there before Din back on the login screen.
if [ "$status" -ne 0 ] && [ $(( $(date +%s) - started )) -lt 120 ]; then
  crashes=$(( $(cat "$session/crashes" 2>/dev/null || echo 0) + 1 ))
  echo "$crashes" > "$session/crashes"
  echo "din-session: Din exited with $status ($crashes in a row)" >&2
  if [ "$crashes" -ge 3 ] && [ "$(current_session)" = "${SESSION_NAME}" ]; then
    previous=$(sed -n 1p "$session/previous-session" 2>/dev/null)
    type=$(sed -n 2p "$session/previous-session" 2>/dev/null)
    accounts call SetSession s "$previous" >/dev/null
    accounts call SetXSession s "$previous" >/dev/null
    accounts call SetSessionType s "$type" >/dev/null
    echo "din-session: Din keeps failing; logging in goes back to \${previous:-the default session}" >&2
    rm -f "$session/crashes"
  fi
else
  rm -f "$session/crashes"
fi
exit "$status"
`;
}

/** Electron running Din's host, on the compositor. */
function dinScript() {
  return `#!/bin/sh
# Electron running Din, on Din's compositor. Written by Din's
# scripts/session.mjs.
here=$(dirname "$(readlink -f "$0")")
set -- "$here/electron/electron" "$here/app/main.mjs" --ozone-platform=wayland --enable-unsafe-swiftshader "$@"
# pam_systemd gives a seat's session CAP_WAKE_ALARM as an ambient
# capability, and programs that drop all theirs (gnome-keyring-daemon) abort
# on one they never asked for. Nothing in Din needs it.
if command -v setpriv >/dev/null 2>&1 && setpriv --inh-caps=-all --ambient-caps=-all true 2>/dev/null; then
  exec setpriv --inh-caps=-all --ambient-caps=-all "$@"
fi
exec "$@"
`;
}

async function build({ profile = false } = {}) {
  const problems = missingBuildTools();
  if (problems.length > 0) throw new Failure(problems.join("\n\n"));
  const cargo = cargoBinary();

  log("Building Din's compositor…");
  await run(cargo, ["build", "--release", "--manifest-path", path.join(ROOT, "native/din-compositor/Cargo.toml")]);
  log("Building din-fd…");
  await run(cargo, ["build", "--release", "--manifest-path", path.join(ROOT, "native/din-fd/Cargo.toml")]);
  log("Building Din…");
  await run("npm", ["run", profile ? "build:profile" : "build"], { cwd: ROOT });
  await run(process.execPath, [path.join(ROOT, "scripts/build-adblock-engine.mjs")], { cwd: ROOT, env: childEnv({ ELECTRON_RUN_AS_NODE: "1" }) });

  const revision = checkoutRevision();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const id = `${revision ? revision.commit.slice(0, 12) : "unknown"}${revision?.dirty ? "-dirty" : ""}${profile ? "-profile" : ""}-${stamp}`;
  const staging = path.join(RELEASES, `.${id}`);
  const release = path.join(RELEASES, id);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  log("Copying the build…");
  copy(await electronDist(), path.join(staging, "electron"));
  hardenElectron(path.join(staging, "electron", "electron"));

  // The same layout as DinOS's (os/configuration.nix's din-app): the host
  // beside dist/ and the node_modules it imports. No package.json, so
  // Electron keeps the profile `npm run dev` uses.
  const app = path.join(staging, "app");
  fs.mkdirSync(app);
  for (const entry of fs.readdirSync(path.join(ROOT, "electron"))) {
    if (entry.endsWith(".mts")) continue;
    copy(path.join(ROOT, "electron", entry), path.join(app, entry));
  }
  copy(path.join(ROOT, "dist"), path.join(app, "dist"));
  const deps = output(process.execPath, [path.join(ROOT, "scripts/runtime-deps.mjs"), "--electron"], {
    cwd: ROOT,
    env: childEnv({ ELECTRON_RUN_AS_NODE: "1" }),
  });
  if (deps === null) throw new Failure("Couldn't list the modules Electron's host imports.");
  for (const dir of deps.split("\n").filter(Boolean)) copy(path.join(ROOT, dir), path.join(app, dir));
  // sudo's askpass helper (electron/system-packages.mts), at ../os.
  fs.mkdirSync(path.join(staging, "os"));
  copy(path.join(ROOT, "os/din-askpass.py"), path.join(staging, "os/din-askpass.py"));

  fs.mkdirSync(path.join(staging, "bin"));
  fs.mkdirSync(path.join(staging, "lib"));
  copy(path.join(ROOT, "native/din-compositor/target/release/din-compositor"), path.join(staging, "bin/din-compositor"));
  copy(path.join(ROOT, "native/din-fd/target/release/libdin_fd.so"), path.join(staging, "lib/libdin_fd.so"));

  fs.writeFileSync(path.join(staging, "din-session"), sessionScript({ profile }), { mode: 0o755 });
  fs.writeFileSync(path.join(staging, "din"), dinScript(), { mode: 0o755 });
  fs.writeFileSync(
    path.join(staging, "release.json"),
    `${JSON.stringify({ id, commit: revision?.commit ?? null, dirty: revision?.dirty ?? false, profile, built: new Date().toISOString() }, null, 2)}\n`,
  );
  fs.renameSync(staging, release);
  return id;
}

/** Point a link in the session folder at a release, in one step. */
function pointAt(link, id) {
  const target = path.join(SESSION, link);
  const temporary = `${target}.new`;
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(path.join("releases", id), temporary);
  fs.renameSync(temporary, target);
}

/** Make a release the one logging in runs, keeping the one before. */
function activate(id) {
  const current = releaseInfo("current");
  if (current && current.id !== id) pointAt("previous", current.id);
  pointAt("current", id);
}

/** Delete builds nothing points at, and none a session is running. */
function prune() {
  const keep = new Set(
    [releaseInfo("current")?.id, releaseInfo("previous")?.id, readText(path.join(SESSION, "running")), process.env.DIN_SESSION_RELEASE].filter(Boolean),
  );
  for (const entry of fs.readdirSync(RELEASES)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(RELEASES, entry), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The login screen's files
// ---------------------------------------------------------------------------

function wrapperScript() {
  return `#!/bin/sh
# Din's login session, installed by Din's scripts/session.mjs: runs the build
# of Din that the user logging in installed, from their home folder.
session="\${XDG_DATA_HOME:-$HOME/.local/share}/din/session/current/din-session"
if [ ! -x "$session" ]; then
  echo "din-session: Din isn't installed for $(id -un) ($session)" >&2
  exit 1
fi
exec "$session" "$@"
`;
}

function desktopEntry() {
  return `[Desktop Entry]
Name=Din
Comment=A social computer
Exec=${WRAPPER}
TryExec=${WRAPPER}
Type=Application
DesktopNames=Din
`;
}

/** Whether AppArmor keeps unconfined programs out of user namespaces here. */
function appArmorRestrictsUserns() {
  return readText("/proc/sys/kernel/apparmor_restrict_unprivileged_userns") === "1";
}

/** Lets this user's builds of Electron make the user namespaces Chromium's sandbox runs in. */
function appArmorProfile() {
  const electron = path.join(RELEASES, "*", "electron", "electron");
  return `# Installed by Din's scripts/session.mjs: Chromium's sandbox, in Din's
# Electron, needs unprivileged user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile din-session "${electron}" flags=(unconfined) {
  userns,

  include if exists <local/din-session>
}
`;
}

/** The files the login screen needs, by where they go. */
function systemFiles() {
  const files = [
    { target: WRAPPER, mode: "755", content: wrapperScript() },
    { target: DESKTOP_FILE, mode: "644", content: desktopEntry() },
  ];
  if (appArmorRestrictsUserns()) files.push({ target: APPARMOR_PROFILE, mode: "644", content: appArmorProfile() });
  return files;
}

function systemFilesCurrent() {
  return systemFiles().every((file) => readText(file.target) === file.content.trim());
}

function systemFilesPresent() {
  return fs.existsSync(WRAPPER) && fs.existsSync(DESKTOP_FILE);
}

/**
 * Run a shell script as root through sudo. From Settings, sudo asks in Din
 * (SUDO_ASKPASS, electron/system-packages.mts); in a terminal, there.
 */
async function asRoot(script, args) {
  if (!which("sudo")) throw new Failure("sudo isn't installed, and installing the session needs it once.");
  const askpass = !!process.env.SUDO_ASKPASS || !process.stdin.isTTY;
  await run("sudo", [...(askpass ? ["-A"] : []), "sh", "-c", script, "din-session", ...args], {
    stdio: [askpass ? "ignore" : "inherit", "inherit", "inherit"],
  });
}

async function installSystemFiles() {
  const files = systemFiles();
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "din-session-"));
  try {
    const args = [];
    for (const [index, file] of files.entries()) {
      const source = path.join(staging, String(index));
      fs.writeFileSync(source, file.content);
      args.push(source, file.mode, file.target);
    }
    log("Adding Din to the login screen. sudo asks for your password…");
    await asRoot(
      `set -e
while [ $# -gt 0 ]; do
  install -D -m "$2" "$1" "$3"
  shift 3
done
if [ -f ${APPARMOR_PROFILE} ] && command -v apparmor_parser >/dev/null 2>&1; then
  apparmor_parser -r ${APPARMOR_PROFILE}
fi`,
      args,
    );
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function removeSystemFiles() {
  log("Taking Din off the login screen. sudo asks for your password…");
  await asRoot(
    `if [ -f ${APPARMOR_PROFILE} ]; then
  command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser -R ${APPARMOR_PROFILE} 2>/dev/null
  rm -f ${APPARMOR_PROFILE}
fi
rm -f ${WRAPPER} ${DESKTOP_FILE}`,
    [],
  );
}

// ---------------------------------------------------------------------------
// The session you log in to (AccountsService, which GDM and LightDM read)
// ---------------------------------------------------------------------------

function accountsArgs(...args) {
  return ["--system", ...args, "org.freedesktop.Accounts", `/org/freedesktop/Accounts/User${process.getuid()}`, "org.freedesktop.Accounts.User"];
}

function accountsProperty(name) {
  if (!which("busctl")) return null;
  const value = output("busctl", accountsArgs("get-property", name));
  const match = value && /^s "(.*)"$/.exec(value);
  return match ? match[1] : null;
}

/** The session the login screen picks for you, or null where it can't be told. */
function defaultSession() {
  const session = accountsProperty("Session");
  if (session) return session;
  return accountsProperty("XSession");
}

function setDefaultSession(name, type) {
  if (!which("busctl")) throw new Failure("Can't reach AccountsService (busctl isn't installed): pick Din from the login screen's menu instead.");
  const call = (method, value) => spawnSync("busctl", [...accountsArgs("call", method, "s", value)], { stdio: "ignore" }).status === 0;
  const session = call("SetSession", name);
  const xsession = call("SetXSession", name);
  call("SetSessionType", type);
  if (!session && !xsession) throw new Failure("AccountsService wouldn't change your login session: pick it from the login screen's menu instead.");
}

/** Remember the session you have now, unless it's Din, to go back to. */
function rememberSession() {
  const name = defaultSession() ?? process.env.DESKTOP_SESSION ?? "";
  if (name === SESSION_NAME) return;
  const type = accountsProperty("SessionType") ?? "";
  writeText(path.join(SESSION, "previous-session"), `${name}\n${type}`);
}

function previousSession() {
  const lines = (readText(path.join(SESSION, "previous-session")) ?? "").split("\n");
  return { name: lines[0] ?? "", type: lines[1] ?? "" };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function requireInstalled() {
  if (!releaseInfo("current")) throw new Failure("Din isn't installed as a session. Run `npm run session:install` first.");
}

/** Builds from the session itself happen in the checkout it was installed from. */
function sourceCheckout() {
  return readText(path.join(SESSION, "source"));
}

async function install({ makeDefault }) {
  const reason = unsupported();
  if (reason) throw new Failure(reason);
  rememberSession();
  const id = await build();
  writeText(path.join(SESSION, "source"), ROOT);
  writeText(path.join(SESSION, "path"), process.env.PATH ?? "");
  if (!systemFilesCurrent()) await installSystemFiles();
  activate(id);
  prune();
  fs.rmSync(path.join(SESSION, "uninstalled"), { force: true });
  warnMissingRuntimeTools();
  if (makeDefault) {
    setDefaultSession(SESSION_NAME, "wayland");
    log("Din is installed, and it's the session you log in to. Log out to start it.");
  } else {
    log("Din is installed. Log out, and pick Din from the login screen's session menu.");
  }
}

async function update({ profile }) {
  const reason = unsupported();
  if (reason) throw new Failure(reason);
  requireInstalled();
  const id = await build({ profile });
  writeText(path.join(SESSION, "source"), ROOT);
  if (!systemFilesCurrent()) await installSystemFiles();
  activate(id);
  prune();
  warnMissingRuntimeTools();
  log(process.env.DIN_SESSION_RELEASE ? "Updated. Log out and back in to use the new build." : "Updated. The next login runs the new build.");
}

function rollback() {
  requireInstalled();
  const previous = releaseInfo("previous");
  if (!previous) throw new Failure("There's no earlier build to go back to.");
  activate(previous.id);
  log(`Logging in runs ${previous.id} again.`);
}

function makeDefault() {
  requireInstalled();
  rememberSession();
  setDefaultSession(SESSION_NAME, "wayland");
  log("Din is the session you log in to.");
}

function restore() {
  const previous = previousSession();
  setDefaultSession(previous.name, previous.type);
  log(previous.name ? `Logging in goes back to ${previous.name}.` : "Logging in goes back to the login screen's default session.");
}

async function uninstall() {
  if (defaultSession() === SESSION_NAME) restore();
  if (systemFilesPresent() || fs.existsSync(APPARMOR_PROFILE)) await removeSystemFiles();
  if (process.env.DIN_SESSION_RELEASE) {
    // This Din runs from one of the builds; the session deletes it as it ends.
    writeText(path.join(SESSION, "uninstalled"), "");
    for (const link of ["current", "previous"]) fs.rmSync(path.join(SESSION, link), { force: true });
    if (fs.existsSync(RELEASES)) prune();
    log("Din is off the login screen. Its files go once you log out.");
  } else {
    fs.rmSync(SESSION, { recursive: true, force: true });
    log("Din is off the login screen, and its builds are deleted.");
  }
}

function status() {
  const reason = unsupported();
  const source = sourceCheckout() ?? ROOT;
  return {
    supported: !reason,
    reason,
    installed: !!releaseInfo("current") && systemFilesPresent(),
    systemFilesCurrent: systemFilesCurrent(),
    current: releaseInfo("current"),
    previous: releaseInfo("previous"),
    running: process.env.DIN_SESSION_RELEASE ?? null,
    defaultSession: defaultSession(),
    previousSession: previousSession().name || null,
    source,
    checkout: checkoutRevision(source),
  };
}

function printStatus(json) {
  const s = status();
  if (json) {
    log(JSON.stringify(s));
    return;
  }
  if (!s.supported) {
    log(s.reason);
    return;
  }
  if (!s.installed) {
    log("Din isn't on the login screen. `npm run session:install` puts it there.");
    return;
  }
  log(`Logging in to Din runs ${s.current.id}${s.previous ? `, and ${s.previous.id} is kept to roll back to` : ""}.`);
  if (s.running) log(`This session is running ${s.running}.`);
  if (s.defaultSession) log(`The login screen picks ${s.defaultSession === SESSION_NAME ? "Din" : s.defaultSession} for you.`);
  if (!s.systemFilesCurrent) log("The login screen's files are out of date: `npm run session:update` brings them up to date.");
  if (s.checkout && s.current?.commit && (s.checkout.commit !== s.current.commit || s.checkout.dirty)) {
    log(`The checkout (${s.source}) has changes since: \`npm run session:update\` builds them.`);
  }
}

async function main() {
  const [command = "status", ...rest] = process.argv.slice(2);
  // From the session, build with the tools the install found (nvm's node,
  // rustup's cargo), which a login session's PATH doesn't have.
  if (process.env.DIN_SESSION_RELEASE) {
    const saved = readText(path.join(SESSION, "path"));
    if (saved) process.env.PATH = `${saved}${path.delimiter}${process.env.PATH ?? ""}`;
  }
  // Updating from a session builds the checkout it was installed from.
  const source = sourceCheckout();
  if (command === "update" && source && path.resolve(source) !== ROOT && fs.existsSync(path.join(source, "scripts/session.mjs"))) {
    await run(process.execPath, [path.join(source, "scripts/session.mjs"), command, ...rest], { env: { ...process.env } });
    return;
  }
  switch (command) {
    case "install":
      await install({ makeDefault: rest.includes("--default") });
      break;
    case "update":
      await update({ profile: rest.includes("--profile") });
      break;
    case "rollback":
      rollback();
      break;
    case "default":
      makeDefault();
      break;
    case "restore":
      restore();
      break;
    case "uninstall":
      await uninstall();
      break;
    case "status":
      printStatus(rest.includes("--json"));
      break;
    default:
      throw new Failure(`Unknown command "${command}". Try install, update, rollback, default, restore, status or uninstall.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Failure ? error.message : error?.stack ?? error}\n`);
  process.exit(1);
});
