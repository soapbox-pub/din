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
import type { GuestLoadOptions, GuestUploadPart } from '@/platform/guest';
import type { WebShareTarget } from '@/lib/webShareTarget';

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
  /**
   * An installed website's or nsite's share target: its window opens at the
   * action with the share in the query (GET) or the form body (POST).
   * Absent for a built-in app, which hears the share in its launchQueue.
   */
  web?: WebShareTarget;
}

/** The apps the sheet looks through: built-in ones by their manifests, installed ones by what they took from theirs. */
export interface ShareApps {
  apps: readonly AppDefinition[];
  getApp: (id: string) => AppDefinition | undefined;
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
export function shareTargets(data: ShareData, { apps, getApp }: ShareApps, opener: string | null = null): ShareTargetApp[] {
  const out: ShareTargetApp[] = [];
  const builtIn = dinManifests();
  for (const [id, manifest] of builtIn) {
    if (id === opener) continue;
    const target = shareTargetOf(manifest);
    const app = getApp(id);
    if (!target || !app || !takesShare(target, data)) continue;
    out.push({ id, name: app.name, icon: app.icon, target });
  }
  // Installed websites and nsites, as their manifests' share targets say.
  for (const app of apps) {
    const web = app.share;
    if (!web || builtIn.has(app.id) || app.id === opener) continue;
    const target: ShareTarget = { action: web.action, method: web.method, enctype: web.enctype, params: web.params };
    if (takesShare(target, data)) out.push({ id: app.id, name: app.name, icon: app.icon, target, web });
  }
  const recent = recentTargets();
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? recent.length : i;
  };
  return out.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** A share's title, text and link under the names a target gives them; the link goes in the text where it has no name of its own. */
function shareFields(target: ShareTarget, data: ShareData): Record<string, string> {
  const p: Record<string, string> = {};
  const { title, text, url } = target.params;
  if (title && data.title) p[title] = data.title;
  let body = data.text;
  if (url && data.url) p[url] = data.url;
  else if (data.url) body = body ? `${body}\n${data.url}` : data.url;
  if (text && body) p[text] = body;
  return p;
}

/**
 * A share target's action with the share's title, text and link in its
 * query, as a browser makes a GET share target's: also where a POST share
 * goes without its files when nothing on the site can take the POST.
 */
export function sharePageUrl(target: ShareTarget, data: ShareData): string {
  const url = new URL(target.action);
  for (const [key, value] of Object.entries(shareFields(target, data))) url.searchParams.set(key, value);
  return url.href;
}

/** A field name or file name in a multipart header, as the HTML standard escapes them. */
function headerValue(value: string): string {
  return value.replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/"/g, '%22');
}

/**
 * A POST share target's request body, as a form submitting the share would
 * send it: url-encoded fields, or multipart with each file under the first
 * of the target's `files` entries that takes it. Files go by path, read by
 * the engine as the request goes.
 */
export function shareRequestBody(target: WebShareTarget, data: ShareData): GuestLoadOptions {
  const fields = shareFields(target, data);
  const encoder = new TextEncoder();
  if (target.enctype !== 'multipart/form-data') {
    return {
      postData: [{ type: 'rawData', bytes: encoder.encode(new URLSearchParams(fields).toString()) }],
      extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
    };
  }
  const boundary = `----DinShare${crypto.randomUUID().replace(/-/g, '')}`;
  const parts: GuestUploadPart[] = [];
  const raw = (text: string) => parts.push({ type: 'rawData', bytes: encoder.encode(text) });
  for (const [name, value] of Object.entries(fields)) {
    raw(`--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(name)}"\r\n\r\n${value}\r\n`);
  }
  for (const file of data.files) {
    const entry = target.params.files?.find((f) => acceptsFile(f.accept, file));
    if (!entry) continue;
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
    raw(`--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(entry.name)}"; filename="${headerValue(file.name)}"\r\nContent-Type: ${type}\r\n\r\n`);
    parts.push({ type: 'file', filePath: file.path });
    raw('\r\n');
  }
  raw(`--${boundary}--\r\n`);
  return { postData: parts, extraHeaders: `Content-Type: multipart/form-data; boundary=${boundary}` };
}

/** POST shares on their way to an installed app's window, by the token its launch carries. */
const pendingPosts = new Map<string, { appId: string; target: WebShareTarget; data: ShareData; at: number }>();

/** How long a POST share waits for its window to take it. */
const PENDING_MS = 5 * 60 * 1000;

/**
 * The POST share a window was opened with (its `share` launch param), once:
 * a window Din reopens after a restart finds none, so a share never goes
 * twice. Only the app it went to can take it.
 */
export function takePostShare(token: unknown, appId: string): { target: WebShareTarget; data: ShareData } | null {
  if (typeof token !== 'string') return null;
  const pending = pendingPosts.get(token);
  if (!pending || pending.appId !== appId) return null;
  pendingPosts.delete(token);
  return Date.now() - pending.at < PENDING_MS ? { target: pending.target, data: pending.data } : null;
}

/** The launch params that give a share to a built-in app, as its `share_target` names them. */
export function shareLaunchParams(target: ShareTarget, data: ShareData, opener: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = { shareNonce: crypto.randomUUID(), ...shareFields(target, data) };
  const paths = data.files.map((f) => f.path);
  if (paths.length === 1) p.path = paths[0];
  else if (paths.length > 1) p.paths = paths;
  // What's shared is the receiver's to read, never to write back.
  if (paths.length > 0) p.readOnlyPaths = paths;
  if (opener) p.opener = opener;
  return p;
}

/**
 * Give a share to an app: a built-in one opens (or its open window hears it)
 * at its share target; an installed website's or nsite's window goes to its
 * share target's action, with the share in the query (GET), or POSTs it there
 * (WebAppFrame takes it by the token in its `share` param).
 */
export function deliverShare(
  app: ShareTargetApp,
  data: ShareData,
  opener: string | null,
  open: (id: string, params: Record<string, unknown>, options: { replaceParams: boolean }) => unknown,
): void {
  noteRecent(app.id);
  if (app.web?.method === 'POST') {
    const token = crypto.randomUUID();
    for (const [key, pending] of pendingPosts) if (Date.now() - pending.at >= PENDING_MS) pendingPosts.delete(key);
    pendingPosts.set(token, { appId: app.id, target: app.web, data, at: Date.now() });
    open(app.id, { share: token }, { replaceParams: true });
  } else if (app.web) {
    open(app.id, { url: sharePageUrl(app.target, data) }, { replaceParams: true });
  } else {
    open(app.id, shareLaunchParams(app.target, data, opener), { replaceParams: true });
  }
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
