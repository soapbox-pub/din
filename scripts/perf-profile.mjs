#!/usr/bin/env node
/**
 * Autonomous performance run: boots a PRODUCTION build of Din (the plain web
 * app, as `npm run dev:browser` serves it) in headless Chromium, drives the
 * desktop through the situations users feel — cold boot, an idle desktop,
 * launching apps, dragging a (wobbly) window, raising windows, searching the
 * apps menu — and writes what `src/lib/perfRuntime.ts` and the browser
 * measured.
 *
 *   npm run perf:profile                         # build + run every scenario
 *   node scripts/perf-profile.mjs --skip-build --idle 30
 *   node scripts/perf-profile.mjs --only drag,switch
 *   node scripts/perf-profile.mjs --only open-apps --cpu-profile   # + hot functions
 *   node scripts/perf-profile.mjs --react-timings  # per-component self ms (inflates CPU)
 *
 * Scenarios (each starts from a fresh load of the same origin):
 *   boot         cold load of the desktop, logged out: time to the dock and
 *                menu bar, and what the first seconds cost
 *   idle         the empty desktop, logged out, nobody touching anything
 *                (--idle <s>, 60)
 *   login-idle   the same, logged in: NostrSync, app-data sync and the menu
 *                bar's account widgets running (--idle <s>)
 *   open-apps    launch each built-in app from the apps menu, one at a time:
 *                click-to-window time, click-to-settled time and what each
 *                launch cost, then close it
 *   terminal     the Terminal app with a fake pty streaming a TUI spinner,
 *                one tab on screen, then with a second tab in front of it
 *                (--idle <s> per phase)
 *   drag         drag a window's title bar in circles for --drag-sec (6) with
 *                wobbly windows on, then again with them off: frame rate,
 *                long frames and main-thread cost of each. --drag-behind
 *                "App Store" leaves other apps open under it
 *   switch       four light windows open, click each title bar in turn for
 *                --rounds (6) rounds: pointer-down to next frame per raise
 *   switch-store the same with the App Store's card grid open as well
 *   apps-menu    open the apps menu and type a search, per keystroke cost to
 *                the next frame
 *   leak         open and close every app, round after round, with the
 *                heap/DOM/listener floor after a forced GC per round and a
 *                heap-snapshot diff of round 2 against the last
 *                (`leak-diff.txt`: what grew, and what holds it).
 *                --leak-rounds <n> (8)
 *   a11y         not a measurement, and only run when named (--only a11y):
 *                axe-core's WCAG 2 A/AA checks on the desktop and on
 *                Settings, and the keyboard's way about the desktop (Ctrl+F2,
 *                F3, F6, the arrow keys and Escape). Exits 1 on a serious or
 *                critical violation, or a key that doesn't land where it should
 *
 * Logged-in scenarios use a throwaway key minted here, or the account in
 * DIN_PERF_NSEC to profile a real one's data. Either way nothing is ever
 * published: the probe answers every outbound EVENT with a local OK
 * (`din:perf-swallow-publish`). Reads go to the real relays unless
 * `--offline`, which answers every REQ with EOSE inside the page
 * (`din:perf-offline`) — use it to compare runs without the network's noise.
 *
 * The browser is Chromium's headless shell (Playwright's download, found in
 * ~/.cache/ms-playwright), or DIN_PERF_CHROME. It is driven over the DevTools
 * protocol directly, so the harness needs no npm dependency.
 *
 * Numbers are "CPU" in the sense Chromium's TaskDuration means it: main-thread
 * busy time over wall time. Headless, software-rendered (SwiftShader: the
 * blur/compositing cost a GPU would take lands off the main thread here, and
 * is NOT measured), and on this machine's cores — compare runs against each
 * other, not against DinOS on real hardware.
 *
 * `--no-blur` turns every backdrop-filter off, to A/B how much of a frame is
 * compositing the frosted glass rather than the app's own work.
 *
 * Output: `perf-reports/<scenario>.json` (full reports), a screenshot per
 * scenario, and a summary on stdout. With --cpu-profile, also
 * `<scenario>.cpuprofile` (DevTools → Performance → load) and the hottest
 * functions resolved through the build's sourcemaps.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { formatDiff, originalSite } from "./heap-diff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const IDLE_SEC = Number(opt("idle", "60"));
const DRAG_SEC = Number(opt("drag-sec", "6"));
/** Apps left open behind the dragged window (comma-separated launcher names). */
const DRAG_BEHIND = opt("drag-behind", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROUNDS = Number(opt("rounds", "6"));
const LEAK_ROUNDS = Number(opt("leak-rounds", "8"));
const OFFLINE = flag("offline");
const ONLY = opt("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = 8383;
const ORIGIN = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1920, height: 1080 };
// Outside `dist-perf/`, which every build empties.
const OUT = resolve(root, "perf-reports");

/** Scenarios that only run when named. */
const OPT_IN = ["a11y"];
const wants = (name) => (ONLY.length === 0 && !OPT_IN.includes(name)) || ONLY.includes(name);

/** The launcher's apps, by the name the apps menu finds them under (--apps "A,B" to pick). */
const APPS = opt("apps", "Web Browser,Files,Terminal,Settings,App Store")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ─── Build + serve ──────────────────────────────────────────────────────────

if (!flag("skip-build")) {
  console.log(`building (VITE_PROFILE=1${flag("react-timings") ? ", VITE_PROFILE_REACT=1" : ""}, vite.config.perf.ts)…`);
  const r = spawnSync("npx", ["vite", "build", "-l", "error", "-c", "vite.config.perf.ts"], {
    cwd: root,
    stdio: "inherit",
    // `--react-timings`: React's profiling build, for per-component self time.
    // Off by default — its render logging inflates CPU (see vite.config.ts).
    env: { ...process.env, VITE_PROFILE: "1", ...(flag("react-timings") ? { VITE_PROFILE_REACT: "1" } : {}) },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
mkdirSync(OUT, { recursive: true });

const children = [];
const cleanups = [];
process.on("exit", () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const fn of cleanups) fn();
});
process.on("SIGINT", () => process.exit(130));

const server = spawn("npx", ["vite", "preview", "-c", "vite.config.perf.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
children.push(server);

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(ORIGIN);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`preview server never answered on ${ORIGIN}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Browser ────────────────────────────────────────────────────────────────

/** Newest Chromium the harness can drive headless: DIN_PERF_CHROME, else Playwright's. */
function findChrome() {
  if (process.env.DIN_PERF_CHROME) return { path: process.env.DIN_PERF_CHROME, shell: false };
  const cache = join(homedir(), ".cache/ms-playwright");
  const newest = (prefix, rel) =>
    (existsSync(cache) ? readdirSync(cache) : [])
      .filter((d) => d.startsWith(prefix))
      .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))
      .map((d) => join(cache, d, rel))
      .find((p) => existsSync(p));
  const shell = newest("chromium_headless_shell-", "chrome-headless-shell-linux64/chrome-headless-shell");
  if (shell) return { path: shell, shell: true };
  const full = newest("chromium-", "chrome-linux64/chrome") ?? newest("chromium-", "chrome-linux/chrome");
  if (full) return { path: full, shell: false };
  throw new Error("no Chromium found: set DIN_PERF_CHROME, or `npx playwright install chromium-headless-shell`");
}

/** A minimal DevTools-protocol client over Node's WebSocket (flattened sessions). */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  off(method, fn) {
    this.listeners.get(method)?.delete(fn);
  }
}

const chrome = findChrome();
const profileDir = mkdtempSync(join(tmpdir(), "din-perf-"));
cleanups.push(() => rmSync(profileDir, { recursive: true, force: true }));
const browserProc = spawn(
  chrome.path,
  [
    ...(chrome.shell ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    // Without it `performance.memory` is bucketed and cached, and the
    // in-app heap samples read as a flat line.
    "--enable-precise-memory-info",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: true },
);
children.push(browserProc);
const browserUrl = await new Promise((res, rej) => {
  let buf = "";
  const timer = setTimeout(() => rej(new Error(`${chrome.path} never printed its DevTools URL:\n${buf}`)), 30_000);
  browserProc.stderr.on("data", (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      res(m[1]);
    }
  });
  browserProc.on("exit", (code) => rej(new Error(`browser exited (${code}):\n${buf}`)));
});

const browser = await CDP.connect(browserUrl);
const { targetInfos } = await browser.send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId } = await browser.send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });

/** The page's DevTools session: `cdp.send(method, params)`. */
const cdp = {
  send: (method, params) => browser.send(method, params, sessionId),
  on: (method, fn) => browser.on(method, (p, s) => s === sessionId && fn(p)),
  off: (method, fn) => browser.off(method, fn),
};

const errors = [];
browser.on("Runtime.exceptionThrown", (p, s) => {
  if (s !== sessionId) return;
  const d = p.exceptionDetails;
  errors.push(String(d.exception?.description ?? d.text).split("\n")[0].slice(0, 300));
});
browser.on("Inspector.targetCrashed", (_p, s) => s === sessionId && errors.push("RENDERER CRASHED"));

// Each frame's page context, by frame id: built-in apps are framed pages of
// their own (<id>.localhost), which the harness reaches into to click.
const frameContexts = new Map();
cdp.on("Runtime.executionContextCreated", ({ context }) => {
  if (context.auxData?.isDefault && context.auxData.frameId) frameContexts.set(context.auxData.frameId, context.id);
});
cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) => {
  for (const [frame, id] of frameContexts) if (id === executionContextId) frameContexts.delete(frame);
});
cdp.on("Runtime.executionContextsCleared", () => frameContexts.clear());

await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");
await cdp.send("Inspector.enable").catch(() => {});
await cdp.send("Performance.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
if (flag("no-blur")) {
  // A/B for compositing cost: every backdrop blur off (a constructed sheet,
  // which the page's CSP doesn't govern).
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `{
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }");
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    }`,
  });
}

// The terminal scenario's stand-in for Electron's pty bridge (src/lib/pty.ts),
// in the Terminal app's frame, where a plain browser has none: every session
// streams what a TUI agent sitting at its spinner sends, ~30 small repaints a
// second of a few colored lines. Installed for that scenario only, so every
// other one sees the plain browser's no-bridge.
const FAKE_PTY = `if (location.hostname === "terminal.localhost") {
    const data = new Set(), exits = new Set(), done = new Set();
    const enc = new TextEncoder();
    const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    let next = 1;
    window.dinos = { pty: {
      spawn(size) {
        const id = next++;
        let frame = 0;
        setInterval(() => {
          frame++;
          let out = "\\x1b7";
          for (let row = 0; row < 4; row++) {
            out += "\\x1b[" + (size.rows - 4 + row) + ";1H\\x1b[2K\\x1b[38;2;120;160;255m" + spin[(frame + row) % spin.length] +
              " \\x1b[38;2;200;200;200mWorking\\x1b[0m · " + (frame / 30).toFixed(1) + "s \\x1b[48;2;30;30;30m" + "─".repeat(40) + "\\x1b[0m";
          }
          out += "\\x1b8";
          const bytes = enc.encode(out);
          for (const cb of data) cb(id, bytes);
        }, 33);
        return Promise.resolve(id);
      },
      write() {},
      resize() {},
      kill() {},
      onData(cb) { data.add(cb); return () => data.delete(cb); },
      onExit(cb) { exits.add(cb); return () => exits.delete(cb); },
      onCommandDone(cb) { done.add(cb); return () => done.delete(cb); },
    } };
  }`;

/** Evaluate `fn(arg)` in the page (a function, serialized), or in a frame's context, awaiting promises. */
async function evaluate(fn, arg, contextId) {
  const expression = `(${fn})(${arg === undefined ? "" : JSON.stringify(arg)})`;
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (exceptionDetails) throw new Error(`evaluate: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

/** Poll `fn(arg)` in the page until it returns something truthy. */
async function waitFor(fn, arg, timeoutMs = 30_000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await evaluate(fn, arg).catch(() => undefined);
    if (v) return v;
    await sleep(pollMs);
  }
  return undefined;
}

async function goto(path) {
  const loaded = new Promise((res) => {
    const fn = () => {
      cdp.off("Page.loadEventFired", fn);
      res();
    };
    cdp.on("Page.loadEventFired", fn);
  });
  await cdp.send("Page.navigate", { url: new URL(path, ORIGIN).href });
  await loaded;
}

async function screenshot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, "base64"));
}

