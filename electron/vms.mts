// Virtual machines (din.system.vms, for the Virtual Machines app in
// src/apps/virtual-machines/), behind the `vms:*` channels.
//
// Plain QEMU with KVM, no libvirt: each machine is a folder in ~/VMs with its
// settings (vm.json), its disk (disk.qcow2), and for UEFI its firmware's
// variables (vars.qcow2, qcow2 so live snapshots can include them), for a
// TPM swtpm's state (tpm/), and for macOS its boot loader (opencore/). The
// folder is the whole machine, to copy or back up.
//
// A running machine is a qemu-system-x86_64 in a transient unit of the
// user's systemd (din-vm-<uuid>, and din-vm-<uuid>-tpm for its swtpm), so it
// inherits none of Electron's descriptors, with its sockets in $XDG_RUNTIME_DIR/din-vms/<uuid>/: QMP, which this
// module drives it over, VNC, which the app's console speaks (the bytes go
// to and from the app over its bridge port, since apps can't open sockets),
// swtpm's, and a pidfile. Machines keep running when the app closes, and
// when Din restarts this module finds them again by their pidfiles.
//
// Windows works out of the box: Windows machines get a SATA disk and an
// e1000e network card, which its installer has drivers for, Hyper-V
// enlightenments, a TPM 2.0 and Secure Boot with Microsoft's keys (OVMF's
// OVMF_VARS.ms.fd). Linux gets virtio, and the screen follows the window's
// size. macOS gets what a Mac would have: an Intel CPU (whatever the host's
// is), Apple's SMC (QEMU's applesmc), USB input, and OpenCore to start it
// from a FAT drive QEMU makes of opencore/. The clipboard is shared over
// QEMU's vdagent wherever the guest runs spice-vdagent.
//
// Snapshots are qcow2's internal ones: savevm/loadvm while running (which
// keep memory too), qemu-img while off. Types are src/lib/vms.ts. Runs as
// TypeScript directly via Node's native type stripping - erasable syntax
// only, like the rest of electron/.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { trash } from './files.mts';
import {
  download,
  forgetPartial,
  installer,
  INSTALLERS,
  INSTALLERS_DIR,
  MACOS_COMMAND,
  MACOS_FAILED,
  MACOS_SCREEN,
  MACOS_STARTED,
  openCoreReady,
  prepareLinux,
  prepareMacos,
  prepareOpenCore,
  prepareWindows,
  pruneDownloads,
  syncOpenCoreScreen,
  WINDOWS_READY,
  type InstallBoot,
} from './vm-installers.mts';
import type {
  NewVm,
  VmConfig,
  VmInfo,
  VmInstall,
  VmInstallerId,
  VmInstallOptions,
  VmOs,
  VmPortForward,
  VmSnapshot,
  VmsStatus,
  VmState,
} from '../src/lib/vms.ts';

const run = promisify(execFile);

interface Deps {
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}

let deps: Deps | null = null;

const VMS_DIR = path.join(os.homedir(), 'VMs');
const RUN_ROOT = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `din-${process.getuid?.() ?? 0}`), 'din-vms');

const MAX_MEMORY_MIB = 1024 * 1024;
const MAX_DISK_GIB = 64 * 1024;
const SNAPSHOT_NAME = /^[^\s"\\][^"\\\n\r\t]{0,62}[^\s"\\]$|^[^\s"\\]$/;
const VM_NAME = /^[^/\0.][^/\0]{0,63}$/;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 8_000;
const QMP_HANDSHAKE_MS = 3_000;

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

interface Firmware {
  /** Secure Boot-capable code, which needs SMM. */
  code: string;
  /** Empty variables: Secure Boot off. */
  vars: string;
  /** Variables with Microsoft's keys enrolled: Secure Boot on. Null where there are none. */
  varsMs: string | null;
}

interface Tools {
  qemu: string | null;
  qemuImg: string | null;
  swtpm: string | null;
  firmware: Firmware | null;
  kvm: boolean;
}

function which(command: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function existing(file: string | undefined): string | null {
  return file && fs.existsSync(file) ? file : null;
}

/**
 * OVMF, as DinOS names it (DIN_OVMF, nixpkgs' OVMF.fd/FV) and as other
 * distros package it: Secure Boot-capable code, empty variables, and
 * variables with Microsoft's keys.
 */
function findFirmware(): Firmware | null {
  const candidates: [string, string, string, string | null][] = [
    ...(process.env.DIN_OVMF ? [[process.env.DIN_OVMF, 'OVMF_CODE.fd', 'OVMF_VARS.fd', 'OVMF_VARS.ms.fd'] as [string, string, string, string]] : []),
    ['/usr/share/OVMF', 'OVMF_CODE_4M.secboot.fd', 'OVMF_VARS_4M.fd', 'OVMF_VARS_4M.ms.fd'],
    ['/usr/share/edk2/ovmf', 'OVMF_CODE.secboot.fd', 'OVMF_VARS.fd', 'OVMF_VARS.secboot.fd'],
    ['/usr/share/edk2/x64', 'OVMF_CODE.secboot.4m.fd', 'OVMF_VARS.4m.fd', null],
    ['/usr/share/qemu', 'edk2-x86_64-secure-code.fd', 'edk2-i386-vars.fd', null],
  ];
  for (const [dir, code, vars, varsMs] of candidates) {
    const c = existing(path.join(dir, code));
    const v = existing(path.join(dir, vars));
    if (c && v) return { code: c, vars: v, varsMs: varsMs ? existing(path.join(dir, varsMs)) : null };
  }
  return null;
}

let tools: Tools | null = null;

function getTools(): Tools {
  if (tools) return tools;
  let kvm = false;
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
    kvm = true;
  } catch {
    // No KVM, or not ours.
  }
  const found: Tools = {
    qemu: existing(process.env.DIN_QEMU) ?? which('qemu-system-x86_64'),
    qemuImg: existing(process.env.DIN_QEMU_IMG) ?? which('qemu-img'),
    swtpm: existing(process.env.DIN_SWTPM) ?? which('swtpm'),
    firmware: findFirmware(),
    kvm,
  };
  // Found once; missing things are looked for again, in case they're installed meanwhile.
  if (found.qemu && found.qemuImg && found.swtpm && found.firmware && found.kvm) tools = found;
  return found;
}

function status(): VmsStatus {
  const t = getTools();
  const missing: string[] = [];
  if (!t.qemu || !t.qemuImg) missing.push('QEMU');
  if (!t.kvm) missing.push('KVM (/dev/kvm)');
  return {
    available: missing.length === 0,
    missing,
    optionalFeature: (!t.qemu || !t.qemuImg) && Boolean(process.env.DIN_FEATURES),
    secureBoot: !!t.firmware?.varsMs,
    tpm: !!t.swtpm,
    dir: VMS_DIR,
    hostMemoryMiB: Math.floor(os.totalmem() / 1024 / 1024),
    hostCpus: os.availableParallelism(),
    installers: Object.keys(INSTALLERS) as VmInstallerId[],
  };
}

function need<T>(tool: T | null, name: string): T {
  if (!tool) throw new Error(`${name} isn’t installed.`);
  return tool;
}

