// File operations behind the Files app, beyond the basic fs bridge in
// main.mts: recursive copy and move, the freedesktop Trash, properties,
// archives, and the din-file: protocol that streams local files to the shell
// for thumbnails and the Preview window.
//
// Same threat model as the fs bridge (see main.mts): every request is
// re-validated against the shell's main frame, and authority is bounded by
// the unprivileged OS user Din runs as. Nothing here can do more than
// window.dinos.fs already can; it just does it in fewer round trips.
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
// Archives, read by three free tools, each where it does best:
//   - bsdtar (libarchive): tarballs, compressed or not, and the package
//     formats built like them (deb, rpm, apk, cpio). 7-Zip only takes those
//     apart one layer at a time (a .tgz to its .tar).
//   - 7-Zip (7zz, built without RARLAB's non-free unRAR code): everything
//     else - zip, 7z, cab, iso, msi, dmg, wim, disk images and more.
//   - unar: RAR, which that build of 7-Zip can't unpack.
// When the first fails, the others get a try, from scratch. 7-Zip and unar
// carry on past a damaged entry, so a damaged archive still gives up
// everything else, as 7-Zip and WinRAR do on Windows. bsdtar also makes
// archives. On a system with none of them, GNU tar, unzip and zip cover the
// common cases.
//
// Archives are untrusted, and so, a little, are the tools: they're big
// parsers of many old formats, with security bugs found every year, and
// the Preview window lists an archive as soon as it's opened. So each runs
// in a bubblewrap sandbox with no network and nothing of the user's: it
// sees the system's programs, the archive (and its other volumes), and the
// one folder it unpacks into, with a cap on its memory and at low priority.
// Where bubblewrap is missing or can't make namespaces, they run as before.
//
// All three keep what they write inside the folder they unpack into: "../"
// and absolute names are rewritten, and nothing is written through a
// symlink that came out of the archive. Symlinks that lead out of it (or
// nowhere) are then removed, as files could be read through them later -
// dragged into a web page, say. A lone hidden item (".bash_login") still
// gets a folder of its own, so that it can't land in home unseen. Against
// zip bombs, an archive whose listing adds up to more than the disk has
// room for is refused before anything is written, and since a listing can
// lie (and tarballs have none), extraction is stopped and undone if the
// disk nears full while it runs.
// ---------------------------------------------------------------------------

/** Single-file compressors, for "notes.txt.gz" that isn't a tarball. */
const DECOMPRESSORS: Record<string, string> = {
  '.gz': 'gzip',
  '.xz': 'xz',
  '.bz2': 'bzip2',
  '.zst': 'zstd',
};

/** Tarballs and the formats bsdtar unpacks whole where 7-Zip doesn't. */
const TARBALL = /\.(?:tar(?:\.[a-z0-9]+)?|tgz|tbz2?|txz|tzst|tlz|deb|udeb|rpm|apk|cpio)$/;

/** How often the disk's free space is checked while extracting. */
const SPACE_CHECK_MS = 250;
/** Free space extraction leaves alone, at most (see `diskRoom`). */
const MAX_RESERVE = 2 * 1024 ** 3;
/** Bytes an archive listing may print. */
const LISTING_BUFFER = 64 * 1024 * 1024;

/**
 * A password given to every tool, so that an encrypted archive fails as
 * one ("Wrong password") instead of prompting on a terminal or stdin.
 */
const NO_PASSPHRASE = 'din-no-passphrase';

type ArchiveTool = 'bsdtar' | '7zz' | 'unar';

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

/** System folders an archive tool may read (those that exist). */
const SANDBOX_SYSTEM = ['/nix/store', '/run/current-system', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];

/** The sandbox's fixed part; the archive and output folder are added. */
function sandboxBase(): string[] {
  return [
    '--unshare-all',
    '--die-with-parent',
    // No controlling terminal to push keystrokes into (TIOCSTI).
    '--new-session',
    ...SANDBOX_SYSTEM.flatMap((dir) => ['--ro-bind-try', dir, dir]),
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--clearenv',
    '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', process.env.LANG ?? 'C.UTF-8',
  ];
}