// ─── Input ──────────────────────────────────────────────────────────────────

let pointer = { x: 0, y: 0 };

async function mouse(type, x, y, extra = {}) {
  pointer = { x, y };
  await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", pointerType: "mouse", ...extra });
}

async function moveTo(x, y, steps = 1) {
  const from = pointer;
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps, { button: "none" });
  }
}

async function click(x, y) {
  await moveTo(x, y);
  await mouse("mousePressed", x, y, { clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", x, y, { clickCount: 1, buttons: 0 });
}

/** Center of the first element `selector` matches (optionally inside `within`), or null. */
const centerOf = (selector, within) =>
  evaluate(
    ([sel, scope]) => {
      const host = scope ? document.querySelector(scope) : document;
      const el = host?.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    },
    [selector, within],
  );

async function clickSelector(selector, within) {
  const at = await waitFor(
    ([sel, scope]) => {
      const host = scope ? document.querySelector(scope) : document;
      const el = host?.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    },
    [selector, within],
    10_000,
  );
  if (!at) throw new Error(`nothing to click at ${selector}`);
  await click(at.x, at.y);
}

/** The page context of the built-in app in window `windowId`, or null before it loads. */
async function appContext(windowId) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('section[data-window-id="${windowId}"] [data-din-app] iframe')`,
  });
  if (!result.objectId) return null;
  const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId });
  await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
  return frameContexts.get(node.frameId) ?? null;
}

/** Center of the first element `selector` matches in window `windowId`'s app page, in the desktop's coordinates, or null. */
async function appCenterOf(windowId, selector) {
  const contextId = await appContext(windowId);
  if (!contextId) return null;
  const inner = await evaluate(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    },
    selector,
    contextId,
  ).catch(() => null);
  if (!inner) return null;
  const frame = await evaluate(
    (id) => document.querySelector(`section[data-window-id="${id}"] [data-din-app] iframe`)?.getBoundingClientRect().toJSON(),
    windowId,
  );
  return frame ? { x: frame.left + inner.x, y: frame.top + inner.y } : null;
}

/** The topmost window's id. */
const topWindowId = () =>
  evaluate(() => {
    const wins = [...document.querySelectorAll("section[data-window-id]")];
    return wins.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]?.dataset.windowId ?? null;
  });

/** Click what `selector` matches in the topmost window's app page. */
async function clickInTopApp(selector) {
  const id = await topWindowId();
  const deadline = Date.now() + 10_000;
  let at = null;
  while (id && !at && Date.now() < deadline) {
    at = await appCenterOf(id, selector);
    if (!at) await sleep(50);
  }
  if (!at) throw new Error(`nothing to click at ${selector} in the top app`);
  await click(at.x, at.y);
}

async function typeText(text) {
  for (const ch of text) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
}

async function pressKey(key, code = key, keyCode) {
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ─── Measurement ────────────────────────────────────────────────────────────

async function metrics() {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Heap after a forced full GC: the floor, which is what a leak raises. */
async function heapFloorMB() {
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const m = await metrics();
  return Math.round((m.JSHeapUsedSize / 1048576) * 10) / 10;
}

/** A heap snapshot into `perf-reports/<name>`, for DevTools → Memory → load. */
async function writeHeapSnapshot(name) {
  const chunks = [];
  const onChunk = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  writeFileSync(resolve(OUT, name), chunks.join(""));
}

/**
 * Everything a leak raises, after a forced GC: JS heap, DOM nodes, listeners,
 * and the page's own census (query cache and registered module caches).
 */
async function memoryFloor() {
  const heapMB = await heapFloorMB();
  const m = await metrics();
  const census = await evaluate(() => window.__dinPerf.memory?.());
  return { heapMB, domNodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, census };
}

/** Least-squares slope of `ys` per step: growth per round, robust to one noisy round. */
function slope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return Math.round((num / den) * 1000) / 1000;
}

/** Per census line, first → last value, for the lines that moved. */
function censusGrowth(first, last) {
  const pairs = (c) => ({
    ...Object.fromEntries((c?.queries ?? []).map((q) => [`query ${q.family}`, q.queries])),
    ...Object.fromEntries(Object.entries(c?.probes ?? {}).map(([k, v]) => [`probe ${k}`, v])),
    "queries (all)": c?.queryTotals?.queries ?? 0,
    "query data KB": c?.queryTotals?.dataKB ?? 0,
    "live intervals": c?.liveIntervals ?? 0,
    "open sockets": c?.openSockets ?? 0,
  });
  const a = pairs(first);
  const b = pairs(last);
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((b[k] ?? 0) !== (a[k] ?? 0)) out[k] = `${a[k] ?? 0} → ${b[k] ?? 0}`;
  }
  return out;
}

/** Diff two snapshots in a child (they parse to GBs), writing `<name>.txt` and returning the parsed diff. */
function runHeapDiff(early, late, name) {
  const json = resolve(OUT, `${name}.json`);
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", resolve(root, "scripts/heap-diff.mjs"), resolve(OUT, early), resolve(OUT, late), "--json", json], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return { error: (r.stderr || "").slice(-2000) };
  writeFileSync(resolve(OUT, `${name}.txt`), r.stdout);
  return JSON.parse(readFileSync(json, "utf8"));
}

/** Main-thread cost between two metric snapshots, as a share of wall time. */
function cost(a, b, wallSec) {
  const pct = (k) => Math.round(((b[k] - a[k]) / wallSec) * 1000) / 10;
  return {
    wallSec: Math.round(wallSec * 10) / 10,
    cpuPct: pct("TaskDuration"),
    scriptPct: pct("ScriptDuration"),
    layoutPct: pct("LayoutDuration"),
    stylePct: pct("RecalcStyleDuration"),
    layouts: b.LayoutCount - a.LayoutCount,
    styleRecalcs: b.RecalcStyleCount - a.RecalcStyleCount,
    heapMB: Math.round((b.JSHeapUsedSize / 1048576) * 10) / 10,
    domNodes: b.Nodes,
    listeners: b.JSEventListeners,
  };
}

/** Main-thread cost of `fn`, with the page's counters reset first. */
async function measure(fn) {
  await resetCounters();
  const a = await metrics();
  const t = Date.now();
  const result = await fn();
  const b = await metrics();
  return { cost: cost(a, b, (Date.now() - t) / 1000), result };
}

const perfReady = () => waitFor(() => Boolean(window.__dinPerf?.json), undefined, 60_000);
const report = async () => JSON.parse(await evaluate(() => window.__dinPerf.json()));
const resetCounters = () => evaluate(() => window.__dinPerf.reset());

/**
 * Frame pacing while `fn` runs: every frame's interval, from a rAF loop the
 * page runs for the duration (it shows in `rafPerSec`, ~60/s, as a known
 * baseline). `p95`/`max` are the jank; `dropped` counts frames over 1.5 vsyncs.
 */
async function framePacing(fn) {
  await evaluate(() => {
    const deltas = [];
    let last = performance.now();
    let running = true;
    const tick = (t) => {
      deltas.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__dinFrames = { deltas, stop: () => (running = false) };
  });
  const t = Date.now();
  const result = await fn();
  const wall = (Date.now() - t) / 1000;
  const deltas = await evaluate(() => {
    window.__dinFrames.stop();
    return window.__dinFrames.deltas.slice(1);
  });
  const sorted = [...deltas].sort((a, b) => a - b);
  const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
  return {
    result,
    frames: {
      fps: Math.round((deltas.length / wall) * 10) / 10,
      p50: q(0.5),
      p95: q(0.95),
      max: Math.round(sorted.at(-1) ?? 0),
      dropped: deltas.filter((d) => d > 25).length,
    },
  };
}

/**
 * Sampling CPU profile of `fn`, reduced to the top self-time functions,
 * resolved through the build's sourcemaps. `--cpu-profile` only: the
 * sampler's own overhead would skew every other number in the run.
 */
async function cpuProfile(name, fn) {
  if (!flag("cpu-profile")) return { result: await fn(), hot: undefined };
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  const result = await fn();
  const { profile } = await cdp.send("Profiler.stop");
  // The raw profile too, for call trees (DevTools → Performance → load).
  writeFileSync(resolve(OUT, `${name}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const self = new Map();
  for (const [id, us] of dt) {
    const { functionName, url, lineNumber, columnNumber } = byId.get(id).callFrame;
    const where = /\/assets\//.test(url) ? originalSite(url, lineNumber, columnNumber) : url.replace(/^.*\//, "");
    const key = `${functionName || "(anonymous)"}${where ? ` ${where}` : ""}`;
    self.set(key, (self.get(key) ?? 0) + us);
  }
  const hot = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([fn, us]) => `${Math.round(us / 1000)}ms ${fn}`);
  return { result, hot };
}

