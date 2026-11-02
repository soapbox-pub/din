// The System Monitor bridge (window.dinos.systemMonitor, for the System Monitor
// app): what's running, what it costs, and a way to stop it.
//
// Sampling: /proc is read (proc-stats.mts) every SAMPLE_MS while the app is
// open, and each snapshot is pushed to the shell as `system-monitor:snapshot`.
// Nothing runs while nobody is subscribed; a shell reload drops every
// subscription, since the page that made them is gone.
//
// CPU is a share of the whole machine, like Windows' Task Manager: a process
// keeping one core of eight busy reads 12.5%, and the column adds up to the
// total. Both come from the same clock: a process's ticks over every CPU's
// ticks since the last sample (/proc/stat).
//
// GPU: the whole GPU's busy share and memory come from its driver
// (/sys/class/drm/card*/device, amdgpu only), a process's from the GPU time
// its DRM clients report (/proc/<pid>/fdinfo, as nvtop reads it) over the
// time since the last sample. Walking every fd of every process each sample
// is thousands of readlinks, so which fds are on the GPU is remembered and
// only looked for again every FD_RESCAN samples. A client open in several
// processes (a child inherits its parent's fds) counts for the oldest.
// Other users' fds are unreadable, so their GPU use is unknown (null).
//
// Disk: traffic is bytes read and written per second, every physical disk
// together (/proc/diskstats), not a percentage: an NVMe drive serves many
// requests at once, so the share of time it has one in flight (Windows'
// "active time", sent along as activeTime) can read 100% at a fraction of
// what it can do. Space is statfs on / and /home, whose levels the
// low-space notification (disk-space.mts) shares.
//
// Processes are labelled with what the user sees. Electron's own processes
// come from app.getAppMetrics(), and each page renderer from the
// WebContents it hosts (a browser tab, an installed web app). Native apps
// are found by ancestry: the process Din launched for an app (native-apps.mts)
// and everything under it, and the Terminal's shells under their
// pty-host.py. The shell groups by these.
//
// Ending: SIGTERM, or SIGKILL to force quit, and only Din's own user's
// processes. Din itself is refused - the main process, what it runs on
// (din-shell), the desktop's renderer, the GPU process and Electron's helpers -
// since losing any of them ends the session. A page renderer is crashed
// through its WebContents instead of signalled, so Electron knows what
// happened and the window shows the page stopped (BrowserView's crashed
// state), with Reload.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { app, ipcMain, webContents } from 'electron';
import { launchedApps } from './native-apps.mts';
import {
  commandDetail,
  displayName,
  readCmdline,
  readCpuTimes,
  readDiskIo,
  readDrmClients,
  readDrmFds,
  readFilesystems,
  readGpu,
  readMemory,
  readOwner,
  readProcesses,
  readUptimeAndLoad,
  readUsers,
  startedAt,
  type CpuTimes,
  type DiskIo,
  type DrmClient,
  type FilesystemSpace,
  type GpuTotals,
  type MemoryTotals,
  type ProcEntry,
} from './proc-stats.mts';

/** How often a snapshot goes out while the app is open. */
const SAMPLE_MS = 2000;
/** The first one comes sooner: CPU use needs two readings. */
const FIRST_SAMPLE_MS = 500;
/**
 * How long a force-quit page renderer gets to crash before it's killed.
 * Crashing takes a while (a hung one can take ten seconds, while its
 * crash dump is written); force quit means now.
 */
const CRASH_GRACE_MS = 1000;
/** How many samples a process's GPU fds are remembered for before they're looked for again. */
const FD_RESCAN = 10;

const SYSTEM_MESSAGE = 'This belongs to the system.';
const DIN_MESSAGE = 'Din needs this to keep running.';
const HOST_MESSAGE = 'Din runs on this; ending it would end the session.';

/** What kind of page a WebContents shows. */
export type PageKind = 'browser-tab' | 'private-tab' | 'web-app' | 'devtools' | 'page';

export interface PageInfo {
  kind: PageKind;
  title: string;
  url: string;
  /** False while the page is hung (Chromium's unresponsive renderer check). */
  responding: boolean;
}

