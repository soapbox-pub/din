/**
 * Sharing, as Android has it and the web names it (docs/din/sharing.md):
 * something shares with `navigator.share` (an app, through DinAppFrame) or
 * `requestShare` (the desktop's own UI, the `din share` command), the
 * desktop shows its share sheet (ShareSheetHost), and the user picks an app
 * whose manifest's `share_target` takes what's shared, or an action of the
 * sheet's own (Copy, Save to Downloads). The app hears the share in its
 * `launchQueue`; the sharer learns only whether it was shared.
 */
import type { DinManifest, ShareTarget } from '@/sdk/din';
import type { AppDefinition } from '@/lib/apps';
import { dinManifests } from '@/lib/dinApps';
import { getFsBridge } from '@/lib/fs';
import type { FileData } from '@/sdk/protocol';

/** A shared file, on disk: one Files shared, or bytes an app shared kept under the share cache. */
export interface ShareFile {
  path: string;
  name: string;
  /** Its MIME type, '' when unknown. */
  type: string;
}

/** What's shared, as the desktop holds it. */
export interface ShareData {
  title?: string;
  text?: string;
  url?: string;
  files: ShareFile[];
}

/** A rectangle on the desktop (client pixels): what the sheet points at. */
export interface ShareAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An app that can take a share. */
export interface ShareTargetApp {
  id: string;
  name: string;
  icon: AppDefinition['icon'];
  target: ShareTarget;
}

/** A share waiting on the user, for the sheet to show. */
export interface ShareRequest {
  id: number;
  data: ShareData;
  /** What it points at; the middle of the screen when null. */
  anchor: ShareAnchor | null;
  /** The app that shared, by id (null for the desktop or the `din` command), which isn't offered as a target. */
  opener: string | null;
  /** The sheet's answer: the app it went to, an action's id, or null when it was closed. */
  finish: (result: string | null) => void;
}

// ---- the request the sheet shows ----

let current: ShareRequest | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: ShareRequest | null): void {
  current = next;
  for (const l of [...listeners]) l();
}

export function subscribeShare(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getShareRequest(): ShareRequest | null {
  return current;
}

/**
 * Show the share sheet. Resolves with where it went (an app's id or an
 * action's), or null when the user closed it, or another share took its
 * place.
 */
export function requestShare(data: ShareData, options: { anchor?: ShareAnchor | null; opener?: string | null } = {}): Promise<string | null> {
  current?.finish(null);
  return new Promise((resolve) => {
    const id = nextId++;
    set({
      id,
      data,
      anchor: options.anchor ?? null,
      opener: options.opener ?? null,
      finish: (result) => {
        if (current?.id === id) set(null);
        resolve(result);
      },
    });
  });
}

/** An element's rectangle, for `requestShare`'s anchor. */
export function anchorOf(element: Element | null | undefined): ShareAnchor | null {
  const r = element?.getBoundingClientRect();
  return r && r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

// ---- which apps take what ----

/** Param names the desktop's launch uses itself, which a share target can't take. */
const RESERVED = new Set(['path', 'paths', 'readOnlyPaths', 'opener', 'shortcut', 'actionAt', 'shareNonce', 'window']);

/** A manifest's `share_target`, if it's one Din can deliver to. */
export function shareTargetOf(manifest: DinManifest): ShareTarget | null {
  const t = manifest.share_target;
  if (!t || typeof t.action !== 'string' || !t.action.startsWith('/') || typeof t.params !== 'object' || t.params === null) return null;
  for (const key of ['title', 'text', 'url'] as const) {
    const name = t.params[key];
    if (name !== undefined && (typeof name !== 'string' || !name || RESERVED.has(name))) return null;
  }
  return t;
}

/** Whether a share target's `accept` takes a file: a MIME type, a type's family (`image/*`), or an extension. */
export function acceptsFile(accept: string | string[], file: Pick<ShareFile, 'name' | 'type'>): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return (Array.isArray(accept) ? accept : [accept]).some((raw) => {
    const a = String(raw).trim().toLowerCase();
    if (!a) return false;
    if (a.startsWith('.')) return name.endsWith(a);
    if (a === '*/*' || a === '*') return true;
    if (a.endsWith('/*')) return type.startsWith(a.slice(0, -1));
    return type === a;
  });
}

/** Whether a target takes this share: every file, or else some of the title, text and URL. */
export function takesShare(target: ShareTarget, data: ShareData): boolean {
  const { params } = target;
  if (data.files.length > 0) {
    const specs = Array.isArray(params.files) ? params.files : [];
    return specs.length > 0 && data.files.every((f) => specs.some((s) => acceptsFile(s.accept, f)));
  }
  // A URL goes in the text where there's no place of its own for it.
  return !!((data.text && params.text) || (data.url && (params.url || params.text)) || (data.title && params.title));
}

/** Recently chosen targets first; kept on this computer. */
const RECENT_KEY = 'din:share-recent';

function recentTargets(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function noteRecent(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentTargets().filter((x) => x !== id)].slice(0, 20)));
  } catch {
    // Private mode or full: the order just doesn't learn.
  }
}

