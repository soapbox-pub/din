// The volumes bridge (window.dinos.volumes, for the Files sidebar and the desktop's
// notifications): USB sticks, SD cards and other removable disks, mounted
// the moment they're plugged in and ejected with one click, the way a Mac
// does it.
//
// UDisks2 is driven over the system bus with dbus.mts, on one connection kept
// for as long as Din runs, like the Bluetooth bridge: udisksd's
// ObjectManager lists the drives and their filesystems, its signals keep the
// list current, and the whole state is pushed to the shell whenever it
// changes (`volumes:changed`). Things the user should hear about - a disk
// ready to use, one safe to unplug, one pulled out while mounted, one that
// can't be read - go out as `volumes:event`.
//
// Mounting: every filesystem on removable media (udisks' HintAuto, never
// HintSystem) gets one decision, the first time it shows up mounted or not:
// mount it, unless an install is writing to disks, or it's the EFI system
// partition, or its drive holds a filesystem the system itself mounted (the
// stick a live boot runs from). udisks mounts it under /run/media/<user>,
// owned by Din's user; os/configuration.nix lets that user do so without a
// polkit prompt.
//
// Encrypted volumes (LUKS) on removable media are listed locked, and their
// decision is to tell the user (`locked`), who unlocks one with its
// passphrase from the notification or Files. Unlocking mounts what's inside;
// that filesystem then stands in for its container, which udisks keeps as
// its CryptoBackingDevice, and takes its drive and hints from it.
//
// Ejecting unmounts everything on the drive, locks what was unlocked, then
// ejects the media or powers the drive off, whichever it can, so the light
// goes out before it's pulled.
//
// Phones plugged in by USB are listed here too, with what they're waiting
// on (Trust, File transfer, unlocking); electron/phone-usb.mts mounts and
// ejects them.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain } from 'electron';
import { DBusConnection, DBusError, unwrap, Variant, type Message } from './dbus.mts';
import { ejectPhone, isPhoneVolume, mountPhone, phoneVolumes, startPhones } from './phone-usb.mts';

const UDISKS = 'org.freedesktop.UDisks2';
const UDISKS_PATH = '/org/freedesktop/UDisks2';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const BLOCK = 'org.freedesktop.UDisks2.Block';
const FILESYSTEM = 'org.freedesktop.UDisks2.Filesystem';
const PARTITION = 'org.freedesktop.UDisks2.Partition';
const DRIVE = 'org.freedesktop.UDisks2.Drive';
const ENCRYPTED = 'org.freedesktop.UDisks2.Encrypted';

const SYSTEM_BUS = process.env.DBUS_SYSTEM_BUS_ADDRESS || 'unix:path=/run/dbus/system_bus_socket';

/** The EFI system partition's type, as GPT and MBR spell it. */
const ESP_TYPES = new Set(['c12a7328-f81f-11d2-ba4b-00a0c93ec93b', '0xef']);

/** Mounting may check the filesystem first; ejecting flushes writes. */
const MOUNT_TIMEOUT_MS = 60_000;
/** Unlocking derives the key from the passphrase, slowly on purpose. */
const UNLOCK_TIMEOUT_MS = 120_000;
/** How long an unlocked volume's filesystem may take to show up. */
const CLEARTEXT_WAIT_MS = 10_000;
const EJECT_TIMEOUT_MS = 120_000;
/**
 * A mount that went away this long before its disk did went with it:
 * udisks cleans up after a pulled disk before it drops the disk's objects.
 */
const PULLED_WINDOW_MS = 3000;
const EMIT_DELAY_MS = 100;

export type VolumeBusy = 'mounting' | 'unlocking' | 'ejecting';

export interface Volume {
  /** udisks' object path for the filesystem, which the actions take. */
  id: string;
  name: string;
  /** Where it's mounted, or null when it isn't. */
  mountPoint: string | null;
  /** The device node, e.g. /dev/sdb1. */
  device: string;
  sizeBytes: number;
  /** The filesystem type, e.g. vfat, exfat, ntfs, ext4; crypto_LUKS when locked. */
  fsType: string;
  /** Encrypted and not unlocked yet: unlock it with its passphrase to open it. */
  locked: boolean;
  readOnly: boolean;
  /** "usb", "sdio" (an SD card), or "" when udisks doesn't say. */
  bus: string;
  busy: VolumeBusy | null;
  /** A phone plugged in by USB rather than a disk, and which kind. */
  phone?: 'android' | 'iphone';
  /** What a phone is waiting on the user for before it opens, e.g. "Unlock the iPhone and tap Trust." */
  needs?: string | null;
}

