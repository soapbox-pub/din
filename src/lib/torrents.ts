/**
 * Torrents (din.system.torrents, for the Torrents app in src/apps/torrents/,
 * and window.dinos.torrents for `din torrents`): downloading and sharing
 * with BitTorrent, from .torrent files and magnet: links. Backed by
 * electron/torrents.mts, which runs a Transmission daemon of Din's own, so
 * transfers go on with the app's window closed.
 */

/** What a transfer is doing. `waiting` says it's queued for it. */
export type TorrentState = 'stopped' | 'checking' | 'downloading' | 'seeding';

/** A transfer, as the list shows it. */
export interface Torrent {
  id: number;
  /** Its info hash, in hex. */
  hash: string;
  name: string;
  state: TorrentState;
  /** Queued for its state: the queue's full, or another is being checked. */
  waiting: boolean;
  /** Everything wanted is here. */
  finished: boolean;
  /** Of what's wanted, 0 to 1. */
  progress: number;
  /** For a magnet link still asking peers what's in it, how far it's got (0 to 1); null once it knows. */
  metadataProgress: number | null;
  /** While its data is checked, how far that's got (0 to 1). */
  checkProgress: number | null;
  /** What's wanted of it, in bytes. */
  sizeBytes: number;
  /** All of it, wanted or not. */
  totalBytes: number;
  /** What's here of what's wanted. */
  haveBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  /** Uploaded over downloaded, or null before anything's downloaded. */
  ratio: number | null;
  /** Bytes a second. */
  rateDown: number;
  rateUp: number;
  /** Seconds left, where there's telling. */
  eta: number | null;
  peersConnected: number;
  /** Peers it's downloading from (web seeds among them). */
  peersSending: number;
  /** Peers it's uploading to. */
  peersReceiving: number;
  fileCount: number;
  /** The MIME type of most of what's in it ("video/mp4"), or null. */
  mimeType: string | null;
  /** Seconds since the epoch. */
  addedAt: number;
  doneAt: number | null;
  /** The folder it downloads into. */
  downloadDir: string;
  /** What went wrong, said as Transmission says it. */
  error: string | null;
  /** A tracker's warning is passing; a local error stops the transfer. */
  errorKind: 'tracker-warning' | 'tracker-error' | 'local' | null;
  private: boolean;
  queuePosition: number;
}

export type TorrentPriority = 'low' | 'normal' | 'high';

export interface TorrentFile {
  index: number;
  /** Its path in the torrent, the torrent's folder first ("Album/01 Song.flac"). */
  path: string;
  bytes: number;
  doneBytes: number;
  wanted: boolean;
  priority: TorrentPriority;
}

export interface TorrentPeer {
  address: string;
  port: number;
  /** The program it runs ("qBittorrent 4.6.2"). */
  client: string;
  /** How much of the torrent it has, 0 to 1. */
  progress: number;
  /** Bytes a second, from it and to it. */
  rateDown: number;
  rateUp: number;
  encrypted: boolean;
  incoming: boolean;
  utp: boolean;
}

export interface TorrentTracker {
  id: number;
  announce: string;
  host: string;
  tier: number;
  /** As the tracker last said, or null when it hasn't. */
  seeders: number | null;
  leechers: number | null;
  downloads: number | null;
  /** The last time it was asked, and what it said. */
  lastAnnounce: { at: number; ok: boolean; result: string; peers: number } | null;
  /** When it's asked next, in seconds since the epoch, or null. */
  nextAnnounceAt: number | null;
  announcing: boolean;
}

/** All there is to say about one transfer, for the inspector. */
export interface TorrentDetail {
  torrent: Torrent;
  magnet: string;
  comment: string;
  creator: string;
  /** When it was made, in seconds since the epoch, or null. */
  createdAt: number | null;
  pieceCount: number;
  pieceBytes: number;
  /** Which pieces it has, a bit each, base64. */
  pieces: string;
  corruptBytes: number;
  secondsDownloading: number;
  secondsSeeding: number;
  files: TorrentFile[];
  peers: TorrentPeer[];
  trackers: TorrentTracker[];
}

export type TorrentEncryption = 'preferred' | 'required' | 'allowed';

export interface TorrentSettings {
  /** Where new transfers download to. */
  downloadDir: string;
  /** New transfers start at once, rather than paused. */
  startWhenAdded: boolean;
  /** At most this many download at once (the rest wait), or none. */
  downloadQueue: { enabled: boolean; size: number };
  /** In kB/s. */
  downloadLimit: { enabled: boolean; kBps: number };
  uploadLimit: { enabled: boolean; kBps: number };
  /** Turtle mode: slower limits for while the connection's wanted for something else. */
  altSpeed: { enabled: boolean; downKBps: number; upKBps: number };
  /** Seeding stops once a transfer's shared this many times what it downloaded. */
  seedRatio: { enabled: boolean; ratio: number };
  encryption: TorrentEncryption;
  /** Asks the router to forward the peer port (UPnP, NAT-PMP). */
  portForwarding: boolean;
  /** The port peers reach this computer on. */
  peerPort: number;
}

