// The USB Flasher bridge (window.dinos.flasher for `din flasher`, and
// din.system.flasher for the USB Flasher app): writing a disk image (an ISO,
// a .img, compressed or not) to a USB drive or memory card, or DinOS itself,
// built from the commit this computer runs.
//
// The drives are listed with lsblk, as the user: whole disks that are
// removable, on USB or in an SD card slot, writable, with nothing on them
// mounted outside /run/media (which leaves out the disk the system runs
// from, and a live USB boot's own stick). The list is read again whenever
// udisks sees a change (volumes.mts) and pushed as `flasher:changed`.
//
// Writing is os's: din-flash.sh, as root, which checks the drive for itself
// whatever's asked of it. On DinOS sudo runs it without asking (DIN_FLASHER,
// configuration.nix); elsewhere this copy beside the module is run with
// `sudo -A`, which asks for the password in Din. The image never goes
// through this process, nor is it opened by root: it's opened here, as the
// user, and the descriptor handed to the helper as its stdin (or to a
// decompressor, whose output is). How far the writing has got is read from
// that descriptor's offset in /proc/self/fdinfo, shared with the helper's
// copy; how far checking it has got, from the helper's `verified` lines.
// While a drive is written, Din mounts nothing that appears on it, and once
// it's done the drive is powered off (volumes.mts) so it can be unplugged.
//
// DinOS's image is the flake's `image` (os/make-stick-image.nix) at the
// commit in /etc/din-revision. That commit is fetched into a repository of
// the user's own in ~/.cache/din/usb-flasher (from the updater's checkout,
// or ~/DinOS), since Nix won't read root's, and built with `nix build`, as
// the user, through the daemon. The system in it is the one running, already
// in the store, so only the image itself is made. The build is kept from
// the garbage collector by an out-link until the drive is written.
//
// One job at a time, kept here rather than in a window, so closing the app
// doesn't stop it, and pushed as it goes.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ipcMain } from 'electron';
import { notifyFromSystem } from './notifications.mts';
import { sudoAskpass } from './system-packages.mts';
import { runCommand, which } from './system.mts';
import { onDisksChanged, powerOffDisk, releaseDisk } from './volumes.mts';

/** The helper as DinOS names it: sudo runs it without asking. */
const SYSTEM_HELPER = process.env.DIN_FLASHER;
/** The helper beside this module, for `sudo -A` where DinOS's isn't. */
export const BUNDLED_HELPER = path.join(import.meta.dirname, 'din-flash.sh');

const REVISION_FILE = '/etc/din-revision';
const VERSION_FILE = '/etc/din-version';
const LIVE_FILE = '/run/din/live';
/** Where Din's updater keeps its checkout, which has every commit it built. */
const UPDATER_SOURCE = '/var/lib/dinos/src';
const CACHE = path.join(os.homedir(), '.cache', 'din', 'usb-flasher');
const SOURCE_REPO = path.join(CACHE, 'source.git');
const OUT_LINK = path.join(CACHE, 'dinos-image');
/** DinOS's image: os/flake.nix's diskSize, 6 GiB. */
const DINOS_IMAGE_BYTES = 6 * 1024 ** 3;

const PUSH_INTERVAL_MS = 250;
const PROGRESS_POLL_MS = 500;

export interface FlashDrive {
  /** The whole disk's device node, e.g. /dev/sdb. */
  path: string;
  /** Its vendor and model, or what it is. */
  name: string;
  sizeBytes: number;
  /** "usb", "mmc" (a memory card), or "" when the kernel doesn't say. */
  transport: string;
  /** The labels of what's on it now, to tell drives apart. */
  labels: string[];
  /** Something on it is mounted (by Din, under /run/media): it's unmounted first. */
  mounted: boolean;
  /** Where its filesystems are mounted, to keep an image from being written over itself. */
  mountPoints: string[];
}

export type Compression = 'xz' | 'gzip' | 'zstd' | 'bzip2';