export interface VolumesState {
  /** False when udisksd isn't running (or there's no system bus). */
  available: boolean;
  volumes: Volume[];
}

export type VolumeEvent =
  | { type: 'mounted'; name: string; mountPoint: string }
  | { type: 'locked'; id: string; name: string }
  | { type: 'ejected'; name: string }
  | { type: 'pulled'; name: string }
  | { type: 'unreadable'; name: string; error: string }
  | { type: 'waiting'; id: string; name: string; needs: string };

type Interfaces = Map<string, Map<string, unknown>>;

let bus: DBusConnection | null = null;
let connecting: Promise<DBusConnection | null> | null = null;
let udisksOwner: string | null = null;
let unsubscribeUdisks: (() => void) | null = null;
/** udisks' objects: path -> interface -> property -> value (unwrapped). */
const objects = new Map<string, Interfaces>();
/** Filesystems that have had their mount-or-not decision. */
const decided = new Set<string>();
const busy = new Map<string, VolumeBusy>();
/** Encrypted volumes being unlocked, whose filesystems unlock() mounts itself. */
const unlocking = new Set<string>();
/** Drives being ejected, whose filesystems are meant to go away. */
const ejecting = new Set<string>();
/** When each filesystem's mount went away without Din unmounting it. */
const unmountedAt = new Map<string, number>();
/** Names of filesystems as last seen, for telling the user they're gone. */
const names = new Map<string, string>();

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let isInstalling: () => boolean = () => false;
let emitTimer: NodeJS.Timeout | null = null;
let lastSent = '';

function unwrapProps(props: Map<string, unknown>): Map<string, unknown> {
  return new Map([...props].map(([key, value]) => [key, unwrap(value)]));
}

/** A NUL-terminated `ay` (a device node, a mount point) as a string. */
function bytesToString(value: unknown): string {
  if (!(value instanceof Uint8Array)) return '';
  const end = value.indexOf(0);
  return Buffer.from(end === -1 ? value : value.subarray(0, end)).toString('utf8');
}

function mountPoints(path: string): string[] {
  const points = objects.get(path)?.get(FILESYSTEM)?.get('MountPoints');
  return Array.isArray(points) ? points.map(bytesToString).filter(Boolean) : [];
}

/** Sizes the way a disk's box prints them: 16 GB, not 14.9 GiB. */
function formatSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  if (unit < 0) return `${bytes} B`;
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

function volumeName(block: Map<string, unknown>): string {
  const label = String(block.get('IdLabel') ?? '').trim() || String(block.get('HintName') ?? '').trim();
  if (label) return label;
  const size = Number(block.get('Size') ?? 0);
  const kind = block.get('IdUsage') === 'crypto' ? 'Encrypted Volume' : 'Volume';
  return size > 0 ? `${formatSize(size)} ${kind}` : 'Untitled';
}

/** The block a path is on the disk: an unlocked filesystem's encrypted container. */
function backingOf(path: string): string {
  const backing = objects.get(path)?.get(BLOCK)?.get('CryptoBackingDevice');
  return typeof backing === 'string' && backing !== '/' && objects.has(backing) ? backing : path;
}

function driveOf(path: string): string | null {
  const drive = objects.get(backingOf(path))?.get(BLOCK)?.get('Drive');
  return typeof drive === 'string' && drive !== '/' ? drive : null;
}

/** Whether a block is on removable media the user would plug in and out. */
function onRemovableMedia(path: string): boolean {
  const ifaces = objects.get(backingOf(path));
  const block = ifaces?.get(BLOCK);
  if (!block) return false;
  if (block.get('HintIgnore') === true || block.get('HintSystem') === true || block.get('HintAuto') !== true) {
    return false;
  }
  const type = String(ifaces?.get(PARTITION)?.get('Type') ?? '').toLowerCase();
  return !ESP_TYPES.has(type);
}

/** Whether a path is a filesystem on removable media. */
function isRemovable(path: string): boolean {
  const ifaces = objects.get(path);
  if (!ifaces?.has(FILESYSTEM) || ifaces.get(BLOCK)?.get('IdUsage') !== 'filesystem') return false;
  return onRemovableMedia(path);
}