const results = {};

function save(name, data) {
  results[name] = data;
  writeFileSync(resolve(OUT, `${name}.json`), JSON.stringify(data, null, 2));
}

/** Every `/assets/<chunk>.js:line:col` in `text` as its `src/` position, through the build's sourcemaps. */
const resolveSites = (text) =>
  text.replace(/\/assets\/([\w.-]+\.js):(\d+):(\d+)/g, (m, file, line, col) => {
    const site = originalSite(`/assets/${file}`, Number(line) - 1, Number(col) - 1);
    return site.startsWith(file) ? m : site;
  });

/** The parts of a runtime report worth reading in a summary, call sites resolved to source. */
function digest(r) {
  return JSON.parse(resolveSites(JSON.stringify(rawDigest(r))));
}

function rawDigest(r) {
  const rt = r.runtime;
  return {
    longFrames: `${rt.frames.count} (${rt.frames.totalMs}ms, blocking ${rt.frames.blockingMs}ms, max ${rt.frames.maxMs}ms, forced layout ${rt.frames.forcedLayoutMs}ms)`,
    commitsPerMin: rt.react.commitsPerMin,
    topRenders: rt.react.components.slice(0, 10).map((c) => `${c.name} ×${c.renders + c.mounts} (${c.selfMs}ms)${c.why ? ` why: ${c.why}` : ""}`),
    topScripts: rt.frames.scripts.slice(0, 5).map((s) => `${s.totalMs}ms ×${s.count} ${s.site}`),
    timers: `setTimeout ${rt.timers.setTimeoutPerSec}/s, rAF ${rt.timers.rafPerSec}/s, ${rt.timers.liveIntervals.length} live intervals`,
    busyIntervals: rt.timers.liveIntervals
      .filter((i) => i.fires > 0 && i.ms < 5000)
      .slice(0, 6)
      .map((i) => `${i.ms}ms ×${i.fires} ${i.site}`),
    rafSites: rt.timers.rafSites.slice(0, 3).map((s) => `~${s.estCalls} ${s.site}`),
    timeoutSites: rt.timers.timeoutSites.slice(0, 5).map((s) => `~${s.estCalls} ${s.site}`),
    animations: rt.animations.map((a) => `${a.name} ×${a.count} on ${a.target}`),
    relays: rt.relays.slice(0, 6).map(
      (x) => `${x.url} open=${x.open}/${x.opened} subs=${x.liveSubs} (peak ${x.peakSubs}) reqs=${x.reqs} ev=${x.events} pub=${x.publishes} in=${Math.round(x.bytesIn / 1024)}KB`,
    ),
    reqShapes: rt.reqShapes.slice(0, 6).map((s) => `${s.reqs} REQ, ${s.events} ev: ${s.shape}`),
    queries: (rt.queries ?? []).slice(0, 8).map((q) => `${q.fetches} fetch / ${q.updates} update / ${q.observers} obs: ${q.family}`),
  };
}

