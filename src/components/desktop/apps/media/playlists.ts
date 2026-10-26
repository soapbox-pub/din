import { extensionOf } from '@/lib/fileTypes';
import { parentPath } from '@/lib/fs';

/**
 * Playlist files: Winamp's M3U and PLS, Windows Media Player's WPL and ASX,
 * and XSPF. Entries are local paths (resolved against the playlist's own
 * folder, with Windows backslashes turned around) or stream URLs.
 */
export interface PlaylistEntry {
  /** An absolute local path, or an http(s) URL. */
  location: string;
  title?: string;
  artist?: string;
  /** Seconds, when the playlist says. */
  duration?: number;
}

export const PLAYLIST_EXTENSIONS = new Set(['m3u', 'm3u8', 'pls', 'wpl', 'asx', 'wax', 'wvx', 'xspf']);

export function isPlaylistFile(name: string): boolean {
  return PLAYLIST_EXTENSIONS.has(extensionOf(name));
}

/** Make a playlist's reference to a song absolute. */
export function resolveLocation(ref: string, baseDir: string): string {
  let s = ref.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      s = s.replace(/^file:\/\//i, '');
    }
    // file:///C:/Music/x.mp3
    s = s.replace(/^\/([A-Za-z]:)/, '$1');
  }
  s = s.replace(/\\/g, '/');
  // A Windows drive path can't be resolved here; keep its tail relative to
  // the playlist, which is right when a folder was copied over whole.
  if (/^[A-Za-z]:\//.test(s)) s = s.slice(3);
  if (s.startsWith('/')) return normalize(s);
  return normalize(`${baseDir.replace(/\/+$/, '')}/${s}`);
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function parseM3u(text: string, baseDir: string): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  let pending: Omit<PlaylistEntry, 'location'> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const info = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)[^,]*,(.*)$/i.exec(line);
      if (info) {
        const seconds = Number(info[1]);
        const label = info[2].trim();
        const dash = label.indexOf(' - ');
        pending = {
          duration: seconds > 0 ? seconds : undefined,
          ...(dash > 0 ? { artist: label.slice(0, dash), title: label.slice(dash + 3) } : { title: label || undefined }),
        };
      }
      continue;
    }
    entries.push({ location: resolveLocation(line, baseDir), ...pending });
    pending = {};
  }
  return entries;
}

function parsePls(text: string, baseDir: string): PlaylistEntry[] {
  const byIndex = new Map<number, PlaylistEntry & { file?: string }>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(raw);
    if (!m) continue;
    const n = Number(m[2]);
    const entry = byIndex.get(n) ?? { location: '' };
    const key = m[1].toLowerCase();
    if (key === 'file') entry.location = resolveLocation(m[3], baseDir);
    else if (key === 'title') entry.title = m[3].trim() || undefined;
    else if (Number(m[3]) > 0) entry.duration = Number(m[3]);
    byIndex.set(n, entry);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e).filter((e) => e.location);
}

function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  return doc.getElementsByTagName('parsererror').length > 0 ? null : doc;
}

/** Case-insensitive element lookup (ASX is often written in any case). */
function elementsNamed(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((e) => e.localName.toLowerCase() === name);
}

function attr(e: Element, name: string): string | null {
  for (const a of Array.from(e.attributes)) if (a.name.toLowerCase() === name) return a.value;
  return null;
}

function parseWpl(text: string, baseDir: string): PlaylistEntry[] {
  const doc = parseXml(text);
  if (!doc) return [];
  return elementsNamed(doc, 'media')
    .map((m) => attr(m, 'src'))
    .filter((src): src is string => !!src)
    .map((src) => ({ location: resolveLocation(src, baseDir) }));
}