export interface ImageInfo {
  path: string;
  name: string;
  /** The file's own size. */
  fileBytes: number;
  compression: Compression | null;
  /** What gets written: the file's size, or what it decompresses to, if that's known. */
  imageBytes: number | null;
  /** An ISO 9660 disc image. */
  iso: boolean;
  /**
   * A disc image with no partition table, which most computers won't start
   * from a USB drive (Windows' own ISOs, older Linux ones): said, not refused.
   */
  notBootableFromUsb: boolean;
}

export interface DinosImageStatus {
  /** Whether DinOS can be built here, and why not. */
  available: boolean;
  reason: string | null;
  /** The release (os/version) and commit running, as the stick will have them. */
  version: string | null;
  commit: string | null;
  /** How big the image is, to tell drives too small for it. */
  imageBytes: number;
}

export type FlashSource = { kind: 'file'; path: string } | { kind: 'dinos' };

export type FlashPhase =
  | 'idle'
  /** Fetching DinOS's source and building its image. */
  | 'building'
  /** Unmounting the drive and asking for the password, if it's asked for. */
  | 'preparing'
  | 'writing'
  | 'verifying'
  /** Powering the drive off. */
  | 'ejecting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface FlashState {
  phase: FlashPhase;
  /** What's written: the file's name, or "DinOS 0.2.0". */
  sourceName: string | null;
  sourceKind: FlashSource['kind'] | null;
  drive: { path: string; name: string; sizeBytes: number } | null;
  /** How far the phase has got, 0 to 1, or null while there's no telling. */
  progress: number | null;
  /** Bytes written, or checked, so far. */
  bytes: number;
  /** Of how many, where that's known. */
  totalBytes: number | null;
  /** Bytes a second, while writing or checking. */
  rate: number | null;
  /** What the DinOS build is doing, in its own words. */
  detail: string | null;
  error: string | null;
  /** The phase it was in when it failed. */
  failedAt: FlashPhase | null;
  /** Whether the drive was powered off, once done. */
  ejected: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface FlasherStatus {
  /** Whether drives can be written here at all. */
  available: boolean;
  /** Why not. */
  reason: string | null;
  /** Writing asks for the administrator password (not on DinOS). */
  asksPassword: boolean;
  dinos: DinosImageStatus;
  drives: FlashDrive[];
  state: FlashState;
}

/** What `flasher:changed` carries. */
export interface FlasherChange {
  drives: FlashDrive[];
  state: FlashState;
}

const IDLE: FlashState = {
  phase: 'idle',
  sourceName: null,
  sourceKind: null,
  drive: null,
  progress: null,
  bytes: 0,
  totalBytes: null,
  rate: null,
  detail: null,
  error: null,
  failedAt: null,
  ejected: false,
  startedAt: null,
  finishedAt: null,
};

let state: FlashState = IDLE;
let drives: FlashDrive[] = [];
let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let pushTimer: NodeJS.Timeout | null = null;
/** What's running for the job, to stop it. */
let running: ChildProcess[] = [];
let cancelled = false;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a drive is being written, which a restart or an automount would spoil. */
export function isWritingDrive(): boolean {
  return state.phase === 'preparing' || state.phase === 'writing' || state.phase === 'verifying';
}

function busy(): boolean {
  return state.phase === 'building' || isWritingDrive() || state.phase === 'ejecting';
}

function push(now = false): void {
  const send = () => {
    pushTimer = null;
    sendToShell('flasher:changed', { drives, state } satisfies FlasherChange);
  };
  if (now) {
    if (pushTimer) clearTimeout(pushTimer);
    send();
  } else {
    pushTimer ??= setTimeout(send, PUSH_INTERVAL_MS);
  }
}