async function qemuImg(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run(need(getTools().qemuImg, 'QEMU'), args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr ? stderr.replace(/^qemu-img:\s*/, '') : String(error), { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Machines on disk
// ---------------------------------------------------------------------------

/** A system Din is installing on the machine, kept in vm.json so it carries on after a restart. */
interface StoredInstall {
  installer: VmInstallerId;
  label: string;
  /** Getting the disc image ready, then the installer running in the machine. */
  step: 'download' | 'install';
  /** A disc image of the user's to install from, instead of downloading. */
  iso: string | null;
  /** The download's name in ~/VMs/.installers, once it's known. */
  download: string | null;
  /** How the installer starts, while it runs. */
  boot: InstallBoot | null;
  error: string | null;
}

interface StoredConfig extends VmConfig {
  version: 1;
  /** Stable for the machine's life: QEMU's -uuid (Windows' activation keys to it) and its run directory. */
  uuid: string;
  created: number;
  install?: StoredInstall;
  /** macOS: the TSC's rate it was first started with, which QEMU needs to save it running (it tells macOS the TSC is invariant). */
  tscHz?: number;
}

const dirOf = (id: string) => path.join(VMS_DIR, id);

/**
 * Make ~/VMs, without copy-on-write on Btrfs: disks rewritten in small pieces
 * fragment and write several times over under it. Only files made after the
 * flag is set get it, so it's set every time, for a folder made before.
 * Compression, which home's files inherit, can't go with it, so it goes
 * first: Btrfs refuses both in one call.
 * Elsewhere chattr refuses, and nothing changes.
 */
async function makeVmsDir(): Promise<void> {
  await fsp.mkdir(VMS_DIR, { recursive: true });
  await run('chattr', ['-c', VMS_DIR])
    .then(() => run('chattr', ['+C', VMS_DIR]))
    .catch(() => {});
}
const configPath = (id: string) => path.join(dirOf(id), 'vm.json');
const diskPath = (id: string) => path.join(dirOf(id), 'disk.qcow2');
const varsPath = (id: string) => path.join(dirOf(id), 'vars.qcow2');
const tpmDir = (id: string) => path.join(dirOf(id), 'tpm');
const logPath = (id: string) => path.join(dirOf(id), 'qemu.log');
/** The installer's kernel and answer file, while it's being installed. */
const installDir = (id: string) => path.join(dirOf(id), 'install');
const openCoreDir = (id: string) => path.join(dirOf(id), 'opencore');
const runDir = (config: StoredConfig) => path.join(RUN_ROOT, config.uuid);

function requireId(id: unknown): string {
  if (typeof id !== 'string' || !VM_NAME.test(id) || !fs.existsSync(configPath(id))) throw new Error('No such virtual machine.');
  return id;
}

async function readConfig(id: string): Promise<StoredConfig> {
  const raw = JSON.parse(await fsp.readFile(configPath(id), 'utf8')) as Partial<StoredConfig>;
  // Its name is its folder's.
  const config = { ...cleanConfig(raw as Partial<VmConfig>, { name: id, os: 'other' }), name: id, version: 1, uuid: '', created: 0 } as StoredConfig;
  config.uuid = typeof raw.uuid === 'string' && /^[0-9a-f-]{36}$/.test(raw.uuid) ? raw.uuid : randomUUID();
  config.created = typeof raw.created === 'number' ? raw.created : Date.now();
  if (typeof raw.tscHz === 'number' && Number.isInteger(raw.tscHz) && raw.tscHz > 0) config.tscHz = raw.tscHz;
  const install = cleanInstall(raw.install);
  if (install) config.install = install;
  if (config.uuid !== raw.uuid) await writeConfig(id, config);
  return config;
}

function cleanInstall(value: unknown): StoredInstall | null {
  const raw = (value ?? null) as Partial<StoredInstall> | null;
  if (!raw || typeof raw.installer !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const boot = raw.boot as Partial<InstallBoot> | null | undefined;
  return {
    installer: raw.installer,
    label: str(raw.label) ?? '',
    step: raw.step === 'install' ? 'install' : 'download',
    iso: cleanPath(raw.iso),
    download: str(raw.download),
    boot:
      boot &&
      [boot.seedDir, boot.seedLabel].every((v) => typeof v === 'string') &&
      [boot.kernel, boot.initrd, boot.append, boot.disk].every((v) => v === undefined || typeof v === 'string')
        ? (boot as InstallBoot)
        : null,
    error: str(raw.error),
  };
}

async function writeConfig(id: string, config: StoredConfig): Promise<void> {
  const file = configPath(id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2) + '\n');
  await fsp.rename(tmp, file);
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}

function cleanForwards(value: unknown): VmPortForward[] {
  if (!Array.isArray(value)) return [];
  const forwards: VmPortForward[] = [];
  for (const f of value.slice(0, 64)) {
    const { protocol, host, guest } = (f ?? {}) as Partial<VmPortForward>;
    if (protocol !== 'tcp' && protocol !== 'udp') continue;
    if (!Number.isInteger(host) || !Number.isInteger(guest)) continue;
    if ((host as number) < 1 || (host as number) > 65535 || (guest as number) < 1 || (guest as number) > 65535) continue;
    forwards.push({ protocol, host: host as number, guest: guest as number });
  }
  return forwards;
}

function cleanPath(value: unknown): string | null {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null;
  return path.resolve(value);
}

/** A whole config from whatever was given, with `base` for what's missing. */
function cleanConfig(input: Partial<VmConfig>, base: Pick<VmConfig, 'name' | 'os'> & Partial<VmConfig>): VmConfig {
  const pick = <K extends keyof VmConfig>(key: K): unknown => (input[key] !== undefined ? input[key] : base[key]);
  const osValue = pick('os');
  const firmware = pick('firmware') === 'bios' ? 'bios' : 'uefi';
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 64) : base.name,
    os: osValue === 'windows' || osValue === 'macos' || osValue === 'linux' ? osValue : 'other',
    system: (['windows', 'macos', 'ubuntu', 'fedora'] as unknown[]).includes(pick('system')) ? (pick('system') as VmInstallerId) : null,
    memoryMiB: int(pick('memoryMiB'), 128, MAX_MEMORY_MIB, 2048),
    cpus: int(pick('cpus'), 1, 256, 2),
    firmware,
    secureBoot: firmware === 'uefi' && pick('secureBoot') === true,
    tpm: pick('tpm') === true,
    cdrom: cleanPath(pick('cdrom')),
    network: pick('network') !== false,
    forwards: cleanForwards(pick('forwards')),
    audio: pick('audio') !== false,
  };
}

/** The disk's virtual size, from its qcow2 header (bytes 24-31, big-endian). */
async function diskSize(id: string): Promise<{ size: number; used: number }> {
  try {
    const handle = await fsp.open(diskPath(id), 'r');
    try {
      const header = Buffer.alloc(32);
      await handle.read(header, 0, 32, 0);
      const stat = await handle.stat();
      const size = header.readUInt32BE(0) === 0x514649fb ? Number(header.readBigUInt64BE(24)) : stat.size;
      return { size, used: stat.blocks * 512 };
    } finally {
      await handle.close();
    }
  } catch {
    return { size: 0, used: 0 };
  }
}

async function ids(): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(VMS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && VM_NAME.test(e.name) && fs.existsSync(configPath(e.name)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

async function info(id: string): Promise<VmInfo> {
  const config = await readConfig(id);
  const running = machines.get(id);
  const { size, used } = await diskSize(id);
  // A live snapshot's memory is often kept in the firmware's variables.
  const varsUsed = await fsp.stat(varsPath(id)).then((s) => s.blocks * 512, () => 0);
  const { version: _v, uuid: _u, created: _c, install: _i, tscHz: _t, ...shown } = config;
  return {
    id,
    dir: dirOf(id),
    config: shown,
    state: running?.state ?? 'stopped',
    diskSizeBytes: size,
    diskUsedBytes: used + varsUsed,
    changesPending: !!running && JSON.stringify(hardware(running.config)) !== JSON.stringify(hardware(config)),
    error: errors.get(id) ?? null,
    install: installInfo(id, config, used),
  };
}

function installInfo(id: string, config: StoredConfig, diskUsed: number): VmInstall | null {
  const stored = config.install;
  if (!stored) return null;
  const live = installing.get(id);
  let installedBytes = 8 * 1024 ** 3;
  let manualUrl = '';
  try {
    ({ installedBytes, manualUrl } = installer(stored.installer));
  } catch {
    // One this version of Din doesn't know.
  }
  return {
    installer: stored.installer,
    label: stored.label,
    phase: stored.error ? 'failed' : stored.step === 'install' ? 'installing' : (live?.phase ?? 'resolving'),
    receivedBytes: live?.received ?? 0,
    totalBytes: live?.total ?? 0,
    // The disk filling is the best sign of how far along it is; done is the installer turning the machine off.
    progress: stored.step === 'install' ? Math.min(0.97, diskUsed / installedBytes) : 0,
    error: stored.error,
    manualUrl,
  };
}

/** What a restart would change (the CD drive changes live, the name doesn't matter). */
function hardware(config: StoredConfig): unknown {
  const { name: _n, cdrom: _c, install: _i, ...rest } = config;
  return rest;
}

async function list(): Promise<VmInfo[]> {
  await rediscover();
  const out: VmInfo[] = [];
  for (const id of await ids()) {
    try {
      out.push(await info(id));
    } catch (error) {
      console.error(`vms: reading ${id} failed`, error);
    }
  }
  return out;
}

let changedTimer: NodeJS.Timeout | null = null;

/** Tell the app, soon, that something changed. */
function changed(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    void list().then((vms) => deps?.sendToShell('vms:changed', vms));
  }, 50);
}

async function create(input: unknown): Promise<VmInfo> {
  const raw = (input ?? {}) as Partial<NewVm>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!VM_NAME.test(name)) throw new Error('Give it a name without slashes that doesn’t start with a dot.');
  const t = getTools();
  need(t.qemuImg, 'QEMU');
  const config: StoredConfig = {
    ...cleanConfig(raw, { name, os: 'other' }),
    name,
    version: 1,
    uuid: randomUUID(),
    created: Date.now(),
  };
  if (config.firmware === 'uefi' && !t.firmware) throw new Error('UEFI firmware (OVMF) isn’t installed.');
  if (config.secureBoot && !t.firmware?.varsMs) config.secureBoot = false;
  const diskGiB = int(raw.diskGiB, 1, MAX_DISK_GIB, 32);

  await makeVmsDir();
  const dir = dirOf(name);
  try {
    await fsp.mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`There’s already a machine called “${name}”.`, { cause: error });
    throw error;
  }
  try {
    await qemuImg('create', '-q', '-f', 'qcow2', diskPath(name), `${diskGiB}G`);
    if (config.firmware === 'uefi') await makeVars(name, config);
    if (config.tpm) await fsp.mkdir(tpmDir(name), { mode: 0o700 });
    await writeConfig(name, config);
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw error;
  }
  changed();
  return info(name);
}