/** What Din knows a process to be, for labelling and grouping. */
export type ProcessRole =
  /** One of Din's own: the main process, the desktop, the GPU process, ... */
  | { kind: 'din'; label: string }
  /** Something else Din started (the compositor, the services host, ...). */
  | { kind: 'helper' }
  /** A renderer showing web pages (empty while it's a spare). */
  | { kind: 'pages'; pages: PageInfo[] }
  /** Part of an app Din launched: a native app, or the Terminal. */
  | { kind: 'app'; appId: string };

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  /** The full command line, space-joined. */
  command: string;
  /** Its arguments in short, e.g. the script an interpreter runs. */
  detail: string;
  uid: number;
  user: string;
  /** Owned by Din's own user. */
  mine: boolean;
  state: string;
  /** Percent of the whole machine's CPU since the last sample. */
  cpu: number;
  /** Percent of the GPU's time since the last sample, or null when it can't be read. */
  gpu: number | null;
  /** Resident memory, in bytes. */
  memory: number;
  /** Start time, in ms since the epoch. */
  startedAt: number;
  role: ProcessRole | null;
  /** Why it can't be ended from here, or null when it can. */
  blocked: string | null;
}

export interface DiskTotals {
  /** Traffic since the last sample, or null without a physical disk to read. */
  io: {
    /** Bytes read and written per second. */
    readRate: number;
    writeRate: number;
    /** Percent of the time the busiest disk had a request in flight. */
    activeTime: number;
  } | null;
  filesystems: FilesystemSpace[];
}

export interface SystemSnapshot {
  /** When it was taken, in ms since the epoch. */
  at: number;
  /** Percent of the whole machine's CPU in use. */
  cpu: number;
  cpuCount: number;
  memory: MemoryTotals;
  /** Null without a GPU whose driver says how busy it is. */
  gpu: GpuTotals | null;
  disk: DiskTotals;
  /** Seconds since boot. */
  uptime: number;
  /** 1, 5 and 15-minute load averages. */
  load: number[];
  processes: ProcessInfo[];
}

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let shell: () => Electron.WebContents | null = () => null;
let pageKind: (contents: Electron.WebContents) => PageKind = () => 'page';

let subscribers = 0;
let running = false;
/** Bumped on every start and stop, so a sample in flight from an older run is dropped. */
let generation = 0;
let timer: NodeJS.Timeout | null = null;
/** The last sample's counters, which the next one's CPU use is measured from. */
let previous: {
  cpu: CpuTimes;
  ticks: Map<string, number>;
  at: bigint;
  gpuNs: Map<string, number>;
  diskIo: DiskIo | null;
} | null = null;
/** Each process's fds on the GPU, as last looked for. */
let drmFds = new Map<string, number[]>();
let samples = 0;
/** Command lines by process (pid, start time, comm: exec changes the last). */
let cmdlines = new Map<string, string[]>();
let users: Map<number, string> | null = null;
/** WebContents whose page is hung, by id. */
const unresponsive = new Set<number>();
/** Din's own ancestors (din-shell, the session), found once. */
let hostPids: Promise<Set<number>> | null = null;

function processKey(entry: ProcEntry): string {
  return `${entry.pid}:${entry.startTicks}:${entry.comm}`;
}

/** The processes Din runs on: its parent, that one's parent, and so on. */
function hosts(): Promise<Set<number>> {
  hostPids ??= (async () => {
    const pids = new Set<number>();
    let pid = process.ppid;
    while (pid > 1 && !pids.has(pid)) {
      pids.add(pid);
      const owner = await readOwner(pid);
      if (!owner) break;
      pid = owner.ppid;
    }
    return pids;
  })();
  return hostPids;
}

/** Electron's view of its processes: types from its metrics, pages by renderer. */
function electronProcesses(): {
  metrics: Map<number, Electron.ProcessMetric>;
  pages: Map<number, { contents: Electron.WebContents; page: PageInfo | null }[]>;
} {
  const metrics = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric]));
  const desktop = shell();
  const pages = new Map<number, { contents: Electron.WebContents; page: PageInfo | null }[]>();
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const pid = contents.getOSProcessId();
    if (!pid) continue;
    const page =
      contents === desktop
        ? null
        : {
            kind: pageKind(contents),
            title: contents.getTitle(),
            url: contents.getURL(),
            responding: !unresponsive.has(contents.id),
          };
    const list = pages.get(pid) ?? [];
    list.push({ contents, page });
    pages.set(pid, list);
  }
  return { metrics, pages };
}