let sandboxWorks: Promise<boolean> | null = null;

/** Whether bubblewrap is here and allowed to make namespaces (checked once). */
function canSandbox(): Promise<boolean> {
  sandboxWorks ??= runCommand('bwrap', [...sandboxBase(), '--', 'true'], { timeout: 10_000 }).then(
    () => true,
    (error: unknown) => {
      console.warn('Archive tools run unsandboxed: bubblewrap', isMissing(error) ? 'is missing' : 'failed', error);
      return false;
    },
  );
  return sandboxWorks;
}

/** Address space an archive tool may use: half the memory, 2 to 8 GB. */
function memoryLimitKiB(): number {
  return Math.floor(Math.min(8 * 1024 ** 3, Math.max(2 * 1024 ** 3, os.totalmem() / 2)) / 1024);
}

/**
 * Run an archive tool in the sandbox, seeing only `read` (read-only) and
 * `write`, with nothing on stdin, so one that wants to ask something can't
 * sit waiting until the timeout. Aborting `signal` stops it.
 */
async function runArchiveTool(
  file: string,
  args: string[],
  options: { read: string[]; write?: string; signal?: AbortSignal; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const sandbox = (await canSandbox())
    ? [
      'bwrap',
      ...sandboxBase(),
      ...options.read.flatMap((p) => ['--ro-bind', p, p]),
      ...(options.write ? ['--bind', options.write, options.write] : []),
      '--',
    ]
    : [];
  const script = 'tool=$1; limit=$2; shift 2; command -v "$tool" >/dev/null || exit 127; ulimit -v "$limit"; exec nice -n 10 "$@" </dev/null';
  try {
    return await runCommand('sh', ['-c', script, 'sh', file, String(memoryLimitKiB()), ...sandbox, file, ...args], {
      timeout: ARCHIVE_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof CommandError && error.code === 127) {
      throw new CommandError(error.message, 'ENOENT', error.stderr);
    }
    throw error;
  }
}

/** Whether a RAR archive (or a volume of one) by its name. */
function isRar(lower: string): boolean {
  return /\.(?:rar|r\d\d)$/.test(lower);
}

/** The tools to try on an archive, best first. */
function archiveTools(archive: string): ArchiveTool[] {
  const lower = archive.toLowerCase();
  if (isRar(lower)) return ['unar', '7zz', 'bsdtar'];
  if (TARBALL.test(lower)) return ['bsdtar', '7zz', 'unar'];
  return ['7zz', 'bsdtar', 'unar'];
}

/** What a tool said about a whole archive failing, in plain words. */
function archiveError(error: unknown): Error {
  const raw = toolError(error).message;
  // 7-Zip puts the archive's name and the reason on separate lines.
  const said = error instanceof CommandError ? error.stderr : raw;
  if (/password|passphrase|encrypt/i.test(said)) return new Error('This archive needs a password');
  if (
    /bad .* data|damaged|corrupt|truncat|checksum|crc|parsing failed|more data than was available|unrecognized archive format|invalid or incomplete|unexpected end|as archive|headers error|unsupported method/i
      .test(said)
  ) {
    return new Error('This archive is damaged or in a format Files can’t read');
  }
  return new Error(raw);
}

function formatSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---- Listing ----------------------------------------------------------------

interface ArchiveContents {
  /** Member paths, folders included. */
  entries: string[];
  /** The files' total unpacked size, when the format records it. */
  bytes: number | null;
}

/** 7-Zip's technical listing: one "Key = value" block per member. */
function parseSevenZipListing(stdout: string): ArchiveContents {
  // Blocks before the dashes describe the archive itself.
  const start = stdout.indexOf('\n----------\n');
  if (start === -1) throw new CommandError('Unreadable listing', null, stdout);
  const entries: string[] = [];
  let bytes = 0;
  for (const block of stdout.slice(start + 12).split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const eq = line.indexOf(' = ');
      if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 3));
      else if (line.endsWith(' =')) fields.set(line.slice(0, -2), '');
    }
    const name = fields.get('Path');
    if (!name) continue;
    entries.push(name);
    if (fields.get('Folder') !== '+') bytes += Number(fields.get('Size')) || 0;
  }
  return { entries, bytes };
}

