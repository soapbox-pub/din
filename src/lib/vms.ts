/**
 * The virtual machines bridge (`din.system.vms`, permission `vms`): QEMU
 * machines kept in ~/VMs, run by Electron main in electron/vms.mts, for the
 * Virtual Machines app (src/apps/virtual-machines/). Types only, shared by
 * both sides; main checks every argument itself.
 */

/** What's installed on the machine, which decides the hardware it gets. */
export type VmOs = 'windows' | 'linux' | 'other';

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
  /** UEFI firmware with Microsoft's Secure Boot keys was found. */
  secureBoot: boolean;
  /** swtpm was found. */
  tpm: boolean;
  /** Where machines are kept (~/VMs). */
  dir: string;
  hostMemoryMiB: number;
  hostCpus: number;
}

export interface VmsBridge {
  status(): Promise<VmsStatus>;
  list(): Promise<VmInfo[]>;
  create(input: NewVm): Promise<VmInfo>;
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

/** The hardware a new machine for this OS starts with. */
export function vmDefaults(os: VmOs): Omit<NewVm, 'name' | 'cdrom'> {
  switch (os) {
    case 'windows':
      return {
        os, memoryMiB: 8192, cpus: 4, diskGiB: 80, firmware: 'uefi', secureBoot: true, tpm: true,
        network: true, forwards: [], audio: true,
      };
    case 'linux':
      return {
        os, memoryMiB: 4096, cpus: 2, diskGiB: 40, firmware: 'uefi', secureBoot: false, tpm: false,
        network: true, forwards: [], audio: true,
      };
    default:
      return {
        os, memoryMiB: 2048, cpus: 2, diskGiB: 20, firmware: 'bios', secureBoot: false, tpm: false,
        network: true, forwards: [], audio: true,
      };
  }
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanVmsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