/** The role Electron itself gives a process, and whether that protects it. */
function electronRole(
  pid: number,
  electron: ReturnType<typeof electronProcesses>,
): { role: ProcessRole; blocked: string | null } | null {
  if (pid === process.pid) return { role: { kind: 'din', label: 'Din' }, blocked: DIN_MESSAGE };
  const hosted = electron.pages.get(pid);
  if (hosted?.some((h) => h.page === null)) {
    return { role: { kind: 'din', label: 'Desktop' }, blocked: DIN_MESSAGE };
  }
  const metric = electron.metrics.get(pid);
  if (hosted || metric?.type === 'Tab') {
    const pages = (hosted ?? []).flatMap((h) => (h.page ? [h.page] : []));
    return { role: { kind: 'pages', pages }, blocked: null };
  }
  if (!metric) return null;
  const label =
    metric.type === 'GPU'
      ? 'Graphics'
      : metric.type === 'Zygote' || metric.type === 'Sandbox helper'
        ? 'Process launcher'
        : metric.name || metric.serviceName || 'Helper';
  return { role: { kind: 'din', label }, blocked: DIN_MESSAGE };
}

/**
 * The Chromium process type in a command line (--type=zygote, renderer,
 * utility, ...), or null for anything that isn't one of Chromium's children.
 */
function chromiumType(argv: string[]): string | null {
  const arg = argv.find((a) => a.startsWith('--type='));
  return arg ? arg.slice('--type='.length) : null;
}

/**
 * The role of one of Electron's own children that its metrics leave out: the
 * zygotes every renderer is forked from (ending one breaks opening pages), and
 * spare renderers.
 */
function chromiumChildRole(type: string): { role: ProcessRole; blocked: string | null } {
  if (type === 'renderer') return { role: { kind: 'pages', pages: [] }, blocked: null };
  return { role: { kind: 'din', label: type === 'zygote' ? 'Process launcher' : 'Helper' }, blocked: DIN_MESSAGE };
}

/** Whether a process is one of Din's main process's descendants. */
async function underMain(pid: number): Promise<boolean> {
  let current = pid;
  for (let depth = 0; current > 1 && depth < 64; depth += 1) {
    const owner = await readOwner(current);
    if (!owner) return false;
    if (owner.ppid === process.pid) return true;
    current = owner.ppid;
  }
  return false;
}

/**
 * The GPU time each of our processes has used so far, in ns, by process key.
 * A client open in several processes counts once, for the oldest of them.
 */
async function gpuTimes(entries: ProcEntry[], me: number): Promise<Map<string, number>> {
  const rescan = samples % FD_RESCAN === 0;
  const mine = entries.filter((entry) => entry.uid === me).sort((a, b) => a.startTicks - b.startTicks);
  const fds = new Map<string, number[]>();
  const clients = await Promise.all(
    mine.map(async (entry): Promise<DrmClient[]> => {
      const key = processKey(entry);
      const known = rescan ? undefined : drmFds.get(key);
      const open = known ?? (await readDrmFds(entry.pid));
      fds.set(key, open);
      return open.length > 0 ? readDrmClients(entry.pid, open) : [];
    }),
  );
  drmFds = fds;
  const claimed = new Set<string>();
  const times = new Map<string, number>();
  mine.forEach((entry, i) => {
    let ns = 0;
    for (const client of clients[i]) {
      if (claimed.has(client.id)) continue;
      claimed.add(client.id);
      ns += client.engineNs;
    }
    times.set(processKey(entry), ns);
  });
  return times;
}

