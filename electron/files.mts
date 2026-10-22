// File operations behind the Files app, beyond the basic fs bridge in
// main.mts: recursive copy and move, the freedesktop Trash, properties,
// archives, and the din-file: protocol that streams local files to the shell
// for thumbnails and the Preview window.
//
// Same threat model as the fs bridge (see main.mts): every request is
// re-validated against the shell's main frame, and authority is bounded by
// the unprivileged OS user Din runs as. Nothing here can do more than
// window.fs already can; it just does it in fewer round trips.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ipcMain, protocol } from 'electron';
import { CommandError, runCommand } from './system.mts';

const fsp = fs.promises;

/** The URL scheme the shell loads local files through (img, video, fetch). */
export const LOCAL_FILE_SCHEME = 'din-file';

/** How long an archive job may run before it's killed. */
const ARCHIVE_TIMEOUT_MS = 60 * 60 * 1000;
/** Entries a folder's properties walk counts before giving up. */
const MAX_DU_ENTRIES = 250_000;
/** Lines of an archive listing returned to the Preview window. */
const MAX_ARCHIVE_LISTING = 5_000;

type IpcEvent = Electron.IpcMainInvokeEvent;

/** Validate and normalize a caller-supplied absolute path. */
function absolute(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0 || !path.isAbsolute(p) || p.includes('\0')) {
    throw new Error('An absolute path is required');
  }
  return path.normalize(p);
}

/** Validate a single entry name (no separators or traversal). */
function entryName(name: unknown): string {
  if (
    typeof name !== 'string' || name.length === 0 || name === '.' || name === '..' ||
    name.includes('/') || name.includes('\0')
  ) {
    throw new Error('Invalid file name');
  }
  return name;
}