/** Fresh firmware variables: Microsoft's keys for Secure Boot, else none. */
async function makeVars(id: string, config: VmConfig): Promise<void> {
  const firmware = need(getTools().firmware, 'UEFI firmware (OVMF)');
  const source = config.secureBoot && firmware.varsMs ? firmware.varsMs : firmware.vars;
  await fsp.rm(varsPath(id), { force: true });
  await qemuImg('convert', '-q', '-f', 'raw', '-O', 'qcow2', source, varsPath(id));
}

async function update(id: string, patch: unknown): Promise<VmInfo> {
  const config = await readConfig(id);
  const p = (patch ?? {}) as Partial<VmConfig>;
  const next: StoredConfig = { ...config, ...cleanConfig(p, config) };
  const running = machines.has(id);
  let target = id;

  if (typeof p.name === 'string' && p.name.trim() !== config.name) {
    const name = p.name.trim();
    if (!VM_NAME.test(name)) throw new Error('Give it a name without slashes that doesn’t start with a dot.');
    if (running) throw new Error('Turn it off to rename it.');
    if (config.install) throw new Error('Rename it once it’s installed.');
    if (fs.existsSync(dirOf(name)) && dirOf(name).toLowerCase() !== dirOf(id).toLowerCase()) {
      throw new Error(`There’s already a machine called “${name}”.`);
    }
    await fsp.rename(dirOf(id), dirOf(name));
    target = name;
    next.name = name;
  }

  const firmwareChanged = next.firmware !== config.firmware || next.secureBoot !== config.secureBoot;
  if (firmwareChanged) {
    if (running) throw new Error('Turn it off to change its firmware.');
    if (next.secureBoot && !getTools().firmware?.varsMs) throw new Error('Secure Boot’s keys aren’t installed.');
    if (next.firmware === 'uefi') await makeVars(target, next);
    else await fsp.rm(varsPath(target), { force: true });
  }
  if (next.tpm) await fsp.mkdir(tpmDir(target), { recursive: true, mode: 0o700 });

  // The CD drive changes now, if it's running.
  if (next.cdrom !== config.cdrom && running) await changeMedium(target, next.cdrom);

  await writeConfig(target, next);
  changed();
  return info(target);
}

async function remove(id: string): Promise<void> {
  if (machines.has(id)) throw new Error('Turn it off first.');
  installing.get(id)?.abort.abort();
  await trash(dirOf(id));
  errors.delete(id);
  changed();
}

async function resizeDisk(id: string, gib: unknown): Promise<void> {
  if (machines.has(id)) throw new Error('Turn it off to resize its disk.');
  const size = int(gib, 1, MAX_DISK_GIB, 0);
  const { size: current } = await diskSize(id);
  if (!size || size * 1024 ** 3 <= current) throw new Error('A disk can only grow.');
  await qemuImg('resize', '-q', diskPath(id), `${size}G`);
  changed();
}

// ---------------------------------------------------------------------------
// QEMU's command line
// ---------------------------------------------------------------------------

/** QEMU's options for a string inside a comma-separated list: commas doubled. */
const opt = (value: string) => value.replace(/,/g, ',,');

/** The hardware each OS gets. */
const DEVICES: Record<VmOs, { disk: string; nic: string; vga: string }> = {
  windows: { disk: 'ide-hd,bus=ide.0', nic: 'e1000e', vga: 'VGA,vgamem_mb=64' },
  // An SSD on SATA, so macOS TRIMs it; and the screen OpenCore picks (vm-installers).
  macos: {
    disk: 'ide-hd,bus=ide.0,rotation_rate=1',
    nic: 'virtio-net-pci',
    vga: `VGA,vgamem_mb=64,xres=${MACOS_SCREEN.width},yres=${MACOS_SCREEN.height}`,
  },
  linux: { disk: 'virtio-blk-pci', nic: 'virtio-net-pci', vga: 'virtio-vga' },
  other: { disk: 'ide-hd,bus=ide.0', nic: 'e1000', vga: 'VGA,vgamem_mb=64' },
};

/**
 * The CPU macOS gets: an Intel one, on AMD hosts too, with the TSC's rate
 * given so QEMU can save it running though macOS is told the TSC is
 * invariant (+invtsc), and that rate in VMware's CPUID leaf, where
 * OpenCore reads it.
 */
const macosCpu = (tscHz: number) => `Skylake-Client,-hle,-rtm,-pcid,kvm=on,vendor=GenuineIntel,+invtsc,tsc-frequency=${tscHz},vmware-cpuid-freq=on`;

/** What a Mac's SMC answers when macOS asks for its key; macOS won't start without it. */
const APPLE_SMC_KEY = 'ourhardworkbythesewordsguardedpleasedontsteal(c)AppleComputerInc';