// ─── Din ────────────────────────────────────────────────────────────────────

/** Fresh storage for the origin, set up the way a scenario wants it. */
async function resetStorage({ login, config } = {}) {
  await goto("/robots.txt");
  await evaluate(
    ([who, cfg, offline]) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("din:perf-swallow-publish", "1");
      if (offline) localStorage.setItem("din:perf-offline", "1");
      if (cfg) localStorage.setItem("nostr:app-config", JSON.stringify(cfg));
      if (who) {
        localStorage.setItem(
          "nostr:login",
          JSON.stringify([
            {
              id: `nsec:${who.pubkey}`,
              type: "nsec",
              pubkey: who.pubkey,
              createdAt: new Date().toISOString(),
              data: { nsec: who.nsec },
            },
          ]),
        );
      }
    },
    [login, config, OFFLINE],
  );
}

/** The desktop is up: menu bar and dock rendered, boot veil faded. */
const desktopReady = () =>
  waitFor(() => Boolean(document.querySelector('[aria-label="Dock"]') && document.querySelector('[aria-label="Open apps menu"]')), undefined, 60_000);

/** Load the desktop fresh and let it settle. */
async function bootDesktop(settleMs = 3000) {
  await goto("/");
  await perfReady();
  await desktopReady();
  await sleep(settleMs);
}