async function sample(): Promise<SystemSnapshot | null> {
  const [cpu, memory, gpu, diskIo, filesystems, entries, { uptime, load }] = await Promise.all([
    readCpuTimes(),
    readMemory(),
    readGpu(),
    readDiskIo(),
    readFilesystems(),
    readProcesses(),
    readUptimeAndLoad(),
  ]);
  if (!cpu) return null;
  users ??= await readUsers();
  const host = await hosts();
  const me = process.getuid?.() ?? -1;
  const at = process.hrtime.bigint();
  const gpuNs = await gpuTimes(entries, me);
  const wallNs = previous ? Number(at - previous.at) : 0;
  samples += 1;

  // Command lines don't change without the comm changing too (exec), so
  // each process's is read once.
  const seen = new Map<string, string[]>();
  await Promise.all(
    entries.map(async (entry) => {
      const key = processKey(entry);
      seen.set(key, cmdlines.get(key) ?? (await readCmdline(entry.pid)));
    }),
  );
  cmdlines = seen;

  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const argvOf = (entry: ProcEntry) => seen.get(processKey(entry)) ?? [];
  const launched = launchedApps();
  const ptyHosts = new Set(
    entries
      .filter((e) => e.ppid === process.pid && argvOf(e).some((arg) => arg.endsWith('/pty-host.py')))
      .map((e) => e.pid),
  );

  // Native apps and terminals own everything under them; anything else
  // under the main process is one of Din's helpers.
  const inherited = new Map<number, ProcessRole | null>();
  const inherit = (pid: number, depth: number): ProcessRole | null => {
    if (pid === process.pid) return { kind: 'helper' };
    const known = inherited.get(pid);
    if (known !== undefined) return known;
    const entry = byPid.get(pid);
    let role: ProcessRole | null = null;
    if (entry && depth < 64) {
      // A launched pid only counts while it's still Din's child: pids are
      // reused, and the launch record outlives the process.
      const appId = launched.get(pid);
      if (appId && entry.ppid === process.pid) role = { kind: 'app', appId };
      else if (ptyHosts.has(pid)) role = { kind: 'app', appId: 'terminal' };
      else role = inherit(entry.ppid, depth + 1);
    }
    inherited.set(pid, role);
    return role;
  };

  const electron = electronProcesses();
  const ticks = new Map<string, number>();
  const elapsed = previous ? cpu.total - previous.cpu.total : 0;
  const processes: ProcessInfo[] = entries.map((entry) => {
    const key = processKey(entry);
    ticks.set(key, entry.ticks);
    const before = previous?.ticks.get(key);
    const used = before !== undefined && elapsed > 0 ? ((entry.ticks - before) / elapsed) * 100 : 0;
    const gpuNow = gpuNs.get(key);
    const gpuBefore = previous?.gpuNs.get(key);
    const gpuUsed =
      gpuNow === undefined
        ? null
        : gpuBefore !== undefined && wallNs > 0
          ? Math.min(100, Math.max(0, ((gpuNow - gpuBefore) / wallNs) * 100))
          : 0;
    const argv = argvOf(entry);
    const mine = entry.uid === me;
    let own = electronRole(entry.pid, electron);
    let role = own?.role ?? (host.has(entry.pid) ? null : inherit(entry.pid, 0));
    const type = role?.kind === 'helper' ? chromiumType(argv) : null;
    if (type) {
      own = chromiumChildRole(type);
      role = own.role;
    }
    return {
      pid: entry.pid,
      ppid: entry.ppid,
      name: displayName(entry.comm, argv),
      command: argv.join(' ') || entry.comm,
      detail: commandDetail(argv),
      uid: entry.uid,
      user: users?.get(entry.uid) ?? String(entry.uid),
      mine,
      state: entry.state,
      cpu: Math.max(0, used),
      gpu: gpuUsed,
      memory: entry.rss,
      startedAt: startedAt(entry.startTicks, cpu),
      role,
      blocked: !mine ? SYSTEM_MESSAGE : host.has(entry.pid) ? HOST_MESSAGE : (own?.blocked ?? null),
    };
  });

  const busy = previous && elapsed > 0 ? 1 - (cpu.idle - previous.cpu.idle) / elapsed : 0;
  const before = previous?.diskIo;
  const seconds = wallNs / 1e9;
  const rate = (now: number, then: number) => Math.max(0, (now - then) / seconds);
  const measured = before && seconds > 0;
  const disk: DiskTotals = {
    io: diskIo && {
      readRate: measured ? rate(diskIo.read, before.read) : 0,
      writeRate: measured ? rate(diskIo.written, before.written) : 0,
      activeTime: measured ? Math.min(100, (rate(diskIo.activeMs, before.activeMs) / 1000) * 100) : 0,
    },
    filesystems,
  };
  previous = { cpu, ticks, at, gpuNs, diskIo };
  return {
    at: Date.now(),
    cpu: Math.min(100, Math.max(0, busy * 100)),
    cpuCount: cpu.cpuCount,
    memory,
    gpu,
    disk,
    uptime,
    load,
    processes,
  };
}

