// Phones plugged in by USB, as places in Files: an Android phone's storage
// over MTP, an iPhone's photos and media over AFC. The volumes bridge
// (electron/volumes.mts) lists them with the disks, so Files' sidebar, its
// notifications and `din disks` treat them the same way.
//
// Neither is a disk udisks knows, so each is mounted with a FUSE filesystem
// under $XDG_RUNTIME_DIR/phones/<name>, where Files (and everything else)
// sees ordinary folders: jmtpfs for Android (libmtp), ifuse for iPhones
// (libimobiledevice, through usbmuxd). Ejecting unmounts it with fusermount.
//
// USB devices are read from sysfs, and again whenever `udevadm monitor`
// reports a USB device coming or going. One is:
//   - an iPhone (Apple's vendor id, a product that says iPhone, iPad or
//     iPod): usbmuxd pairs it as it's plugged in, which the phone allows only
//     unlocked, once the user taps Trust. Until then it's listed as needing
//     that, and pairing is checked again every few seconds.
//   - an Android phone with MTP on (udev's ID_MTP_DEVICE, from libmtp's
//     rules): mounted straight away. A locked phone lists no storage, so an
//     empty mount is undone and the phone listed as needing unlocking.
//   - an Android phone without it (a phone maker's vendor id, and nothing on
//     it a keyboard, a disk or a hub would have): charging only, Android's
//     default, so it's listed as needing File transfer chosen on the phone.
// Each phone gets one decision when it's plugged in, like a disk: it's
// mounted as soon as it can be, and once ejected it's left alone until it's
// plugged in again (or opened from Files).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Volume, VolumeEvent } from './volumes.mts';

const SYSFS_USB = '/sys/bus/usb/devices';
const APPLE = '05ac';
/**
 * Phone makers' USB vendor ids, for telling a phone that's only charging.
 * Only makers whose ids aren't also on modems, network adapters and docks.
 */
const ANDROID_VENDORS = new Set([
  '18d1', // Google
  '04e8', // Samsung
  '22b8', // Motorola
  '2a70', // OnePlus
  '2717', // Xiaomi
  '0fce', // Sony
  '1004', // LG
  '0bb4', // HTC
  '22d9', // OPPO
  '2d95', // vivo
  '2a45', // Meizu
  '2b4c', // Nothing
  '1ebf', // Fairphone
  '29a9', // Fairphone
  '1bbb', // TCL / Alcatel
  '2e04', // HMD (Nokia)
]);
/**
 * Interface classes a phone that's only charging never has: audio, network,
 * HID, printer, storage, hub, CDC data, smart card, video, audio/video,
 * wireless (Bluetooth, RNDIS).
 */
const NOT_A_PHONE = new Set(['01', '02', '03', '07', '08', '09', '0a', '0b', '0e', '10', 'e0']);

const RESCAN_DELAY_MS = 300;
const POLL_MS = 3000;
const RETRY_MS = 3000;
/** How often (in retries) an unpaired iPhone is asked to pair again, rather than checked. */
const PAIR_EVERY = 3;
const COMMAND_TIMEOUT_MS = 30_000;
const MOUNT_TIMEOUT_MS = 60_000;

const FILE_TRANSFER = 'On the phone, choose File transfer in its USB notification.';
const UNLOCK_ANDROID = 'Unlock the phone to open it.';
const TRUST_IPHONE = 'Unlock the iPhone and tap Trust.';
const DENIED_IPHONE = 'Unplug the iPhone, plug it in again, then tap Trust.';
const NO_TOOLS = 'This computer can’t open phones.';

type PhoneKind = 'android' | 'iphone';

interface UsbDevice {
  sysname: string;
  vendor: string;
  product: string;
  manufacturer: string;
  serial: string;
  busnum: number;
  devnum: number;
  mtp: boolean;
  kind: PhoneKind | null;
}

