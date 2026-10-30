/**
 * The desktop's side of widgets (docs/widgets.md): napplets (NIP-5D) on the
 * desktop, built in at widget://<id>/ or from Nostr at napplet://<hash>/.
 * What they are, where they come from, and the ports main hands over as they
 * load. WidgetFrame does the hosting.
 */
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19, verifyEvent } from 'nostr-tools';

/** The session partition widgets run in (WIDGETS_PARTITION in electron/widgets.mts). */
export const WIDGETS_PARTITION = 'persist:widgets';

/** The napplet manifest kinds (NIP-5D): snapshot, root and named. */
export const NAPPLET_KINDS = [5129, 15129, 35129] as const;

/**
 * The NAP domains Din answers. A widget gets those of these it declares
 * (R and O tags, or a built-in's manifest), and nothing else.
 */
export const SUPPORTED_DOMAINS = ['shell', 'theme', 'identity', 'storage', 'resource'] as const;
export type Domain = (typeof SUPPORTED_DOMAINS)[number];

/** The domains the user is asked about, and can turn off; the rest are harmless (readiness, colors). */
export const PERMISSION_DOMAINS = ['identity', 'resource', 'storage'] as const satisfies readonly Domain[];
export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export function isPermissionDomain(domain: string): domain is PermissionDomain {
  return (PERMISSION_DOMAINS as readonly string[]).includes(domain);
}

/** Widgets sit on a grid of cells this big, this far apart (src/lib/widgetGrid.ts). */
export const WIDGET_CELL = 76;
export const WIDGET_GAP = 16;
/** The smallest a widget can be resized to, in cells each way. */
export const WIDGET_MIN_SPAN = 2;

/** The sizes a widget is offered in, to start; from there it can be resized to any number of cells. */
export type WidgetSize = 'small' | 'medium' | 'large';

/** Each preset size, in cells. */
export const WIDGET_SIZES: Record<WidgetSize, { cols: number; rows: number; label: string }> = {
  small: { cols: 2, rows: 2, label: 'Small' },
  medium: { cols: 4, rows: 2, label: 'Medium' },
  large: { cols: 4, rows: 4, label: 'Large' },
};

/** A span of cells, in CSS pixels. */
export function spanPixels({ cols, rows }: { cols: number; rows: number }): { width: number; height: number } {
  return { width: cols * (WIDGET_CELL + WIDGET_GAP) - WIDGET_GAP, height: rows * (WIDGET_CELL + WIDGET_GAP) - WIDGET_GAP };
}

/** A widget from Nostr: its manifest, as verified when it was added. */
export interface NappletSource {
  type: 'napplet';
  /** Who it is for storage: `kind:pubkey:d` for named and root napplets, the event id for a snapshot. */
  address: string;
  pubkey: string;
  sha256: string;
  title: string;
  description: string;
  /** What it declared it needs (R) and can use (O). */
  requires: string[];
  optional: string[];
  servers: string[];
  source?: string;
  /** Its icon on Blossom (PNG, JPEG or WebP), by hash. */
  icon?: { sha256: string; type: string };
}

export interface BuiltinSource {
  type: 'builtin';
  id: string;
}

export type WidgetSource = BuiltinSource | NappletSource;

/** A widget on the desktop. */
export interface PlacedWidget {
  /** This instance (one widget may be placed more than once). */
  id: string;
  source: WidgetSource;
  /** The work area it's on, and the cells it covers on that area's grid. */
  monitor: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** Permissions the user turned off for this copy. */
  denied?: PermissionDomain[];
}

// ---------------------------------------------------------------------------
// The bridge (window.dinos.widgets, electron/preload.cjs)
// ---------------------------------------------------------------------------

