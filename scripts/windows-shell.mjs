#!/usr/bin/env node
/**
 * Din as the Windows shell: packages a build of this checkout with Electron's
 * Windows build, so Din can stand in for explorer.exe as the desktop a user
 * logs in to.
 *
 *   npm run build && npm run windows:package [-- --zip <electron-win32-x64.zip>] [--out <dir>]
 *
 * Writes <out>/din (default dist-windows/din): Electron renamed din.exe, with
 * Din's host and pages in resources/app, laid out as DinOS installs them
 * (main.mjs beside dist/ and the runtime node_modules). Copy the folder to
 * the Windows machine, then, in the user's PowerShell:
 *
 *   .\din\install-shell.ps1             # log in to Din instead of Explorer
 *   .\din\install-shell.ps1 -Restore    # back to Explorer
 *
 * install-shell.ps1 sets the per-user shell (HKCU\...\Winlogon\Shell), from
 * the next sign-in. Ctrl+Alt+Del
 * still reaches Task Manager, which can run explorer.exe for a way out.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const version = require(path.join(ROOT, "node_modules/electron/package.json")).version;
const out = path.resolve(arg("--out", path.join(ROOT, "dist-windows")));
const target = path.join(out, "din");
const cache = path.join(out, `electron-v${version}-win32-x64.zip`);
const zip = arg("--zip", cache);

if (!fs.existsSync(path.join(ROOT, "dist/index.html")) || !fs.existsSync(path.join(ROOT, "electron/main.mjs"))) {
  console.error("windows-shell: build first (npm run build)");
  process.exit(1);
}

// `npm run build` leaves out the ad blocker's engine (as scripts/session.mjs does, build it here).
if (!fs.existsSync(path.join(ROOT, "electron/adblock-extension/engine.js"))) {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/build-adblock-engine.mjs")], { cwd: ROOT, stdio: "inherit" });
}

fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(zip)) {
  const url = `https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-win32-x64.zip`;
  console.log(`windows-shell: downloading ${url}`);
  execFileSync("curl", ["-fsSL", "-o", zip, url], { stdio: "inherit" });
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
execFileSync("unzip", ["-q", zip, "-d", target], { stdio: "inherit" });
fs.renameSync(path.join(target, "electron.exe"), path.join(target, "din.exe"));
fs.rmSync(path.join(target, "resources/default_app.asar"), { force: true });

// Din's host, as os/packages.nix installs it.
const app = path.join(target, "resources/app");
fs.mkdirSync(app, { recursive: true });
fs.cpSync(path.join(ROOT, "dist"), path.join(app, "dist"), { recursive: true });
for (const file of fs.readdirSync(path.join(ROOT, "electron"))) {
  if (/\.(mjs|cjs|py|ps1|wasm)$/.test(file) || file === "cursor-converter.js") {
    fs.copyFileSync(path.join(ROOT, "electron", file), path.join(app, file));
  }
}
fs.cpSync(path.join(ROOT, "electron/adblock-extension"), path.join(app, "adblock-extension"), { recursive: true });
const deps = execFileSync(process.execPath, [path.join(ROOT, "scripts/runtime-deps.mjs")], { cwd: ROOT, encoding: "utf8" });
for (const dir of deps.split("\n").filter(Boolean)) {
  fs.cpSync(path.join(ROOT, dir), path.join(app, dir), { recursive: true, dereference: true });
}
const pkg = require(path.join(ROOT, "package.json"));
fs.writeFileSync(
  path.join(app, "package.json"),
  JSON.stringify({ name: "din", productName: "Din", version: pkg.version, type: "module", main: "main.mjs" }, null, 2) + "\n",
);
fs.copyFileSync(path.join(ROOT, "scripts/windows/install-shell.ps1"), path.join(target, "install-shell.ps1"));
console.log(`windows-shell: ${target}`);