function parseAsx(text: string, baseDir: string): PlaylistEntry[] {
  // ASX is loosely XML; lower-casing the tags makes most of it parse.
  const doc = parseXml(text.replace(/<(\/?)(\w+)/g, (_, slash: string, tag: string) => `<${slash}${tag.toLowerCase()}`).replace(/&(?![a-z]+;|#)/gi, '&amp;'));
  if (!doc) return [];
  const entries: PlaylistEntry[] = [];
  for (const entry of elementsNamed(doc, 'entry')) {
    const ref = elementsNamed(entry, 'ref')[0];
    const href = ref && attr(ref, 'href');
    if (!href) continue;
    entries.push({
      location: resolveLocation(href, baseDir),
      title: elementsNamed(entry, 'title')[0]?.textContent?.trim() || undefined,
      artist: elementsNamed(entry, 'author')[0]?.textContent?.trim() || undefined,
    });
  }
  return entries;
}

function parseXspf(text: string, baseDir: string): PlaylistEntry[] {
  const doc = parseXml(text);
  if (!doc) return [];
  return elementsNamed(doc, 'track').flatMap((track) => {
    const location = elementsNamed(track, 'location')[0]?.textContent?.trim();
    if (!location) return [];
    const duration = Number(elementsNamed(track, 'duration')[0]?.textContent);
    return [{
      location: resolveLocation(location, baseDir),
      title: elementsNamed(track, 'title')[0]?.textContent?.trim() || undefined,
      artist: elementsNamed(track, 'creator')[0]?.textContent?.trim() || undefined,
      duration: duration > 0 ? duration / 1000 : undefined,
    }];
  });
}

/** Read a playlist file's entries. `path` names the file (its folder resolves relative entries). */
export function parsePlaylist(path: string, text: string): PlaylistEntry[] {
  const dir = parentPath(path);
  switch (extensionOf(path)) {
    case 'pls': return parsePls(text, dir);
    case 'wpl': return parseWpl(text, dir);
    case 'asx': case 'wax': case 'wvx': return parseAsx(text, dir);
    case 'xspf': return parseXspf(text, dir);
    default: return parseM3u(text, dir);
  }
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Where `to` is, relative to the folder `fromDir` (both absolute). */
function relativePath(fromDir: string, to: string): string {
  if (/^https?:/i.test(to)) return to;
  const from = fromDir.split('/').filter(Boolean);
  const target = to.split('/').filter(Boolean);
  let i = 0;
  while (i < from.length && i < target.length - 1 && from[i] === target[i]) i++;
  if (i === 0) return to;
  return [...from.slice(i).map(() => '..'), ...target.slice(i)].join('/');
}

/** Write entries in the format `path`'s extension names (M3U8 by default). */
export function writePlaylist(path: string, name: string, entries: PlaylistEntry[]): string {
  const dir = parentPath(path);
  const rel = (e: PlaylistEntry) => relativePath(dir, e.location);
  const label = (e: PlaylistEntry) => (e.artist ? `${e.artist} - ${e.title ?? ''}` : (e.title ?? ''));
  switch (extensionOf(path)) {
    case 'pls':
      return [
        '[playlist]',
        ...entries.flatMap((e, i) => [
          `File${i + 1}=${rel(e)}`,
          ...(e.title ? [`Title${i + 1}=${label(e)}`] : []),
          `Length${i + 1}=${e.duration ? Math.round(e.duration) : -1}`,
        ]),
        `NumberOfEntries=${entries.length}`,
        'Version=2',
        '',
      ].join('\n');
    case 'wpl':
      return [
        '<?wpl version="1.0"?>',
        '<smil>',
        '  <head>',
        '    <meta name="Generator" content="Din Media Player"/>',
        `    <title>${escapeXml(name)}</title>`,
        '  </head>',
        '  <body>',
        '    <seq>',
        ...entries.map((e) => `      <media src="${escapeXml(rel(e))}"/>`),
        '    </seq>',
        '  </body>',
        '</smil>',
        '',
      ].join('\r\n');
    case 'xspf':
      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
        `  <title>${escapeXml(name)}</title>`,
        '  <trackList>',
        ...entries.map((e) => [
          '    <track>',
          `      <location>${escapeXml(/^https?:/i.test(e.location) ? e.location : `file://${e.location.split('/').map(encodeURIComponent).join('/')}`)}</location>`,
          ...(e.title ? [`      <title>${escapeXml(e.title)}</title>`] : []),
          ...(e.artist ? [`      <creator>${escapeXml(e.artist)}</creator>`] : []),
          ...(e.duration ? [`      <duration>${Math.round(e.duration * 1000)}</duration>`] : []),
          '    </track>',
        ].join('\n')),
        '  </trackList>',
        '</playlist>',
        '',
      ].join('\n');
    default:
      return [
        '#EXTM3U',
        ...entries.flatMap((e) => [`#EXTINF:${e.duration ? Math.round(e.duration) : -1},${label(e)}`, rel(e)]),
        '',
      ].join('\n');
  }
}