/** The block unlocked from an encrypted one, or null while it's locked. */
function cleartextOf(path: string): string | null {
  for (const [other, ifaces] of objects) {
    if (ifaces.get(BLOCK)?.get('CryptoBackingDevice') === path) return other;
  }
  return null;
}

/** Whether a path is a locked encrypted volume on removable media. */
function isLocked(path: string): boolean {
  const ifaces = objects.get(path);
  if (!ifaces?.has(ENCRYPTED) || ifaces.get(BLOCK)?.get('IdUsage') !== 'crypto') return false;
  return onRemovableMedia(path) && cleartextOf(path) === null;
}

/** Whether something on a drive is mounted by the system, not for the user. */
function holdsSystemMount(drive: string): boolean {
  for (const [path, ifaces] of objects) {
    if (ifaces.get(BLOCK)?.get('Drive') !== drive) continue;
    if (mountPoints(path).some((point) => !point.startsWith('/run/media/') && !point.startsWith('/media/'))) {
      return true;
    }
  }
  return false;
}

function state(): VolumesState {
  const volumes: Volume[] = [];
  for (const [path, ifaces] of objects) {
    const locked = isLocked(path);
    if (!locked && !isRemovable(path)) continue;
    const block = ifaces.get(BLOCK)!;
    const drive = driveOf(path);
    if (drive && holdsSystemMount(drive)) continue;
    volumes.push({
      id: path,
      name: volumeName(block),
      mountPoint: mountPoints(path)[0] ?? null,
      device: bytesToString(block.get('PreferredDevice')) || bytesToString(block.get('Device')),
      sizeBytes: Number(block.get('Size') ?? 0),
      fsType: String(block.get('IdType') ?? ''),
      locked,
      readOnly: block.get('ReadOnly') === true,
      bus: String((drive && objects.get(drive)?.get(DRIVE)?.get('ConnectionBus')) ?? ''),
      busy: busy.get(path) ?? (drive && ejecting.has(drive) ? 'ejecting' : null),
    });
  }
  volumes.sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
  volumes.push(...phoneVolumes());
  return { available: udisksOwner !== null, volumes };
}

/** Tell the shell, soon: plugging a disk in sends a burst of changes. */
function changed(): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    const current = state();
    const json = JSON.stringify(current);
    if (json === lastSent) return;
    lastSent = json;
    sendToShell('volumes:changed', current);
  }, EMIT_DELAY_MS);
}

function announce(event: VolumeEvent): void {
  sendToShell('volumes:event', event);
}

// ---------------------------------------------------------------------------
// Mounting what's plugged in
// ---------------------------------------------------------------------------

/** Give every new removable filesystem, or locked volume, its one decision. */
function autoMount(): void {
  for (const path of objects.keys()) {
    if (decided.has(path)) continue;
    const locked = isLocked(path);
    if (!locked && !isRemovable(path)) continue;
    decided.add(path);
    const drive = driveOf(path);
    if (isInstalling() || (drive && holdsSystemMount(drive))) continue;
    if (locked) {
      announce({ type: 'locked', id: path, name: names.get(path) ?? 'Untitled' });
      continue;
    }
    if (mountPoints(path).length > 0 || unlocking.has(backingOf(path))) continue;
    void mount(path).then(
      (mountPoint) => announce({ type: 'mounted', name: names.get(path) ?? 'Untitled', mountPoint }),
      (error) => {
        if (!objects.has(path)) return;
        console.error(`volumes: mounting ${path} failed`, error);
        announce({ type: 'unreadable', name: names.get(path) ?? 'Untitled', error: explain(error).message });
      },
    );
  }
}

/** Remember names, and notice mounts that went away by themselves. */
function track(path: string, before: string[]): void {
  const block = objects.get(path)?.get(BLOCK);
  if (block) names.set(path, volumeName(block));
  if (before.length > 0 && mountPoints(path).length === 0 && busy.get(path) !== 'ejecting') {
    const drive = driveOf(path);
    if (!drive || !ejecting.has(drive)) unmountedAt.set(path, Date.now());
  }
}