/** Whether something (even a broken symlink) exists at `p`. */
async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Split "photo.tar.gz" into ["photo", ".tar.gz"], keeping double extensions. */
function splitName(name: string): [string, string] {
  const double = /(\.tar\.[a-z0-9]+)$/i.exec(name);
  if (double && double.index > 0) return [name.slice(0, double.index), double[1]];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/**
 * A path in `dir` for `name` that doesn't exist yet: the name itself, or
 * "name (2).ext", "name (3).ext", ... as file managers do.
 */
export async function uniquePath(dir: string, name: string): Promise<string> {
  let candidate = path.join(dir, name);
  if (!(await exists(candidate))) return candidate;
  const [stem, ext] = splitName(name);
  const base = stem.replace(/ \(\d+\)$/, '');
  for (let n = 2; ; n++) {
    candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/** Whether `child` is `parent` or somewhere beneath it. */
function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Copy a file or folder tree, never overwriting anything. */
async function copyTree(from: string, to: string): Promise<void> {
  await fsp.cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

/** Move a file or folder, across filesystems if need be. */
async function moveTree(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyTree(from, to);
    await fsp.rm(from, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// The Trash (freedesktop.org Trash spec, home trash only).
// ---------------------------------------------------------------------------

function trashDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'Trash');
}

/** Local time as the spec's DeletionDate (YYYY-MM-DDThh:mm:ss). */
function deletionDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Percent-encode a path for a .trashinfo file, keeping the slashes. */
function encodeTrashPath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** Move a path to the Trash; resolves to its name in Trash/files. */
async function trash(target: string): Promise<string> {
  const root = trashDir();
  const files = path.join(root, 'files');
  const info = path.join(root, 'info');
  if (isWithin(target, root)) throw new Error('This is already in the Trash');
  await fsp.mkdir(files, { recursive: true });
  await fsp.mkdir(info, { recursive: true });

  // The .trashinfo is created first and exclusively, which reserves the name.
  const base = path.basename(target);
  let name = base;
  let infoPath: string;
  for (let n = 2; ; n++) {
    infoPath = path.join(info, `${name}.trashinfo`);
    try {
      const contents = `[Trash Info]\nPath=${encodeTrashPath(target)}\nDeletionDate=${deletionDate(new Date())}\n`;
      await fsp.writeFile(infoPath, contents, { flag: 'wx' });
      if (!(await exists(path.join(files, name)))) break;
      await fsp.rm(infoPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const [stem, ext] = splitName(base);
    name = `${stem}.${n}${ext}`;
  }

  try {
    await fsp.rename(target, path.join(files, name));
  } catch (error) {
    await fsp.rm(infoPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
      const err = new Error('This is on another drive, so it can’t go to the Trash') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    }
    throw error;
  }
  return name;
}

/** Where a trashed item came from, per its .trashinfo (null if unknown). */
async function trashOrigin(name: string): Promise<{ path: string; deletedAt: string | null } | null> {
  try {
    const text = await fsp.readFile(path.join(trashDir(), 'info', `${name}.trashinfo`), 'utf8');
    const p = /^Path=(.*)$/m.exec(text)?.[1];
    if (!p) return null;
    const decoded = decodeURIComponent(p);
    return {
      path: path.isAbsolute(decoded) ? decoded : path.join(os.homedir(), decoded),
      deletedAt: /^DeletionDate=(.*)$/m.exec(text)?.[1] ?? null,
    };
  } catch {
    return null;
  }
}

/** Put a trashed item back where it came from; resolves to that path. */
async function restore(name: string): Promise<string> {
  const origin = await trashOrigin(name);
  if (!origin) throw new Error('Din doesn’t know where this came from');
  const dir = path.dirname(origin.path);
  await fsp.mkdir(dir, { recursive: true });
  const dest = await uniquePath(dir, path.basename(origin.path));
  await moveTree(path.join(trashDir(), 'files', name), dest);
  await fsp.rm(path.join(trashDir(), 'info', `${name}.trashinfo`), { force: true });
  return dest;
}

/** Permanently delete one item from the Trash, or all of it. */
async function purge(name?: string): Promise<void> {
  const root = trashDir();
  const names = name === undefined
    ? await fsp.readdir(path.join(root, 'files')).catch(() => [] as string[])
    : [name];
  for (const n of names) {
    await fsp.rm(path.join(root, 'files', n), { recursive: true, force: true });
    await fsp.rm(path.join(root, 'info', `${n}.trashinfo`), { force: true });
  }
  if (name === undefined) {
    // Orphaned .trashinfo files, too.
    for (const n of await fsp.readdir(path.join(root, 'info')).catch(() => [] as string[])) {
      await fsp.rm(path.join(root, 'info', n), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Properties.
// ---------------------------------------------------------------------------

/** uid/gid -> name, from /etc/passwd and /etc/group. */
async function idNames(file: string): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      const [name, , id] = line.split(':');
      if (name && id && /^\d+$/.test(id)) names.set(Number(id), name);
    }
  } catch {
    // Unreadable; ids are shown as numbers.
  }
  return names;
}

async function details(target: string) {
  const lstats = await fsp.lstat(target);
  const symlink = lstats.isSymbolicLink();
  let stats = lstats;
  let linkTarget: string | null = null;
  if (symlink) {
    linkTarget = await fsp.readlink(target).catch(() => null);
    stats = await fsp.stat(target).catch(() => lstats);
  }
  const [users, groups] = await Promise.all([idNames('/etc/passwd'), idNames('/etc/group')]);
  let free: number | null = null;
  let total: number | null = null;
  try {
    const sfs = await fsp.statfs(stats.isDirectory() ? target : path.dirname(target));
    free = sfs.bavail * sfs.bsize;
    total = sfs.blocks * sfs.bsize;
  } catch {
    // Not every filesystem reports space.
  }
  return {
    path: target,
    kind: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
    symlink,
    linkTarget,
    size: stats.size,
    mode: stats.mode & 0o7777,
    uid: stats.uid,
    gid: stats.gid,
    owner: users.get(stats.uid) ?? String(stats.uid),
    group: groups.get(stats.gid) ?? String(stats.gid),
    isOwner: process.getuid?.() === stats.uid,
    atimeMs: stats.atimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs > 0 ? stats.birthtimeMs : null,
    free,
    total,
    trashOrigin: isWithin(target, path.join(trashDir(), 'files')) &&
      path.dirname(target) === path.join(trashDir(), 'files')
      ? await trashOrigin(path.basename(target))
      : null,
  };
}

/** Total size and counts beneath a folder (bounded, doesn't follow links). */
async function diskUsage(root: string) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  let seen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const stats = await Promise.all(
      dirents.map((d) => fsp.lstat(path.join(dir, d.name)).catch(() => null)),
    );
    for (let i = 0; i < dirents.length; i++) {
      const s = stats[i];
      if (!s) continue;
      if (s.isDirectory()) {
        dirs++;
        stack.push(path.join(dir, dirents[i].name));
      } else {
        files++;
        bytes += s.size;
      }
    }
    seen += dirents.length;
    if (seen > MAX_DU_ENTRIES) {
      truncated = true;
      break;
    }
  }
  return { files, dirs, bytes, truncated };
}

// ---------------------------------------------------------------------------
// Archives. bsdtar (libarchive) reads and writes nearly everything; on a
// system without it, GNU tar, unzip and zip cover the common cases.
// ---------------------------------------------------------------------------

/** Single-file compressors, for "notes.txt.gz" that isn't a tarball. */
const DECOMPRESSORS: Record<string, string> = {
  '.gz': 'gzip',
  '.xz': 'xz',
  '.bz2': 'bzip2',
  '.zst': 'zstd',
};

function isMissing(error: unknown): boolean {
  return error instanceof CommandError && error.code === 'ENOENT';
}

/** The useful part of a failed archive tool's complaint. */
function toolError(error: unknown): Error {
  if (error instanceof CommandError) {
    const line = error.stderr.split('\n').map((l) => l.trim()).find(Boolean);
    return new Error(line ?? error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function run(file: string, args: string[]): Promise<string> {
  const { stdout } = await runCommand(file, args, {
    timeout: ARCHIVE_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/** An archive member name that can't be mistaken for an option. */
function safeArg(name: string): string {
  return name.startsWith('-') ? `./${name}` : name;
}

async function extractInto(archive: string, dest: string): Promise<void> {
  const lower = archive.toLowerCase();
  const ext = Object.keys(DECOMPRESSORS).find((e) => lower.endsWith(e));
  if (ext && !/\.tar\.[a-z0-9]+$/.test(lower)) {
    // A bare compressed file, not a tarball: its compressor unpacks it.
    const [stem] = splitName(path.basename(archive));
    await run('sh', ['-c', `${DECOMPRESSORS[ext]} -dc -- "$1" > "$2"`, 'sh', archive, path.join(dest, stem)])
      .catch((e: unknown) => { throw toolError(e); });
    return;
  }
  try {
    await run('bsdtar', ['-xf', archive, '-C', dest]);
    return;
  } catch (error) {
    if (!isMissing(error)) throw toolError(error);
  }
  // No bsdtar.
  try {
    if (lower.endsWith('.zip') || lower.endsWith('.jar')) {
      await run('unzip', ['-q', archive, '-d', dest]);
    } else {
      await run('tar', ['-xf', archive, '-C', dest]);
    }
  } catch (error) {
    throw isMissing(error) ? new Error('No program to open this kind of archive is installed') : toolError(error);
  }
}

/**
 * Extract an archive next to itself: a single top-level item lands as is,
 * anything else in a folder named after the archive. Resolves to the path
 * of what was created.
 */
async function extract(archive: string, destDir: string): Promise<string> {
  const tmp = path.join(destDir, `.${path.basename(archive)}.extracting-${randomBytes(4).toString('hex')}`);
  await fsp.mkdir(tmp);
  try {
    await extractInto(archive, tmp);
    const items = await fsp.readdir(tmp);
    if (items.length === 1) {
      const dest = await uniquePath(destDir, items[0]);
      await fsp.rename(path.join(tmp, items[0]), dest);
      return dest;
    }
    const [stem] = splitName(path.basename(archive));
    const dest = await uniquePath(destDir, stem);
    await fsp.rename(tmp, dest);
    return dest;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** Pack `names` (entries of `dir`) into a new archive; format by extension. */
async function compress(dir: string, names: string[], outName: string): Promise<string> {
  const out = await uniquePath(dir, outName);
  const members = names.map(safeArg);
  try {
    await run('bsdtar', ['-a', '-cf', out, '-C', dir, ...members]);
    return out;
  } catch (error) {
    if (!isMissing(error)) {
      await fsp.rm(out, { force: true });
      throw toolError(error);
    }
  }
  try {
    if (out.toLowerCase().endsWith('.zip')) {
      await run('sh', ['-c', 'cd -- "$1" || exit 1; out=$2; shift 2; exec zip -qry "$out" "$@"', 'sh', dir, out, ...names.map((n) => `./${n}`)]);
    } else {
      await run('tar', ['-a', '-cf', out, '-C', dir, ...members]);
    }
    return out;
  } catch (error) {
    await fsp.rm(out, { force: true });
    throw isMissing(error) ? new Error('No program to make this kind of archive is installed') : toolError(error);
  }
}

/** What's inside an archive, for the Preview window. */
async function listArchive(archive: string) {
  let stdout: string;
  try {
    stdout = await run('bsdtar', ['-tf', archive]);
  } catch (error) {
    if (!isMissing(error)) throw toolError(error);
    try {
      stdout = archive.toLowerCase().endsWith('.zip')
        ? await run('unzip', ['-Z1', archive])
        : await run('tar', ['-tf', archive]);
    } catch (e) {
      throw isMissing(e) ? new Error('No program to open this kind of archive is installed') : toolError(e);
    }
  }
  const entries = stdout.split('\n').filter(Boolean);
  return {
    entries: entries.slice(0, MAX_ARCHIVE_LISTING),
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** Folders watched at once; the oldest watch goes when a new one would pass this. */
const MAX_WATCHES = 64;
/** Changes are reported at most this often per folder. */
const WATCH_DEBOUNCE_MS = 250;

export function registerFileOpsHandlers({ assertShellSender, sendToShell }: {
  assertShellSender: (event: IpcEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  // Open folders are watched so the Files app follows changes made
  // elsewhere (a terminal, a download, another app) without polling.
  const watches = new Map<number, { watcher: fs.FSWatcher; timer: NodeJS.Timeout | null }>();
  let nextWatchId = 1;
  const unwatch = (id: number) => {
    const watch = watches.get(id);
    if (!watch) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.watcher.close();
    watches.delete(id);
  };
  ipcMain.handle('fs:watch', (event, target) => {
    assertShellSender(event);
    const dir = absolute(target);
    if (watches.size >= MAX_WATCHES) unwatch(watches.keys().next().value!);
    const id = nextWatchId++;
    try {
      const watcher = fs.watch(dir, { persistent: false }, () => {
        const watch = watches.get(id);
        if (!watch || watch.timer) return;
        watch.timer = setTimeout(() => {
          watch.timer = null;
          sendToShell('fs:changed', dir);
        }, WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => unwatch(id));
      watches.set(id, { watcher, timer: null });
    } catch {
      // Unwatchable (permissions, inotify limits); the folder just won't follow changes.
      return null;
    }
    return id;
  });
  ipcMain.handle('fs:unwatch', (event, id) => {
    assertShellSender(event);
    if (typeof id === 'number') unwatch(id);
  });

  const handle = (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertShellSender(event);
      return fn(...args);
    });
  };

  // Copy/move into a folder under the same name, or "name (2)" when taken.
  handle('fs:copyInto', async (from, dir, name) => {
    const src = absolute(from);
    const destDir = absolute(dir);
    if (isWithin(destDir, src)) throw new Error('A folder can’t be copied into itself');
    const dest = await uniquePath(destDir, name === undefined ? path.basename(src) : entryName(name));
    await copyTree(src, dest);
    return dest;
  });
  handle('fs:moveInto', async (from, dir) => {
    const src = absolute(from);
    const destDir = absolute(dir);
    if (path.dirname(src) === destDir) return src;
    if (isWithin(destDir, src)) throw new Error('A folder can’t be moved into itself');
    const dest = await uniquePath(destDir, path.basename(src));
    await moveTree(src, dest);
    return dest;
  });
  // Move to an exact path that must not exist yet (undo, renames).
  handle('fs:move', async (from, to) => {
    const src = absolute(from);
    const dest = absolute(to);
    // Allow case-only renames on case-insensitive filesystems.
    if (src.toLowerCase() !== dest.toLowerCase() && (await exists(dest))) {
      throw new Error(`“${path.basename(dest)}” already exists`);
    }
    await moveTree(src, dest);
  });

  handle('fs:trash', async (target) => {
    const p = absolute(target);
    if (p === '/' || p === os.homedir()) throw new Error('Refusing to trash this folder');
    return trash(p);
  });
  handle('fs:restore', async (name) => restore(entryName(name)));
  handle('fs:purge', async (name) => purge(name === undefined ? undefined : entryName(name)));
  handle('fs:trashDir', async () => {
    const dir = path.join(trashDir(), 'files');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(path.join(trashDir(), 'info'), { recursive: true });
    return dir;
  });

  handle('fs:details', async (target) => details(absolute(target)));
  handle('fs:du', async (target) => diskUsage(absolute(target)));
  handle('fs:chmod', async (target, mode) => {
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error('Invalid mode');
    }
    await fsp.chmod(absolute(target), mode);
  });

  handle('fs:extract', async (archive, dir) => extract(absolute(archive), absolute(dir)));
  handle('fs:compress', async (dir, names, outName) => {
    if (!Array.isArray(names) || names.length === 0) throw new Error('Nothing to compress');
    return compress(absolute(dir), names.map(entryName), entryName(outName));
  });
  handle('fs:listArchive', async (archive) => listArchive(absolute(archive)));
}

/** Content types for what the shell renders inline. */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', heic: 'image/heic', jxl: 'image/jxl',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  mov: 'video/quicktime', ogv: 'video/ogg', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
};

/**
 * din-file://localhost/<absolute path>: a local file, with Range support so
 * video seeks. Handled in the default session only, which is the shell's:
 * every <webview> guest lives in a partition of its own (see
 * will-attach-webview in main.mts), so no web page can reach it.
 *
 * Call after app ready; the scheme itself is registered as privileged in
 * main.mts.
 */
export function registerLocalFileProtocol(shellOrigin: string): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    const cors = { 'access-control-allow-origin': shellOrigin };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: cors });
    }
    let file: string;
    try {
      file = absolute(decodeURIComponent(new URL(request.url).pathname));
    } catch {
      return new Response(null, { status: 400, headers: cors });
    }
    let size: number;
    try {
      const stats = await fsp.stat(file);
      if (!stats.isFile()) return new Response(null, { status: 404, headers: cors });
      size = stats.size;
    } catch {
      return new Response(null, { status: 404, headers: cors });
    }

    const ext = path.extname(file).slice(1).toLowerCase();
    const headers: Record<string, string> = {
      ...cors,
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
      // An SVG is a document: never let one run script in this origin.
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
    };

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2]));
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = String(size === 0 ? 0 : end - start + 1);

    if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
  });
}
