// What's running and what it costs, read straight from /proc for the System
// Monitor (system-monitor.mts): each process's CPU time, memory, owner and
// command line and GPU time, the machine's CPU, memory and GPU totals, and
// its disks' traffic and free space.
//
// Nothing is spawned. `ps` would fork Electron's main process on every
// sample (see system-worker.mts for what that costs), and everything it
// prints is a file read away. Plain Node, no Electron, so it can be run on
// its own.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Clock ticks per second in /proc's times (USER_HZ). Fixed at 100 by the
 * kernel's ABI on every architecture Din runs on; Node can't sysconf it.
 */
const USER_HZ = 100;

/** PF_KTHREAD in /proc/<pid>/stat's flags: a kernel thread, not a program. */
const PF_KTHREAD = 0x00200000;

/** One process, as one pass over /proc saw it. */
export interface ProcEntry {
  pid: number;
  ppid: number;
  /** The kernel's name for it (comm), at most 15 characters. */
  comm: string;
  /** R running, S sleeping, D waiting on disk, Z zombie, T stopped, ... */
  state: string;
  /** Real user id. */
  uid: number;
  /** CPU time used so far (user + system), in clock ticks. */
  ticks: number;
  /** Resident memory, in bytes. */
  rss: number;
  /** When it started, in clock ticks since boot. */
  startTicks: number;
}

/** The machine-wide CPU counters from /proc/stat, in clock ticks. */
export interface CpuTimes {
  /** Every tick of every CPU so far. */
  total: number;
  /** The ticks spent idle (or waiting on I/O). */
  idle: number;
  /** Seconds since the epoch the machine booted at. */
  bootTime: number;
  cpuCount: number;
}

export interface MemoryTotals {
  total: number;
  /** MemTotal - MemAvailable: what programs hold, not counting reclaimable cache. */
  used: number;
  swapTotal: number;
  swapUsed: number;
}

/** The GPU's own figures, from its driver's files in /sys. */
export interface GpuTotals {
  /** Percent of the time it's busy, as the driver measures it. */
  busy: number;
  /** Its own memory (on an integrated GPU, RAM set aside for it), in bytes. */
  memoryUsed: number;
  memoryTotal: number;
  /** System memory it's borrowed on top (GTT), in bytes. */
  sharedUsed: number;
  sharedTotal: number;
}

/** One open handle on a GPU, from /proc/<pid>/fdinfo. */
export interface DrmClient {
  /** The device and the driver's client id: the same client can be open on several fds, and in several processes. */
  id: string;
  /** GPU time used so far, every engine together, in ns. */
  engineNs: number;
}

/** Parse /proc/<pid>/fdinfo/<fd>. Null when the fd isn't a GPU client. */
export function parseDrmFdinfo(text: string): DrmClient | null {
  const client = /^drm-client-id:\s+(\d+)/m.exec(text);
  if (!client) return null;
  const pdev = /^drm-pdev:\s+(\S+)/m.exec(text)?.[1] ?? '';
  let engineNs = 0;
  // drm-engine-<name>: <n> ns, and drm-engine-capacity-<name> (Intel), which isn't time.
  for (const match of text.matchAll(/^drm-engine-(?!capacity-)[\w-]+:\s+(\d+) ns/gm)) {
    engineNs += Number(match[1]);
  }
  return { id: `${pdev}/${client[1]}`, engineNs };
}

/** Parse /proc/<pid>/stat. Null for kernel threads and unreadable lines. */
export function parseStat(text: string): Omit<ProcEntry, 'uid' | 'rss'> | null {
  // comm is parenthesized and may itself contain spaces and parentheses, so
  // split around the last ')'.
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open));
  const comm = text.slice(open + 1, close);
  // Fields from the state on: state(3) ppid(4) ... flags(9) ... utime(14)
  // stime(15) ... starttime(22), numbered as in proc(5).
  const fields = text.slice(close + 2).split(' ');
  const field = (n: number) => Number(fields[n - 3]);
  if ((field(9) & PF_KTHREAD) !== 0) return null;
  const ppid = field(4);
  const ticks = field(14) + field(15);
  const startTicks = field(22);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(ticks)) return null;
  return { pid, ppid, comm, state: fields[0], ticks, startTicks };
}