/** A filesystem's object went away: was its disk pulled out while in use? */
function forget(path: string, before: string[], drive: string | null): void {
  const name = names.get(path);
  const gone = unmountedAt.get(path);
  const wasMounted = before.length > 0 || (gone !== undefined && Date.now() - gone < PULLED_WINDOW_MS);
  if (wasMounted && name && !(drive && ejecting.has(drive)) && busy.get(path) !== 'ejecting') {
    announce({ type: 'pulled', name });
  }
  decided.delete(path);
  busy.delete(path);
  unmountedAt.delete(path);
  names.delete(path);
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

async function connection(): Promise<DBusConnection | null> {
  if (bus) return bus;
  connecting ??= (async () => {
    const b = await DBusConnection.connect(SYSTEM_BUS);
    if (!b) return null;
    b.onClose = () => {
      if (bus !== b) return;
      bus = null;
      udisksOwner = null;
      unsubscribeUdisks = null;
      objects.clear();
      decided.clear();
      busy.clear();
      changed();
    };
    b.subscribe({ sender: 'org.freedesktop.DBus', interface: 'org.freedesktop.DBus', member: 'NameOwnerChanged' }, (message) => {
      if (message.body[0] === UDISKS) void load(b);
    });
    bus = b;
    await load(b);
    return b;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Read udisks' objects afresh and follow their changes. */
async function load(b: DBusConnection): Promise<void> {
  unsubscribeUdisks?.();
  unsubscribeUdisks = null;
  objects.clear();
  decided.clear();

  // udisksd is started on demand, by the first call for it.
  await b.bus('StartServiceByName', 'su', [UDISKS, 0]).catch(() => {});
  const owner = await b
    .bus('GetNameOwner', 's', [UDISKS])
    .then(([name]) => name as string)
    .catch(() => null);
  udisksOwner = owner;
  if (!owner) {
    changed();
    return;
  }

  const unsubscribers = [
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesAdded' }, (message: Message) => {
      const [path, ifaces] = message.body as [string, Map<string, Map<string, unknown>>];
      const before = mountPoints(path);
      const entry = objects.get(path) ?? new Map();
      for (const [iface, props] of ifaces) entry.set(iface, unwrapProps(props));
      objects.set(path, entry);
      track(path, before);
      autoMount();
      changed();
    }),
    b.subscribe({ sender: owner, interface: OBJECT_MANAGER, member: 'InterfacesRemoved' }, (message: Message) => {
      const [path, ifaces] = message.body as [string, string[]];
      const entry = objects.get(path);
      if (!entry) return;
      const before = mountPoints(path);
      const drive = driveOf(path);
      for (const iface of ifaces) entry.delete(iface);
      if (!entry.has(BLOCK) || !(entry.has(FILESYSTEM) || entry.has(ENCRYPTED))) forget(path, before, drive);
      if (entry.size === 0) objects.delete(path);
      if (ifaces.includes(DRIVE)) ejecting.delete(path);
      changed();
    }),
    b.subscribe({ sender: owner, interface: PROPERTIES, member: 'PropertiesChanged' }, (message: Message) => {
      const [iface, values, invalidated] = message.body as [string, Map<string, unknown>, string[]];
      const path = message.path;
      const props = path ? objects.get(path)?.get(iface) : undefined;
      if (!path || !props) return;
      const before = mountPoints(path);
      for (const [key, value] of values) props.set(key, unwrap(value));
      for (const key of invalidated) props.delete(key);
      track(path, before);
      autoMount();
      changed();
    }),
  ];
  unsubscribeUdisks = () => unsubscribers.forEach((unsubscribe) => unsubscribe());

  try {
    const [managed] = await b.call({ destination: UDISKS, path: UDISKS_PATH, interface: OBJECT_MANAGER, member: 'GetManagedObjects' });
    for (const [path, ifaces] of managed as Map<string, Map<string, Map<string, unknown>>>) {
      objects.set(path, new Map([...ifaces].map(([iface, props]) => [iface, unwrapProps(props)])));
      track(path, []);
    }
  } catch (error) {
    console.error('volumes: reading udisks objects failed', error);
  }
  autoMount();
  changed();
}

function call(member: string, path: string, iface: string, signature = '', body: unknown[] = [], timeout?: number) {
  if (!bus) return Promise.reject(new Error("Can't reach the disk service."));
  return bus.call({ destination: UDISKS, path, interface: iface, member, signature, body, timeout });
}

/** Never let udisks wait on a polkit prompt nobody will see. */
const NO_PROMPT = { 'auth.no_user_interaction': new Variant('b', true) };

/** Words for udisks' errors that a person can act on. */
function explain(error: unknown): Error {
  if (!(error instanceof DBusError)) return error instanceof Error ? error : new Error(String(error));
  const message = error.message.replace(/^GDBus\.Error:[\w.]+:\s*/, '');
  if (error.type === 'org.freedesktop.UDisks2.Error.DeviceBusy' || /target is busy/i.test(message)) {
    return new Error('It’s in use. Close any files or apps using it, then try again.');
  }
  if (error.type === 'org.freedesktop.UDisks2.Error.NotAuthorized' || error.type.endsWith('NotAuthorizedCanObtain')) {
    return new Error('This computer doesn’t allow it.');
  }
  if (/unknown filesystem type/i.test(message)) {
    return new Error('This computer can’t read its format.');
  }
  if (/operation not permitted|no key available|incorrect passphrase|wrong passphrase/i.test(message)) {
    return new Error('That passphrase isn’t right.');
  }
  return new Error(message || error.type);
}

async function withBusy<T>(path: string, kind: VolumeBusy, action: () => Promise<T>): Promise<T> {
  if (busy.has(path)) throw new Error('Already busy with that disk.');
  busy.set(path, kind);
  changed();
  try {
    return await action();
  } finally {
    busy.delete(path);
    changed();
  }
}

/** Mount a filesystem; resolves to where. */
async function mount(path: string): Promise<string> {
  const existing = mountPoints(path)[0];
  if (existing) return existing;
  return withBusy(path, 'mounting', async () => {
    try {
      const [mountPoint] = await call('Mount', path, FILESYSTEM, 'a{sv}', [NO_PROMPT], MOUNT_TIMEOUT_MS);
      return String(mountPoint);
    } catch (error) {
      if (error instanceof DBusError && error.type === 'org.freedesktop.UDisks2.Error.AlreadyMounted') {
        return mountPoints(path)[0] ?? '';
      }
      throw explain(error);
    }
  });
}

/** Wait for udisks to report an unlocked block's filesystem; false if it never does. */
function filesystemShowsUp(path: string): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (isRemovable(path)) resolve(true);
      else if (Date.now() - start > CLEARTEXT_WAIT_MS || !bus) resolve(false);
      else setTimeout(check, 100);
    };
    check();
  });
}