function qemuArgs(id: string, config: StoredConfig, rundir: string, loadvm: string | null): string[] {
  const t = getTools();
  const devices = DEVICES[config.os];
  const windows = config.os === 'windows';
  const mac = config.os === 'macos';
  const args = [
    '-name', opt(config.name),
    '-uuid', config.uuid,
    '-machine', `q35,accel=kvm${config.firmware === 'uefi' ? ',smm=on' : ''}`,
    '-cpu', windows ? 'host,hv_relaxed,hv_vapic,hv_spinlocks=0x1fff,hv_vpindex,hv_runtime,hv_synic,hv_stimer,hv_time,hv_frequencies' : mac ? macosCpu(config.tscHz ?? 0) : 'host',
    '-smp', mac ? `${config.cpus},sockets=1,cores=${config.cpus},threads=1` : String(config.cpus),
    '-m', `${config.memoryMiB}M`,
    '-nodefaults',
    '-no-user-config',
  ];
  if (mac) args.push('-device', `isa-applesmc,osk=${APPLE_SMC_KEY}`, '-smbios', 'type=2');
  if (config.firmware === 'uefi') {
    const firmware = need(t.firmware, 'UEFI firmware (OVMF)');
    args.push(
      '-global', 'driver=cfi.pflash01,property=secure,value=on',
      '-drive', `if=pflash,format=raw,unit=0,readonly=on,file=${opt(firmware.code)}`,
      '-drive', `if=pflash,format=qcow2,unit=1,file=${opt(varsPath(id))}`,
    );
  }
  if (config.tpm) {
    args.push(
      '-chardev', `socket,id=chrtpm,path=${opt(path.join(rundir, 'swtpm.sock'))}`,
      '-tpmdev', 'emulator,id=tpm0,chardev=chrtpm',
      '-device', 'tpm-crb,tpmdev=tpm0',
    );
  }
  // An installer's kernel (-kernel), or OpenCore, takes the first place to start from itself.
  const boot = config.install?.step === 'install' ? config.install.boot : null;
  const first = boot?.kernel || mac ? 1 : 0;
  args.push(
    '-drive', `if=none,id=disk0,format=qcow2,discard=unmap,file=${opt(diskPath(id))}`,
    // The disk first: one with nothing on it yet falls through to the CD.
    '-device', `${devices.disk},drive=disk0,bootindex=${first}`,
    '-drive', `if=none,id=cd0,media=cdrom,readonly=on${config.cdrom ? `,format=raw,file=${opt(config.cdrom)}` : ''}`,
    '-device', `ide-cd,drive=cd0,bus=ide.1,id=cd0dev,bootindex=${first + 1}`,
  );
  if (config.network) {
    const forwards = config.forwards.map((f) => `,hostfwd=${f.protocol}:127.0.0.1:${f.host}-:${f.guest}`).join('');
    args.push('-netdev', `user,id=net0${forwards}`, '-device', `${devices.nic},netdev=net0`);
  }
  args.push(
    '-device', devices.vga,
    // Ports enough for every USB device without a hub, behind which macOS sometimes misses the tablet.
    '-device', `qemu-xhci,id=xhci${mac ? ',p2=8,p3=8' : ''}`,
    '-device', 'usb-tablet,bus=xhci.0',
  );
  if (mac) {
    args.push(
      // macOS has no PS/2 driver.
      '-device', 'usb-kbd,bus=xhci.0',
      '-blockdev', JSON.stringify({ driver: 'vvfat', 'node-name': 'opencore', dir: openCoreDir(id), label: 'OPENCORE', 'read-only': true }),
      '-device', 'usb-storage,bus=xhci.0,drive=opencore,removable=on,bootindex=0',
    );
    if (boot?.disk) {
      // Recovery, on a disk of its own with its writes kept aside (it won't start read-only).
      const format = /\.dmg$/i.test(boot.disk) ? 'dmg' : 'raw';
      args.push('-drive', `if=none,id=recovery,format=${format},snapshot=on,file=${opt(boot.disk)}`, '-device', 'ide-hd,bus=ide.2,drive=recovery');
    }
  }
  if (!mac) {
    // Clipboard sharing, through spice-vdagent in the guest (macOS has none).
    args.push(
      '-chardev', 'qemu-vdagent,id=vdagent,name=vdagent,clipboard=on',
      '-device', 'virtio-serial-pci',
      '-device', 'virtserialport,chardev=vdagent,name=com.redhat.spice.0',
    );
  }
  args.push(
    '-device', 'virtio-balloon-pci',
    '-object', 'rng-random,id=rng0,filename=/dev/urandom',
    '-device', 'virtio-rng-pci,rng=rng0',
  );
  if (config.audio) {
    args.push('-audiodev', 'pipewire,id=snd0', '-device', 'ich9-intel-hda', '-device', 'hda-duplex,audiodev=snd0');
  }
  if (boot?.kernel) {
    // The installer's own kernel, told to install by itself from the answer
    // file on the FAT drive below. Its reboot at the end turns the machine
    // off instead, which is how Din hears it's done.
    args.push('-kernel', boot.kernel, '-initrd', boot.initrd ?? '', '-append', boot.append ?? '', '-action', 'reboot=shutdown');
  } else if (boot) {
    // Windows Setup, which restarts several times on its way, says it's done
    // on the first serial port (vm-installers' answer file), and Din's
    // script in macOS's Recovery says there how it's going.
    args.push('-chardev', `file,id=ser0,path=${opt(path.join(rundir, 'serial.log'))}`, '-device', 'isa-serial,chardev=ser0');
  }
  if (boot) {
    // The answer file, on a FAT drive QEMU makes from a folder.
    args.push(
      '-blockdev', JSON.stringify({ driver: 'vvfat', 'node-name': 'seed', dir: boot.seedDir, label: boot.seedLabel, 'read-only': true }),
      '-device', 'usb-storage,bus=xhci.0,drive=seed,removable=on,id=seeddev',
    );
  }
  if (windows) args.push('-rtc', 'base=localtime');
  args.push(
    '-display', 'none',
    '-vnc', `unix:${opt(path.join(rundir, 'vnc.sock'))}`,
    // Nothing connects to it: it's here for its steady 30 ms look at the
    // screen. QEMU looks for changes as often as its fastest display asks,
    // and VNC alone asks less and less often while the screen sits still
    // (up to 3 s), so the first change after a pause, the pointer moving
    // or what a click did, showed up to a step late: 420 ms for what the
    // guest drew in 250.
    '-spice', `unix=on,addr=${opt(path.join(rundir, 'refresh.sock'))},disable-ticketing=on`,
    '-qmp', `unix:${opt(path.join(rundir, 'qmp.sock'))},server=on,wait=off`,
    '-pidfile', path.join(rundir, 'qemu.pid'),
  );
  if (loadvm) args.push('-loadvm', loadvm);
  return args;
}

// ---------------------------------------------------------------------------
// QMP
// ---------------------------------------------------------------------------

type QmpReply = { return?: unknown; error?: { class: string; desc: string }; id?: number; event?: string };

/** QEMU's JSON control protocol over its socket: commands, and the events in between. */
class Qmp {
  private socket: net.Socket;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (event: string, data: unknown) => void = () => {};
  onClose: () => void = () => {};
  closed = false;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.message(line);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('The machine stopped.'));
      this.pending.clear();
      this.onClose();
    });
    socket.on('error', () => {});
  }

  /**
   * Connect and leave capability negotiation, retrying until `deadline`,
   * or until `alive` says the process has gone (resolving null).
   */
  static async connect(socketPath: string, deadline: number, alive: () => Promise<boolean> = async () => true): Promise<Qmp | null> {
    for (;;) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
        const qmp = new Qmp(socket);
        // QEMU serves one QMP client at a time: while another holds it, nothing answers.
        const timer = setTimeout(() => qmp.close(), QMP_HANDSHAKE_MS);
        try {
          await qmp.execute('qmp_capabilities');
        } finally {
          clearTimeout(timer);
        }
        return qmp;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        if (!(await alive())) return null;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  private message(line: string): void {
    let reply: QmpReply & { data?: unknown };
    try {
      reply = JSON.parse(line) as QmpReply & { data?: unknown };
    } catch {
      return;
    }
    if (reply.event) {
      this.onEvent(reply.event, reply.data);
      return;
    }
    if (typeof reply.id !== 'number') return;
    const p = this.pending.get(reply.id);
    if (!p) return;
    this.pending.delete(reply.id);
    if (reply.error) p.reject(new Error(reply.error.desc));
    else p.resolve(reply.return);
  }

  execute(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The machine isn’t running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(args ? { execute: command, arguments: args, id } : { execute: command, id }) + '\n');
    });
  }

  /** An HMP command; what it prints is an error when there's anything. */
  async human(commandLine: string): Promise<void> {
    const output = String((await this.execute('human-monitor-command', { 'command-line': commandLine })) ?? '').trim();
    if (output) throw new Error(output.replace(/^Error:\s*/, ''));
  }

  close(): void {
    this.socket.destroy();
  }
}

// ---------------------------------------------------------------------------
// Running machines
// ---------------------------------------------------------------------------

interface Machine {
  config: StoredConfig;
  state: VmState;
  qmp: Qmp | null;
  pid: number | null;
  /** Stops swtpm, when this module started it. */
  stopTpm: (() => void) | null;
  rundir: string;
  /** Asked to stop, so its exiting isn't an error. */
  stopping: boolean;
  /** Its power button was pressed, so its turning off isn't an installer finishing. */
  poweredDown: boolean;
  exited: Promise<void>;
  markExited: () => void;
}

const machines = new Map<string, Machine>();
/** Why each machine last stopped badly. */
const errors = new Map<string, string>();

function machine(id: string): Machine {
  const m = machines.get(id);
  if (!m || !m.qmp) throw new Error('It isn’t running.');
  return m;
}