interface LsarListing {
  lsarContents?: { XADFileName?: string; XADFileSize?: number; XADIsDirectory?: number }[];
}

/** An archive and the files it's made of (several, for multi-volume ones). */
interface ArchiveSource {
  archive: string;
  volumes: string[];
}

/** "name.partN.rar", "name.r00", "name.7z.001", "name.z01": the volumes' stem. */
const VOLUME = /^(.+?)(?:\.part\d+\.rar|\.rar|\.r\d\d|\.(?:7z|zip|tar)\.\d{3}|\.zip|\.z\d\d|\.\d{3})$/i;
/** Volumes the sandbox shows a tool, at most. */
const MAX_VOLUMES = 1_000;

/**
 * The archive and, if it may be one volume of several, its siblings by the
 * same stem: the sandbox shows a tool those and nothing else.
 */
async function archiveSource(archive: string): Promise<ArchiveSource> {
  const name = path.basename(archive);
  const stem = VOLUME.exec(name)?.[1];
  if (!stem) return { archive, volumes: [archive] };
  const dir = path.dirname(archive);
  const siblings = (await fsp.readdir(dir).catch(() => []))
    .filter((n) => n !== name && VOLUME.exec(n)?.[1] === stem)
    .slice(0, MAX_VOLUMES);
  return { archive, volumes: [archive, ...siblings.map((n) => path.join(dir, n))] };
}

async function listWith(tool: ArchiveTool, { archive, volumes }: ArchiveSource, signal?: AbortSignal): Promise<ArchiveContents> {
  const options = { read: volumes, signal, maxBuffer: LISTING_BUFFER };
  if (tool === '7zz') {
    const { stdout } = await runArchiveTool('7zz', ['l', '-slt', `-p${NO_PASSPHRASE}`, '--', archive], options);
    return parseSevenZipListing(stdout);
  }
  if (tool === 'unar') {
    const { stdout } = await runArchiveTool('lsar', ['-j', archive], options);
    const members = (JSON.parse(stdout) as LsarListing).lsarContents ?? [];
    return {
      entries: members.flatMap((m) => m.XADFileName ?? []),
      bytes: members.reduce((sum, m) => sum + (m.XADIsDirectory ? 0 : m.XADFileSize ?? 0), 0),
    };
  }
  // A tarball has no index: its sizes are only known by reading it all.
  const { stdout } = await runArchiveTool('bsdtar', ['--passphrase', NO_PASSPHRASE, '-tf', archive], options);
  return { entries: stdout.split('\n').filter(Boolean), bytes: null };
}

/** List an archive with the first tool that can. */
async function inspectArchive(archive: string, signal?: AbortSignal): Promise<ArchiveContents> {
  const source = await archiveSource(archive);
  let failure: unknown = null;
  for (const tool of archiveTools(archive)) {
    try {
      return await listWith(tool, source, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isMissing(error)) failure ??= error;
    }
  }
  if (failure !== null) throw archiveError(failure);
  // None of them.
  try {
    const stdout = archive.toLowerCase().endsWith('.zip')
      ? await run('unzip', ['-Z1', archive])
      : await run('tar', ['-tf', archive]);
    return { entries: stdout.split('\n').filter(Boolean), bytes: null };
  } catch (e) {
    throw isMissing(e) ? new Error('No program to open this kind of archive is installed') : archiveError(e);
  }
}

// ---- Extracting -------------------------------------------------------------

interface Unpacked {
  /** Members that came out damaged, partly or not at all. */
  damaged: string[];
  /** The archive was damaged in a way no member was named for. */
  incomplete: boolean;
}