const windowCount = () => evaluate(() => document.querySelectorAll("section[data-window-id]").length);

/** In the page: no Suspense fallback, skeleton or app splash left in the newest window, its entrance animation done. */
const windowSettled = () => {
  const wins = [...document.querySelectorAll("section[data-window-id]")];
  const win = wins.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0];
  if (!win) return false;
  if (getComputedStyle(win).opacity !== "1") return false;
  return !win.querySelector('[data-slot="skeleton"], .animate-pulse, .animate-spin, [data-din-app-splash]');
};

/** Launch `name` through the apps menu (search + Enter), as a user would. */
async function launch(name) {
  await clickSelector('[aria-label="Open apps menu"]');
  await waitFor(() => document.activeElement?.getAttribute("aria-label") === "Search apps", undefined, 5000);
  await typeText(name);
  await pressKey("Enter", "Enter", 13);
}

/** Close every window through its close button (a built-in app's is in its page), waiting out the exit animation. */
async function closeAll() {
  for (let i = 0; i < 20 && (await windowCount()) > 0; i++) {
    const id = await evaluate(() => document.querySelector("section[data-window-id]:not(.pointer-events-none)")?.dataset.windowId ?? null);
    if (!id) break;
    const at =
      (await centerOf('[aria-label="Close window"]', `section[data-window-id="${id}"]`)) ??
      (await appCenterOf(id, '[aria-label="Close window"]'));
    if (!at) break;
    await click(at.x, at.y);
    await sleep(250);
  }
  await sleep(300);
}

/** In this document: the points of the regions `region` (a selector) matches that hit one and nothing clickable in it; to pass to evaluate. */
const freeSpotsIn = (region) => {
  const spots = [];
  for (const el of document.querySelectorAll(region)) {
    const r = el.getBoundingClientRect();
    for (let y = r.top + 4; y < r.bottom - 2; y += 6) {
      for (let x = r.left + 8; x < r.right - 8; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit && el.contains(hit) && !hit.closest('button, input, a, [role="tab"], [data-window-no-drag]')) spots.push({ x, y });
      }
    }
  }
  return spots;
};

/**
 * A point on window `id`'s title bar that nothing covers and nothing in it
 * takes as a click: the desktop's header, or a built-in app's own drag region.
 */
async function grabPoint(id) {
  const section = `section[data-window-id="${id}"]`;
  const [desktop] = await evaluate(freeSpotsIn, `${section} [data-din-region="drag"]`);
  if (desktop) return desktop;
  const contextId = await appContext(id);
  if (!contextId) return null;
  const inner = await evaluate(freeSpotsIn, '[data-din-region="drag"]', contextId).catch(() => []);
  // In the desktop's coordinates, where the frame is what's there.
  return evaluate(
    ([sel, spots]) => {
      const frame = document.querySelector(`${sel} [data-din-app] iframe`);
      const r = frame?.getBoundingClientRect();
      if (!r) return null;
      const pts = spots.map((p) => ({ x: r.left + p.x, y: r.top + p.y }));
      return pts.find((pt) => document.elementFromPoint(pt.x, pt.y) === frame) ?? null;
    },
    [section, inner],
  );
}

/** Drag from `from` by (dx, dy) in small steps, and let go. */
async function dragBy(from, dx, dy, steps = 12) {
  await moveTo(from.x, from.y);
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", from.x + (dx * i) / steps, from.y + (dy * i) / steps, { buttons: 1 });
    await sleep(16);
  }
  await mouse("mouseReleased", from.x + dx, from.y + dy, { clickCount: 1, buttons: 0 });
  await sleep(600);
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

await waitForServer();

const sk = process.env.DIN_PERF_NSEC ? nip19.decode(process.env.DIN_PERF_NSEC).data : generateSecretKey();
const me = { pubkey: getPublicKey(sk), nsec: nip19.nsecEncode(sk) };