function schedule(run: number, delay: number): void {
  timer = setTimeout(async () => {
    try {
      const snapshot = await sample();
      // Stopped while it was being taken.
      if (run !== generation) return;
      if (snapshot) sendToShell('system-monitor:snapshot', snapshot);
    } catch (error) {
      console.warn('[system-monitor] sample failed:', error);
    }
    if (run === generation) schedule(run, SAMPLE_MS);
  }, delay);
}

function start(): void {
  if (running) return;
  running = true;
  const run = ++generation;
  previous = null;
  // The baseline the first snapshot's CPU use is measured from.
  void sample()
    .catch(() => null)
    .then(() => {
      if (run === generation) schedule(run, FIRST_SAMPLE_MS);
    });
}

function stop(): void {
  running = false;
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  previous = null;
  cmdlines = new Map();
  drmFds = new Map();
  samples = 0;
  users = null;
}

/** A shell that reloads or goes away takes its subscriptions with it. */
const watchedShells = new WeakSet<Electron.WebContents>();
function watchShell(contents: Electron.WebContents): void {
  if (watchedShells.has(contents)) return;
  watchedShells.add(contents);
  const reset = () => {
    subscribers = 0;
    stop();
  };
  contents.on('did-navigate', reset);
  contents.on('render-process-gone', reset);
  contents.once('destroyed', reset);
}

function trackResponsiveness(contents: Electron.WebContents): void {
  const id = contents.id;
  contents.on('unresponsive', () => unresponsive.add(id));
  contents.on('responsive', () => unresponsive.delete(id));
  contents.on('render-process-gone', () => unresponsive.delete(id));
  contents.once('destroyed', () => unresponsive.delete(id));
}

/** Validate a pid from the shell. */
function requirePid(pid: unknown): number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('A process id is required.');
  }
  return pid;
}

/** End a process: SIGTERM, or SIGKILL when forced. */
async function end(pid: number, force: boolean): Promise<void> {
  const owner = await readOwner(pid);
  // Gone already, which is what was wanted.
  if (!owner) return;
  if (owner.uid !== process.getuid?.()) throw new Error(SYSTEM_MESSAGE);
  if ((await hosts()).has(pid)) throw new Error(HOST_MESSAGE);
  const electron = electronProcesses();
  const own = electronRole(pid, electron);
  if (own?.blocked) throw new Error(own.blocked);
  if (!own) {
    const type = chromiumType(await readCmdline(pid));
    if (type && chromiumChildRole(type).blocked && (await underMain(pid))) throw new Error(DIN_MESSAGE);
  }
  const hosted = electron.pages.get(pid);
  if (hosted?.length) {
    // One renderer can host several pages; crashing it through any of them
    // tells Electron about all of them.
    const { contents } = hosted[0];
    contents.forcefullyCrashRenderer();
    if (force) {
      setTimeout(() => {
        if (contents.isDestroyed() || contents.getOSProcessId() !== pid) return;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Gone in the meantime.
        }
      }, CRASH_GRACE_MS);
    }
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') throw new Error(SYSTEM_MESSAGE, { cause: error });
    throw error;
  }
}

export function registerSystemMonitorHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  shell: () => Electron.WebContents | null;
  pageKind: (contents: Electron.WebContents) => PageKind;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;
  shell = options.shell;
  pageKind = options.pageKind;

  for (const contents of webContents.getAllWebContents()) trackResponsiveness(contents);
  app.on('web-contents-created', (_event, contents) => trackResponsiveness(contents));

  ipcMain.handle('system-monitor:subscribe', (event) => {
    assertShellSender(event);
    watchShell(event.sender);
    subscribers += 1;
    start();
  });

  ipcMain.handle('system-monitor:unsubscribe', (event) => {
    assertShellSender(event);
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) stop();
  });

  ipcMain.handle('system-monitor:filesystems', (event) => {
    assertShellSender(event);
    return readFilesystems();
  });

  ipcMain.handle('system-monitor:end', async (event, pid: unknown) => {
    assertShellSender(event);
    await end(requirePid(pid), false);
  });

  ipcMain.handle('system-monitor:force-quit', async (event, pid: unknown) => {
    assertShellSender(event);
    await end(requirePid(pid), true);
  });
}