/** unar's report of an entry it couldn't unpack: "  name  (123 B)... Failed! (why)". */
const UNAR_FAILED = /^\s*(.+?)(?:\s+\(\d+ B\))?\.\.\. Failed!/;

async function unarInto({ archive, volumes }: ArchiveSource, dest: string, signal: AbortSignal): Promise<Unpacked> {
  try {
    await runArchiveTool('unar', ['-q', '-f', '-D', '-o', dest, archive], { read: volumes, write: dest, signal });
    return { damaged: [], incomplete: false };
  } catch (error) {
    if (signal.aborted || !(error instanceof CommandError) || error.code !== 1) throw error;
    // Exit 1 is for a failed entry as well as a failed archive: keep what
    // came out if it got anywhere.
    const damaged = error.stderr.split('\n').flatMap((line) => UNAR_FAILED.exec(line)?.[1] ?? []);
    if (damaged.length === 0 || (await fsp.readdir(dest)).length === 0) throw error;
    return { damaged, incomplete: false };
  }
}

/** 7-Zip's report of a member it couldn't unpack: "ERROR: Data Error : name". */
const SEVENZIP_ERROR = /^ERROR: .+ : (.+)$/;

async function sevenZipInto({ archive, volumes }: ArchiveSource, dest: string, signal: AbortSignal): Promise<Unpacked> {
  try {
    await runArchiveTool('7zz', ['x', '-y', '-bso0', '-bsp0', `-p${NO_PASSPHRASE}`, `-o${dest}`, '--', archive], {
      read: volumes,
      write: dest,
      signal,
    });
    return { damaged: [], incomplete: false };
  } catch (error) {
    // 1 is a warning, 2 a fatal error: either may follow some good output.
    if (signal.aborted || !(error instanceof CommandError) || (error.code !== 1 && error.code !== 2)) throw error;
    // Encrypted, or a method this build lacks (RAR's): let another try.
    if (/password|unsupported method|as archive/i.test(error.stderr)) throw error;
    if ((await fsp.readdir(dest)).length === 0) throw error;
    const damaged = new Set<string>();
    for (const line of error.stderr.split('\n')) {
      const name = SEVENZIP_ERROR.exec(line.trim())?.[1];
      if (name) damaged.add(name.startsWith(`${dest}/`) ? name.slice(dest.length + 1) : name);
    }
    return { damaged: [...damaged], incomplete: damaged.size === 0 && error.code === 2 };
  }
}

/** bsdtar stops at the first damaged entry, so any damage fails the lot. */
async function bsdtarInto({ archive, volumes }: ArchiveSource, dest: string, signal: AbortSignal): Promise<Unpacked> {
  await runArchiveTool('bsdtar', ['--passphrase', NO_PASSPHRASE, '-xf', archive, '-C', dest], { read: volumes, write: dest, signal });
  return { damaged: [], incomplete: false };
}

const EXTRACTORS: Record<ArchiveTool, (source: ArchiveSource, dest: string, signal: AbortSignal) => Promise<Unpacked>> = {
  bsdtar: bsdtarInto,
  '7zz': sevenZipInto,
  unar: unarInto,
};

/** Extract `archive` into the empty `dest`. */
async function extractInto(archive: string, dest: string, signal: AbortSignal): Promise<Unpacked> {
  const lower = archive.toLowerCase();
  const ext = Object.keys(DECOMPRESSORS).find((e) => lower.endsWith(e));
  if (ext && !TARBALL.test(lower)) {
    // A bare compressed file, not a tarball: its compressor unpacks it.
    const [stem] = splitName(path.basename(archive));
    await runArchiveTool('sh', ['-c', `exec ${DECOMPRESSORS[ext]} -dc -- "$0" > "$1"`, archive, path.join(dest, stem)], {
      read: [archive],
      write: dest,
      signal,
    }).catch((e: unknown) => { throw signal.aborted ? e : toolError(e); });
    return { damaged: [], incomplete: false };
  }
  const source = await archiveSource(archive);
  let failure: unknown = null;
  for (const tool of archiveTools(archive)) {
    try {
      return await EXTRACTORS[tool](source, dest, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isMissing(error)) continue;
      failure ??= error;
      for (const item of await fsp.readdir(dest)) {
        await removeTree(path.join(dest, item));
      }
    }
  }
  if (failure !== null) throw archiveError(failure);
  // None of them.
  try {
    if (lower.endsWith('.zip') || lower.endsWith('.jar')) {
      await run('unzip', ['-q', archive, '-d', dest]);
    } else {
      await run('tar', ['-xf', archive, '-C', dest]);
    }
    return { damaged: [], incomplete: false };
  } catch (error) {
    throw isMissing(error) ? new Error('No program to open this kind of archive is installed') : archiveError(error);
  }
}