function setState(m: Machine, state: VmState): void {
  if (m.state === state) return;
  m.state = state;
  changed();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function newMachine(config: StoredConfig, rundir: string): Machine {
  let markExited!: () => void;
  const exited = new Promise<void>((r) => (markExited = r));
  return { config, state: 'starting', qmp: null, pid: null, stopTpm: null, rundir, stopping: false, poweredDown: false, exited, markExited };
}

interface Launched {
  alive(): Promise<boolean>;
  stop(): void;
}

/**
 * Start a long-lived program of a machine's: as a transient unit of the
 * user's systemd (din-vm-<uuid>), so it inherits none of Electron's file
 * descriptors (its listening sockets among them) and lives in a cgroup of
 * its own, outliving a restart of Din's. Where there's no systemd user
 * manager, as a detached child. Its output goes to the end of `log`.
 */
async function launch(unit: string, argv: string[], log: string): Promise<Launched> {
  const systemdRun = which('systemd-run');
  const systemctl = which('systemctl');
  if (systemdRun && systemctl) {
    // The last run's unit lingers a moment after its process ends (QMP
    // closing tells us first), and its name can't be reused until it goes.
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      const { stdout } = await run(systemctl, ['--user', 'show', '-p', 'LoadState', '--value', `${unit}.service`]).catch(() => ({ stdout: 'not-found' }));
      if (stdout.trim() === 'not-found') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      await run(systemdRun, [
        '--user', '--collect', '--quiet', '--unit', unit,
        '-p', `StandardOutput=append:${log}`, '-p', 'StandardError=inherit',
        '--', ...argv,
      ]);
      return {
        alive: () =>
          run(systemctl, ['--user', 'is-active', '--quiet', unit]).then(
            () => true,
            () => false,
          ),
        stop: () => void run(systemctl, ['--user', 'stop', unit]).catch(() => {}),
      };
    } catch (error) {
      console.warn(`vms: systemd-run ${unit} failed; starting it directly`, error);
    }
  }
  const fd = fs.openSync(log, 'a');
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.unref();
  let done = false;
  child.once('exit', () => (done = true));
  child.once('error', () => (done = true));
  return { alive: async () => !done, stop: () => void (done || child.kill()) };
}

/** What QEMU last said in its log, for an error. */
async function logTail(id: string): Promise<string> {
  try {
    const text = await fsp.readFile(logPath(id), 'utf8');
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !/terminating on signal/.test(l));
    return lines.slice(-3).join('\n').replace(/qemu-system-x86_64:\s*/g, '');
  } catch {
    return '';
  }
}

/** Wire up a machine's QMP connection; its closing means it stopped. */
async function attach(id: string, m: Machine, qmp: Qmp): Promise<void> {
  m.qmp = qmp;
  qmp.onEvent = (event) => {
    if (event === 'STOP') setState(m, 'paused');
    else if (event === 'RESUME') setState(m, 'running');
    // Not POWERDOWN, the button being pressed: the guest may not listen.
    else if (event === 'SHUTDOWN') setState(m, 'stopping');
    else if (event === 'RESET') void installerRestarted(id, m);
  };
  qmp.onClose = () => void exited(id, m);
  const result = (await qmp.execute('query-status')) as { running?: boolean; status?: string };
  setState(m, result.running ? 'running' : 'paused');
}

async function exited(id: string, m: Machine): Promise<void> {
  if (machines.get(id) !== m) return;
  machines.delete(id);
  m.qmp?.close();
  // Not asked to stop, and not shut down by its guest (which says SHUTDOWN
  // first): it failed to start, or crashed, or was killed.
  const byGuest = !m.stopping && m.state === 'stopping';
  if (!m.stopping && m.state !== 'stopping') errors.set(id, (await logTail(id)) || 'It stopped unexpectedly.');
  for (const [conn, d] of displays) if (d.id === id) closeDisplay(conn);
  // swtpm ends with QEMU, unless QEMU never reached it.
  m.stopTpm?.();
  void fsp.rm(m.rundir, { recursive: true, force: true });
  m.markExited();
  changed();
  // An installer turning the machine off by itself is it finishing.
  if (byGuest && !m.poweredDown && m.config.install?.step === 'install' && m.config.install.boot?.kernel) void finishInstall(id);
}

