/**
 * Typed access to the network monitor bridge exposed by the Electron preload
 * (`window.dinos.networkMonitor`, see electron/preload.cjs +
 * electron/network-monitor.mts), behind the System Monitor's Network view.
 *
 * Requests are every page's (the desktop's, apps', browser tabs' and web
 * apps', never private or Tor tabs'), recorded through the DevTools protocol
 * only while someone records, and pushed in batches. Connections are every
 * program's open sockets, from `ss`, read when asked. Absent in a plain
 * browser; callers feature-detect via `getNetworkMonitorBridge()`.
 */

/** Who made a request: the desktop itself, or one of its pages. */
export interface RequestSource {
  contentsId: number;
  kind: 'desktop' | 'browser-tab' | 'web-app' | 'page';
  /** The page's own address (din://files/, a tab's site, widget://clock/). */
  url: string;
  title: string;
}

export type RequestState = 'pending' | 'done' | 'failed' | 'open' | 'closed';

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  /** DevTools' resource type: Document, Script, Image, Fetch, XHR, WebSocket, ... */
  type: string;
  state: RequestState;
  /** ms since the epoch. */
  startedAt: number;
  endedAt: number | null;
  status: number | null;
  statusText: string;
  mimeType: string;
  protocol: string;
  /** ip:port */
  remoteAddress: string;
  fromCache: boolean;
  /** Bytes over the network, headers included (a WebSocket's: its frames'). */
  size: number;
  redirectedTo: string | null;
  error: string | null;
  initiator: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  framesSent: number;
  framesReceived: number;
  source: RequestSource;
}

export interface WebSocketFrame {
  requestId: string;
  at: number;
  direction: 'sent' | 'received';
  /** 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
  opcode: number;
  /** The payload (base64 for binary), cut to its first 2000 characters. */
  data: string;
  /** The payload's whole length, in bytes. */
  length: number;
  /** Whether `data` is only the payload's start. */
  truncated: boolean;
}

export interface NetworkEvents {
  /** Requests that changed, whole. */
  requests: NetworkRequest[];
  frames: WebSocketFrame[];
  /** Frames left out of this batch for being too many. */
  framesDropped: number;
}

export interface Connection {
  protocol: 'tcp' | 'udp';
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  /** A host Din's requests reached at the address, else its reverse DNS name. */
  remoteHost: string | null;
  /** Null for another user's, whose program only root can see. */
  pid: number | null;
  program: string | null;
  uid: number | null;
  inode: number;
  /** Bytes carried so far (TCP only). */
  sent: number | null;
  received: number | null;
}

export interface ConnectionsResult {
  /** False when `ss` (iproute2) isn't installed. */
  available: boolean;
  connections: Connection[];
}

export interface NetworkMonitorBridge {
  /** Record pages' requests, in batches. Returns a fn that stops. */
  record(callback: (events: NetworkEvents) => void): () => void;
  /** Every program's open connections (not loopback), read now. */
  connections(): Promise<ConnectionsResult>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    networkMonitor?: NetworkMonitorBridge;
  }
}

/** The network monitor bridge, or undefined outside the Electron shell. */
export function getNetworkMonitorBridge(): NetworkMonitorBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.networkMonitor;
}