/**
 * Free space and files on the disk holding `dir`, and how much of the space
 * extraction must leave: 2 GB, or less on a small or nearly full disk, so
 * that a bomb can't take the last of it from Din and everything else.
 */
async function diskRoom(dir: string): Promise<{ free: number; files: number; reserve: number }> {
  const sfs = await fsp.statfs(dir);
  const free = sfs.bavail * sfs.bsize;
  return {
    free,
    // Filesystems without a fixed number of inodes (btrfs) report none.
    files: sfs.files > 0 ? sfs.ffree : Infinity,
    reserve: Math.min(MAX_RESERVE, (sfs.blocks * sfs.bsize) / 10, free / 2),
  };
}

const FILLED_DISK = 'Stopped: this archive would have filled the disk';

/** Extractions in progress, by the job id the shell gave, to cancel them. */
const extractJobs = new Map<string, AbortController>();

/**
 * Walk the tree under `root`, calling `onLink` for each symlink, and give
 * its owner full access to every folder on the way: an archive can make
 * folders that can't be entered or changed, which nothing could check,
 * use, or remove.
 */
async function walkOpeningFolders(root: string, onLink: (link: string) => Promise<void>): Promise<void> {
  const dirs = [root];
  for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
    const { mode } = await fsp.lstat(dir);
    if ((mode & 0o700) !== 0o700) await fsp.chmod(dir, (mode & 0o7777) | 0o700);
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(p);
      else if (entry.isSymbolicLink()) await onLink(p);
    }
  }
}