/** Unlock an encrypted volume with its passphrase and mount what's in it; resolves to where. */
async function unlock(path: string, passphrase: string): Promise<string> {
  const cleartext = await withBusy(path, 'unlocking', async () => {
    unlocking.add(path);
    try {
      const [opened] = await call('Unlock', path, ENCRYPTED, 'sa{sv}', [passphrase, NO_PROMPT], UNLOCK_TIMEOUT_MS).catch((error) => {
        throw explain(error);
      });
      const cleartext = String(opened);
      if (!(await filesystemShowsUp(cleartext))) {
        await call('Lock', path, ENCRYPTED, 'a{sv}', [NO_PROMPT]).catch(() => {});
        throw new Error('It unlocked, but there’s nothing on it this computer can open.');
      }
      return cleartext;
    } finally {
      unlocking.delete(path);
    }
  });
  return mount(cleartext);
}

/** Unmount everything on a filesystem's drive, then let the drive go. */
async function eject(path: string): Promise<void> {
  const drive = driveOf(path);
  const name = names.get(path) ?? 'Untitled';
  const filesystems = drive
    ? [...objects.keys()].filter((p) => driveOf(p) === drive && objects.get(p)?.has(FILESYSTEM))
    : [path];
  const encrypted = drive
    ? [...objects.keys()].filter((p) => driveOf(p) === drive && objects.get(p)?.has(ENCRYPTED))
    : [backingOf(path)].filter((p) => objects.get(p)?.has(ENCRYPTED));
  if (drive && ejecting.has(drive)) return;
  if (drive) ejecting.add(drive);
  changed();
  try {
    for (const filesystem of filesystems) {
      if (mountPoints(filesystem).length === 0) continue;
      await call('Unmount', filesystem, FILESYSTEM, 'a{sv}', [NO_PROMPT], EJECT_TIMEOUT_MS).catch((error) => {
        if (error instanceof DBusError && error.type === 'org.freedesktop.UDisks2.Error.NotMounted') return;
        throw explain(error);
      });
    }
    for (const container of encrypted) {
      if (!cleartextOf(container)) continue;
      await call('Lock', container, ENCRYPTED, 'a{sv}', [NO_PROMPT], EJECT_TIMEOUT_MS).catch((error) => {
        if (error instanceof DBusError && error.type === 'org.freedesktop.UDisks2.Error.NotUnlocked') return;
        throw explain(error);
      });
    }
    const props = drive ? objects.get(drive)?.get(DRIVE) : undefined;
    if (drive && props) {
      // Media that comes out (an SD card, a disc) is ejected; a stick or a
      // disk is powered off. Either can be refused by hardware that doesn't
      // do it, which leaves it unmounted and just as safe to pull.
      if (props.get('Ejectable') === true && props.get('MediaRemovable') === true) {
        await call('Eject', drive, DRIVE, 'a{sv}', [NO_PROMPT], EJECT_TIMEOUT_MS).catch(() => {});
      }
      if (props.get('CanPowerOff') === true && objects.has(drive)) {
        await call('PowerOff', drive, DRIVE, 'a{sv}', [NO_PROMPT], EJECT_TIMEOUT_MS).catch(() => {});
      }
    }
    announce({ type: 'ejected', name });
  } finally {
    // A drive that powered off is gone already; one that didn't stays known
    // as unmounted, and isn't mounted again until it's plugged in again.
    if (drive) setTimeout(() => {
      ejecting.delete(drive);
      changed();
    }, PULLED_WINDOW_MS);
    changed();
  }
}