/**
 * The installed apps that take a share, those chosen lately first, then by
 * name. The sharer itself isn't among them.
 */
export function shareTargets(data: ShareData, getApp: (id: string) => AppDefinition | undefined, opener: string | null = null): ShareTargetApp[] {
  const out: ShareTargetApp[] = [];
  for (const [id, manifest] of dinManifests()) {
    if (id === opener) continue;
    const target = shareTargetOf(manifest);
    const app = getApp(id);
    if (!target || !app || !takesShare(target, data)) continue;
    out.push({ id, name: app.name, icon: app.icon, target });
  }
  const recent = recentTargets();
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? recent.length : i;
  };
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** The launch params that give a share to a target, as its `share_target` names them. */
export function shareLaunchParams(target: ShareTarget, data: ShareData, opener: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = { shareNonce: crypto.randomUUID() };
  const { title, text, url } = target.params;
  if (title && data.title) p[title] = data.title;
  let body = data.text;
  if (url && data.url) p[url] = data.url;
  else if (data.url) body = body ? `${body}\n${data.url}` : data.url;
  if (text && body) p[text] = body;
  const paths = data.files.map((f) => f.path);
  if (paths.length === 1) p.path = paths[0];
  else if (paths.length > 1) p.paths = paths;
  // What's shared is the receiver's to read, never to write back.
  if (paths.length > 0) p.readOnlyPaths = paths;
  if (opener) p.opener = opener;
  return p;
}

/** Give a share to an app: it opens (or its open window hears it) at its share target. */
export function deliverShare(
  app: ShareTargetApp,
  data: ShareData,
  opener: string | null,
  open: (id: string, params: Record<string, unknown>, options: { replaceParams: boolean }) => unknown,
): void {
  noteRecent(app.id);
  open(app.id, shareLaunchParams(app.target, data, opener), { replaceParams: true });
}

// ---- what the sheet does itself ----

/** The text a share copies: its title, text and link, each on a line, without repeats. */
export function shareText(data: ShareData): string {
  const parts = [data.title, data.text, data.url].filter((x): x is string => !!x && !!x.trim());
  return [...new Set(parts)].join('\n');
}

/** The folder shared bytes are kept in until they're a day old: `~/.cache/din/shared`. */
async function shareCache(): Promise<string | null> {
  const fs = getFsBridge();
  if (!fs) return null;
  return `${(await fs.homedir()).replace(/\/$/, '')}/.cache/din/shared`;
}

/** A file name that stays one: no folders, nothing hidden, not too long. */
function safeName(name: string): string {
  const base = name.replace(/[/\\\0]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  return base || 'file';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keep files an app shared as bytes on disk, each share in a folder of its
 * own, so the app it goes to can be handed them as files. Shares older than
 * a day are cleared out as new ones come.
 */
export async function stageSharedFiles(files: FileData[]): Promise<ShareFile[]> {
  if (files.length === 0) return [];
  const fs = getFsBridge();
  const cache = await shareCache();
  if (!fs || !cache) throw new DOMException('Files can only be shared in the Din desktop app', 'NotAllowedError');
  await fs.mkdir(cache);
  void fs.readdir(cache).then(
    (listing) => {
      for (const entry of listing.entries) {
        if (entry.mtimeMs !== null && Date.now() - entry.mtimeMs > DAY_MS) void fs.rm(`${cache}/${entry.name}`, { recursive: true }).catch(() => {});
      }
    },
    () => {},
  );
  const dir = `${cache}/${crypto.randomUUID()}`;
  await fs.mkdir(dir);
  const taken = new Set<string>();
  const out: ShareFile[] = [];
  for (const f of files) {
    let name = safeName(f.name);
    for (let n = 2; taken.has(name); n++) name = safeName(f.name).replace(/(\.[^.]*)?$/, ` (${n})$1`);
    taken.add(name);
    await fs.writeFile(`${dir}/${name}`, new Uint8Array(f.bytes));
    out.push({ path: `${dir}/${name}`, name, type: f.type });
  }
  return out;
}

/** Copy shared files into ~/Downloads (renamed where a name's taken); resolves with where they went. */
export async function saveSharedFiles(files: ShareFile[]): Promise<string[]> {
  const fs = getFsBridge();
  if (!fs) throw new Error('Saving takes the Din desktop app');
  const downloads = `${(await fs.homedir()).replace(/\/$/, '')}/Downloads`;
  await fs.mkdir(downloads);
  const out: string[] = [];
  for (const f of files) out.push(await fs.copyInto(f.path, downloads, f.name));
  return out;
}