/** The real uid and resident memory (bytes) from /proc/<pid>/status. */
export function parseStatus(text: string): { uid: number; rss: number } | null {
  const uid = /^Uid:\s+(\d+)/m.exec(text);
  if (!uid) return null;
  // Absent for zombies, which hold no memory.
  const rss = /^VmRSS:\s+(\d+) kB/m.exec(text);
  return { uid: Number(uid[1]), rss: rss ? Number(rss[1]) * 1024 : 0 };
}

/** The aggregate "cpu" line and boot time from /proc/stat. */
export function parseCpuTimes(text: string): CpuTimes | null {
  const line = /^cpu\s+(.*)$/m.exec(text);
  if (!line) return null;
  // user nice system idle iowait irq softirq steal; guest time is already
  // counted in user and nice.
  const [user, nice, system, idle, iowait, irq, softirq, steal] = line[1]
    .trim()
    .split(/\s+/)
    .map((n) => Number(n) || 0);
  const btime = /^btime\s+(\d+)/m.exec(text);
  const cpuCount = text.match(/^cpu\d+\s/gm)?.length ?? 1;
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
    bootTime: btime ? Number(btime[1]) : 0,
    cpuCount,
  };
}

/** Memory and swap from /proc/meminfo, in bytes. */
export function parseMeminfo(text: string): MemoryTotals {
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : 0;
  };
  const total = kb('MemTotal');
  // Kernels before 3.14 have no MemAvailable; free + cache is close.
  const available = /^MemAvailable:/m.test(text)
    ? kb('MemAvailable')
    : kb('MemFree') + kb('Buffers') + kb('Cached');
  const swapTotal = kb('SwapTotal');
  return {
    total,
    used: Math.max(0, total - available),
    swapTotal,
    swapUsed: Math.max(0, swapTotal - kb('SwapFree')),
  };
}

/** uid -> user name, from /etc/passwd. */
export function parsePasswd(text: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of text.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid && !users.has(Number(uid))) users.set(Number(uid), name);
  }
  return users;
}

/** When a process started, in ms since the epoch. */
export function startedAt(startTicks: number, cpu: CpuTimes): number {
  return (cpu.bootTime + startTicks / USER_HZ) * 1000;
}

/** One process's stat and status, or null when it's gone or a kernel thread. */
async function readProcess(pid: number): Promise<ProcEntry | null> {
  try {
    const [stat, status] = await Promise.all([
      fsp.readFile(`/proc/${pid}/stat`, 'utf8'),
      fsp.readFile(`/proc/${pid}/status`, 'utf8'),
    ]);
    const parsed = parseStat(stat);
    const owner = parseStatus(status);
    return parsed && owner ? { ...parsed, ...owner } : null;
  } catch {
    // It exited between the listing and the read.
    return null;
  }
}

/** Every user-space process running now. */
export async function readProcesses(): Promise<ProcEntry[]> {
  const names = await fsp.readdir('/proc');
  const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
  const entries = await Promise.all(pids.map(readProcess));
  return entries.filter((entry): entry is ProcEntry => entry !== null);
}

/** One process's owner and memory, for checking it before signalling it. */
export async function readOwner(pid: number): Promise<{ uid: number; ppid: number } | null> {
  const entry = await readProcess(pid);
  return entry && { uid: entry.uid, ppid: entry.ppid };
}

/** A process's arguments, or [] when it has none (or is gone). */
export async function readCmdline(pid: number): Promise<string[]> {
  try {
    const text = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8');
    return text.split('\0').filter((arg) => arg.length > 0);
  } catch {
    return [];
  }
}

export async function readCpuTimes(): Promise<CpuTimes | null> {
  return parseCpuTimes(await fsp.readFile('/proc/stat', 'utf8'));
}

export async function readMemory(): Promise<MemoryTotals> {
  return parseMeminfo(await fsp.readFile('/proc/meminfo', 'utf8'));
}