interface UsbPhone {
  id: string;
  kind: PhoneKind;
  name: string;
  device: UsbDevice;
  mountPoint: string | null;
  needs: string | null;
  busy: 'mounting' | 'ejecting' | null;
  /** Ejected: not mounted again until it's plugged in again or opened. */
  ejected: boolean;
  /** The iPhone's UDID, once usbmuxd has it. */
  udid: string | null;
  /** The mount in progress, which a second open waits on. */
  mounting: Promise<string> | null;
  retry: NodeJS.Timeout | null;
  attempts: number;
  /** Told the user it's waiting on them, for this `needs`. */
  told: string | null;
}

const phones = new Map<string, UsbPhone>();
let onChanged: () => void = () => {};
let announce: (event: VolumeEvent) => void = () => {};
let started = false;
let rescanTimer: NodeJS.Timeout | null = null;

function run(command: string, args: string[], timeout = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const message = `${stderr}\n${stdout}`.trim() || error.message;
      reject(Object.assign(new Error(message), { code: (error as NodeJS.ErrnoException).code }));
    });
  });
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function mountRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;
  return path.join(runtime, 'phones');
}

// ---------------------------------------------------------------------------
// Finding phones
// ---------------------------------------------------------------------------

function readAttr(dir: string, name: string): string {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8').trim();
  } catch {
    return '';
  }
}

/** What udev made of a device, from its database (`E:KEY=value` lines). */
function udevProperties(dev: string): Map<string, string> {
  const props = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(`/run/udev/data/c${dev}`, 'utf8').split('\n')) {
      if (!line.startsWith('E:')) continue;
      const eq = line.indexOf('=');
      if (eq > 2) props.set(line.slice(2, eq), line.slice(eq + 1));
    }
  } catch {
    // Not processed by udev (yet).
  }
  return props;
}

function classify(dir: string, sysname: string, vendor: string, product: string, mtp: boolean): PhoneKind | null {
  if (vendor === APPLE) return /iPhone|iPad|iPod/i.test(product) ? 'iphone' : null;
  if (mtp) return 'android';
  if (!ANDROID_VENDORS.has(vendor) || readAttr(dir, 'bDeviceClass') === '09') return null;
  let interfaces: string[];
  try {
    interfaces = fs.readdirSync(dir).filter((name) => name.startsWith(`${sysname}:`));
  } catch {
    return null;
  }
  const classes = interfaces.map((name) => readAttr(path.join(dir, name), 'bInterfaceClass'));
  return classes.some((c) => NOT_A_PHONE.has(c)) ? null : 'android';
}

function scan(): UsbDevice[] {
  let names: string[];
  try {
    names = fs.readdirSync(SYSFS_USB);
  } catch {
    return [];
  }
  const found: UsbDevice[] = [];
  for (const sysname of names) {
    if (sysname.includes(':') || sysname.startsWith('usb')) continue;
    const dir = path.join(SYSFS_USB, sysname);
    const vendor = readAttr(dir, 'idVendor');
    if (!vendor) continue;
    const product = readAttr(dir, 'product');
    const mtp = udevProperties(readAttr(dir, 'dev')).get('ID_MTP_DEVICE') === '1';
    const kind = classify(dir, sysname, vendor, product, mtp);
    if (!kind) continue;
    found.push({
      sysname,
      vendor,
      product,
      manufacturer: readAttr(dir, 'manufacturer'),
      serial: readAttr(dir, 'serial'),
      busnum: Number(readAttr(dir, 'busnum')),
      devnum: Number(readAttr(dir, 'devnum')),
      mtp,
      kind,
    });
  }
  return found;
}

function defaultName(device: UsbDevice): string {
  if (device.kind === 'iphone') return device.product.replace(/^Apple\s+/i, '') || 'iPhone';
  const product = device.product.trim();
  // Some phones call themselves just "MTP" or "Android".
  if (product && !/^(mtp|android|ptp)$/i.test(product)) {
    const maker = device.manufacturer.trim();
    return maker && !product.toLowerCase().startsWith(maker.toLowerCase()) && maker.length <= 12 && !/inc|ltd|corp/i.test(maker)
      ? `${maker} ${product}`
      : product;
  }
  return device.manufacturer.trim() ? `${device.manufacturer.trim()} Phone` : 'Android Phone';
}

