// file:// in the Web Browser's tabs.
//
// Every guest session refuses file:// (hardenGuestSession in main.mts): an
// extension's chrome.tabs.update skips the address bar's checks, and could
// otherwise point a tab at Din's own profile, or anywhere else on the disk.
// The browser's normal and private sessions serve local files only from the
// folders the user opened themselves: the shell grants one as it loads a
// file:// URL it was asked for (the address bar, a bookmark, history), and a
// folder's own page may go up to the folders around it. A file grants its
// folder, so the page's images, styles and scripts beside it load too.
//
// Din's profile is never served, whatever was granted. A local page is as in
// Chrome, an opaque origin that can show the files beside it but not read
// them, which needs Electron's file privileges off (fileExtraPrivileges);
// where they're on, it's sandboxed instead. Files go through Chromium's own
// file loader, which knows their types and serves ranges, so a video seeks.
// Folders are listed by Din: the loader can't list them from here.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Folders each session may serve, by their real paths. */
const grants = new WeakMap<Electron.Session, Set<string>>();

/** The real path a file: URL names, or null if it isn't local or doesn't exist. */
function realPathOf(url: string): string | null {
  try {
    return fs.realpathSync(fileURLToPath(url));
  } catch {
    return null;
  }
}

function within(file: string, dir: string): boolean {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Din's own profile: keys, cookies, site data. Never shown in a tab. */
function isDinProfile(file: string): boolean {
  let profile: string;
  try {
    profile = fs.realpathSync(app.getPath('userData'));
  } catch {
    return false;
  }
  return within(file, profile);
}

/**
 * Let a session serve the folder a file: URL is in (or is): the user asked
 * for it. Grants last until Din quits.
 */
export function allowLocalFile(s: Electron.Session, url: string): void {
  const real = realPathOf(url);
  if (!real) return;
  const dir = isDirectory(real) ? real : path.dirname(real);
  let set = grants.get(s);
  if (!set) {
    set = new Set();
    grants.set(s, set);
  }
  set.add(dir);
}

function isGranted(s: Electron.Session, file: string): boolean {
  for (const dir of grants.get(s) ?? []) if (within(file, dir)) return true;
  return false;
}

/**
 * A page going to `url` by itself (a link clicked, not the address bar): a
 * page from a file the session serves may go up to the folders above it, as
 * a folder's listing links to its parent. Grants that folder.
 */
export function allowLocalFileNavigation(s: Electron.Session, from: string, url: string): void {
  if (!/^file:/i.test(from) || !/^file:/i.test(url)) return;
  const current = realPathOf(from);
  const target = realPathOf(url);
  if (!current || !target || !isGranted(s, current) || !isDirectory(target)) return;
  if (within(current, target)) allowLocalFile(s, url);
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** The session's file: protocol handler: files from granted folders, and nothing else. */
export async function serveLocalFile(s: Electron.Session, request: Request): Promise<Response> {
  const real = realPathOf(request.url);
  if (!real) return refuse(404, 'This file doesn’t exist.');
  if (isDinProfile(real) || !isGranted(s, real)) return refuse(403, 'Local files cannot be opened here.');
  if (isDirectory(real)) {
    const url = new URL(request.url);
    // Relative links in the listing resolve against a folder's URL with its slash.
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
      return new Response(null, { status: 301, headers: { location: url.href } });
    }
    return listFolder(real);
  }
  let response: Response;
  try {
    response = await s.fetch(request, { bypassCustomProtocolHandlers: true });
  } catch {
    return refuse(404, 'This file couldn’t be read.');
  }
  if (!(await fileExtraPrivileges())) return response;
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', `sandbox ${SANDBOX_ALLOWS}`);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * What a local page may still do where file: pages are privileged. Never
 * allow-same-origin: that would be the one origin every file shares.
 */
const SANDBOX_ALLOWS = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

/** Where Electron's fuses start in its binary, after this. */
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
/** GrantFileProtocolExtraPrivileges's place among the fuses. */
const FILE_PRIVILEGES_FUSE = 7;

let privileged: Promise<boolean> | null = null;

/**
 * Whether this Electron gives file: pages its extra privileges: one origin
 * with every file, so a page could fetch any file it can name and send it
 * anywhere. DinOS turns them off (electron-hardened in os/packages.nix), and
 * its file: pages are as Chrome's: each an opaque origin that can show the
 * files around it but not read them. Elsewhere (`npm run dev`), local files
 * are served sandboxed instead, which also keeps them from loading the files
 * around them. Read from the binary's fuses, once; unknown counts as on.
 */
function fileExtraPrivileges(): Promise<boolean> {
  privileged ??= (async () => {
    try {
      const handle = await fs.promises.open(process.execPath, 'r');
      try {
        const chunk = Buffer.alloc(8 << 20);
        let carry = Buffer.alloc(0);
        for (let position = 0; ; ) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
          if (bytesRead === 0) return true;
          const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
          const at = data.indexOf(FUSE_SENTINEL);
          if (at >= 0) {
            const fuses = Buffer.alloc(2 + FILE_PRIVILEGES_FUSE + 1);
            await handle.read(fuses, 0, fuses.length, position - carry.length + at + FUSE_SENTINEL.length);
            // A version byte (1), the number of fuses, then one '0' or '1' each.
            if (fuses[0] !== 1 || fuses[1] <= FILE_PRIVILEGES_FUSE) return true;
            return fuses[2 + FILE_PRIVILEGES_FUSE] !== '0'.charCodeAt(0);
          }
          carry = data.subarray(Math.max(0, data.length - FUSE_SENTINEL.length + 1));
          position += bytesRead;
        }
      } finally {
        await handle.close();
      }
    } catch {
      return true;
    }
  })();
  return privileged;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A folder's page: its parent, then its folders and files by name. No script. */
async function listFolder(dir: string): Promise<Response> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return refuse(403, 'This folder couldn’t be read.');
  }
  const rows = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      const stat = await fs.promises.stat(full).catch(() => null);
      return { name: entry.name, folder: stat?.isDirectory() ?? entry.isDirectory(), size: stat?.size ?? 0, mtime: stat?.mtime ?? null };
    }),
  );
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  rows.sort((a, b) => Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name));

  const parent = path.dirname(dir);
  const parentHref = pathToFileURL(parent).href.replace(/\/?$/, '/');
  const parentRow = parent !== dir
    ? `<tr><td><a href="${escapeHtml(parentHref)}">↑ Parent folder</a></td><td></td><td></td></tr>`
    : '';
  const body = rows
    .map(({ name, folder, size, mtime }) => {
      const href = encodeURIComponent(name) + (folder ? '/' : '');
      return `<tr><td><a href="${escapeHtml(href)}">${escapeHtml(name)}${folder ? '/' : ''}</a></td>` +
        `<td class="n">${folder ? '' : formatSize(size)}</td>` +
        `<td class="n">${mtime ? escapeHtml(dateFormat.format(mtime)) : ''}</td></tr>`;
    })
    .join('');
  const title = escapeHtml(dir);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; margin: 32px auto; max-width: 960px; padding: 0 24px; }
h1 { font-size: 24px; font-weight: 600; word-break: break-all; margin: 0 0 24px; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 13px; font-weight: 600; opacity: 0.7; padding: 8px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
td { padding: 4px 8px; }
tr:hover td { background: color-mix(in srgb, currentColor 5%, transparent); }
td.n, th.n { text-align: right; white-space: nowrap; opacity: 0.8; }
a { color: LinkText; text-decoration: none; word-break: break-all; }
a:hover { text-decoration: underline; }
p { opacity: 0.7; }
</style></head>
<body><h1>${title}</h1>
<table><thead><tr><th>Name</th><th class="n">Size</th><th class="n">Modified</th></tr></thead>
<tbody>${parentRow}${body}</tbody></table>
${rows.length === 0 ? '<p>This folder is empty.</p>' : ''}
</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