/** Seconds since boot, and the 1/5/15-minute load averages. */
export async function readUptimeAndLoad(): Promise<{ uptime: number; load: number[] }> {
  const [uptime, loadavg] = await Promise.all([
    fsp.readFile('/proc/uptime', 'utf8').catch(() => '0'),
    fsp.readFile('/proc/loadavg', 'utf8').catch(() => '0 0 0'),
  ]);
  return {
    uptime: Number(uptime.split(' ')[0]) || 0,
    load: loadavg.split(' ').slice(0, 3).map((n) => Number(n) || 0),
  };
}

/** The first GPU whose driver reports how busy it is (amdgpu does), found once. */
let gpuDevice: Promise<string | null> | null = null;
function findGpuDevice(): Promise<string | null> {
  gpuDevice ??= (async () => {
    const cards = await fsp.readdir('/sys/class/drm').catch(() => [] as string[]);
    for (const card of cards.filter((name) => /^card\d+$/.test(name)).sort()) {
      const device = `/sys/class/drm/${card}/device`;
      try {
        await fsp.access(`${device}/gpu_busy_percent`);
        return device;
      } catch {
        // Not one that says.
      }
    }
    return null;
  })();
  return gpuDevice;
}

/** The GPU's totals, or null on a machine without one Din can read. */
export async function readGpu(): Promise<GpuTotals | null> {
  const device = await findGpuDevice();
  if (!device) return null;
  const read = async (name: string) => Number(await fsp.readFile(`${device}/${name}`, 'utf8').catch(() => '0')) || 0;
  const [busy, memoryUsed, memoryTotal, sharedUsed, sharedTotal] = await Promise.all([
    read('gpu_busy_percent'),
    read('mem_info_vram_used'),
    read('mem_info_vram_total'),
    read('mem_info_gtt_used'),
    read('mem_info_gtt_total'),
  ]);
  return { busy, memoryUsed, memoryTotal, sharedUsed, sharedTotal };
}

/**
 * The fds a process has open on a GPU (/dev/dri/*). [] when it has none, or
 * isn't ours to look at.
 */
export async function readDrmFds(pid: number): Promise<number[]> {
  const dir = `/proc/${pid}/fd`;
  const fds = await fsp.readdir(dir).catch(() => [] as string[]);
  const targets = await Promise.all(fds.map((fd) => fsp.readlink(`${dir}/${fd}`).catch(() => '')));
  return fds.filter((_, i) => targets[i].startsWith('/dev/dri/')).map(Number);
}

