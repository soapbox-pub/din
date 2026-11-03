/**
 * The virtual machines bridge (`din.system.vms`, permission `vms`): QEMU
 * machines kept in ~/VMs, run by Electron main in electron/vms.mts, for the
 * Virtual Machines app (src/apps/virtual-machines/) and the `din vms`
 * commands. Shared by both sides; main checks every argument itself.
 */

/** What's installed on the machine, which decides the hardware it gets. */
export type VmOs = 'windows' | 'macos' | 'linux' | 'other';

export type VmFirmware = 'uefi' | 'bios';

export type VmState = 'stopped' | 'starting' | 'running' | 'paused' | 'stopping';

export interface VmPortForward {
  protocol: 'tcp' | 'udp';
  /** The port on this computer (on 127.0.0.1 only). */
  host: number;
  /** The port inside the machine. */
  guest: number;
}

export interface VmConfig {
  name: string;
  os: VmOs;
  /** The system Din installed on it, for its badge; null when it was installed by hand. */
  system: VmInstallerId | null;
  memoryMiB: number;
  cpus: number;
  firmware: VmFirmware;
  /** UEFI only: Microsoft's keys enrolled, so Secure Boot is on. */
  secureBoot: boolean;
  /** A TPM 2.0 (swtpm), which Windows 11 needs. */
  tpm: boolean;
  /** The disc image in the CD drive, or null when it's empty. */
  cdrom: string | null;
  /** NAT to this computer's network, or no network at all. */
  network: boolean;
  forwards: VmPortForward[];
  /** Sound through this computer's speakers and microphone. */
  audio: boolean;
}

/** The systems Din fetches and installs by itself. */
export type VmInstallerId = 'windows' | 'macos' | 'ubuntu' | 'fedora';

export type VmInstallPhase =
  /** Finding the newest release. */
  | 'resolving'
  | 'downloading'
  /** Checking the download against its published SHA-256. */
  | 'verifying'
  /** The installer is running in the machine. */
  | 'installing'
  /** It couldn't go on: `error` says why, and `manualUrl` where to get the disc image by hand. */
  | 'failed';

/** A machine Din is still installing: downloading its system, then setting it up. */
export interface VmInstall {
  installer: VmInstallerId;
  /** What's going on it, once known ("Ubuntu 26.04.1 LTS"). */
  label: string;
  phase: VmInstallPhase;
  receivedBytes: number;
  /** 0 while unknown. */
  totalBytes: number;
  /** While installing, roughly how far along it is (0-1). */
  progress: number;
  error: string | null;
  /** The system's own download page, for getting its disc image by hand. */
  manualUrl: string;
}

/** Custom Install: anything left out is chosen for this computer. */
export interface VmInstallOptions {
  /** Install from this disc image instead of downloading one. */
  iso?: string;
  name?: string;
  memoryMiB?: number;
  cpus?: number;
  diskGiB?: number;
}

export interface VmInfo {
  /** The folder's name in ~/VMs, which the actions take. */
  id: string;
  /** The folder. */
  dir: string;
  config: VmConfig;
  state: VmState;
  /** The disk's size as the machine sees it. */
  diskSizeBytes: number;
  /** What the disk, and snapshots' memory, take up on this computer. */
  diskUsedBytes: number;
  /** Settings changed while it runs, which take effect when it next starts. */
  changesPending: boolean;
  /** Why it last stopped when it shouldn't have, or failed to start. */
  error: string | null;
  /** Set while Din is installing its system; null once it's done. */
  install: VmInstall | null;
}

export interface VmSnapshot {
  name: string;
  /** Unix ms. */
  date: number;
  /** The memory saved with it: nonzero for a snapshot of a running machine, which restores running. */
  stateBytes: number;
}

export interface NewVm extends VmConfig {
  diskGiB: number;
}

export interface VmsStatus {
  /** Everything needed is installed and KVM is usable. */
  available: boolean;
  /** What's missing, as the user should hear it ("QEMU", "KVM", …). */
  missing: string[];
  /** QEMU is missing, and DinOS has it as an optional feature (Settings → Optional Features). */
  optionalFeature: boolean;
  /** UEFI firmware with Microsoft's Secure Boot keys was found. */
  secureBoot: boolean;
  /** swtpm was found. */
  tpm: boolean;
  /** Where machines are kept (~/VMs). */
  dir: string;
  /** The systems Din can install by itself (`install`). */
  installers: VmInstallerId[];
  hostMemoryMiB: number;
  hostCpus: number;
}