/** Remove a temporary tree, however the archive left its folders' modes. */
async function removeTree(root: string): Promise<void> {
  try {
    await fsp.rm(root, { recursive: true, force: true });
  } catch {
    await walkOpeningFolders(root, async () => {}).catch(() => {});
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/**
 * Remove the symlinks under `root` that lead out of it, or nowhere (so
 * can't be checked); resolves to their paths, relative to `root`. Each is
 * judged by where it really leads, through any links on the way, at the
 * time - one that led out through another was already out when checked.
 */
async function removeEscapingLinks(root: string): Promise<string[]> {
  const realRoot = await fsp.realpath(root);
  const removed: string[] = [];
  await walkOpeningFolders(root, async (p) => {
    const target = await fsp.realpath(p).catch(() => null);
    if (target !== null && isWithin(target, realRoot)) return;
    await fsp.rm(p, { force: true });
    removed.push(path.relative(root, p));
  });
  return removed;
}

/**
 * Extract an archive next to itself: a single top-level item lands as is
 * (unless hidden), anything else in a folder named after the archive.
 * Resolves to the path of what was created, what came out damaged - an
 * archive with some damage still gives up the rest - and the symlinks left
 * out. One too big for the disk is refused.
 */
async function extract(
  archive: string,
  destDir: string,
  job?: string,
): Promise<{ path: string; removedLinks: string[] } & Unpacked> {
  const controller = new AbortController();
  const { signal } = controller;
  if (job !== undefined) extractJobs.set(job, controller);
  const room = await diskRoom(destDir);
  const tmp = path.join(destDir, `.${path.basename(archive)}.extracting-${randomBytes(4).toString('hex')}`);
  let checking = false;
  const watch = setInterval(() => {
    if (checking) return;
    checking = true;
    diskRoom(destDir)
      .then(({ free }) => {
        if (free < room.reserve / 2) {
          controller.abort(new Error(FILLED_DISK));
        }
      })
      .catch(() => {})
      .finally(() => { checking = false; });
  }, SPACE_CHECK_MS);
  try {
    const lower = archive.toLowerCase();
    // Tarballs are read through to be listed: the watch covers them.
    if (!TARBALL.test(lower) && !Object.keys(DECOMPRESSORS).some((e) => lower.endsWith(e))) {
      const contents = await inspectArchive(archive, signal).catch(() => null);
      const spare = Math.max(0, room.free - room.reserve);
      if (contents?.bytes != null && contents.bytes > spare) {
        throw new Error(
          `This archive unpacks to ${formatSize(contents.bytes)}, more than the ${formatSize(spare)} this disk can spare`,
        );
      }
      if (contents && contents.entries.length > room.files) {
        throw new Error(
          `This archive holds ${contents.entries.length.toLocaleString('en-US')} files, more than this disk has room for`,
        );
      }
    }
    await fsp.mkdir(tmp);
    let unpacked: Unpacked;
    try {
      unpacked = await extractInto(archive, tmp, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason as Error;
      // Faster than the watch could catch it.
      if (/no space left/i.test(error instanceof Error ? error.message : '')) throw new Error(FILLED_DISK, { cause: error });
      throw error;
    }
    if (signal.aborted) throw signal.reason as Error;
    const removedLinks = await removeEscapingLinks(tmp);
    const items = await fsp.readdir(tmp);
    if (items.length === 1 && !items[0].startsWith('.')) {
      const dest = await uniquePath(destDir, items[0]);
      await fsp.rename(path.join(tmp, items[0]), dest);
      return { path: dest, removedLinks, ...unpacked };
    }
    const [stem] = splitName(path.basename(archive));
    const dest = await uniquePath(destDir, stem);
    await fsp.rename(tmp, dest);
    return { path: dest, removedLinks, ...unpacked };
  } finally {
    clearInterval(watch);
    if (job !== undefined && extractJobs.get(job) === controller) extractJobs.delete(job);
    await removeTree(tmp);
  }
}

/** Stop an extraction in progress; what it wrote so far is removed. */
function cancelExtract(job: string): void {
  extractJobs.get(job)?.abort(new Error('Extraction canceled'));
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
  const { entries } = await inspectArchive(archive);
  return {
    entries: entries.slice(0, MAX_ARCHIVE_LISTING),
    total: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Recent files, for the file picker.
// ---------------------------------------------------------------------------

/** The user folders Recent looks through, under home. */
const RECENT_DIRS = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'];
/** How many folders deep below each of them. */
const RECENT_DEPTH = 2;
/** Entries looked at in each, at most, so a huge Pictures can't stall the picker. */
const MAX_RECENT_SCAN = 5_000;
/** Of GTK's recently used files, how many of the latest are checked. */
const MAX_RECENT_XBEL = 300;
const MAX_RECENT = 200;
/** Downloads still in progress (Firefox, Chromium, Safari). */
const UNFINISHED_DOWNLOAD = /\.(?:part|crdownload|download)$/i;

interface RecentFile {
  path: string;
  name: string;
  kind: 'file';
  symlink: boolean;
  size: number;
  mtimeMs: number;
  /** When it was last made, changed, moved here, or opened (ms). */
  usedMs: number;
}

/** GTK's recently used files (recently-used.xbel), latest first, as [path, ms]. */
async function xbelRecent(home: string): Promise<[string, number][]> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(home, '.local/share/recently-used.xbel'), 'utf8');
  } catch {
    return [];
  }
  const found: [string, number][] = [];
  for (const match of text.matchAll(/<bookmark\s([^>]*)>/g)) {
    const attrs = match[1];
    const href = /\bhref="file:\/\/([^"]+)"/.exec(attrs)?.[1];
    if (!href) continue;
    let p: string;
    try {
      p = decodeURIComponent(href.replaceAll('&amp;', '&'));
    } catch {
      continue;
    }
    const times = [...attrs.matchAll(/\b(?:added|modified|visited)="([^"]+)"/g)]
      .map((m) => Date.parse(m[1]))
      .filter((t) => !Number.isNaN(t));
    if (times.length > 0) found.push([p, Math.max(...times)]);
  }
  return found.sort((a, b) => b[1] - a[1]).slice(0, MAX_RECENT_XBEL);
}