export interface WidgetsBridge {
  /** Fetch and verify a widget's artifact; resolves with the napplet:// host it's served at. */
  fetch(sha256: string, servers: string[]): Promise<string>;
  /** A widget's icon, verified against its hash. */
  icon(sha256: string, servers: string[]): Promise<Uint8Array>;
  /** NAP-RESOURCE: something from the web, fetched by main (https, public addresses, no cookies). */
  resource(url: string): Promise<{ bytes: Uint8Array; type: string }>;
  onContextMenu(callback: (e: { webContentsId: number; x: number; y: number }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    widgets?: WidgetsBridge;
  }
}

export function getWidgetsBridge(): WidgetsBridge | undefined {
  return window.dinos?.widgets;
}

// ---------------------------------------------------------------------------
// Built-in widgets: src/widgets/<id>/manifest.json, bundled into the desktop.
// ---------------------------------------------------------------------------

export interface BuiltinManifest {
  name: string;
  description: string;
  /** A lucide icon name, for the gallery. */
  icon: string;
  domains: Domain[];
  size: WidgetSize;
  sizes: WidgetSize[];
}

const RAW = import.meta.glob<BuiltinManifest>('/src/widgets/*/manifest.json', { eager: true, import: 'default' });

/** The order the gallery shows them in; any others follow. */
const ORDER = ['clock', 'calendar', 'weather', 'world-clock', 'battery', 'timer', 'sticky-note', 'profile'];

const BUILTINS = new Map<string, BuiltinManifest>(
  Object.entries(RAW)
    .map(([file, manifest]) => [/\/src\/widgets\/([^/]+)\/manifest\.json$/.exec(file)?.[1] ?? '', manifest] as const)
    .filter(([id]) => id)
    .sort(([a], [b]) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99)),
);

export function builtinWidgets(): ReadonlyMap<string, BuiltinManifest> {
  return BUILTINS;
}

export function builtinWidget(id: string): BuiltinManifest | undefined {
  return BUILTINS.get(id);
}

/** A widget's name, as the user sees it. */
export function widgetTitle(source: WidgetSource): string {
  return source.type === 'builtin' ? (BUILTINS.get(source.id)?.name ?? source.id) : source.title;
}

/** The sizes a widget comes in. */
export function widgetSizes(source: WidgetSource): WidgetSize[] {
  return source.type === 'builtin' ? (BUILTINS.get(source.id)?.sizes ?? ['small']) : ['small', 'medium', 'large'];
}

/** The domains a widget declared, of what Din answers. */
export function declaredDomains(source: WidgetSource): Domain[] {
  const declared = source.type === 'builtin'
    ? (BUILTINS.get(source.id)?.domains ?? [])
    : [...source.requires, ...source.optional];
  const set = new Set<string>(declared);
  // NAP-SHELL is only readiness and the list of domains: every widget has it.
  set.add('shell');
  return SUPPORTED_DOMAINS.filter((d) => set.has(d));
}

/** The domains a widget gets: what it declared, of what Din answers, less what the user turned off. */
export function grantedDomains(source: WidgetSource, denied: readonly string[] = []): Domain[] {
  return declaredDomains(source).filter((d) => !denied.includes(d));
}

/** Who a widget is, for its storage. */
export function widgetIdentity(source: WidgetSource): string {
  return source.type === 'builtin' ? `builtin:${source.id}` : source.address;
}