function update(next: Partial<FlashState>, now = false): void {
  state = { ...state, ...next };
  push(now);
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

interface LsblkDevice {
  name: string;
  path: string;
  type: string;
  size: number | string | null;
  rm: boolean | string | null;
  ro: boolean | string | null;
  tran: string | null;
  vendor: string | null;
  model: string | null;
  label: string | null;
  mountpoints?: (string | null)[];
  mountpoint?: string | null;
  children?: LsblkDevice[];
}

const flag = (value: boolean | string | null) => value === true || value === '1';

function flatten(device: LsblkDevice): LsblkDevice[] {
  return [device, ...(device.children ?? []).flatMap(flatten)];
}

function mountsOf(device: LsblkDevice): string[] {
  return (device.mountpoints ?? [device.mountpoint ?? null]).filter((m): m is string => !!m);
}

function driveName(device: LsblkDevice, memoryCard: boolean): string {
  const vendor = (device.vendor ?? '').trim();
  const model = (device.model ?? '').trim().replace(/_/g, ' ');
  // Vendors often say it again in the model ("SanDisk", "SanDisk Ultra").
  const name = model.toLowerCase().startsWith(vendor.toLowerCase()) ? model : [vendor, model].filter(Boolean).join(' ');
  return name || (memoryCard ? 'Memory card' : 'USB drive');
}

/** The drives a disk image could be written to. */
async function listDrives(): Promise<FlashDrive[]> {
  if (process.platform !== 'linux') return [];
  const { stdout } = await runCommand(
    'lsblk',
    ['-J', '-b', '-o', 'NAME,PATH,TYPE,SIZE,RM,RO,TRAN,VENDOR,MODEL,LABEL,MOUNTPOINTS'],
    { timeout: 15_000 },
  );
  const { blockdevices = [] } = JSON.parse(stdout) as { blockdevices?: LsblkDevice[] };
  const found: FlashDrive[] = [];
  for (const disk of blockdevices) {
    if (disk.type !== 'disk' || flag(disk.ro)) continue;
    const memoryCard = disk.name.startsWith('mmcblk') || disk.tran === 'mmc';
    if (!flag(disk.rm) && disk.tran !== 'usb' && !memoryCard) continue;
    const sizeBytes = Number(disk.size ?? 0);
    if (!(sizeBytes > 0)) continue;
    const all = flatten(disk);
    const mountPoints = all.flatMap(mountsOf);
    // Mounted by the system rather than for the user: the stick a live boot
    // runs from, or a disk in /etc/fstab. Never offered.
    if (mountPoints.some((m) => !m.startsWith('/run/media/') && !m.startsWith('/media/'))) continue;
    found.push({
      path: disk.path,
      name: driveName(disk, memoryCard),
      sizeBytes,
      transport: memoryCard ? 'mmc' : (disk.tran ?? ''),
      labels: [...new Set(all.map((d) => (d.label ?? '').trim()).filter(Boolean))],
      mounted: mountPoints.length > 0,
      mountPoints,
    });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

let listing: Promise<FlashDrive[]> | null = null;
let listAgain = false;

/** Read the drives again, and push them if they changed. */
function refreshDrives(): Promise<FlashDrive[]> {
  if (listing) {
    listAgain = true;
    return listing;
  }
  listing = listDrives()
    .catch((error: unknown) => {
      console.error('usb-flasher: listing drives failed', error);
      return drives;
    })
    .then((next) => {
      const changed = JSON.stringify(next) !== JSON.stringify(drives);
      drives = next;
      if (changed) push();
      return next;
    })
    .finally(() => {
      listing = null;
      if (listAgain) {
        listAgain = false;
        void refreshDrives();
      }
    });
  return listing;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const DECOMPRESSORS: Record<Compression, string> = { xz: 'xz', gzip: 'gzip', zstd: 'zstd', bzip2: 'bzip2' };

function compressionOf(head: Buffer): Compression | null {
  if (head.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return 'zstd';
  if (head.subarray(0, 3).toString('latin1') === 'BZh') return 'bzip2';
  return null;
}

/** What a compressed image decompresses to, where its format says. */
async function decompressedSize(file: string, compression: Compression): Promise<number | null> {
  try {
    if (compression === 'xz') {
      const { stdout } = await runCommand('xz', ['--robot', '--list', '--', file], { timeout: 30_000 });
      const totals = stdout.split('\n').find((line) => line.startsWith('totals\t'));
      const size = Number(totals?.split('\t')[4]);
      return Number.isFinite(size) && size > 0 ? size : null;
    }
    if (compression === 'zstd') {
      const { stdout, stderr } = await runCommand('zstd', ['-lv', '--', file], { timeout: 30_000 });
      const match = /Decompressed Size:.*\((\d+) B\)/.exec(stdout + stderr);
      return match ? Number(match[1]) : null;
    }
  } catch {
    // Not said, or the tool isn't here (writing would say so).
  }
  return null;
}

async function readAt(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** What's in an image file: its size, compression, and whether it's a disc's. */
export async function inspectImage(file: unknown): Promise<ImageInfo> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Not a file');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    throw new Error('That file can’t be found.');
  }
  if (!stat.isFile()) throw new Error('That isn’t a file.');
  if (stat.size === 0) throw new Error('That file is empty.');
  const head = await readAt(file, 0, 512);
  const compression = compressionOf(head);
  if (compression && !which(DECOMPRESSORS[compression])) {
    throw new Error(`Images compressed with ${compression} can’t be opened on this computer.`);
  }
  let iso = false;
  let notBootableFromUsb = false;
  if (!compression && stat.size > 0x8006) {
    iso = (await readAt(file, 0x8001, 5)).toString('latin1') === 'CD001';
    // A hybrid ISO has a partition table at its start too, so it starts
    // from a USB drive as well as a disc; one without doesn't.
    notBootableFromUsb = iso && !(head.length >= 512 && head[510] === 0x55 && head[511] === 0xaa);
  }
  return {
    path: file,
    name: path.basename(file),
    fileBytes: stat.size,
    compression,
    imageBytes: compression ? await decompressedSize(file, compression) : stat.size,
    iso,
    notBootableFromUsb,
  };
}

// ---------------------------------------------------------------------------
// DinOS
// ---------------------------------------------------------------------------

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function dinosStatus(): DinosImageStatus {
  const commit = readText(REVISION_FILE);
  const version = readText(VERSION_FILE);
  const base = { version, commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null, imageBytes: DINOS_IMAGE_BYTES };
  const unavailable = (reason: string): DinosImageStatus => ({ ...base, available: false, reason });
  if (process.platform !== 'linux' || process.arch !== 'x64' || !commit) {
    return unavailable('DinOS can only be made on a computer running DinOS.');
  }
  if (!base.commit) {
    return unavailable(
      commit.endsWith('-dirty')
        ? 'This DinOS was built from changes that weren’t committed, so it can’t be made again. Commit them in ~/DinOS and update, then try again.'
        : 'Din can’t tell which version of DinOS this is.',
    );
  }
  if (fs.existsSync(LIVE_FILE)) {
    return unavailable('DinOS is running from a USB stick, which has no room to make another. Install it first.');
  }
  if (!which('nix') || !which('git')) return unavailable('Nix isn’t on this computer, so DinOS can’t be made here.');
  return { ...base, available: true, reason: null };
}

/** Run a command for the build, as the user, and resolve with its output. */
function run(
  file: string,
  args: string[],
  options: { cwd?: string; onLine?: (line: string) => void } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    running.push(child);
    let stdout = '';
    let tail = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      tail = `${tail}\n${line}`.slice(-4000);
      options.onLine?.(line);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      running = running.filter((c) => c !== child);
      if (cancelled) reject(new Error('Cancelled'));
      else if (code === 0) resolve(stdout);
      else reject(new Error(tail.trim().split('\n').filter(Boolean).pop() || `${path.basename(file)} exited ${code}`));
    });
  });
}