/** The GPU clients open on a process's fds, one per client. */
export async function readDrmClients(pid: number, fds: number[]): Promise<DrmClient[]> {
  const infos = await Promise.all(
    fds.map((fd) => fsp.readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8').catch(() => '')),
  );
  const clients = new Map<string, DrmClient>();
  for (const info of infos) {
    const client = parseDrmFdinfo(info);
    if (client) clients.set(client.id, client);
  }
  return [...clients.values()];
}

/** The disks' I/O counters from /proc/diskstats, every physical disk together. */
export interface DiskIo {
  /** Bytes read and written so far. */
  read: number;
  written: number;
  /** Time some disk had a request in flight, in ms (io_ticks), the busiest disk's. */
  activeMs: number;
}

/** One filesystem's space, from statfs. */
export interface FilesystemSpace {
  /** What it is to the user: "System" for /, "Home" for /home. */
  label: string;
  mountPoint: string;
  /** Bytes in all. */
  total: number;
  /** Bytes the user can still write (bavail: not the blocks kept for root). */
  free: number;
  level: SpaceLevel;
}

/** How worried to be about a filesystem's free space. */
export type SpaceLevel = 'ok' | 'low' | 'critical';

const GIB = 1024 ** 3;

/**
 * Low under 10% free, critical under 5%, and in bytes never above 10 GiB
 * and 2 GiB: a big disk's 10% is room enough to be no worry.
 */
export function spaceLevel(free: number, total: number): SpaceLevel {
  if (free < Math.min(total * 0.05, 2 * GIB)) return 'critical';
  if (free < Math.min(total * 0.1, 10 * GIB)) return 'low';
  return 'ok';
}

/** The sector size /proc/diskstats counts in, whatever the disk's own. */
const DISKSTATS_SECTOR = 512;

/**
 * Parse /proc/diskstats for the named disks. Only whole physical disks are
 * counted: a partition, or an LVM or encrypted volume on one, would count
 * the same bytes again.
 */
export function parseDiskstats(text: string, disks: Set<string>): DiskIo {
  const io: DiskIo = { read: 0, written: 0, activeMs: 0 };
  for (const line of text.split('\n')) {
    // major minor name reads merged sectors-read ms writes merged sectors-written ms in-flight io-ticks ...
    const fields = line.trim().split(/\s+/);
    if (fields.length < 13 || !disks.has(fields[2])) continue;
    io.read += (Number(fields[5]) || 0) * DISKSTATS_SECTOR;
    io.written += (Number(fields[9]) || 0) * DISKSTATS_SECTOR;
    io.activeMs = Math.max(io.activeMs, Number(fields[12]) || 0);
  }
  return io;
}

/** The physical disks (those with a device behind them, unlike loop, zram and dm-*), found once. */
let physicalDisks: Promise<Set<string>> | null = null;
function findPhysicalDisks(): Promise<Set<string>> {
  physicalDisks ??= (async () => {
    const names = await fsp.readdir('/sys/block').catch(() => [] as string[]);
    const found = await Promise.all(
      names.map((name) =>
        fsp.access(`/sys/block/${name}/device`).then(
          () => name,
          () => null,
        ),
      ),
    );
    return new Set(found.filter((name): name is string => name !== null));
  })();
  return physicalDisks;
}

export async function readDiskIo(): Promise<DiskIo | null> {
  try {
    const [text, disks] = await Promise.all([fsp.readFile('/proc/diskstats', 'utf8'), findPhysicalDisks()]);
    return disks.size > 0 ? parseDiskstats(text, disks) : null;
  } catch {
    return null;
  }
}

/** The filesystems people fill: the system's and, when it's its own, home's. */
const WATCHED_FILESYSTEMS = [
  { label: 'System', mountPoint: '/' },
  { label: 'Home', mountPoint: '/home' },
];

/** The space on / and /home, once when they're the same filesystem. */
export async function readFilesystems(): Promise<FilesystemSpace[]> {
  const seen = new Set<number>();
  const result: FilesystemSpace[] = [];
  for (const { label, mountPoint } of WATCHED_FILESYSTEMS) {
    try {
      const [stats, sfs] = await Promise.all([fsp.stat(mountPoint), fsp.statfs(mountPoint)]);
      if (seen.has(stats.dev) || sfs.blocks === 0) continue;
      seen.add(stats.dev);
      const total = sfs.blocks * sfs.bsize;
      const free = sfs.bavail * sfs.bsize;
      result.push({ label, mountPoint, total, free, level: spaceLevel(free, total) });
    } catch {
      // Not there, or not one that reports space.
    }
  }
  return result;
}

export async function readUsers(): Promise<Map<number, string>> {
  try {
    return parsePasswd(await fsp.readFile('/etc/passwd', 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * The name to show for a process: its comm, unless the kernel cut that off
 * at 15 characters and the program's own path has the whole of it. Nix's
 * wrapper naming (".firefox-wrapped", cut to ".firefox-wrappe") is undone.
 */
export function displayName(comm: string, argv: string[]): string {
  let name = comm;
  if (comm.length >= 15 && argv.length > 0) {
    const base = path.basename(argv[0]);
    if (base.startsWith(comm)) name = base;
  }
  return /^\.(.+?)-w(?:r(?:a(?:p(?:p(?:e(?:d)?)?)?)?)?)?$/.exec(name)?.[1] ?? name;
}

/**
 * What a command line says beyond the program's name: its arguments, minus
 * options, with paths cut to their last part ("node /srv/app/server.js
 * --port 80" is "server.js 80").
 */
export function commandDetail(argv: string[]): string {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => (arg.includes('/') ? path.basename(arg) : arg))
    .join(' ');
}