function rescan(): void {
  const found = scan();
  const seen = new Set<string>();
  for (const device of found) {
    const id = `phone:${device.serial || device.sysname}`;
    seen.add(id);
    const existing = phones.get(id);
    if (existing) {
      // Switching USB modes plugs the phone in again, as a new device.
      const replugged = existing.device.devnum !== device.devnum || existing.device.busnum !== device.busnum;
      const mtpChanged = existing.device.mtp !== device.mtp;
      existing.device = device;
      if (replugged && existing.mountPoint) {
        void unmount(existing.mountPoint, true).catch(() => {});
        existing.mountPoint = null;
      }
      if (replugged || mtpChanged) advance(existing);
      continue;
    }
    const phone: UsbPhone = {
      id,
      kind: device.kind!,
      name: defaultName(device),
      device,
      mountPoint: null,
      needs: null,
      busy: null,
      ejected: false,
      udid: null,
      mounting: null,
      retry: null,
      attempts: 0,
      told: null,
    };
    phones.set(id, phone);
    advance(phone);
  }
  for (const [id, phone] of phones) {
    if (!seen.has(id)) forget(phone);
  }
  onChanged();
}

function scheduleRescan(): void {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    rescan();
  }, RESCAN_DELAY_MS);
}

/** Rescan on every USB device udev finishes with; poll where udevadm isn't. */
function watch(): void {
  let buffered = '';
  const monitor = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=usb/usb_device'], { stdio: ['ignore', 'pipe', 'ignore'] });
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    if (lines.some((line) => line.startsWith('UDEV'))) scheduleRescan();
  });
  const poll = () => setInterval(scheduleRescan, POLL_MS).unref();
  monitor.on('error', poll);
  monitor.on('exit', (code) => {
    if (code !== null) poll();
  });
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

function setNeeds(phone: UsbPhone, needs: string | null): void {
  phone.needs = needs;
  if (needs && phone.told !== needs && !phone.ejected) {
    phone.told = needs;
    announce({ type: 'waiting', id: phone.id, name: phone.name, needs });
  }
  if (!needs) phone.told = null;
  onChanged();
}

function retryLater(phone: UsbPhone): void {
  if (phone.retry) clearTimeout(phone.retry);
  phone.retry = setTimeout(() => {
    phone.retry = null;
    if (phones.get(phone.id) === phone) advance(phone);
  }, RETRY_MS);
}

/** Take a phone as far as it can go toward mounted, by itself. */
function advance(phone: UsbPhone): void {
  if (phone.ejected || phone.mounting || phone.mountPoint) return;
  if (phone.kind === 'android' && !phone.device.mtp) {
    setNeeds(phone, FILE_TRANSFER);
    return;
  }
  void mount(phone).then(
    (mountPoint) => announce({ type: 'mounted', name: phone.name, mountPoint }),
    (error: Error) => {
      if (phones.get(phone.id) !== phone || phone.ejected) return;
      if (phone.needs) {
        if (phone.needs !== NO_TOOLS && phone.needs !== DENIED_IPHONE) retryLater(phone);
        return;
      }
      console.error(`phone-usb: mounting ${phone.name} failed`, error);
      announce({ type: 'unreadable', name: phone.name, error: error.message });
    },
  );
}