/**
 * The files the user most likely wants next: what's newest in their own
 * folders (a screenshot, a download), what GTK apps opened, and `extra`,
 * what the picker itself handed out. Latest first.
 */
async function recentFiles(extra: [string, number][]): Promise<RecentFile[]> {
  const home = os.homedir();
  const found = new Map<string, RecentFile>();
  const add = (p: string, stats: fs.Stats, symlink: boolean, usedMs: number) => {
    if (!stats.isFile() || UNFINISHED_DOWNLOAD.test(p)) return;
    const known = found.get(p);
    // A file moved or copied in keeps its old mtime; its ctime says when it arrived.
    const used = Math.max(usedMs, stats.mtimeMs, stats.ctimeMs);
    if (known && known.usedMs >= used) return;
    found.set(p, { path: p, name: path.basename(p), kind: 'file', symlink, size: stats.size, mtimeMs: stats.mtimeMs, usedMs: used });
  };

  // Breadth first, so a folder too big to finish still gives its top levels.
  const walk = async (root: string, maxDepth: number): Promise<void> => {
    let budget = MAX_RECENT_SCAN;
    let level = [root];
    for (let depth = 0; depth <= maxDepth && level.length > 0 && budget > 0; depth++) {
      const next: string[] = [];
      for (const dir of level) {
        if (budget <= 0) break;
        let dirents: fs.Dirent[];
        try {
          dirents = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        await Promise.all(dirents.map(async (d) => {
          if (budget <= 0 || d.name.startsWith('.')) return;
          budget--;
          const p = path.join(dir, d.name);
          if (d.isDirectory()) {
            if (d.name !== 'node_modules') next.push(p);
          } else if (d.isFile() || d.isSymbolicLink()) {
            try {
              add(p, await fsp.stat(p), d.isSymbolicLink(), 0);
            } catch {
              // Gone, or a broken link.
            }
          }
        }));
      }
      level = next;
    }
  };
  await Promise.all([
    walk(home, 0),
    ...RECENT_DIRS.map((dir) => walk(path.join(home, dir), RECENT_DEPTH)),
  ]);

  const used = [...extra, ...(await xbelRecent(home))];
  await Promise.all(used.map(async ([p, ms]) => {
    try {
      const link = await fsp.lstat(p);
      add(p, link.isSymbolicLink() ? await fsp.stat(p) : link, link.isSymbolicLink(), ms);
    } catch {
      // No longer there.
    }
  }));

  return [...found.values()].sort((a, b) => b.usedMs - a.usedMs).slice(0, MAX_RECENT);
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

  handle('fs:extract', async (archive, dir, job) =>
    extract(absolute(archive), absolute(dir), typeof job === 'string' ? job : undefined));
  handle('fs:cancelExtract', async (job) => {
    if (typeof job === 'string') cancelExtract(job);
  });
  handle('fs:compress', async (dir, names, outName) => {
    if (!Array.isArray(names) || names.length === 0) throw new Error('Nothing to compress');
    return compress(absolute(dir), names.map(entryName), entryName(outName));
  });
  handle('fs:listArchive', async (archive) => listArchive(absolute(archive)));
  handle('fs:recent', async (extra) => {
    const used = Array.isArray(extra)
      ? extra.slice(0, 100).flatMap((item): [string, number][] =>
          Array.isArray(item) && typeof item[0] === 'string' && path.isAbsolute(item[0]) && typeof item[1] === 'number'
            ? [[path.normalize(item[0]), item[1]]]
            : [])
      : [];
    return recentFiles(used);
  });
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