/** Bring the running commit into the user's own repository, for Nix to read. */
async function fetchSource(commit: string): Promise<void> {
  if (!fs.existsSync(path.join(SOURCE_REPO, 'HEAD'))) {
    await fs.promises.mkdir(SOURCE_REPO, { recursive: true });
    await run('git', ['init', '--quiet', '--bare', SOURCE_REPO]);
  }
  const has = await run('git', ['-C', SOURCE_REPO, 'cat-file', '-e', `${commit}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!has) {
    const sources = [UPDATER_SOURCE, path.join(os.homedir(), 'DinOS')].filter((dir) => fs.existsSync(dir));
    let fetched = false;
    for (const source of sources) {
      // The updater's checkout is root's; reading it is all this does.
      const ok = await run('git', ['-c', `safe.directory=${source}`, '-C', SOURCE_REPO, 'fetch', '--quiet', '--no-tags', source, commit]).then(
        () => true,
        () => false,
      );
      if (cancelled) throw new Error('Cancelled');
      if (ok) {
        fetched = true;
        break;
      }
    }
    if (!fetched) {
      throw new Error(`DinOS’s source for this version (${commit.slice(0, 7)}) isn’t on this computer. Update DinOS, then try again.`);
    }
  }
  await run('git', ['-C', SOURCE_REPO, 'update-ref', 'refs/heads/dinos', commit]);
}

/** What a line of `nix build -L`'s output says, for the app to show. */
function buildDetail(line: string): string | null {
  const text = line.replace(/^[\w.+-]+> /, '').trim();
  if (!text || text.length > 200) return null;
  return text;
}

/** Build DinOS's image from the running commit; resolves with the image file. */
async function buildDinos(commit: string): Promise<string> {
  update({ detail: 'Getting DinOS’s source' }, true);
  await fetchSource(commit);
  update({ detail: 'Putting the image together' }, true);
  const flake = `git+file://${SOURCE_REPO}?ref=dinos&rev=${commit}&dir=os#image`;
  const out = await run(
    'nix',
    ['--extra-experimental-features', 'nix-command flakes', 'build', '-L', '--out-link', OUT_LINK, '--print-out-paths', flake],
    {
      onLine: (line) => {
        const detail = buildDetail(line);
        if (detail) update({ detail });
      },
    },
  );
  const image = path.join(out.trim().split('\n').pop() ?? '', 'nixos.img');
  if (!fs.existsSync(image)) throw new Error('The build finished without an image.');
  return image;
}

function releaseBuild(): void {
  fs.promises.rm(OUT_LINK, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** How the helper is run: sudo without asking on DinOS, else with Din asking. */
function helperCommand(disk: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } | null {
  if (SYSTEM_HELPER) return { file: 'sudo', args: ['-n', SYSTEM_HELPER, 'write', disk], env: process.env };
  if (process.platform !== 'linux' || !which('sudo') || !fs.existsSync(BUNDLED_HELPER)) return null;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const askpass = sudoAskpass();
  if (askpass) env.SUDO_ASKPASS = askpass;
  return { file: 'sudo', args: ['-A', BUNDLED_HELPER, 'write', disk], env };
}

/** The offset a descriptor of ours has got to, shared with whoever has a copy. */
function offsetOf(fd: number): number | null {
  try {
    const match = /^pos:\s*(\d+)/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Words for what sudo or the helper said last. */
function helperError(tail: string, code: number | null): string {
  if (/no password was provided|password is required|incorrect password|a password is required/i.test(tail)) {
    return 'No password was entered, so nothing was written.';
  }
  if (/is not in the sudoers file|may not run sudo|not allowed to execute/i.test(tail)) {
    return 'Your account isn’t allowed to write to drives on this computer.';
  }
  const last = tail.trim().split('\n').filter((line) => !/^\[sudo\]/.test(line)).pop();
  return last || `Writing stopped (${code})`;
}

/** Write an image file to a drive, checking it afterwards. */
async function writeImage(image: ImageInfo, drive: FlashDrive): Promise<void> {
  const helper = helperCommand(drive.path);
  if (!helper) throw new Error('Drives can’t be written on this computer.');

  update({ phase: 'preparing', progress: null, bytes: 0, totalBytes: image.imageBytes, rate: null, detail: null }, true);
  // Din's own mounts come off first; the helper refuses anything else in use.
  await releaseDisk(drive.path);
  if (cancelled) throw new Error('Cancelled');

  const fd = fs.openSync(image.path, 'r');
  const children: ChildProcess[] = [];
  let poll: NodeJS.Timeout | null = null;
  try {
    const decompress = image.compression ? spawn(DECOMPRESSORS[image.compression], ['-dc'], { stdio: [fd, 'pipe', 'pipe'] }) : null;
    if (decompress) children.push(decompress);
    const child = spawn(helper.file, helper.args, { env: helper.env, stdio: [decompress ? decompress.stdout! : fd, 'pipe', 'pipe'] });
    children.push(child);
    running.push(...children);

    let tail = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000);
    });
    let decompressError = '';
    decompress?.stderr!.on('data', (chunk: Buffer) => {
      decompressError = (decompressError + chunk.toString()).slice(-2000);
    });

    const written: { bytes: number | null } = { bytes: null };
    let phase: 'preparing' | 'writing' | 'verifying' = 'preparing';
    let last = { at: Date.now(), bytes: 0 };
    const measure = (bytes: number) => {
      const now = Date.now();
      const rate = now > last.at ? ((bytes - last.bytes) * 1000) / (now - last.at) : null;
      // Smoothed, so the time left doesn't jump about.
      const smoothed = rate === null ? state.rate : state.rate === null ? rate : state.rate * 0.8 + rate * 0.2;
      last = { at: now, bytes };
      return smoothed !== null && smoothed >= 0 ? smoothed : null;
    };

    poll = setInterval(() => {
      if (phase !== 'writing') return;
      const read = offsetOf(fd);
      if (read === null) return;
      if (image.compression) {
        // How much of the compressed file is in, as the measure of how far.
        update({ progress: Math.min(1, read / image.fileBytes), bytes: read, totalBytes: image.fileBytes, rate: measure(read) });
      } else {
        update({ progress: Math.min(1, read / image.fileBytes), bytes: read, rate: measure(read) });
      }
    }, PROGRESS_POLL_MS);

    createInterface({ input: child.stdout! }).on('line', (line) => {
      const [kind, value, sum] = line.split(' ');
      if (kind === 'step' && value === 'write') {
        phase = 'writing';
        last = { at: Date.now(), bytes: 0 };
        update({ phase: 'writing', progress: 0, bytes: 0, rate: null }, true);
      } else if (kind === 'step' && value === 'verify') {
        phase = 'verifying';
        last = { at: Date.now(), bytes: 0 };
        const total = Number(sum);
        update({ phase: 'verifying', progress: 0, bytes: 0, totalBytes: total > 0 ? total : null, rate: null }, true);
      } else if (kind === 'verified') {
        const bytes = Number(value);
        if (Number.isFinite(bytes)) {
          update({ bytes, progress: state.totalBytes ? Math.min(1, bytes / state.totalBytes) : null, rate: measure(bytes) });
        }
      } else if (kind === 'done' && sum) {
        written.bytes = Number(value);
      }
    });

    const exited = (proc: ChildProcess) =>
      new Promise<number | null>((resolve) => {
        proc.on('error', () => resolve(-1));
        proc.on('close', (code) => resolve(code));
      });
    const [code, decompressCode] = await Promise.all([exited(child), decompress ? exited(decompress) : Promise.resolve(0)]);
    if (cancelled) throw new Error('Cancelled');
    if (decompress && decompressCode !== 0) {
      throw new Error(`The image couldn’t be decompressed: ${decompressError.trim().split('\n').pop() || 'it may be damaged'}.`);
    }
    const { bytes } = written;
    if (code !== 0 || bytes === null) throw new Error(helperError(tail, code));
    // Every byte of the image, not some of it: a decompressor or a pipe
    // that stopped early would leave the helper checking a short copy.
    if (image.imageBytes !== null && bytes !== image.imageBytes) {
      throw new Error(`Only ${bytes} of the image’s ${image.imageBytes} bytes were written.`);
    }
    update({ bytes, totalBytes: bytes, progress: 1 }, true);
  } finally {
    if (poll) clearInterval(poll);
    running = running.filter((c) => !children.includes(c));
    fs.closeSync(fd);
  }
}

function finish(next: Partial<FlashState>): void {
  update({ ...next, rate: null, finishedAt: Date.now() }, true);
}

async function flash(source: FlashSource, drivePath: string): Promise<void> {
  cancelled = false;
  const drive = drives.find((d) => d.path === drivePath);
  if (!drive) throw new Error('That drive isn’t plugged in.');
  const dinos = source.kind === 'dinos' ? dinosStatus() : null;
  const sourceName = dinos
    ? `DinOS${dinos.version ? ` ${dinos.version}` : ''}`
    : path.basename(source.kind === 'file' ? source.path : '');
  state = {
    ...IDLE,
    phase: source.kind === 'dinos' ? 'building' : 'preparing',
    sourceName,
    sourceKind: source.kind,
    drive: { path: drive.path, name: drive.name, sizeBytes: drive.sizeBytes },
    startedAt: Date.now(),
  };
  push(true);

  try {
    let image: ImageInfo;
    if (source.kind === 'dinos') {
      const file = await buildDinos(dinos!.commit!);
      if (cancelled) throw new Error('Cancelled');
      image = await inspectImage(file);
    } else {
      image = await inspectImage(source.path);
    }
    if (image.imageBytes !== null && image.imageBytes > drive.sizeBytes) {
      throw new Error(`The image is bigger than the drive: it needs ${formatBytes(image.imageBytes)}.`);
    }
    if (drive.mountPoints.some((m) => image.path === m || image.path.startsWith(`${m}/`))) {
      throw new Error('The image is on that drive. Copy it to this computer first, or choose another drive.');
    }
    await writeImage(image, drive);
    if (cancelled) throw new Error('Cancelled');

    update({ phase: 'ejecting', progress: null, rate: null }, true);
    const ejected = await powerOffDisk(drive.path).catch(() => false);
    finish({ phase: 'done', ejected });
    notifyFromSystem('usb-flasher', `${drive.name} is ready`, ejected ? `${sourceName} was written and checked. You can unplug it.` : `${sourceName} was written and checked.`);
  } catch (error) {
    if (cancelled) {
      finish({ phase: 'cancelled', error: null });
    } else {
      finish({ phase: 'failed', failedAt: state.phase, error: messageOf(error) });
      notifyFromSystem('usb-flasher', `${drive.name} wasn’t written`, messageOf(error));
    }
  } finally {
    if (source.kind === 'dinos') releaseBuild();
    running = [];
    void refreshDrives();
  }
}

function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function cancel(): void {
  if (!busy() || state.phase === 'ejecting') return;
  cancelled = true;
  // sudo passes the signal on to the helper, which stops where it is.
  for (const child of running) child.kill('SIGTERM');
}

function parseSource(raw: unknown): FlashSource {
  if (typeof raw === 'object' && raw !== null) {
    const source = raw as Record<string, unknown>;
    if (source.kind === 'dinos') return { kind: 'dinos' };
    if (source.kind === 'file' && typeof source.path === 'string' && path.isAbsolute(source.path)) {
      return { kind: 'file', path: source.path };
    }
  }
  throw new Error('Not something to write');
}

async function status(): Promise<FlasherStatus> {
  await refreshDrives();
  const helper = SYSTEM_HELPER || (process.platform === 'linux' && which('sudo') && fs.existsSync(BUNDLED_HELPER));
  return {
    available: !!helper,
    reason: helper ? null : 'Drives can’t be written on this computer.',
    asksPassword: !SYSTEM_HELPER,
    dinos: dinosStatus(),
    drives,
    state,
  };
}

export function registerUsbFlasherHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;
  onDisksChanged(() => void refreshDrives());

  ipcMain.handle('flasher:status', (event) => {
    assertShellSender(event);
    return status();
  });

  ipcMain.handle('flasher:inspect', (event, file: unknown) => {
    assertShellSender(event);
    return inspectImage(file);
  });

  // Resolves once it's started; how it goes is pushed.
  ipcMain.handle('flasher:flash', async (event, source: unknown, drive: unknown) => {
    assertShellSender(event);
    if (busy()) throw new Error('A drive is being written already.');
    if (typeof drive !== 'string') throw new Error('Not a drive');
    const parsed = parseSource(source);
    if (parsed.kind === 'dinos') {
      const dinos = dinosStatus();
      if (!dinos.available) throw new Error(dinos.reason ?? 'DinOS can’t be made here.');
    } else {
      await inspectImage(parsed.path);
    }
    await refreshDrives();
    if (!drives.some((d) => d.path === drive)) throw new Error('That drive isn’t plugged in.');
    void flash(parsed, drive);
  });

  ipcMain.handle('flasher:cancel', (event) => {
    assertShellSender(event);
    cancel();
  });

  // Done with what's finished: back to choosing.
  ipcMain.handle('flasher:reset', (event) => {
    assertShellSender(event);
    if (busy()) throw new Error('A drive is being written.');
    state = IDLE;
    push(true);
  });
}
