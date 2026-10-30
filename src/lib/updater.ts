/**
 * Typed access to the updater bridge exposed by the Electron preload
 * (`window.dinos.updater`, see electron/preload.cjs + electron/updater.mts).
 *
 * An installed DinOS builds its updates from Din's source on its own, from
 * the repository and branch it follows, and stages them for the next boot;
 * Settings shows where that's got to, offers the restart, and changes the
 * source. The bridge is absent outside the Electron shell and reports
 * `available: false` off DinOS.
 */

export type UpdateStep = 'fetch' | 'space' | 'build' | 'install';

export interface UpdateState {
  available: boolean;
  /** Running from a USB stick, which isn't updated. */
  live: boolean;
  /** The running system's release (os/version). */
  version: string | null;
  /** The commit the running system was built from. */
  current: string | null;
  /** The commit the next boot starts, when it isn't the running one. */
  staged: string | null;
  /** The repository updates are built from, and its branch. */
  url: string | null;
  branch: string | null;
  /** Whether the system updates by itself, rather than only when asked. */
  auto: boolean;
  phase: 'idle' | 'checking' | 'updating' | 'failed';
  /** The commit being built and staged. */
  updatingTo: string | null;
  step: UpdateStep | null;
  /** Percent of the build. */
  percent: number;
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
}

export interface UpdaterBridge {
  state(): Promise<UpdateState>;
  /** Look for a newer commit now, and build and stage it. */
  check(): Promise<void>;
  /** Whether the system updates by itself. */
  setAuto(auto: boolean): Promise<void>;
  /** Build updates from another repository or branch. sudo asks the user first. */
  setSource(url: string, branch: string): Promise<void>;
  reboot(): Promise<void>;
  onProgress(callback: (state: UpdateState) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    updater?: UpdaterBridge;
  }
}

/** The updater bridge, or undefined outside the Electron shell. */
export function getUpdaterBridge(): UpdaterBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.updater;
}

export const UPDATE_STEP_LABELS: Record<UpdateStep, string> = {
  fetch: 'Getting',
  space: 'Making room for',
  build: 'Building',
  install: 'Installing',
};

/** The default source (os/din-update.sh's DEFAULT_URL and DEFAULT_BRANCH). */
export const DEFAULT_UPDATE_URL =
  'nostr://npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/git.shakespeare.diy/din';
export const DEFAULT_UPDATE_BRANCH = 'main';

/** A commit as people read them: its first seven characters. */
export function shortRevision(revision: string): string {
  return revision.replace(/^([0-9a-f]{7})[0-9a-f]*/, '$1');
}