export interface VmsBridge {
  status(): Promise<VmsStatus>;
  list(): Promise<VmInfo[]>;
  create(input: NewVm): Promise<VmInfo>;
  /**
   * A new machine with this system on it: Din makes it at once, sized to this
   * computer, then downloads the newest release, checks it, and installs it
   * hands-free. Progress is the machine's `install`.
   */
  install(installer: VmInstallerId, options?: VmInstallOptions): Promise<VmInfo>;
  /** Try a failed install again, from a disc image of the user's if given. */
  retryInstall(id: string, options?: VmInstallOptions): Promise<void>;
  /** Stop installing and throw the machine away. */
  cancelInstall(id: string): Promise<void>;
  /** Change its settings; hardware changes take effect when it next starts. Renaming needs it off. */
  update(id: string, patch: Partial<VmConfig>): Promise<VmInfo>;
  /** Move it to the Trash. Needs it off. */
  remove(id: string): Promise<void>;
  start(id: string): Promise<void>;
  /** Press the power button: the guest shuts itself down. */
  shutdown(id: string): Promise<void>;
  /** Pull the plug. */
  forceStop(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  reset(id: string): Promise<void>;
  /** Put a disc image in the CD drive (null ejects it), at once if it's running. */
  setCdrom(id: string, path: string | null): Promise<void>;
  /** Grow the disk. Needs it off. */
  resizeDisk(id: string, gib: number): Promise<void>;
  snapshots(id: string): Promise<VmSnapshot[]>;
  takeSnapshot(id: string, name: string): Promise<void>;
  /** Go back to a snapshot. One taken while it was off turns it off first. */
  restoreSnapshot(id: string, name: string): Promise<void>;
  deleteSnapshot(id: string, name: string): Promise<void>;
  /**
   * Connect to its screen: an RFB (VNC) stream, whose bytes come in on
   * onDisplayData and go out with displayWrite. Resolves with the connection's id.
   */
  openDisplay(id: string): Promise<number>;
  displayWrite(connection: number, data: Uint8Array): void;
  closeDisplay(connection: number): void;
  onDisplayData(callback: (connection: number, data: Uint8Array) => void): () => void;
  onDisplayClosed(callback: (connection: number) => void): () => void;
  /** Every machine, whenever one changes. */
  onChanged(callback: (vms: VmInfo[]) => void): () => void;
}

/** What the desktop has of it (`window.dinos.vms`), for the `din vms` commands: all but the screens. */
export type VmsDesktopBridge = Omit<VmsBridge, 'openDisplay' | 'displayWrite' | 'closeDisplay' | 'onDisplayData' | 'onDisplayClosed'>;

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    vms?: VmsDesktopBridge;
  }
}

/** The desktop's virtual machines, or undefined outside Electron. */
export function getVmsBridge(): VmsDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.vms;
}

/** The hardware a new machine for this OS starts with. */
export function vmDefaults(os: VmOs): Omit<NewVm, 'name' | 'cdrom'> {
  switch (os) {
    case 'windows':
      return {
        os, system: null, memoryMiB: 8192, cpus: 4, diskGiB: 80, firmware: 'uefi', secureBoot: true, tpm: true,
        network: true, forwards: [], audio: true,
      };
    case 'macos':
      // No sound: macOS has no driver for QEMU's sound card.
      return {
        os, system: null, memoryMiB: 8192, cpus: 4, diskGiB: 128, firmware: 'uefi', secureBoot: false, tpm: false,
        network: true, forwards: [], audio: false,
      };
    case 'linux':
      return {
        os, system: null, memoryMiB: 4096, cpus: 2, diskGiB: 40, firmware: 'uefi', secureBoot: false, tpm: false,
        network: true, forwards: [], audio: true,
      };
    default:
      return {
        os, system: null, memoryMiB: 2048, cpus: 2, diskGiB: 20, firmware: 'bios', secureBoot: false, tpm: false,
        network: true, forwards: [], audio: true,
      };
  }
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanVmsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