// ---------------------------------------------------------------------------
// Napplet manifests (NIP-5D)
// ---------------------------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A sha256 (hex) as a napplet:// host: lowercase base32, unpadded (nappletHost in electron/widgets.mts). */
export function nappletHost(sha256: string): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < sha256.length; i += 2) {
    value = (value << 8) | Number.parseInt(sha256.slice(i, i + 2), 16);
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The URL a widget's guest loads. */
export function widgetUrl(source: WidgetSource): string {
  return source.type === 'builtin' ? `widget://${source.id}/` : `napplet://${nappletHost(source.sha256)}/`;
}

/** Why a napplet manifest was refused. */
export class NappletManifestError extends Error {
  override name = 'NappletManifestError';
}

/**
 * A napplet manifest event, checked as NIP-5D asks: a manifest kind, a valid
 * signature, exactly one sha256 `x` tag, a description, and a `d` tag only
 * (and exactly one) on a named napplet.
 */
export function parseNappletManifest(event: NostrEvent): NappletSource {
  if (!(NAPPLET_KINDS as readonly number[]).includes(event.kind)) throw new NappletManifestError('This isn\'t a widget.');
  if (!verifyEvent(event)) throw new NappletManifestError('This widget\'s signature isn\'t valid.');
  const tags = (name: string) => event.tags.filter((t) => t[0] === name);
  const x = tags('x');
  if (x.length !== 1 || !/^[0-9a-f]{64}$/.test(x[0][1] ?? '')) throw new NappletManifestError('This widget doesn\'t name exactly one artifact.');
  const d = tags('d');
  if (event.kind === 35129 ? d.length !== 1 || !d[0][1] : d.length > 0) throw new NappletManifestError('This widget\'s identifier is malformed.');
  const description = event.content.trim();
  if (!description) throw new NappletManifestError('This widget has no description.');
  const domains = (name: string) => [...new Set(tags(name).map((t) => t[1]).filter((v): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v)))];
  const title = tags('title')[0]?.[1]?.trim();
  const source = tags('source');
  const icon = tags('icon')[0];
  const iconOk = icon && /^[0-9a-f]{64}$/.test(icon[1] ?? '') && ['image/png', 'image/jpeg', 'image/webp'].includes(icon[2] ?? '');
  const address = event.kind === 5129 ? event.id : event.kind === 15129 ? `15129:${event.pubkey}` : `35129:${event.pubkey}:${d[0][1]}`;
  return {
    type: 'napplet',
    address,
    pubkey: event.pubkey,
    sha256: x[0][1],
    title: title || (event.kind === 35129 ? d[0][1] : 'Widget'),
    description,
    requires: domains('R'),
    optional: domains('O'),
    servers: tags('server').map((t) => t[1]).filter((s): s is string => typeof s === 'string' && /^https:\/\//.test(s)),
    source: source.length === 1 && source[0].length === 2 ? source[0][1] : undefined,
    icon: iconOk ? { sha256: icon[1], type: icon[2] } : undefined,
  };
}

/** The required domains a napplet declared that Din doesn't answer. */
export function missingDomains(source: NappletSource): string[] {
  return source.requires.filter((d) => !(SUPPORTED_DOMAINS as readonly string[]).includes(d));
}

/** The relay filter for a widget's `naddr1…`, or null if it isn't one. */
export function nappletFilter(input: string): { filter: { kinds: number[]; authors: string[]; '#d'?: string[]; limit: number }; relays: string[] } | null {
  const text = input.trim().replace(/^nostr:/, '');
  try {
    const decoded = nip19.decode(text);
    if (decoded.type !== 'naddr' || !(NAPPLET_KINDS as readonly number[]).includes(decoded.data.kind)) return null;
    const { kind, pubkey, identifier, relays } = decoded.data;
    return {
      filter: { kinds: [kind], authors: [pubkey], ...(kind === 35129 ? { '#d': [identifier] } : {}), limit: 1 },
      relays: relays ?? [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ports, as main hands them over (dinos-widgets:port in electron/preload.cjs).
// ---------------------------------------------------------------------------

/** Which widget main says a port is from: the host of the guest's URL. */
export type PortSource = { kind: 'builtin'; id: string } | { kind: 'napplet'; sha256: string };

export interface WidgetPort {
  port: MessagePort;
  source: PortSource;
}

/** Whether a port is from this widget. */
export function portIsFrom(port: WidgetPort, source: WidgetSource): boolean {
  return source.type === 'builtin'
    ? port.source.kind === 'builtin' && port.source.id === source.id
    : port.source.kind === 'napplet' && port.source.sha256 === source.sha256;
}

const waiting = new Map<number, (port: WidgetPort) => void>();
const arrived = new Map<number, WidgetPort>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const data = e.data as { type?: string; info?: { webContentsId?: unknown; source?: PortSource } } | null;
    if (data?.type !== 'dinos-widgets:port') return;
    const port = e.ports[0];
    const webContentsId = data.info?.webContentsId;
    const source = data.info?.source;
    if (!port || typeof webContentsId !== 'number' || !source) return;
    const entry = { port, source };
    const take = waiting.get(webContentsId);
    if (take) take(entry);
    else arrived.set(webContentsId, entry);
  });
}

/** Hear each port a widget's guest connects with (once per load). Ports that came first are handed over at once. */
export function onWidgetPort(webContentsId: number, listener: (port: WidgetPort) => void): () => void {
  waiting.set(webContentsId, listener);
  const early = arrived.get(webContentsId);
  if (early) {
    arrived.delete(webContentsId);
    listener(early);
  }
  return () => {
    if (waiting.get(webContentsId) === listener) waiting.delete(webContentsId);
  };
}
