/**
 * Typed access to the System Monitor bridge exposed by the Electron preload
 * (`window.systemMonitor`, see electron/preload.cjs +
 * electron/system-monitor.mts).
 *
 * The main process reads /proc every couple of seconds while someone is
 * subscribed and pushes the whole snapshot. CPU figures are shares of the
 * whole machine (all cores together make 100%). Absent in a plain browser;
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

export interface SystemSnapshot {
  /** When it was taken, in ms since the epoch. */
  at: number;
  /** Percent of the whole machine's CPU in use. */
  cpu: number;
  cpuCount: number;
  memory: MemoryTotals;
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
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    systemMonitor?: SystemMonitorBridge;
  }
}

/** The System Monitor bridge, or undefined outside the Electron shell. */
export function getSystemMonitorBridge(): SystemMonitorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.systemMonitor;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanSystemMonitorError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