/** Machines still running from before Din (re)started, found by their pidfiles. */
let rediscovered = false;
async function rediscover(): Promise<void> {
  if (rediscovered) return;
  rediscovered = true;
  for (const id of await ids()) {
    if (machines.has(id)) continue;
    let config: StoredConfig;
    try {
      config = await readConfig(id);
    } catch {
      continue;
    }
    const rundir = runDir(config);
    let pid: number;
    try {
      pid = Number.parseInt(await fsp.readFile(path.join(rundir, 'qemu.pid'), 'utf8'), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || !alive(pid)) continue;
    const m = newMachine(config, rundir);
    m.pid = pid;
    machines.set(id, m);
    try {
      const qmp = await Qmp.connect(path.join(rundir, 'qmp.sock'), Date.now() + 2000, async () => alive(pid));
      if (!qmp) throw new Error('It stopped.');
      await attach(id, m, qmp);
    } catch (error) {
      console.error(`vms: reconnecting to ${id} failed`, error);
      machines.delete(id);
    }
  }
}

/** The TSC's rate KVM gives a guest on this computer, from a QEMU that's started and quit at once. */
async function hostTscHz(qemu: string): Promise<number> {
  const child = spawn(qemu, ['-machine', 'q35,accel=kvm', '-cpu', 'host', '-S', '-nodefaults', '-display', 'none', '-qmp', 'stdio'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (out += chunk));
  child.stdin.end(
    [
      { execute: 'qmp_capabilities' },
      { execute: 'qom-get', arguments: { path: '/machine/unattached/device[0]', property: 'tsc-frequency' } },
      { execute: 'quit' },
    ].map((c) => JSON.stringify(c)).join('\n') + '\n',
  );
  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  for (const line of out.split('\n')) {
    try {
      const reply = JSON.parse(line) as { return?: unknown };
      if (typeof reply.return === 'number' && reply.return > 0) return reply.return;
    } catch {
      // Not JSON.
    }
  }
  throw new Error('QEMU didn’t say how fast this computer’s TSC is.');
}

async function waitForSocket(file: string, deadline: number): Promise<void> {
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('The TPM didn’t start.');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function start(id: string, loadvm: string | null = null): Promise<void> {
  await rediscover();
  if (machines.has(id)) throw new Error('It’s already running.');
  const t = getTools();
  const qemu = need(t.qemu, 'QEMU');
  if (!t.kvm) throw new Error('KVM isn’t available on this computer (/dev/kvm).');
  const config = await readConfig(id);
  if (config.install?.step === 'download') throw new Error('Its system is still being downloaded.');
  if (config.cdrom && !fs.existsSync(config.cdrom)) {
    throw new Error(`The disc image in its CD drive is gone: ${config.cdrom}. Eject it in Settings.`);
  }
  const rundir = runDir(config);
  await fsp.rm(rundir, { recursive: true, force: true });
  await fsp.mkdir(rundir, { recursive: true, mode: 0o700 });
  errors.delete(id);

  const m = newMachine(config, rundir);
  machines.set(id, m);
  changed();
  await fsp.writeFile(logPath(id), '');
  const unit = `din-vm-${config.uuid}`;
  let qemuProcess: Launched | null = null;
  try {
    if (config.os === 'macos') {
      if (config.firmware !== 'uefi') throw new Error('macOS needs UEFI firmware: turn it on in Settings.');
      if (!config.tscHz) {
        config.tscHz = await hostTscHz(qemu);
        await writeConfig(id, config);
      }
      // A machine made by hand gets its boot loader the first time it starts.
      if (!openCoreReady(openCoreDir(id))) await prepareOpenCore(openCoreDir(id), config.uuid, AbortSignal.timeout(5 * 60_000));
      else await syncOpenCoreScreen(openCoreDir(id));
    }
    if (config.tpm) {
      const swtpm = need(t.swtpm, 'swtpm (for the TPM)');
      await fsp.mkdir(tpmDir(id), { recursive: true, mode: 0o700 });
      const tpm = await launch(`${unit}-tpm`, [
        swtpm, 'socket', '--tpm2',
        '--tpmstate', `dir=${tpmDir(id)},mode=0600`,
        '--ctrl', `type=unixio,path=${path.join(rundir, 'swtpm.sock')}`,
        // It ends when QEMU lets go of it.
        '--terminate',
      ], logPath(id));
      m.stopTpm = tpm.stop;
      await waitForSocket(path.join(rundir, 'swtpm.sock'), Date.now() + 5000);
    }
    qemuProcess = await launch(unit, [qemu, ...qemuArgs(id, config, rundir, loadvm)], logPath(id));
    const qmp = await Qmp.connect(path.join(rundir, 'qmp.sock'), Date.now() + START_TIMEOUT_MS, qemuProcess.alive);
    if (!qmp) throw new Error((await logTail(id)) || 'It didn’t start.');
    try {
      m.pid = Number.parseInt(await fsp.readFile(path.join(rundir, 'qemu.pid'), 'utf8'), 10) || null;
    } catch {
      // Stopping falls back on QMP alone.
    }
    await attach(id, m, qmp);
    if (config.install?.step === 'install' && config.install.installer === 'windows') void pressAnyKey(m);
    if (config.install?.step === 'install' && config.install.installer === 'macos') void startMacosInstall(m);
  } catch (error) {
    if (machines.get(id) === m) {
      m.stopping = true;
      qemuProcess?.stop();
      void exited(id, m);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function shutdown(id: string): Promise<void> {
  const m = machine(id);
  m.poweredDown = true;
  if (m.state === 'paused') await m.qmp!.execute('cont');
  await m.qmp!.execute('system_powerdown');
}

async function forceStop(id: string): Promise<void> {
  const m = machines.get(id);
  if (!m) return;
  m.stopping = true;
  setState(m, 'stopping');
  try {
    await m.qmp?.execute('quit');
  } catch {
    // It went, or it's stuck; either way:
  }
  const timer = setTimeout(() => {
    if (m.pid && alive(m.pid)) process.kill(m.pid, 'SIGKILL');
  }, STOP_TIMEOUT_MS);
  // Its QMP closing is how we hear it's gone.
  await m.exited;
  clearTimeout(timer);
}

async function changeMedium(id: string, cdrom: string | null): Promise<void> {
  const m = machine(id);
  if (cdrom) {
    if (!fs.existsSync(cdrom)) throw new Error('That disc image doesn’t exist.');
    await m.qmp!.execute('blockdev-change-medium', { id: 'cd0dev', filename: cdrom, format: 'raw', 'read-only-mode': 'read-only' });
  } else {
    await m.qmp!.execute('eject', { id: 'cd0dev', force: true });
  }
}

async function setCdrom(id: string, file: unknown): Promise<void> {
  const cdrom = file === null ? null : cleanPath(file);
  if (file !== null && !cdrom) throw new Error('That isn’t a disc image.');
  const config = await readConfig(id);
  if (machines.has(id)) await changeMedium(id, cdrom);
  await writeConfig(id, { ...config, cdrom });
  changed();
}

// ---------------------------------------------------------------------------
// Installing a system by itself (electron/vm-installers.mts)
// ---------------------------------------------------------------------------

interface LiveInstall {
  phase: 'resolving' | 'downloading' | 'verifying';
  received: number;
  total: number;
  abort: AbortController;
}

/** Machines whose disc image is being fetched now. */
const installing = new Map<string, LiveInstall>();

async function writeInstall(id: string, patch: Partial<StoredInstall>): Promise<StoredConfig> {
  const config = await readConfig(id);
  if (!config.install) throw new Error('It isn’t being installed.');
  const next = { ...config, install: { ...config.install, ...patch } };
  await writeConfig(id, next);
  changed();
  return next;
}

/** A new machine, sized to this computer, with the system on it to come. */
async function install(which: unknown, options: unknown): Promise<VmInfo> {
  const info = installer(which);
  const opts = (options ?? {}) as VmInstallOptions;
  const iso = opts.iso === undefined ? null : cleanPath(opts.iso);
  if (opts.iso !== undefined && (!iso || !fs.existsSync(iso))) throw new Error('That disc image doesn’t exist.');
  const host = status();
  const taken = new Set((await ids()).map((n) => n.toLowerCase()));
  let name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim() : info.name;
  if (!(typeof opts.name === 'string' && opts.name.trim())) for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${info.name} ${n}`;
  const hw = info.hardware;
  const created = await create({
    name,
    os: hw.os,
    system: which as VmInstallerId,
    // Half of this computer, up to what the system makes good use of.
    memoryMiB: opts.memoryMiB ?? Math.max(hw.minMemoryMiB, Math.min(8192, Math.floor(host.hostMemoryMiB / 2 / 512) * 512)),
    cpus: opts.cpus ?? Math.max(1, Math.min(4, Math.floor(host.hostCpus / 2))),
    diskGiB: opts.diskGiB ?? hw.diskGiB,
    firmware: 'uefi',
    // What's missing, Windows' answer file tells Setup not to check for.
    secureBoot: hw.secureBoot && host.secureBoot,
    tpm: hw.tpm && host.tpm,
    cdrom: null,
    network: true,
    forwards: [],
    // macOS has no driver for QEMU's sound card.
    audio: hw.os !== 'macos',
  } satisfies NewVm);
  const config = await readConfig(created.id);
  config.install = { installer: which as VmInstallerId, label: info.name, step: 'download', iso, download: null, boot: null, error: null };
  await writeConfig(created.id, config);
  void runInstall(created.id);
  return (await list()).find((v) => v.id === created.id) ?? created;
}

/** Get the disc image (downloading it unless it's the user's), then start the installer. */
async function runInstall(id: string): Promise<void> {
  if (installing.has(id)) return;
  const live: LiveInstall = { phase: 'resolving', received: 0, total: 0, abort: new AbortController() };
  installing.set(id, live);
  changed();
  try {
    let config = await readConfig(id);
    const stored = config.install;
    if (!stored || stored.step !== 'download') return;
    const info = installer(stored.installer);
    let iso = stored.iso;
    if (!iso) {
      const release = await info.resolve();
      await writeInstall(id, { label: release.label, download: release.file.name });
      iso = await download(
        release.file,
        (phase, received, total) => {
          Object.assign(live, { phase, received, total });
          changed();
        },
        live.abort.signal,
      );
    }
    live.phase = 'verifying';
    changed();
    let boot: InstallBoot;
    if (stored.installer === 'macos') {
      await prepareOpenCore(openCoreDir(id), config.uuid, live.abort.signal);
      boot = await prepareMacos(iso, installDir(id));
    } else if (stored.installer === 'windows') {
      boot = await prepareWindows(iso, installDir(id));
    } else {
      boot = await prepareLinux(stored.installer, iso, installDir(id));
    }
    if (live.abort.signal.aborted) return;
    config = await readConfig(id);
    // macOS's recovery image goes in as a disk, not a disc.
    const cdrom = boot.disk ? config.cdrom : iso;
    await writeConfig(id, { ...config, cdrom, install: { ...config.install!, step: 'install', boot, error: null } });
    installing.delete(id);
    void keepOnlyUsedDownloads();
    await start(id);
  } catch (error) {
    if (live.abort.signal.aborted || !fs.existsSync(configPath(id))) return;
    console.error(`vms: installing ${id} failed`, error);
    await writeInstall(id, { error: error instanceof Error ? error.message : String(error) }).catch(() => {});
  } finally {
    if (installing.get(id) === live) installing.delete(id);
    changed();
  }
}

/** The installer turned the machine off: take the disc out and start the new system. */
async function finishInstall(id: string): Promise<void> {
  try {
    const config = await readConfig(id);
    delete config.install;
    await writeConfig(id, { ...config, cdrom: null });
    await fsp.rm(installDir(id), { recursive: true, force: true });
    void keepOnlyUsedDownloads();
    changed();
    await start(id);
  } catch (error) {
    console.error(`vms: finishing installing ${id} failed`, error);
    errors.set(id, error instanceof Error ? error.message : String(error));
    changed();
  }
}

async function retryInstall(id: string, options: unknown): Promise<void> {
  const config = await readConfig(id);
  if (!config.install) throw new Error('It isn’t being installed.');
  if (machines.has(id)) throw new Error('Turn it off first.');
  const opts = (options ?? {}) as VmInstallOptions;
  const iso = opts.iso === undefined ? config.install.iso : cleanPath(opts.iso);
  if (iso && !fs.existsSync(iso)) throw new Error('That disc image doesn’t exist.');
  await writeInstall(id, { step: 'download', iso, boot: null, error: null });
  void runInstall(id);
}

async function cancelInstall(id: string): Promise<void> {
  const config = await readConfig(id);
  if (!config.install) throw new Error('It isn’t being installed.');
  installing.get(id)?.abort.abort();
  if (machines.has(id)) await forceStop(id);
  // Nothing on it yet to keep.
  await fsp.rm(dirOf(id), { recursive: true, force: true });
  errors.delete(id);
  const name = config.install.download;
  if (name) {
    const others = await Promise.all((await ids()).map((other) => readConfig(other).then((c) => c.install?.download, () => null)));
    if (!others.includes(name)) forgetPartial(name);
  }
  changed();
}

/** Throw away downloads no machine is installing from, or has in its CD drive. */
async function keepOnlyUsedDownloads(): Promise<void> {
  const keep = new Set<string>();
  for (const id of await ids()) {
    const config = await readConfig(id).catch(() => null);
    if (config?.cdrom?.startsWith(INSTALLERS_DIR)) keep.add(config.cdrom);
    const disk = config?.install?.step === 'install' ? config.install.boot?.disk : undefined;
    if (disk?.startsWith(INSTALLERS_DIR)) keep.add(disk);
    if (config?.install?.download && config.install.step === 'download') keep.add(path.join(INSTALLERS_DIR, config.install.download));
  }
  await pruneDownloads(keep);
}

/**
 * Windows Setup is done (it said so on the serial port, at its first
 * logon), or macOS's installer has taken over from Din: take the disc and
 * answer drive out while it runs, and it's an ordinary machine.
 */
async function finishSaidInstall(id: string, m: Machine): Promise<void> {
  try {
    const config = await readConfig(id);
    delete config.install;
    await writeConfig(id, { ...config, cdrom: null });
    // The machine's own copy too, so its settings don't read as changed.
    delete m.config.install;
    m.config.cdrom = null;
    if (m.qmp) {
      await changeMedium(id, null).catch(() => {});
      await m.qmp.execute('device_del', { id: 'seeddev' }).catch(() => {});
    }
    await fsp.rm(installDir(id), { recursive: true, force: true });
    void keepOnlyUsedDownloads();
  } catch (error) {
    console.error(`vms: finishing installing ${id} failed`, error);
  }
  changed();
}

/**
 * Windows' disc says "Press any key to boot from CD or DVD" and gives up
 * after a few seconds: press Enter for it while the firmware gets there.
 * Once Windows is on the disk, the disk starts first and this goes unread.
 */
async function pressAnyKey(m: Machine): Promise<void> {
  for (const until = Date.now() + 25_000; Date.now() < until && m.qmp && !m.qmp.closed; ) {
    await m.qmp.execute('send-key', { keys: [{ type: 'qcode', data: 'ret' }] }).catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }
}

/**
 * Recovery has no answer file: once it's showing, open its Terminal
 * (Shift-Command-T) and, once the Terminal's window has appeared, type the
 * command that runs vm-installers' script, until the script says it's
 * begun. Nothing's typed into Recovery's own window, where Return would
 * choose what's selected. Once macOS's installer has started from the
 * disk, Recovery isn't shown again and nothing's typed.
 */
async function startMacosInstall(m: Machine): Promise<void> {
  const file = path.join(m.rundir, 'screen.ppm');
  const live = () => !!m.qmp && !m.qmp.closed;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let last: Screen | null = null;
  for (const until = Date.now() + 20 * 60_000; Date.now() < until && live(); ) {
    await sleep(5000);
    if (await macosBegun(m)) return;
    const before = await screenshot(m, file);
    // Recovery, and settled: nothing else is opening by itself.
    const settled = !!before && !!last && recoveryShowing(before) && !windowOpened(last, before);
    last = before;
    if (!before || !settled) continue;
    await sendKeys(m, ['shift', 'meta_l', 't']);
    await sleep(3000);
    const after = await screenshot(m, file);
    last = after;
    if (!after || !windowOpened(before, after)) continue;
    await typeText(m, `${MACOS_COMMAND}\n`);
    // The script says it's begun at once; the disk fills within a minute or two.
    await sleep(45_000);
    last = null;
  }
}

/**
 * Whether Din's script in Recovery has begun: it says so on the serial port,
 * or Apple's installer is filling the disk (an erased one holds a few MB).
 */
async function macosBegun(m: Machine): Promise<boolean> {
  if ((await fsp.readFile(path.join(m.rundir, 'serial.log'), 'latin1').catch(() => '')).includes(MACOS_STARTED)) return true;
  return (await diskSize(m.config.name)).used > 1024 ** 3;
}

/**
 * macOS's installer restarting the machine, once Din's script has begun, is
 * Apple's installer taking over: it goes on from the disk by itself, on the
 * screen, and ends at Setup Assistant, which is the user's to answer.
 */
async function installerRestarted(id: string, m: Machine): Promise<void> {
  const install = m.config.install;
  if (install?.step !== 'install' || install.installer !== 'macos' || finishing.has(id)) return;
  if (!(await macosBegun(m)) || finishing.has(id)) return;
  finishing.add(id);
  await finishSaidInstall(id, m).finally(() => finishing.delete(id));
}

interface Screen {
  width: number;
  height: number;
  /** RGB, a row at a time. */
  pixels: Buffer;
}

/** What's on the machine's screen now, from QEMU's screendump (a PPM). */
async function screenshot(m: Machine, file: string): Promise<Screen | null> {
  try {
    await m.qmp!.execute('screendump', { filename: file });
    const ppm = await fsp.readFile(file);
    const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.toString('latin1', 0, 32));
    if (!header) return null;
    return { width: Number(header[1]), height: Number(header[2]), pixels: ppm.subarray(header[0].length) };
  } catch {
    return null;
  } finally {
    void fsp.rm(file, { force: true });
  }
}

const pixelAt = (screen: Screen, x: number, y: number) => {
  const at = (y * screen.width + x) * 3;
  return [screen.pixels[at], screen.pixels[at + 1], screen.pixels[at + 2]];
};

/**
 * Whether Recovery's menu bar is up: light text at its left on a dark bar
 * (at either scale macOS draws it). Before, the screen is plain grey, or
 * black: OpenCore's text and the Apple logo are on black, and a key
 * pressed then would stop OpenCore at its menu.
 */
function recoveryShowing(screen: Screen): boolean {
  let light = 0;
  for (let y = 4; y < 48; y++) for (let x = 40; x < 480; x++) if (pixelAt(screen, x, y).every((c) => c > 200)) light++;
  let bar = 0;
  let samples = 0;
  for (let x = screen.width / 2; x < screen.width - 200; x += 8, samples++) bar += Math.max(...pixelAt(screen, x, 10));
  return light > 30 && bar / samples > 12 && bar / samples < 90;
}

/** Whether a window appeared between two screenshots: a good part of the screen changed. */
function windowOpened(before: Screen, after: Screen): boolean {
  if (before.width !== after.width || before.height !== after.height) return false;
  let changed = 0;
  let samples = 0;
  // Faint changes count: Terminal's window is translucent, dark over dark.
  for (let at = 0; at + 2 < before.pixels.length; at += 3 * 16, samples++) {
    const diff = [0, 1, 2].reduce((n, c) => n + Math.abs(before.pixels[at + c] - after.pixels[at + c]), 0);
    if (diff > 24) changed++;
  }
  return changed / samples > 0.05;
}

async function sendKeys(m: Machine, keys: string[]): Promise<void> {
  await m.qmp?.execute('send-key', { keys: keys.map((data) => ({ type: 'qcode', data })) }).catch(() => {});
}

const QCODES: Record<string, string> = { ' ': 'spc', '\n': 'ret', '/': 'slash', '.': 'dot', '-': 'minus' };

/** Type plain ASCII on a US keyboard, as macOS starts with. */
async function typeText(m: Machine, text: string): Promise<void> {
  for (const char of text) {
    const lower = char.toLowerCase();
    await sendKeys(m, [...(char !== lower ? ['shift'] : []), QCODES[lower] ?? lower]);
    await new Promise((r) => setTimeout(r, 40));
  }
}

const finishing = new Set<string>();

// While an installer runs, how far along it is (its disk filling) changes by
// itself; and Windows Setup may have said it's done, or macOS's script that
// it couldn't go on.
setInterval(() => {
  let busy = false;
  for (const [id, m] of machines) {
    const install = m.config.install;
    if (install?.step !== 'install' || m.state !== 'running') continue;
    busy = true;
    if (install.boot?.kernel || finishing.has(id)) continue;
    void fsp.readFile(path.join(m.rundir, 'serial.log'), 'utf8').then(
      (text) => {
        if (finishing.has(id)) return;
        const failed = new RegExp(`^${MACOS_FAILED} (.*)$`, 'm').exec(text);
        if (failed && install.installer === 'macos' && !install.error) {
          install.error = failed[1].trim();
          void writeInstall(id, { error: install.error }).catch(() => {});
        }
        if (install.installer === 'macos' || !text.includes(WINDOWS_READY)) return;
        finishing.add(id);
        void finishSaidInstall(id, m).finally(() => finishing.delete(id));
      },
      () => {},
    );
  }
  if (busy) changed();
}, 3000).unref();

/** Downloads cut off by Din stopping carry on. */
async function resumeInstalls(): Promise<void> {
  for (const id of await ids()) {
    const config = await readConfig(id).catch(() => null);
    if (config?.install?.step === 'download' && !config.install.error) void runInstall(id);
  }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

interface ImageSnapshot {
  name: string;
  'date-sec': number;
  'date-nsec': number;
  'vm-state-size': number;
}

async function imageSnapshots(file: string): Promise<ImageSnapshot[]> {
  if (!fs.existsSync(file)) return [];
  const json = JSON.parse(await qemuImg('info', '-U', '--output=json', file)) as { snapshots?: ImageSnapshot[] };
  return json.snapshots ?? [];
}

/** Snapshots on the disk, with the memory QEMU saved in whichever image it chose (often the firmware's variables). */
async function snapshots(id: string): Promise<VmSnapshot[]> {
  const [disk, vars] = await Promise.all([imageSnapshots(diskPath(id)), imageSnapshots(varsPath(id))]);
  const varsState = new Map(vars.map((s) => [s.name, s['vm-state-size']]));
  return disk
    .map((s) => ({
      name: s.name,
      date: s['date-sec'] * 1000 + Math.floor(s['date-nsec'] / 1e6),
      stateBytes: Math.max(s['vm-state-size'], varsState.get(s.name) ?? 0),
    }))
    .sort((a, b) => a.date - b.date);
}

function requireSnapshotName(name: unknown): string {
  if (typeof name !== 'string' || !SNAPSHOT_NAME.test(name)) throw new Error('Give the snapshot a name (without quotes or backslashes).');
  return name;
}

/** The images a snapshot lives in, while the machine's off. */
async function snapshotImages(id: string): Promise<string[]> {
  return fs.existsSync(varsPath(id)) ? [diskPath(id), varsPath(id)] : [diskPath(id)];
}

async function takeSnapshot(id: string, name: unknown): Promise<void> {
  const tag = requireSnapshotName(name);
  if ((await snapshots(id)).some((s) => s.name === tag)) throw new Error(`There’s already a snapshot called “${tag}”.`);
  const m = machines.get(id);
  if (m) {
    if (!m.qmp || m.state === 'starting' || m.state === 'stopping') throw new Error('Wait until it’s running.');
    await m.qmp.human(`savevm "${tag}"`);
  } else {
    for (const image of await snapshotImages(id)) await qemuImg('snapshot', '-c', tag, image);
  }
  changed();
}

async function restoreSnapshot(id: string, name: unknown): Promise<void> {
  const tag = requireSnapshotName(name);
  const snapshot = (await snapshots(id)).find((s) => s.name === tag);
  if (!snapshot) throw new Error('No such snapshot.');
  const m = machines.get(id);
  if (snapshot.stateBytes > 0) {
    // Taken running: it comes back running.
    if (m?.qmp && m.state !== 'starting') await m.qmp.human(`loadvm "${tag}"`);
    else await start(id, tag);
  } else {
    // Taken off: it's turned off, and its disks go back.
    if (m) await forceStop(id);
    for (const image of await snapshotImages(id)) {
      if ((await imageSnapshots(image)).some((s) => s.name === tag)) await qemuImg('snapshot', '-a', tag, image);
    }
  }
  changed();
}

async function deleteSnapshot(id: string, name: unknown): Promise<void> {
  const tag = requireSnapshotName(name);
  const m = machines.get(id);
  if (m?.qmp) {
    await m.qmp.human(`delvm "${tag}"`);
  } else {
    for (const image of await snapshotImages(id)) {
      if ((await imageSnapshots(image)).some((s) => s.name === tag)) await qemuImg('snapshot', '-d', tag, image);
    }
  }
  changed();
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

interface Display {
  id: string;
  socket: net.Socket;
  /** The bridge sender that opened it: only it may write, and it hears the bytes. */
  owner: Electron.WebContents;
}

const displays = new Map<number, Display>();
let nextDisplay = 1;
const MAX_DISPLAY_WRITE = 1024 * 1024;

async function openDisplay(id: string, owner: Electron.WebContents): Promise<number> {
  const m = machine(id);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection(path.join(m.rundir, 'vnc.sock'));
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  socket.setNoDelay(true);
  const conn = nextDisplay++;
  displays.set(conn, { id, socket, owner });
  socket.on('data', (chunk) => {
    if (owner.isDestroyed()) closeDisplay(conn);
    else owner.send('vms:display', conn, chunk);
  });
  socket.on('close', () => {
    if (!displays.has(conn)) return;
    displays.delete(conn);
    if (!owner.isDestroyed()) owner.send('vms:displayClosed', conn);
  });
  socket.on('error', () => {});
  return conn;
}

function closeDisplay(conn: number): void {
  const d = displays.get(conn);
  if (!d) return;
  displays.delete(conn);
  d.socket.destroy();
  if (!d.owner.isDestroyed()) d.owner.send('vms:displayClosed', conn);
}

// Screens whose windows went away without saying so.
setInterval(() => {
  for (const [conn, d] of displays) if (d.owner.isDestroyed()) closeDisplay(conn);
}, 10_000).unref();

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export function registerVmsHandlers(options: Deps): void {
  deps = options;
  const { assertShellSender } = options;

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertShellSender(event);
      return fn(...args);
    });
  };
  /** A channel acting on one machine, named by its first argument. */
  const handleVm = (channel: string, fn: (id: string, ...args: unknown[]) => unknown) =>
    handle(channel, async (id, ...args) => {
      await rediscover();
      return fn(requireId(id), ...args);
    });

  handle('vms:status', () => status());
  handle('vms:list', () => list());
  handle('vms:create', (input) => create(input));
  handle('vms:install', (which, options) => install(which, options));
  handleVm('vms:retryInstall', (id, options) => retryInstall(id, options));
  handleVm('vms:cancelInstall', (id) => cancelInstall(id));
  handleVm('vms:update', (id, patch) => update(id, patch));
  handleVm('vms:remove', (id) => remove(id));
  handleVm('vms:start', (id) => start(id));
  handleVm('vms:shutdown', (id) => shutdown(id));
  handleVm('vms:forceStop', (id) => forceStop(id));
  handleVm('vms:pause', (id) => machine(id).qmp!.execute('stop').then(() => undefined));
  handleVm('vms:resume', (id) => machine(id).qmp!.execute('cont').then(() => undefined));
  handleVm('vms:reset', (id) => machine(id).qmp!.execute('system_reset').then(() => undefined));
  handleVm('vms:setCdrom', (id, file) => setCdrom(id, file));
  handleVm('vms:resizeDisk', (id, gib) => resizeDisk(id, gib));
  handleVm('vms:snapshots', (id) => snapshots(id));
  handleVm('vms:takeSnapshot', (id, name) => takeSnapshot(id, name));
  handleVm('vms:restoreSnapshot', (id, name) => restoreSnapshot(id, name));
  handleVm('vms:deleteSnapshot', (id, name) => deleteSnapshot(id, name));

  ipcMain.handle('vms:openDisplay', async (event, id: unknown) => {
    assertShellSender(event);
    await rediscover();
    return openDisplay(requireId(id), event.sender);
  });
  ipcMain.on('vms:displayWrite', (event, conn: unknown, data: unknown) => {
    assertShellSender(event);
    const d = typeof conn === 'number' ? displays.get(conn) : undefined;
    if (!d || d.owner.id !== event.sender.id || !(data instanceof Uint8Array) || data.byteLength > MAX_DISPLAY_WRITE) return;
    d.socket.write(data);
  });
  ipcMain.on('vms:closeDisplay', (event, conn: unknown) => {
    assertShellSender(event);
    const d = typeof conn === 'number' ? displays.get(conn) : undefined;
    if (d && d.owner.id === event.sender.id) closeDisplay(conn as number);
  });

  void rediscover().then(() => {
    if (machines.size) changed();
    return resumeInstalls();
  });
}
