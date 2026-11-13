#!/usr/bin/env node
/**
 * What Din costs on a real computer: runs the production build in Electron,
 * as DinOS does (every app window a process of its own), and measures the
 * memory of every process Din runs and how long each app takes to load.
 * `perf-profile.mjs` measures the desktop's own work in a plain browser,
 * where apps are iframes served over http; this measures what that can't:
 * processes, and loading over Din's own schemes (app:, din:).
 *
 *   npm run perf:memory                             # build, then measure
 *   node scripts/perf-memory.mjs --skip-build --label after --compare perf-reports/memory-before.json
 *   node scripts/perf-memory.mjs --apps calculator,mail --loads 3 --settle 8
 *   node scripts/perf-memory.mjs --visible          # on this screen, not Xvfb
 *   node scripts/perf-memory.mjs --keep-home        # leave Din's throwaway home behind, to look in
 *   node scripts/perf-memory.mjs --main-heap        # + the main process's V8 heap, through its Node inspector
 *   node scripts/perf-memory.mjs --main-snapshot    # + perf-reports/main[-<label>].heapsnapshot of it, idle
 *                                                   # (DevTools → Memory → Load, or scripts/heap-diff.mjs)
 *   node scripts/perf-memory.mjs --set appearance.glass=frosted   # under these settings (din settings set)
 *   node scripts/perf-memory.mjs --apps empty --empty-dir <built page>   # what only that page costs in a window
 *   node scripts/perf-memory.mjs --breakdown        # + Chromium's own account of each process, by allocator
 *                                                   # (v8, malloc, cc's images and tiles, discardable, gpu…)
 *   node scripts/perf-memory.mjs --breakdown --breakdown-depth 6   # further down each allocator's tree (2), into
 *                                                   # the report: malloc's buckets, each decoded image
 *   node scripts/perf-memory.mjs --breakdown --breakdown-trace     # + perf-reports/breakdown[-<label>].trace.json,
 *                                                   # the idle desktop's dump whole, every attribute
 *   node scripts/perf-memory.mjs --home /tmp/h --apps none   # boot only, in a home kept between runs:
 *                                                   # the second boot and after start with caches, as a computer's do
 *   node scripts/perf-memory.mjs --chromium disable-features=AudioServiceOutOfProcess   # under Chromium switches (a=1,b)
 *
 * The run:
 *   boot   Electron started to the desktop answering the `din` socket, then
 *          the empty desktop (logged out) once it settles (--boot-settle,
 *          35 s), and what it uses of a core at rest
 *   apps   each app (--apps, by id) opened --loads times (3), one at a time:
 *          what it added to Din's memory, its page's load timings, and what
 *          it uses of a core left alone. The
 *          loads are cold, warm and hot in V8's code cache's sense: the first
 *          compiles, the second has the cache written, the third reads it
 *   all    every one of them open at once
 *
 * Memory is PSS (each shared page split between the processes sharing it),
 * from /proc/<pid>/smaps_rollup, over the Electron main process and
 * everything under it (renderers, the GPU process, Electron's utilities,
 * the native apps' Xvfb) and the Assistant's OpenCode server, after a forced GC
 * in every page; `electronMB` is Electron's own processes alone. An app's
 * cost (`addedMB`) is how much those grow while it's open, its renderer and
 * what it made the GPU process and main hold: the rest come and go on their
 * own (the Assistant's server, nmcli) and would drown it. Each load is
 * measured against the desktop settled after the window before it closed
 * (--settle, 8 s, for both: see SETTLE_MS), and the loads agree to a few MB
 * from run to run. `ownMB` is the processes the app started and `restMB` how
 * the ones already there changed, by kind: those go down when an app opens,
 * since PSS now splits the pages they share (Electron's own code) with one
 * more process. Only the sum says what the app costs.
 *
 * CPU is what the processes used of one core with nothing asked of them, over
 * --rest seconds (5; 0 to skip): the idle desktop's by kind, and for each
 * app's last load its own processes' and the rest's. An app that reads above
 * zero at rest is drawing or polling when it needn't.
 *
 * Din runs with a throwaway home (HOME, XDG_RUNTIME_DIR, XDG_STATE_HOME), no
 * session bus, and on its own Xvfb (software GL, so the GPU process's memory
 * and CPU aren't a real GPU's) unless --visible. It never signs in and never
 * publishes. The Assistant's OpenCode server detaches from Din (its own
 * session, not under Din's process tree), so it's found by the pid it writes
 * down, counted as `opencode`, given a port of its own so that it neither
 * collides with a server the user is running nor is left holding OpenCode's
 * usual port, and stopped when the run ends.
 *
 * Output: `perf-reports/memory[-<label>].json` and a summary on stdout; with
 * --compare, each number's change from that report.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APPS = opt("apps", "calculator,text-editor,file-browser,terminal,mail,messages,calendar,settings,web-browser")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s && s !== "none");
const LOADS = Number(opt("loads", "3"));
// Chromium's compositor keeps a tile or a buffer it has stopped using for five
// seconds before letting it go, in the page's process and the GPU's both: a
// window's opening and closing leave 10 to 20 MB of them. Sooner than that a
// sample holds them or doesn't, by luck.
const SETTLE_MS = Number(opt("settle", "8")) * 1000;
// The main process keeps what starting up left on its heap until V8 gets to
// it, half a minute in: about 30 MB, which the first app measured would be
// credited with giving back.
const BOOT_SETTLE_MS = Number(opt("boot-settle", "35")) * 1000;
const REST_MS = Number(opt("rest", "5")) * 1000;
const BREAKDOWN_DEPTH = Number(opt("breakdown-depth", "2"));
const LABEL = opt("label", "");
const COMPARE = opt("compare", "");
const VIEWPORT = { width: 1920, height: 1080 };
const OUT = resolve(root, "perf-reports");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (kb) => Math.round(kb / 102.4) / 10;

// ─── Build ──────────────────────────────────────────────────────────────────

if (!flag("skip-build")) {
  console.log("building (npm run build)…");
  const r = spawnSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
for (const file of ["dist/index.html", "electron/main.mjs"]) {
  if (!existsSync(resolve(root, file))) {
    console.error(`no ${file}: run without --skip-build`);
    process.exit(1);
  }
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
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));

const home = opt("home", "") ? resolve(opt("home", "")) : mkdtempSync(join(tmpdir(), "din-perf-memory-"));
if (opt("home", "") || flag("keep-home")) cleanups.push(() => console.log(`kept Din's home: ${home}`));
else cleanups.push(() => rmSync(home, { recursive: true, force: true }));
const runtimeDir = join(home, "run");
mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
const socket = join(runtimeDir, "din.sock");
// A run before in the same home may have left it.
rmSync(socket, { force: true });

// ─── Display ────────────────────────────────────────────────────────────────

/** An Xvfb of our own, by the display number it picks. */
async function startXvfb() {
  const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${VIEWPORT.width}x${VIEWPORT.height}x24`, "-nolisten", "tcp"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(proc);
  return new Promise((res, rej) => {
    let buf = "";
    proc.on("error", () => rej(new Error("Xvfb isn't installed: install it, or pass --visible")));
    proc.on("exit", (code) => rej(new Error(`Xvfb exited (${code})`)));
    proc.stdio[3].on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) res(`:${buf.trim()}`);
    });
  });
}

const display = flag("visible") ? null : await startXvfb();

// ─── Din ────────────────────────────────────────────────────────────────────

const env = {
  ...process.env,
  HOME: home,
  XDG_RUNTIME_DIR: runtimeDir,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"),
  // Where OpenCode says which server is running: never the user's own, which Din would attach to.
  XDG_STATE_HOME: join(home, ".local/state"),
  DBUS_SESSION_BUS_ADDRESS: "disabled:",
};

// The Assistant's OpenCode server takes a port of its own. On OpenCode's usual
// one it would either fail against the server the user is running (Din trying
// again every minute, three processes and 200 MB for twenty seconds each
// time), or, with none running, take the port and be left holding it.
const assistantConfig = join(env.XDG_CONFIG_HOME, "opencode/service.json");
if (!existsSync(assistantConfig)) {
  const port = await new Promise((res, rej) => {
    const probe = net.createServer();
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => res(port));
    });
  });
  mkdirSync(dirname(assistantConfig), { recursive: true });
  writeFileSync(assistantConfig, `${JSON.stringify({ port })}\n`);
}

/**
 * The Assistant's server, once Din has started it: OpenCode's own word for
 * its pid. It leaves Din's process tree (a session of its own, so that it
 * outlives the client that started it), so it's neither found under Din nor
 * stopped with it.
 */
function assistantServer() {
  try {
    const { pid } = JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "opencode/service.json"), "utf8"));
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return cmdline.includes("serve") && cmdline.includes("--service") ? pid : null;
  } catch {
    return null;
  }
}
// Before the home goes, which is where its pid is.
cleanups.unshift(() => {
  const pid = assistantServer();
  if (pid === null) return;
  try {
    // It leads a process group of its own: whatever it started goes with it.
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
});
// None of the session's: DIN_NOSTRD_SOCKET would hand it the user's signer,
// DIN_POLKIT_AGENT a second agent on the system bus, and so on.
for (const name of Object.keys(env)) if (name.startsWith("DIN_")) delete env[name];
delete env.ELECTRON_RUN_AS_NODE;
if (display) {
  env.DISPLAY = display;
  delete env.WAYLAND_DISPLAY;
}

// The binary itself, not node_modules/.bin's Node wrapper around it, so the
// process tree's root is Electron's main process.
const electron = (await import("electron")).default;
const started = performance.now();
const startedAt = Date.now();
// --breakdown asks main which process each app's page is in.
const MAIN_INSPECTOR = flag("main-heap") || flag("main-snapshot") || flag("breakdown");
const MAIN_HEAP = flag("main-heap") || flag("main-snapshot");
const din = spawn(
  electron,
  [
    ...(MAIN_INSPECTOR ? ["--inspect=0"] : []),
    resolve(root, "electron/main.mjs"),
    "--remote-debugging-port=0",
    "--enable-unsafe-swiftshader",
    ...(display ? ["--ozone-platform=x11"] : []),
    // --chromium a=1,b: Chromium switches to try (--a=1 --b).
    ...opt("chromium", "").split(",").filter(Boolean).map((s) => `--${s}`),
  ],
  { cwd: root, env, stdio: ["ignore", "ignore", "pipe"], detached: true },
);
children.push(din);
let dinLog = "";
const devtoolsUrl = new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(`Electron never printed its DevTools URL:\n${dinLog.slice(-4000)}`)), 60_000);
  din.stderr.on("data", (d) => {
    dinLog += d;
    const m = dinLog.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      res(m[1]);
    }
  });
  din.on("exit", (code) => rej(new Error(`Electron exited (${code}):\n${dinLog.slice(-4000)}`)));
});
/** The main process's Node inspector, with --main-heap. */
const inspectorUrl = MAIN_INSPECTOR
  ? new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("Electron's main never printed its inspector URL")), 60_000);
      const look = () => {
        const m = dinLog.match(/Debugger listening on (ws:\/\/\S+)/);
        if (!m) return;
        clearTimeout(timer);
        din.stderr.off("data", look);
        res(m[1]);
      };
      din.stderr.on("data", look);
    })
  : null;

/**
 * One `din` command over the socket, as electron/din-cli.mts sends it; its
 * answer's data, or null if it isn't answering (within `timeoutMs`, if given).
 */
function command(argv, timeoutMs) {
  return new Promise((res, rej) => {
    const conn = net.connect(socket);
    if (timeoutMs) {
      conn.setTimeout(timeoutMs, () => {
        conn.destroy();
        res(null);
      });
    }
    let buf = "";
    conn.setEncoding("utf8");
    conn.once("error", () => res(null));
    conn.once("connect", () => conn.write(`${JSON.stringify({ command: argv, cwd: home })}\n`));
    conn.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type !== "answer") continue;
        conn.end();
        if (msg.ok !== true) rej(new Error(`din ${argv.join(" ")}: ${msg.error ?? "failed"}`));
        else res(msg.data ?? {});
      }
    });
    conn.once("close", () => res(null));
  });
}

/**
 * `--apps empty`: an app that's an empty page, run from a folder as `din apps
 * run` does, in a window of its own like any app's: what a window costs
 * before an app puts anything in it.
 */
const EMPTY_APP = "empty";

/** Run a folder's app (`din apps run --detach`); its page's URL. */
function runFolder(dir) {
  return new Promise((res, rej) => {
    const conn = net.connect(socket);
    let buf = "";
    conn.setEncoding("utf8");
    conn.once("error", rej);
    conn.once("connect", () => conn.write(`${JSON.stringify({ dir, detach: true, paths: [] })}\n`));
    conn.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.type === "error") rej(new Error(`din apps run: ${msg.message}`));
        if (msg.type === "opened") {
          conn.end();
          res(String(msg.url));
        }
      }
    });
  });
}

/** Open an app (or the empty one): the URL its page loads at, and a way to close its window. */
async function openApp(id) {
  if (id === EMPTY_APP) {
    // --empty-dir: a page of your own instead (titled "Empty", for closing), to measure what only it costs.
    const dir = opt("empty-dir", "") ? resolve(opt("empty-dir", "")) : join(home, "empty-app");
    if (!opt("empty-dir", "")) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), "<!doctype html><title>Empty</title><body></body>\n");
    }
    const url = await runFolder(dir);
    return { page: url, close: () => command(["windows", "close", "Empty"]).catch(() => {}) };
  }
  const opened = await command(["apps", "open", id]);
  return {
    page: `din://${id}/`,
    close: () => (opened?.window ? command(["windows", "close", opened.window]).catch(() => {}) : Promise.resolve()),
  };
}