/**
 * Unmount whatever Din mounted from a disk (by device node, e.g. /dev/sdb),
 * so the Installer can write to it.
 */
export async function releaseDisk(disk: string): Promise<void> {
  if (!(await connection())) return;
  for (const [path, ifaces] of objects) {
    const block = ifaces.get(BLOCK);
    if (!block || !ifaces.has(FILESYSTEM) || mountPoints(path).length === 0) continue;
    const device = bytesToString(block.get('Device'));
    if (device !== disk && !(device.startsWith(disk) && /^p?\d+$/.test(device.slice(disk.length)))) continue;
    if (!mountPoints(path).every((point) => point.startsWith('/run/media/') || point.startsWith('/media/'))) continue;
    const drive = driveOf(path);
    if (drive) ejecting.add(drive);
    try {
      await call('Unmount', path, FILESYSTEM, 'a{sv}', [NO_PROMPT], EJECT_TIMEOUT_MS);
    } catch (error) {
      throw explain(error);
    } finally {
      if (drive) ejecting.delete(drive);
    }
  }
}

function requireVolume(path: unknown): string {
  if (typeof path !== 'string' || !(isRemovable(path) || isLocked(path))) throw new Error('No such disk.');
  return path;
}

export function registerVolumesHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  isInstalling: () => boolean;
}): void {
  const { assertShellSender } = options;
  sendToShell = options.sendToShell;
  isInstalling = options.isInstalling;

  // Disks plugged in before Din started are mounted as it starts, not when
  // something first asks.
  void connection();
  startPhones({ changed, announce });

  ipcMain.handle('volumes:state', async (event) => {
    assertShellSender(event);
    await connection();
    lastSent = '';
    return state();
  });

  ipcMain.handle('volumes:mount', async (event, path: unknown) => {
    assertShellSender(event);
    if (isPhoneVolume(path)) return mountPhone(path);
    if (!(await connection()) || !udisksOwner) throw new Error("Can't reach the disk service.");
    const volume = requireVolume(path);
    if (isLocked(volume)) throw new Error('It’s locked. Unlock it with its passphrase first.');
    return mount(volume);
  });

  ipcMain.handle('volumes:unlock', async (event, path: unknown, passphrase: unknown) => {
    assertShellSender(event);
    if (!(await connection()) || !udisksOwner) throw new Error("Can't reach the disk service.");
    const volume = requireVolume(path);
    if (!isLocked(volume)) throw new Error('It isn’t locked.');
    if (typeof passphrase !== 'string' || !passphrase) throw new Error('Enter its passphrase.');
    return unlock(volume, passphrase);
  });

  ipcMain.handle('volumes:eject', async (event, path: unknown) => {
    assertShellSender(event);
    if (isPhoneVolume(path)) return ejectPhone(path);
    if (!(await connection()) || !udisksOwner) throw new Error("Can't reach the disk service.");
    await eject(requireVolume(path));
  });
}
