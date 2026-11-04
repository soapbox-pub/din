/**
 * Typed access to the System Monitor bridge exposed by the Electron preload
 * (`window.dinos.systemMonitor`, see electron/preload.cjs +
 * electron/system-monitor.mts).
 *
 * The main process reads /proc every couple of seconds while someone is
 * subscribed and pushes the whole snapshot. CPU figures are shares of the
 * whole machine (all cores together make 100%); disk traffic is bytes per
 * second, not a percentage (see electron/system-monitor.mts). Absent in a plain browser;
 * callers feature-detect via `getSystemMonitorBridge()`.
 */

/** What kind of page a renderer shows. */
export type PageKind = 'browser-tab' | 'private-tab' | 'web-app' | 'devtools' | 'page';

export interface PageInfo {
  kind: PageKind;
  title: string;
  url: string;
  /** False while the page is hung. */
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
  /** R running, S sleeping, D waiting on disk, Z zombie, T stopped, ... */
  state: string;
  /** Percent of the whole machine's CPU since the last snapshot. */
  cpu: number;
  /** Percent of the GPU's time since the last snapshot, or null when it can't be read (another user's). */
  gpu: number | null;
  /** Resident memory, in bytes. */
  memory: number;
  /** Start time, in ms since the epoch. */
  startedAt: number;
  role: ProcessRole | null;
  /** Why it can't be ended from here, or null when it can. */
  blocked: string | null;
}

export interface MemoryTotals {
  total: number;
  used: number;
  swapTotal: number;
  swapUsed: number;
}

export interface GpuTotals {
  /** Percent of the time it's busy. */
  busy: number;
  /** Its own memory (on an integrated GPU, RAM set aside for it), in bytes. */
  memoryUsed: number;
  memoryTotal: number;
  /** System memory it's borrowed on top, in bytes. */
  sharedUsed: number;
  sharedTotal: number;
}

/** How worried to be about a filesystem's free space (electron/proc-stats.mts's spaceLevel). */
export type SpaceLevel = 'ok' | 'low' | 'critical';

export interface FilesystemSpace {
  /** What it is to the user: "System" for /, "Home" for /home. */
  label: string;
  mountPoint: string;
  /** Bytes in all. */
  total: number;
  /** Bytes the user can still write. */
  free: number;
  level: SpaceLevel;
}

export interface DiskTotals {
  /** Traffic since the last snapshot, or null without a physical disk to read. */
  io: {
    /** Bytes read and written per second. */
    readRate: number;
    writeRate: number;
    /** Percent of the time the busiest disk had a request in flight. */
    activeTime: number;
  } | null;
  /** / and, when it's a filesystem of its own, /home. */
  filesystems: FilesystemSpace[];
}

export interface SystemSnapshot {
  /** When it was taken, in ms since the epoch. */
  at: number;
  /** Percent of the whole machine's CPU in use. */
  cpu: number;
  cpuCount: number;
  memory: MemoryTotals;
  /** Null without a GPU whose driver says how busy it is (amdgpu and xe do). */
  gpu: GpuTotals | null;
  disk: DiskTotals;
  /** Seconds since boot. */
  uptime: number;
  /** 1, 5 and 15-minute load averages. */
  load: number[];
  processes: ProcessInfo[];
}

export interface SystemMonitorBridge {
  /** Receive snapshots while subscribed. Returns an unsubscribe fn. */
  subscribe(callback: (snapshot: SystemSnapshot) => void): () => void;
  /** Ask a process to quit (SIGTERM; a web page's renderer is crashed). */
  end(pid: number): Promise<void>;
  /** Make a process quit now (SIGKILL). */
  forceQuit(pid: number): Promise<void>;
  /** The space on /home, measured now. */
  filesystems(): Promise<FilesystemSpace[]>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    systemMonitor?: SystemMonitorBridge;
  }
}

/** The System Monitor bridge, or undefined outside the Electron shell. */
export function getSystemMonitorBridge(): SystemMonitorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.systemMonitor;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanSystemMonitorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