try {
  if (wants("boot")) {
    console.log("\n▶ boot (cold load, logged out)");
    const mark = errors.length;
    await resetStorage();
    const a = await metrics();
    const t0 = Date.now();
    await goto("/");
    const loadMs = Date.now() - t0;
    await desktopReady();
    const desktopMs = Date.now() - t0;
    await perfReady();
    const paint = await evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return {
        domContentLoadedMs: nav && Math.round(nav.domContentLoadedEventEnd),
        scripts: performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script").length,
        transferKB: Math.round(performance.getEntriesByType("resource").reduce((n, r) => n + (r.decodedBodySize || 0), 0) / 1024),
      };
    });
    await sleep(5000);
    const b = await metrics();
    await screenshot("boot");
    save("boot", { loadMs, desktopMs, ...paint, firstSeconds: cost(a, b, (Date.now() - t0) / 1000), errors: errors.slice(mark), report: await report() });
  }

  if (wants("idle")) {
    console.log(`\n▶ idle (logged out, ${IDLE_SEC}s)`);
    const mark = errors.length;
    await resetStorage();
    await bootDesktop(5000);
    const { cost: idle } = await measure(() => sleep(IDLE_SEC * 1000));
    save("idle", { idle, errors: errors.slice(mark), report: await report() });
  }

  if (wants("login-idle")) {
    console.log(`\n▶ login-idle (logged in${process.env.DIN_PERF_NSEC ? " as DIN_PERF_NSEC" : ", throwaway key"}${OFFLINE ? ", offline" : ""}, ${IDLE_SEC}s)`);
    const mark = errors.length;
    await resetStorage({ login: me });
    await bootDesktop(10_000);
    await screenshot("login-idle");
    const { cost: idle } = await measure(() => sleep(IDLE_SEC * 1000));
    save("login-idle", { idle, errors: errors.slice(mark), report: await report() });
  }

  if (wants("open-apps")) {
    console.log("\n▶ open-apps (launch each app from the apps menu)");
    const mark = errors.length;
    await resetStorage();
    await bootDesktop();
    const { result: launches, hot } = await cpuProfile("open-apps", async () => {
      const out = {};
      for (const name of APPS) {
        await closeAll();
        await resetCounters();
        const a = await metrics();
        const before = await windowCount();
        const t = Date.now();
        await launch(name);
        const appeared = await waitFor((n) => document.querySelectorAll("section[data-window-id]").length > n, before, 15_000, 10);
        const windowMs = Date.now() - t;
        const settled = await waitFor(windowSettled, undefined, 15_000, 25);
        const settledMs = Date.now() - t;
        await sleep(1000);
        const b = await metrics();
        const r = await report();
        await screenshot(`open-${name.toLowerCase().replace(/\s+/g, "-")}`);
        out[name] = {
          windowMs: appeared ? windowMs : null,
          settledMs: settled ? settledMs : null,
          cost: cost(a, b, (Date.now() - t) / 1000),
          longFrames: `${r.runtime.frames.count} (${r.runtime.frames.totalMs}ms, max ${r.runtime.frames.maxMs}ms)`,
          commits: r.runtime.react.commits,
          topRenders: r.runtime.react.components.slice(0, 6).map((c) => `${c.name} ×${c.renders + c.mounts}`),
          // Still running a second after launch: a loading indicator that never stops costs frames forever.
          animations: r.runtime.animations.map((x) => `${x.name} ×${x.count} on ${x.target}`),
          reqShapes: r.runtime.reqShapes.slice(0, 4).map((x) => `${x.reqs} REQ, ${x.events} ev: ${x.shape}`),
        };
        const ms = (v) => (v === null ? "never" : `${v}ms`);
        console.log(`  ${name}: window ${ms(out[name].windowMs)}, settled ${ms(out[name].settledMs)}, long frames ${out[name].longFrames}`);
      }
      await closeAll();
      return out;
    });
    save("open-apps", { launches, hot, errors: errors.slice(mark) });
  }

  if (wants("terminal")) {
    console.log(`\n▶ terminal (TUI spinners streaming, ${IDLE_SEC}s per phase)`);
    const mark = errors.length;
    const { identifier: fakePty } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_PTY });
    await resetStorage();
    await bootDesktop();
    await launch("Terminal");
    const settled = await waitFor(windowSettled, undefined, 15_000);
    if (!settled) throw new Error("Terminal never finished loading");
    await sleep(1500);
    const phases = {};
    const { hot } = await cpuProfile("terminal", async () => {
      // One session, on screen: the floor any visible TUI costs.
      phases.oneVisible = (await measure(() => sleep(IDLE_SEC * 1000))).cost;
      // A second tab in front of it: the first keeps streaming, unseen.
      await clickInTopApp('[aria-label="New terminal"]');
      await sleep(1500);
      phases.plusHiddenTab = (await measure(() => sleep(IDLE_SEC * 1000))).cost;
    });
    // Back to the first tab: the screenshot must show its latest frame (the
    // spinner's elapsed time), not a stale one. WebGL paints to a canvas, so
    // there is no DOM text to check instead.
    await clickInTopApp('[role="tab"]');
    await sleep(500);
    await screenshot("terminal");
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: fakePty });
    save("terminal", { ...phases, hot, errors: errors.slice(mark), report: await report() });
    console.log(`  one visible: cpu ${phases.oneVisible.cpuPct}%, + a hidden tab: cpu ${phases.plusHiddenTab.cpuPct}%`);
  }

  if (wants("drag")) {
    const runs = {};
    for (const wobbly of [true, false]) {
      const label = wobbly ? "wobbly" : "plain";
      console.log(`\n▶ drag (${label}, ${DRAG_SEC}s of circles)`);
      const mark = errors.length;
      await resetStorage({ config: { wobblyWindows: wobbly } });
      await bootDesktop();
      for (const name of DRAG_BEHIND) {
        await launch(name);
        await waitFor(windowSettled, undefined, 15_000);
      }
      await launch("Settings");
      await waitFor(windowSettled, undefined, 15_000);
      await sleep(800);
      const grab = await grabPoint(await topWindowId());
      if (!grab) throw new Error("no window to drag");
      await moveTo(grab.x, grab.y);
      await mouse("mousePressed", grab.x, grab.y, { clickCount: 1, buttons: 1 });
      const { result, hot } = await cpuProfile(`drag-${label}`, () =>
        measure(() =>
          framePacing(async () => {
            const end = Date.now() + DRAG_SEC * 1000;
            let i = 0;
            // ~120 moves/s, as a gaming mouse would send; 250px circles.
            while (Date.now() < end) {
              const t = i++ / 40;
              const x = grab.x + Math.cos(t * Math.PI * 2) * 250 - 250;
              const y = grab.y + Math.sin(t * Math.PI * 2) * 150 + 150;
              await mouse("mouseMoved", x, y, { buttons: 1 });
              await sleep(8);
            }
            return i;
          }),
        ),
      );
      await mouse("mouseReleased", pointer.x, pointer.y, { clickCount: 1, buttons: 0 });
      // Let the wobble settle, and measure that too: it is part of the gesture.
      const settle = await measure(() => framePacing(() => sleep(1500)));
      const r = await report();
      runs[label] = {
        moves: result.result.result,
        drag: { ...result.cost, ...result.result.frames },
        settle: { ...settle.cost, ...settle.result.frames },
        hot,
        errors: errors.slice(mark),
        digest: digest(r),
      };
      console.log(`  ${label}: ${runs[label].drag.fps} fps, p95 ${runs[label].drag.p95}ms, cpu ${runs[label].drag.cpuPct}%`);
    }
    save("drag", runs);
  }

  // Raising windows, first among the light apps, then with the App Store's
  // card grid open too: what one more heavy window costs every raise.
  for (const [scenario, apps] of [
    ["switch", APPS.filter((a) => a !== "App Store")],
    ["switch-store", APPS],
  ]) {
    if (!wants(scenario)) continue;
    console.log(`\n▶ ${scenario} (raise each of ${apps.length} windows, ${ROUNDS} rounds)`);
    const mark = errors.length;
    await resetStorage();
    await bootDesktop();
    // Fanned out, so every title bar has a strip to click (the browser
    // would otherwise cover the smaller windows cascaded under it).
    for (const [i, name] of apps.entries()) {
      await launch(name);
      await waitFor(windowSettled, undefined, 15_000);
      await sleep(300);
      const grab = await grabPoint(await topWindowId());
      if (grab) await dragBy(grab, i * 180, i * 50);
    }
    const ids = await evaluate(() => [...document.querySelectorAll("section[data-window-id]")].map((w) => w.dataset.windowId));
    await sleep(1500);
    // Press to the next frame after the window came to the front: the press
    // timed here (one in a built-in app's frame never reaches the desktop's
    // document), the frame in the page, both on the wall clock.
    await evaluate(() => {
      window.__dinRaises = [];
      const topId = () =>
        [...document.querySelectorAll("section[data-window-id]")].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]?.dataset.windowId;
      let top = topId();
      new MutationObserver(() => {
        const now = topId();
        if (now === top) return;
        top = now;
        requestAnimationFrame(() => setTimeout(() => window.__dinRaises.push({ id: now, at: performance.timeOrigin + performance.now() }), 0));
      }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
    });
    const missed = [];
    const presses = [];
    const { result, hot } = await cpuProfile(scenario, () =>
      measure(async () => {
        for (let round = 0; round < ROUNDS; round++) {
          for (const id of ids) {
            const at = await grabPoint(id);
            if (!at) {
              missed.push(id);
              continue;
            }
            await moveTo(at.x, at.y);
            presses.push({ id, at: performance.timeOrigin + performance.now() });
            await mouse("mousePressed", at.x, at.y, { clickCount: 1, buttons: 1 });
            await mouse("mouseReleased", at.x, at.y, { clickCount: 1, buttons: 0 });
            await sleep(120);
          }
        }
      }),
    );
    await sleep(300);
    // Each raise against the press on that window just before it.
    const raises = (await evaluate(() => window.__dinRaises))
      .map((r) => {
        const press = presses.filter((p) => p.id === r.id && p.at <= r.at).at(-1);
        return press ? r.at - press.at : null;
      })
      .filter((ms) => ms !== null)
      .sort((a, b) => a - b);
    const q = (p) => Math.round(raises[Math.min(raises.length - 1, Math.floor(raises.length * p))] ?? 0);
    await screenshot(scenario);
    save(scenario, {
      raises: raises.length,
      presses: presses.length,
      // Windows with no title bar left to click.
      missed: [...new Set(missed)],
      raiseToFrameMs: { p50: q(0.5), p95: q(0.95), max: Math.round(raises.at(-1) ?? 0) },
      cost: result.cost,
      hot,
      errors: errors.slice(mark),
      report: await report(),
    });
    console.log(`  ${raises.length} raises: p50 ${q(0.5)}ms, p95 ${q(0.95)}ms`);
  }

  if (wants("apps-menu")) {
    console.log("\n▶ apps-menu (type a search, per-keystroke cost)");
    const mark = errors.length;
    await resetStorage();
    await bootDesktop();
    await clickSelector('[aria-label="Open apps menu"]');
    await waitFor(() => document.activeElement?.getAttribute("aria-label") === "Search apps", undefined, 5000);
    await evaluate(() => {
      window.__dinKeys = [];
      document.addEventListener(
        "keydown",
        (e) => {
          const start = e.timeStamp;
          requestAnimationFrame(() => setTimeout(() => window.__dinKeys.push(performance.now() - start), 0));
        },
        true,
      );
    });
    const { result, hot } = await cpuProfile("apps-menu", () =>
      measure(async () => {
        for (let round = 0; round < 4; round++) {
          await typeText("settings");
          await sleep(100);
          for (let i = 0; i < 8; i++) await pressKey("Backspace", "Backspace", 8);
          await sleep(100);
        }
      }),
    );
    await sleep(300);
    const keys = (await evaluate(() => window.__dinKeys)).sort((a, b) => a - b);
    const q = (p) => Math.round(keys[Math.min(keys.length - 1, Math.floor(keys.length * p))] ?? 0);
    save("apps-menu", {
      keys: keys.length,
      keyToFrameMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: Math.round(keys.at(-1) ?? 0) },
      cost: result.cost,
      hot,
      errors: errors.slice(mark),
      report: await report(),
    });
  }

  if (wants("leak")) {
    console.log(`\n▶ leak (open + close every app, ${LEAK_ROUNDS} rounds)`);
    const mark = errors.length;
    await resetStorage();
    await bootDesktop();
    const floors = [];
    for (let round = 1; round <= LEAK_ROUNDS; round++) {
      for (const name of APPS) {
        await launch(name);
        await waitFor(windowSettled, undefined, 15_000);
        await sleep(400);
      }
      await closeAll();
      await sleep(500);
      const floor = await memoryFloor();
      floors.push(floor);
      console.log(`  round ${round}: heap ${floor.heapMB}MB, ${floor.domNodes} nodes, ${floor.listeners} listeners`);
      if (round === 2) await writeHeapSnapshot("leak-early.heapsnapshot");
    }
    await writeHeapSnapshot("leak-late.heapsnapshot");
    const diff = runHeapDiff("leak-early.heapsnapshot", "leak-late.heapsnapshot", "leak-diff");
    if (!diff.error) console.log(formatDiff(diff).split("\n").slice(0, 40).join("\n"));
    save("leak", {
      rounds: LEAK_ROUNDS,
      perRound: {
        heapMB: slope(floors.map((f) => f.heapMB)),
        domNodes: slope(floors.map((f) => f.domNodes)),
        listeners: slope(floors.map((f) => f.listeners)),
        documents: slope(floors.map((f) => f.documents)),
      },
      floors: floors.map(({ census: _c, ...f }) => f),
      census: censusGrowth(floors[0]?.census, floors.at(-1)?.census),
      heapDiff: diff.error ? diff : { heapMB: diff.heapMB, detachedNodes: diff.detachedNodes, growers: diff.growers?.slice(0, 15), netByClass: diff.netByClass?.slice(0, 15), detached: diff.detached },
      errors: errors.slice(mark),
    });
  }

  if (wants("a11y")) {
    console.log("\n▶ a11y (axe on the desktop and Settings, keyboard navigation)");
    const mark = errors.length;
    await resetStorage();
    await bootDesktop();
    const axeSource = readFileSync(resolve(root, "node_modules/axe-core/axe.min.js"), "utf8");
    const runAxe = async () => {
      await cdp.send("Runtime.evaluate", { expression: axeSource });
      return evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
        return result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 4).map((n) => n.target.join(" ")),
        }));
      });
    };
    const ctrlKey = async (key, code, keyCode, shift = false) => {
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: 2 | (shift ? 8 : 0) };
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(150);
    };
    const focused = () => evaluate(() => {
      const el = document.activeElement;
      return {
        area: el?.closest("[data-focus-area]")?.getAttribute("data-focus-area") ?? null,
        name: el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 40) ?? null,
      };
    });
    const keyboard = [];
    const expect = async (step, area, act) => {
      await act();
      const at = await focused();
      keyboard.push({ step, want: area, got: at.area, on: at.name, ok: at.area === area });
    };

    const desktop = await runAxe();
    await launch("Settings");
    await waitFor(windowSettled, undefined, 15_000);
    await sleep(800);
    const settings = await runAxe();

    await expect("Ctrl+F2", "menu-bar", () => ctrlKey("F2", "F2", 113));
    const first = (await focused()).name;
    await expect("→ along the menu bar", "menu-bar", () => pressKey("ArrowRight", "ArrowRight", 39));
    keyboard.at(-1).ok &&= (await focused()).name !== first;
    await expect("Ctrl+F3", "dock", () => ctrlKey("F3", "F3", 114));
    await expect("→ along the Dock", "dock", () => pressKey("ArrowRight", "ArrowRight", 39));
    await expect("Ctrl+F8", "status", () => ctrlKey("F8", "F8", 119));
    await expect("Escape", null, () => pressKey("Escape", "Escape", 27));
    await expect("Ctrl+F6", "menu-bar", () => ctrlKey("F6", "F6", 117));
    await expect("Ctrl+F6 again", "dock", () => ctrlKey("F6", "F6", 117));
    await expect("Ctrl+Shift+F6", "menu-bar", () => ctrlKey("F6", "F6", 117, true));
    await screenshot("a11y");

    const serious = [...desktop, ...settings].filter((v) => v.impact === "serious" || v.impact === "critical");
    const missed = keyboard.filter((k) => !k.ok);
    for (const [where, list] of [["desktop", desktop], ["settings", settings]]) {
      console.log(`  ${where}: ${list.length} violation(s)`);
      for (const v of list) console.log(`    ${v.impact} ${v.id} ×${v.nodes}: ${v.help} (${v.targets[0] ?? ""})`);
    }
    for (const k of keyboard) console.log(`  ${k.ok ? "✓" : "✗"} ${k.step}: ${k.got ?? "the window"}${k.on ? ` (${k.on})` : ""}`);
    save("a11y", { desktop, settings, keyboard, errors: errors.slice(mark) });
    if (serious.length > 0 || missed.length > 0) process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  await screenshot("failure").catch(() => {});
  process.exitCode = 1;
}

// ─── Summary ────────────────────────────────────────────────────────────────

for (const [name, r] of Object.entries(results)) {
  console.log(`\n══ ${name} ══`);
  const { report: rep, ...rest } = r;
  console.log(JSON.stringify(rest, null, 1));
  if (rep) console.log(JSON.stringify(digest(rep), null, 1));
}
console.log(`\nfull reports: ${OUT}`);
process.exit(process.exitCode ?? 0);