// ─── DevTools ───────────────────────────────────────────────────────────────

/** A minimal DevTools-protocol client over Node's WebSocket (flattened sessions). */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p?.resolve(msg.result);
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
    return () => this.listeners.get(method).delete(fn);
  }
}

const browser = await CDP.connect(await devtoolsUrl);

const pageTargets = async () =>
  (await browser.send("Target.getTargets")).targetInfos.filter((t) => t.type === "page" || t.type === "webview");

/** Run `expression` in a target, its value; null if the target went away. */
async function inTarget(targetId, fn) {
  let sessionId;
  try {
    ({ sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true }));
    return await fn(sessionId);
  } catch {
    return null;
  } finally {
    if (sessionId) await browser.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

const evaluate = (sessionId, expression) =>
  browser.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result.value);

/** A forced GC in every page, so the memory read after is what's live. */
async function collectGarbage() {
  for (const t of await pageTargets()) await inTarget(t.targetId, (s) => browser.send("HeapProfiler.collectGarbage", {}, s));
}

const TIMINGS = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const fcp = performance.getEntriesByName("first-contentful-paint")[0];
  const scripts = performance.getEntriesByType("resource").filter((r) => r.initiatorType === "script" || r.name.endsWith(".js"));
  return nav && nav.loadEventEnd > 0 ? {
    timeOrigin: performance.timeOrigin,
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    loadMs: Math.round(nav.loadEventEnd),
    firstPaintMs: fcp ? Math.round(fcp.startTime) : null,
    scripts: scripts.length,
  } : null;
})()`;

/**
 * The load timings of the page at `prefix` once it has loaded; null if none
 * appears within `appearMs` (an app the desktop draws itself, like Settings,
 * has no page of its own) or it doesn't load within 30 s.
 */
async function pageTimings(prefix, appearMs = 30_000) {
  const appearBy = Date.now() + appearMs;
  const loadBy = Date.now() + 30_000;
  let seen = false;
  while (Date.now() < (seen ? loadBy : appearBy)) {
    for (const t of await pageTargets()) {
      if (!t.url.startsWith(prefix)) continue;
      seen = true;
      const timings = await inTarget(t.targetId, (s) => evaluate(s, TIMINGS));
      if (timings) return timings;
    }
    await sleep(100);
  }
  return null;
}

// ─── Memory ─────────────────────────────────────────────────────────────────

/** Every process under these, themselves included. */
function descendants(...roots) {
  const parent = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // The comm field may hold spaces and parentheses: ppid follows the last ")".
      parent.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {
      // gone
    }
  }
  const under = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, ppid] of parent) {
      if (!under.has(child) && under.has(ppid)) {
        under.add(child);
        grew = true;
      }
    }
  }
  return [...under];
}

/** What a process is: Electron's by its --type, anything else by its name. */
function kindOf(pid) {
  // Chromium rewrites its processes' command lines as one string, spaces between.
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]/);
  const type = cmdline.find((a) => a.startsWith("--type="))?.slice(7);
  if (!type) return pid === din.pid ? "main" : readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  if (type === "utility") {
    const sub = cmdline.find((a) => a.startsWith("--utility-sub-type="))?.slice(19) ?? "";
    return `utility:${sub.split(".").pop()}`;
  }
  return type;
}

/** Electron's own processes, as opposed to what Din runs (the Assistant's server, native apps, nmcli). */
const isElectron = (kind) => ["main", "renderer", "gpu-process", "zygote"].includes(kind) || kind.startsWith("utility:");

/** Din's whole process tree, and the Assistant's server and what it runs, which left it. */
function dinProcesses() {
  const server = assistantServer();
  return descendants(din.pid, ...(server === null ? [] : [server]));
}

/** PSS of Din's whole process tree and of Electron's part of it, and by kind of process. */
function measure() {
  const byKind = {};
  const byPid = new Map();
  let totalKB = 0;
  let electronKB = 0;
  let processes = 0;
  let electronProcesses = 0;
  for (const pid of dinProcesses()) {
    let pss;
    let kind;
    try {
      pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1] ?? 0);
      kind = kindOf(pid);
    } catch {
      continue;
    }
    byPid.set(pid, { kind, kb: pss });
    totalKB += pss;
    processes++;
    if (isElectron(kind)) {
      electronKB += pss;
      electronProcesses++;
    }
    const k = (byKind[kind] ??= { count: 0, mb: 0 });
    k.count++;
    k.mb = Math.round((k.mb + pss / 1024) * 10) / 10;
  }
  const sample = { totalMB: mb(totalKB), processes, electronMB: mb(electronKB), electronProcesses, byKind };
  // Each process's own, for telling an app's from the rest: not part of the report.
  Object.defineProperty(sample, "byPid", { value: byPid });
  return sample;
}

/** CPU time a process has used so far (user and system), in seconds; null once it's gone. */
function cpuSeconds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / 100;
  } catch {
    return null;
  }
}

/**
 * What Din's processes use of one core over `ms` with nothing asked of them,
 * in percent: `own` (an app's processes) together, and the rest by kind.
 */
async function restingCpu(sample, ms, own = new Set()) {
  const before = new Map([...sample.byPid.keys()].map((pid) => [pid, cpuSeconds(pid)]));
  const started = performance.now();
  await sleep(ms);
  const seconds = (performance.now() - started) / 1000;
  const byKind = {};
  let ownSeconds = 0;
  for (const [pid, was] of before) {
    const now = cpuSeconds(pid);
    if (was === null || now === null) continue;
    if (own.has(pid)) ownSeconds += now - was;
    else byKind[sample.byPid.get(pid).kind] = (byKind[sample.byPid.get(pid).kind] ?? 0) + (now - was);
  }
  const pct = (s) => Math.round((s / seconds) * 1000) / 10;
  return {
    ...(own.size > 0 ? { ownPct: pct(ownSeconds) } : {}),
    byKind: Object.fromEntries(Object.entries(byKind).map(([kind, s]) => [kind, pct(s)]).filter(([, p]) => p > 0)),
  };
}

const cpuLine = (byKind) =>
  Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, p]) => `${kind} ${p}%`)
    .join(", ") || "nothing";

const mainInspector = inspectorUrl ? CDP.connect(await inspectorUrl) : null;

/**
 * The main process's own memory as Node sees it, after a GC (--main-heap):
 * V8's heap, the memory outside it that JS objects hold (Buffers,
 * ArrayBuffers), and the resident total, the rest of which is Chromium's.
 */
async function mainHeap() {
  if (!mainInspector) return null;
  const main = await mainInspector;
  await main.send("HeapProfiler.collectGarbage");
  const { result } = await main.send("Runtime.evaluate", { expression: "JSON.stringify(process.memoryUsage())", returnByValue: true });
  const usage = JSON.parse(result.value);
  const m = (bytes) => Math.round(bytes / 1024 / 102.4) / 10;
  return { rssMB: m(usage.rss), heapUsedMB: m(usage.heapUsed), heapTotalMB: m(usage.heapTotal), externalMB: m(usage.external), arrayBuffersMB: m(usage.arrayBuffers) };
}

/** The OS process of the page whose URL starts with `prefix`, by Electron's own account, or null. */
async function pagePid(prefix) {
  if (!mainInspector) return null;
  const main = await mainInspector;
  // `require` is the inspector's own (its command-line API): main is an ES module.
  const expression = `JSON.stringify(require("electron").webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => [w.getURL(), w.getOSProcessId()]))`;
  const { result } = await main.send("Runtime.evaluate", { expression, includeCommandLineAPI: true, returnByValue: true });
  if (typeof result?.value !== "string") return null;
  return JSON.parse(result.value).find(([url]) => url.startsWith(prefix))?.[1] ?? null;
}

/** A heap snapshot of the main process, written to `file` (--main-snapshot). */
async function mainSnapshot(file) {
  const main = await mainInspector;
  const chunks = [];
  const off = main.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => chunks.push(chunk));
  await main.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  off();
  writeFileSync(file, chunks.join(""));
}

function dirBytes(dir) {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    bytes += entry.isDirectory() ? dirBytes(file) : statSync(file).size;
  }
  return bytes;
}

/**
 * Chromium's own account of each of its processes (--breakdown): a
 * memory-infra dump, as chrome://tracing takes one. Per process its private
 * footprint (what it alone costs) and that by allocator, the top level
 * (v8, blink_gc, partition_alloc, cc, skia, discardable, gpu, …) and the
 * level below for the big ones; a renderer is named by its page's title.
 */
let traceWritten = false;
async function breakdown() {
  const events = [];
  const offData = browser.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  const complete = new Promise((res) => {
    const off = browser.on("Tracing.tracingComplete", () => {
      off();
      res();
    });
  });
  await browser.send("Tracing.start", {
    traceConfig: { includedCategories: ["disabled-by-default-memory-infra"], memoryDumpConfig: { triggers: [] } },
  });
  await browser.send("Tracing.requestMemoryDump", { deterministic: true, levelOfDetail: "detailed" });
  await browser.send("Tracing.end");
  await complete;
  offData();
  // --breakdown-trace: the first dump (the idle desktop's) whole, every allocator and its attributes.
  if (flag("breakdown-trace") && !traceWritten) {
    traceWritten = true;
    writeFileSync(resolve(OUT, `breakdown${LABEL ? `-${LABEL}` : ""}.trace.json`), JSON.stringify({ traceEvents: events }));
  }

  const names = new Map();
  const labels = new Map();
  for (const e of events) {
    if (e.ph !== "M") continue;
    if (e.name === "process_name") names.set(e.pid, e.args.name);
    if (e.name === "process_labels") labels.set(e.pid, e.args.labels);
  }
  const hexMB = (v) => Math.round(parseInt(v ?? "0", 16) / 104857.6) / 10;
  // A process's totals and its allocators come in events of their own.
  const byPid = new Map();
  for (const e of events) {
    const dumps = e.ph === "v" ? e.args?.dumps : null;
    if (!dumps || names.get(e.pid)?.includes("TracingService")) continue;
    const p = byPid.get(e.pid) ?? { pid: e.pid, type: names.get(e.pid) ?? "?", label: labels.get(e.pid) ?? null, footprintMB: 0, allocators: {} };
    byPid.set(e.pid, p);
    if (dumps.process_totals) p.footprintMB = hexMB(dumps.process_totals.private_footprint_bytes);
    for (const [name, dump] of Object.entries(dumps.allocators ?? {})) {
      const depth = name.split("/").length;
      const size = hexMB(dump.attrs?.size?.value);
      // The level below only where it's big enough to be worth naming; leaves of shared or global dumps are ids.
      // --breakdown-depth goes further down (into the report, the summary keeps to the biggest ten).
      const worthNaming = depth === 2 ? size >= 2 : depth <= BREAKDOWN_DEPTH && size >= 0.5;
      if (depth === 1 ? size >= 0.5 : worthNaming && !/^(global|shared_memory|discardable)\//.test(name)) p.allocators[name] = size;
    }
  }
  const processes = [...byPid.values()].filter((p) => p.footprintMB > 0);
  for (const p of processes) p.allocators = Object.fromEntries(Object.entries(p.allocators).sort((a, b) => b[1] - a[1]));
  return processes.sort((a, b) => b.footprintMB - a.footprintMB);
}

function printBreakdown(processes) {
  for (const p of processes) {
    console.log(`    ${String(p.footprintMB).padStart(6)} MB  ${p.type}${p.label ? ` (${p.label})` : ""}`);
    const top = Object.entries(p.allocators).slice(0, 10).map(([k, v]) => `${k} ${v}`);
    if (top.length) console.log(`              ${top.join(" · ")}`);
  }
}

async function settledSample(ms) {
  await sleep(ms);
  await collectGarbage();
  await sleep(500);
  return measure();
}

// ─── Run ────────────────────────────────────────────────────────────────────

const report = { generatedAt: new Date().toISOString(), label: LABEL || null, display: display ? "xvfb" : "visible", apps: {} };

try {
  let ready = null;
  let listeningMs = null;
  for (let i = 0; i < 1200 && !ready; i++) {
    if (listeningMs === null && existsSync(socket)) listeningMs = Math.round(performance.now() - started);
    // A command sent before the desktop listens waits out main's timeout: each try gives up soon.
    ready = await command(["windows", "list"], 250).catch(() => null);
    if (!ready) await sleep(50);
  }
  if (!ready) throw new Error("Din never answered on its socket");
  const answeredMs = Math.round(performance.now() - started);
  const { timeOrigin, ...desktop } = (await pageTimings("app://din")) ?? {};
  report.boot = {
    // Electron started to main listening on the din socket.
    listeningMs,
    // To the desktop's page starting to load, and to the desktop answering a command.
    desktopNavigationMs: timeOrigin ? Math.round(timeOrigin - startedAt) : null,
    answeredMs,
    desktop,
  };
  console.log(
    `\n▶ boot: main listening at ${listeningMs} ms, the desktop's page started at ${report.boot.desktopNavigationMs} ms ` +
      `and loaded ${desktop.loadMs ?? "?"} ms after, answering commands at ${answeredMs} ms`,
  );

  // --set key=value[,key=value]: settings (`din settings set`) to measure under.
  for (const pair of opt("set", "").split(",").filter(Boolean)) {
    const at = pair.indexOf("=");
    await command(["settings", "set", pair.slice(0, at), pair.slice(at + 1)]);
  }
  if (opt("set", "")) report.settings = opt("set", "");

  report.idle = await settledSample(BOOT_SETTLE_MS);
  if (flag("breakdown")) {
    report.idle.breakdown = await breakdown();
    console.log("▶ idle, by Chromium's account (private footprint, MB by allocator):");
    printBreakdown(report.idle.breakdown);
  }
  console.log(
    `▶ idle desktop: ${report.idle.totalMB} MB in ${report.idle.processes} processes, ` +
      `Electron's ${report.idle.electronMB} MB in ${report.idle.electronProcesses}`,
  );
  report.idle.cpu = (await restingCpu(report.idle, REST_MS * 2)).byKind;
  console.log(`  at rest, of one core: ${cpuLine(report.idle.cpu)}`);
  if (MAIN_HEAP) {
    report.idle.main = await mainHeap();
    const h = report.idle.main;
    console.log(`  main: ${h.rssMB} MB resident, V8 heap ${h.heapUsedMB} of ${h.heapTotalMB} MB, ${h.externalMB} MB external`);
  }
  if (flag("main-snapshot")) {
    const file = resolve(OUT, `main${LABEL ? `-${LABEL}` : ""}.heapsnapshot`);
    await mainSnapshot(file);
    console.log(`  wrote ${file.slice(root.length + 1)}`);
  }

  const known = new Set([EMPTY_APP, ...((await command(["apps", "list"])) ?? []).map((a) => a.id)]);
  for (const id of APPS.filter((a) => !known.has(a))) console.warn(`  no app ${id}, skipped`);
  const apps = APPS.filter((a) => known.has(a));

  if (apps.length > 0) console.log(`\n▶ apps, ${LOADS} loads each (cold, warm, hot)`);
  // The desktop with nothing open, settled: what each load is measured against.
  let before = measure();
  for (const id of apps) {
    const loads = [];
    let renderer = null;
    for (let n = 0; n < LOADS; n++) {
      // The last load's renderer, by Chromium's account.
      const last = flag("breakdown") && n === LOADS - 1;
      const opened = await openApp(id).catch((error) => {
        console.warn(`  ${error.message}`);
        return undefined;
      });
      if (opened === undefined) break;
      const timings = await pageTimings(opened.page, 3000);
      const open = await settledSample(SETTLE_MS);
      if (last) {
        const pid = await pagePid(opened.page);
        renderer = pid === null ? null : ((await breakdown()).find((p) => p.pid === pid) ?? null);
        // --purge: what the renderer gives back when told memory is short, as Chrome tells background tabs.
        if (renderer && flag("purge")) {
          const page = (await pageTargets()).find((t) => t.url.startsWith(opened.page));
          if (page) await inTarget(page.targetId, (s) => browser.send("Memory.simulatePressureNotification", { level: "critical" }, s));
          await sleep(2000);
          const after = (await breakdown()).find((p) => p.pid === pid);
          if (after) renderer.afterPurge = { footprintMB: after.footprintMB, allocators: after.allocators };
        }
      }
      // The app's own processes, and what the ones there before it hold now, by kind.
      const own = new Set([...open.byPid].filter(([pid, p]) => !before.byPid.has(pid) && isElectron(p.kind)).map(([pid]) => pid));
      const ownKB = [...own].reduce((sum, pid) => sum + open.byPid.get(pid).kb, 0);
      const rest = {};
      for (const [pid, p] of open.byPid) {
        const was = before.byPid.get(pid);
        if (was && isElectron(p.kind)) rest[p.kind] = (rest[p.kind] ?? 0) + (p.kb - was.kb);
      }
      const { timeOrigin: _, ...loadTimings } = timings ?? {};
      loads.push({
        ...loadTimings,
        addedMB: Math.round((open.electronMB - before.electronMB) * 10) / 10,
        ownMB: mb(ownKB),
        restMB: Object.fromEntries(Object.entries(rest).map(([kind, kb]) => [kind, mb(kb)]).filter(([, m]) => Math.abs(m) >= 0.5)),
        processesAdded: open.electronProcesses - before.electronProcesses,
        // Once, on the last load: three loads' worth of waiting would tell no more.
        ...(n === LOADS - 1 && REST_MS > 0 ? { cpu: await restingCpu(open, REST_MS, own) } : {}),
      });
      await opened.close();
      // As long as an open window gets: what closing it left takes as long to go.
      before = await settledSample(SETTLE_MS);
    }
    if (loads.length === 0) continue;
    report.apps[id] = loads;
    if (renderer) (report.renderers ??= {})[id] = renderer;
    const row = loads.map((l) => (l.loadMs !== undefined ? `${l.loadMs} ms` : "—")).join(" / ");
    const last = loads.at(-1);
    const others = Object.values(last.cpu?.byKind ?? {}).reduce((sum, p) => sum + p, 0);
    const resting = last.cpu ? `   at rest ${last.cpu.ownPct ?? 0}% its own, ${Math.round(others * 10) / 10}% the rest` : "";
    const added = loads.map((l) => l.addedMB).join(" / ");
    console.log(`  ${id.padEnd(16)} + ${added} MB (its own ${last.ownMB})   load ${row}${resting}`);
    if (renderer) {
      const top = Object.entries(renderer.allocators).slice(0, 8).map(([k, v]) => `${k} ${v}`);
      console.log(`  ${"".padEnd(16)} its renderer: ${renderer.footprintMB} MB · ${top.join(" · ")}`);
      if (renderer.afterPurge) console.log(`  ${"".padEnd(16)} after a memory-pressure purge: ${renderer.afterPurge.footprintMB} MB`);
    }
  }

  const measured = Object.keys(report.apps);
  if (measured.length > 0) {
    console.log("\n▶ all open at once");
    for (const id of measured) {
      await openApp(id);
      await sleep(1500);
    }
    report.all = { apps: measured.length, ...(await settledSample(SETTLE_MS * 2)) };
    if (flag("breakdown")) {
      report.all.breakdown = await breakdown();
      console.log("  by Chromium's account:");
      printBreakdown(report.all.breakdown);
    }
    if (MAIN_HEAP) report.all.main = await mainHeap();
    console.log(
      `  ${report.all.totalMB} MB in ${report.all.processes} processes with ${measured.length} apps open, ` +
        `Electron's ${report.all.electronMB} MB in ${report.all.electronProcesses}`,
    );
  }
  for (const [kind, k] of Object.entries((report.all ?? report.idle).byKind).sort((a, b) => b[1].mb - a[1].mb)) {
    console.log(`    ${kind.padEnd(24)} ${String(k.count).padStart(3)} × → ${k.mb} MB`);
  }
  // What V8 kept of the scripts it compiled (only http(s) and schemes with
  // `codeCache`), in the desktop's session and each partition (din-apps, …).
  // A script's first load leaves a marker; its second, the code.
  const userData = join(home, ".config/Electron");
  const partitions = join(userData, "Partitions");
  const caches = [userData, ...(existsSync(partitions) ? readdirSync(partitions).map((p) => join(partitions, p)) : [])]
    .map((dir) => join(dir, "Code Cache/js"))
    .filter((dir) => existsSync(dir));
  report.codeCacheKB = Math.round(caches.reduce((sum, dir) => sum + dirBytes(dir), 0) / 1024);
  console.log(`\n▶ V8's code cache: ${report.codeCacheKB} KB`);
} finally {
  const name = `memory${LABEL ? `-${LABEL}` : ""}.json`;
  writeFileSync(resolve(OUT, name), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote perf-reports/${name}`);
}

if (COMPARE) {
  const old = JSON.parse(readFileSync(resolve(COMPARE), "utf8"));
  const diff = (a, b, unit) => (typeof a === "number" && typeof b === "number" ? `${b} → ${a} ${unit} (${a - b >= 0 ? "+" : ""}${Math.round((a - b) * 10) / 10})` : "—");
  console.log(`\n▶ against ${COMPARE}`);
  console.log(`  boot to answering ${diff(report.boot?.answeredMs, old.boot?.answeredMs, "ms")}`);
  console.log(`  desktop load      ${diff(report.boot?.desktop?.loadMs, old.boot?.desktop?.loadMs, "ms")}`);
  console.log(`  V8's code cache   ${diff(report.codeCacheKB, old.codeCacheKB, "KB")}`);
  console.log(`  idle, Electron    ${diff(report.idle?.electronMB, old.idle?.electronMB, "MB")}`);
  console.log(`  all open, Electron ${diff(report.all?.electronMB, old.all?.electronMB, "MB")}`);
  for (const [id, loads] of Object.entries(report.apps)) {
    const was = old.apps?.[id];
    if (!was) continue;
    const cells = loads.map((l, i) => diff(l.loadMs, was[i]?.loadMs, "ms")).join("   ");
    console.log(`  ${id.padEnd(16)}  load ${cells}`);
  }
}

process.exit(0);