/** A path for the phone under $XDG_RUNTIME_DIR/phones that no other phone has. */
function mountPointFor(phone: UsbPhone): string {
  const base = phone.name.replace(/[/\0]/g, '-').replace(/^\.+/, '').trim() || 'Phone';
  const taken = new Set([...phones.values()].filter((p) => p !== phone).map((p) => p.mountPoint));
  for (let n = 1; ; n++) {
    const candidate = path.join(mountRoot(), n === 1 ? base : `${base} ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** Mount a phone; resolves to where. Rejects with `needs` when the phone is waiting on the user. */
function mount(phone: UsbPhone): Promise<string> {
  if (phone.mountPoint) return Promise.resolve(phone.mountPoint);
  phone.mounting ??= (async () => {
    try {
      if (phone.kind === 'iphone') await pairIphone(phone);
      // Trying again while it waits on the user shows nothing, rather than
      // a spinner every few seconds.
      if (!phone.needs) {
        phone.busy = 'mounting';
        onChanged();
      }
      const mountPoint = mountPointFor(phone);
      await fs.promises.mkdir(mountPoint, { recursive: true });
      try {
        if (phone.kind === 'iphone') await mountIphone(phone, mountPoint);
        else await mountAndroid(phone, mountPoint);
      } catch (error) {
        await fs.promises.rmdir(mountPoint).catch(() => {});
        throw error;
      }
      if (phones.get(phone.id) !== phone) {
        await unmount(mountPoint, true).catch(() => {});
        throw new Error('It was unplugged.');
      }
      phone.mountPoint = mountPoint;
      setNeeds(phone, null);
      return mountPoint;
    } finally {
      phone.busy = null;
      phone.mounting = null;
      onChanged();
    }
  })();
  return phone.mounting;
}

/** Make sure usbmuxd has paired the iPhone, which takes Trust on the phone. */
async function pairIphone(phone: UsbPhone): Promise<void> {
  const fail = (needs: string, cause?: unknown): never => {
    throw waitOn(phone, needs, cause);
  };
  if (!phone.udid) {
    const out = await run('idevice_id', ['-l']).catch((error) => (missing(error) ? fail(NO_TOOLS) : ''));
    const serial = phone.device.serial.replace(/-/g, '').toLowerCase();
    const udids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    phone.udid = udids.find((u) => u.replace(/-/g, '').toLowerCase() === serial) ?? (udids.length === 1 ? udids[0] : null);
    if (!phone.udid) fail(TRUST_IPHONE);
  }
  const udid = phone.udid!;
  const attempt = phone.attempts++;
  try {
    await run('idevicepair', ['-u', udid, attempt % PAIR_EVERY === 0 ? 'pair' : 'validate']);
  } catch (error) {
    if (missing(error)) fail(NO_TOOLS, error);
    const message = (error as Error).message;
    if (/denied/i.test(message)) fail(DENIED_IPHONE, error);
    if (/no device found/i.test(message)) phone.udid = null;
    // A pair that's waiting on the dialog, a passcode, or not paired yet.
    fail(TRUST_IPHONE, error);
  }
  phone.attempts = 0;
  const name = await run('idevicename', ['-u', udid]).catch(() => '');
  if (name.trim()) phone.name = name.trim();
}

/** The phone waits on the user: say what for, in the phone's state and as the error. */
function waitOn(phone: UsbPhone, needs: string, cause?: unknown): Error {
  setNeeds(phone, needs);
  return new Error(needs, { cause });
}

async function mountIphone(phone: UsbPhone, mountPoint: string): Promise<void> {
  try {
    await run('ifuse', [mountPoint, '--udid', phone.udid!], MOUNT_TIMEOUT_MS);
  } catch (error) {
    if (missing(error)) throw waitOn(phone, NO_TOOLS, error);
    if (/lockdownd|passcode|locked/i.test((error as Error).message)) throw waitOn(phone, TRUST_IPHONE, error);
    throw new Error(`The iPhone didn’t open: ${(error as Error).message}`, { cause: error });
  }
}

async function mountAndroid(phone: UsbPhone, mountPoint: string): Promise<void> {
  const { busnum, devnum } = phone.device;
  try {
    await run('jmtpfs', [`-device=${busnum},${devnum}`, mountPoint], MOUNT_TIMEOUT_MS);
  } catch (error) {
    throw waitOn(phone, missing(error) ? NO_TOOLS : UNLOCK_ANDROID, error);
  }
  // A locked phone answers, but with no storage to show.
  const entries = await fs.promises.readdir(mountPoint).catch(() => []);
  if (entries.length === 0) {
    await unmount(mountPoint, true).catch(() => {});
    throw waitOn(phone, UNLOCK_ANDROID);
  }
}

async function unmount(mountPoint: string, lazy = false): Promise<void> {
  try {
    await run('fusermount', lazy ? ['-uz', mountPoint] : ['-u', mountPoint]);
  } catch (error) {
    if (/busy/i.test((error as Error).message)) {
      throw new Error('It’s in use. Close any files or apps using it, then try again.', { cause: error });
    }
    if (!/not found in|not mounted|no such file/i.test((error as Error).message)) throw error;
  }
  await fs.promises.rmdir(mountPoint).catch(() => {});
}

/** A phone was unplugged: let its mount go, whatever was using it. */
function forget(phone: UsbPhone): void {
  phones.delete(phone.id);
  if (phone.retry) clearTimeout(phone.retry);
  if (phone.mountPoint) void unmount(phone.mountPoint, true).catch(() => {});
}

/** Mounts left behind by a Din that didn't get to unmount them. */
async function clearStaleMounts(): Promise<void> {
  const root = `${mountRoot()}/`;
  const mounts = await fs.promises.readFile('/proc/self/mounts', 'utf8').catch(() => '');
  for (const line of mounts.split('\n')) {
    const point = (line.split(' ')[1] ?? '').replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (point.startsWith(root)) await unmount(point, true).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// For the volumes bridge
// ---------------------------------------------------------------------------

export function isPhoneVolume(id: unknown): id is string {
  return typeof id === 'string' && phones.has(id);
}

export function phoneVolumes(): Volume[] {
  return [...phones.values()].map((phone) => ({
    id: phone.id,
    name: phone.name,
    mountPoint: phone.mountPoint,
    device: `/dev/bus/usb/${String(phone.device.busnum).padStart(3, '0')}/${String(phone.device.devnum).padStart(3, '0')}`,
    sizeBytes: 0,
    fsType: phone.kind === 'iphone' ? 'afc' : 'mtp',
    locked: false,
    readOnly: false,
    bus: 'usb',
    busy: phone.busy,
    phone: phone.kind,
    needs: phone.mountPoint ? null : phone.needs,
  }));
}

/** Open a phone from Files or `din disks mount`: mount it, or say what it's waiting on. */
export async function mountPhone(id: string): Promise<string> {
  const phone = phones.get(id);
  if (!phone) throw new Error('No such disk.');
  phone.ejected = false;
  if (phone.mountPoint) return phone.mountPoint;
  if (phone.kind === 'android' && !phone.device.mtp) throw new Error(FILE_TRANSFER);
  if (phone.retry) clearTimeout(phone.retry);
  phone.retry = null;
  try {
    return await mount(phone);
  } catch (error) {
    if (phone.needs && phone.needs !== NO_TOOLS && phone.needs !== DENIED_IPHONE) retryLater(phone);
    throw error;
  }
}

export async function ejectPhone(id: string): Promise<void> {
  const phone = phones.get(id);
  if (!phone) throw new Error('No such disk.');
  phone.ejected = true;
  if (phone.retry) clearTimeout(phone.retry);
  phone.retry = null;
  if (phone.mounting) await phone.mounting.catch(() => {});
  const mountPoint = phone.mountPoint;
  if (mountPoint) {
    phone.busy = 'ejecting';
    onChanged();
    try {
      await unmount(mountPoint);
      phone.mountPoint = null;
    } finally {
      phone.busy = null;
      onChanged();
    }
  }
  phone.needs = null;
  phone.told = null;
  onChanged();
  announce({ type: 'ejected', name: phone.name });
}

export function startPhones(options: { changed: () => void; announce: (event: VolumeEvent) => void }): void {
  onChanged = options.changed;
  announce = options.announce;
  if (started || process.platform !== 'linux') return;
  started = true;
  void clearStaleMounts().finally(() => {
    watch();
    rescan();
  });
}