export interface TorrentsStatus {
  /** Whether transfers can run here at all. */
  available: boolean;
  /** Why not, said to the user as it is. */
  reason: string | null;
  /** Off DinOS: Transmission can be installed from the system's packages (Optional Features' `torrents`). */
  optionalFeature: boolean;
  /** Transmission's version. */
  version: string | null;
  settings: TorrentSettings | null;
  /** Bytes a second, every transfer together. */
  rateDown: number;
  rateUp: number;
}

/** What `onChanged` hears, as transfers move. */
export interface TorrentsChange {
  torrents: Torrent[];
  rateDown: number;
  rateUp: number;
  settings: TorrentSettings;
}

/** What's added: a magnet: link, or a .torrent file by path. */
export type TorrentSource = { magnet: string } | { path: string };

/** A torrent before it's added, for the Add window. */
export interface TorrentPreview {
  name: string;
  /** Its info hash, in hex, where that can be told (not for a v2-only torrent file). */
  hash: string | null;
  /** Null for a magnet link, which says what's in it only once peers tell. */
  sizeBytes: number | null;
  files: { path: string; bytes: number }[] | null;
  trackers: string[];
  private: boolean;
  comment: string;
  /** The transfer it already is, if it's been added. */
  existing: number | null;
}

export interface AddTorrentOptions {
  /** Where it downloads; else the setting. */
  downloadDir?: string;
  /** Added paused, whatever the setting says. */
  paused?: boolean;
  /** Files (by index) not to download. */
  unwanted?: number[];
}

export interface TorrentsBridge {
  /** Starts Din's Transmission if it isn't running. */
  status(): Promise<TorrentsStatus>;
  list(): Promise<Torrent[]>;
  detail(id: number): Promise<TorrentDetail>;
  /** Read a torrent file or magnet link without adding it. */
  inspect(source: TorrentSource): Promise<TorrentPreview>;
  add(source: TorrentSource, options?: AddTorrentOptions): Promise<{ id: number; name: string; duplicate: boolean }>;
  /** Resume; `now` skips the queue. */
  start(ids: number[], now?: boolean): Promise<void>;
  /** Pause. */
  stop(ids: number[]): Promise<void>;
  /** Check what's downloaded against the torrent's hashes. */
  verify(ids: number[]): Promise<void>;
  /** Ask the trackers for more peers now. */
  reannounce(ids: number[]): Promise<void>;
  /** Take transfers off the list; with `trash`, what they downloaded goes to the Trash. */
  remove(ids: number[], options: { trash: boolean }): Promise<void>;
  setFiles(id: number, change: { wanted?: number[]; unwanted?: number[]; priority?: TorrentPriority; files?: number[] }): Promise<void>;
  /** Download into another folder; with `move`, what's there already moves with it. */
  setLocation(ids: number[], dir: string, move: boolean): Promise<void>;
  setSettings(patch: Partial<Omit<TorrentSettings, 'peerPort'>>): Promise<TorrentSettings>;
  /** Whether peers can reach this computer on its port, asked of Transmission's port checker. */
  testPort(): Promise<boolean>;
  /** Show what a transfer downloaded (or one file of it, by index) in Files. */
  reveal(id: number, file?: number): Promise<void>;
  /** Open what a transfer downloaded (or one file of it) in the app for it: a folder in Files. */
  open(id: number, file?: number): Promise<void>;
  onChanged(callback: (change: TorrentsChange) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    torrents?: TorrentsBridge;
  }
}

/** The desktop's torrents bridge, for `din torrents`. */
export function getTorrentsBridge(): TorrentsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.torrents;
}

/** Whether a string is a magnet: link Din takes as a torrent. */
export function isMagnetUrl(url: string): boolean {
  return /^magnet:\?/i.test(url.trim()) && /[?&]xt=urn:bt(ih|mh):/i.test(url);
}

/** The name a magnet link gives (its dn), or null. */
export function magnetName(url: string): string | null {
  try {
    const name = new URLSearchParams(url.trim().slice('magnet:?'.length)).get('dn');
    return name?.trim() || null;
  } catch {
    return null;
  }
}

/** An error from the bridge, without Electron's wrapping. */
export function cleanTorrentsError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
