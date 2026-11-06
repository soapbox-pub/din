// The System Monitor's warnings, for when a program is slowing the computer
// down and nobody has the System Monitor open to see it: every few seconds
// /proc is read (proc-stats.mts, far less of it than a System Monitor
// snapshot), and a program that's
//
//   - kept a big share of the processor busy for a minute while the whole
//     machine was too (CPU_*: a build pinned to a few cores of many, as
//     lowcpu runs them, or one busy program on an idle machine, isn't news),
//   - or is the biggest holder of memory while memory is running out
//     (MEMORY_*),
//
// is sent to the shell as `system-monitor:alert`, where ResourceAlertsHost
// shows a notification from the System Monitor that can stop it. Each
// program is warned about once for each reason, for as long as it runs;
// once it's gone, `system-monitor:alert-gone` takes the notification down.
//
// Only what the System Monitor could end is warned about: Din's own user's
// programs, not Din itself (system-monitor.mts's describeEndable).
//
// The shell turns this on and off (Settings → Notifications), and nothing
// runs while it's off or before the desktop asks.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import { readCpuTimes, readMemory, readProcesses, type CpuTimes, type ProcEntry } from './proc-stats.mts';
import { describeEndable } from './system-monitor.mts';

const CHECK_MS = 5000;
/** How many checks a CPU warning is measured over: a minute. */
const CPU_WINDOW = 12;
/** The whole machine was at least this busy over the window, in percent... */
const CPU_MACHINE_BUSY = 70;
/** ...and the program used at least this share of it, in percent... */
const CPU_PROCESS_SHARE = 25;
/** ...and at least this many cores' worth, so a small machine's one busy core isn't news. */
const CPU_PROCESS_CORES = 1.5;
/** Memory in use (what programs hold, not cache) past this share, in percent... */
const MEMORY_USED = 90;
/** ...for this many checks in a row... */
const MEMORY_CHECKS = 3;
/** ...and the biggest program holds at least this share of it, in percent. */
const MEMORY_PROCESS_SHARE = 10;

/** One warning, as the shell gets it. */
export interface ResourceAlert {
  /** Unique for this program and reason ("cpu:1234:5678"); `alert-gone` names it. */
  id: string;
  kind: 'cpu' | 'memory';
  pid: number;
  /** Its program's name, or the page it shows. */
  name: string;
  /** The app it's part of, when Din launched it. */
  appId: string | null;
  /** Percent of the whole machine's CPU it used over the last minute. */
  cpu: number;
  cpuCount: number;
  /** Resident memory, in bytes. */
  memory: number;
  memoryTotal: number;
  /** Memory still available to programs, in bytes. */
  memoryFree: number;
}

interface Reading {
  cpu: CpuTimes;
  /** CPU ticks so far, by process key. */
  ticks: Map<string, number>;
}

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let timer: NodeJS.Timeout | null = null;
let checking = false;
/** The last CPU_WINDOW + 1 readings, oldest first. */
let readings: Reading[] = [];
let memoryHigh = 0;
/** What's been warned about: alert id → process key, so it's taken down when the process goes. */
const warned = new Map<string, string>();

function processKey(entry: ProcEntry): string {
  return `${entry.pid}:${entry.startTicks}`;
}

async function alertFor(
  kind: ResourceAlert['kind'],
  entry: ProcEntry,
  byPid: Map<number, ProcEntry>,
  figures: Omit<ResourceAlert, 'id' | 'kind' | 'pid' | 'name' | 'appId' | 'memory'>,
): Promise<void> {
  const id = `${kind}:${processKey(entry)}`;
  if (warned.has(id)) return;
  // Asked once: what can't be stopped now won't be later.
  warned.set(id, processKey(entry));
  const subject = await describeEndable(entry, byPid);
  if (!subject) return;
  const alert: ResourceAlert = { id, kind, pid: entry.pid, ...subject, memory: entry.rss, ...figures };
  sendToShell('system-monitor:alert', alert);
}

async function check(): Promise<void> {
  const [cpu, memory, entries] = await Promise.all([readCpuTimes(), readMemory(), readProcesses()]);
  if (!cpu || !timer) return;
  const me = process.getuid?.() ?? -1;
  const mine = entries.filter((entry) => entry.uid === me && entry.pid !== process.pid);
  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  const alive = new Set(entries.map(processKey));

  // Gone, so its warning is moot.
  for (const [id, key] of warned) {
    if (alive.has(key)) continue;
    warned.delete(id);
    sendToShell('system-monitor:alert-gone', id);
  }

  readings.push({ cpu, ticks: new Map(mine.map((entry) => [processKey(entry), entry.ticks])) });
  if (readings.length > CPU_WINDOW + 1) readings = readings.slice(-(CPU_WINDOW + 1));
  const memoryFree = memory.total - memory.used;
  const figures = { cpuCount: cpu.cpuCount, memoryTotal: memory.total, memoryFree };

  if (readings.length === CPU_WINDOW + 1) {
    const first = readings[0];
    const elapsed = cpu.total - first.cpu.total;
    const busy = elapsed > 0 ? (1 - (cpu.idle - first.cpu.idle) / elapsed) * 100 : 0;
    if (busy >= CPU_MACHINE_BUSY) {
      for (const entry of mine) {
        const before = first.ticks.get(processKey(entry));
        if (before === undefined) continue;
        const share = ((entry.ticks - before) / elapsed) * 100;
        if (share < CPU_PROCESS_SHARE || (share / 100) * cpu.cpuCount < CPU_PROCESS_CORES) continue;
        await alertFor('cpu', entry, byPid, { ...figures, cpu: share });
      }
    }
  }

  memoryHigh = memory.total > 0 && (memory.used / memory.total) * 100 >= MEMORY_USED ? memoryHigh + 1 : 0;
  if (memoryHigh >= MEMORY_CHECKS) {
    const biggest = mine.reduce<ProcEntry | null>((top, entry) => (!top || entry.rss > top.rss ? entry : top), null);
    if (biggest && (biggest.rss / memory.total) * 100 >= MEMORY_PROCESS_SHARE) {
      await alertFor('memory', biggest, byPid, { ...figures, cpu: 0 });
    }
  }
}

function start(): void {
  if (timer) return;
  const run = () => {
    if (checking) return;
    checking = true;
    void check()
      .catch((error) => console.warn('[resource-alerts] check failed:', error))
      .finally(() => {
        checking = false;
      });
  };
  timer = setInterval(run, CHECK_MS);
  run();
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  readings = [];
  memoryHigh = 0;
  for (const id of warned.keys()) sendToShell('system-monitor:alert-gone', id);
  warned.clear();
}

export function registerResourceAlertHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  sendToShell = options.sendToShell;
  ipcMain.handle('system-monitor:alerts', (event, on: unknown) => {
    options.assertShellSender(event);
    // A reloaded shell asks again; what it was told before went with it.
    stop();
    if (on === true) start();
  });
}
