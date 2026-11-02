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

export type UpdateStep = 'fetch' | 'merge' | 'space' | 'build' | 'install';

/**
 * Why an update failed, when it's the user's changes that stopped it: they
 * conflict with the branch, were never committed, can't be found (not on
 * the branch, nor in ~/DinOS), or don't build merged with it.
 */
export type UpdateFailure = 'conflict' | 'dirty' | 'missing' | 'build';

/**
 * What a system takes beyond a switch to it: Din restarting, for a new Din
 * (din-shell is never restarted by a switch), or the computer, for a new
 * kernel, initrd or kernel parameters.
 */
export type UpdateRestart = 'din' | 'reboot';

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
  /**
   * Whether the system has changes of the user's (from ~/DinOS), which
   * updates merge the branch into.
   */
  custom: boolean;
  /** How many commits of the user's it has, when known. */
  changes: number | null;
  phase: 'idle' | 'checking' | 'updating' | 'failed';
  /** The commit being built and staged. */
  updatingTo: string | null;
  step: UpdateStep | null;
  /** Percent of the build. */
  percent: number;
  /** When a check last finished, in ms since the epoch. */
  checkedAt: number | null;
  error: string | null;
  /** Set when the user's changes stopped the update, which the assistant can fix. */
  reason: UpdateFailure | null;
  /** What the running system still needs to be all of itself, after a switch to it. */
  restart: UpdateRestart | null;
  /** What the staged system takes beyond applying it; null if nothing. */
  stagedNeeds: UpdateRestart | null;
}

export interface UpdaterBridge {
  state(): Promise<UpdateState>;
  /** Look for a newer commit now, and build and stage it. */
  check(): Promise<void>;
  /**
   * Build the branch's tip as it is, over whatever the system was built
   * from: for a system whose commit the updater can't find (`missing`).
   */
  replace(): Promise<void>;
  /** Whether the system updates by itself. */
  setAuto(auto: boolean): Promise<void>;
  /** Build updates from another repository or branch. sudo asks the user first. */
  setSource(url: string, branch: string): Promise<void>;
  /** Switch to the staged system now, where that needs no restart of the computer. */
  apply(): Promise<void>;
  /**
   * Build a branch or commit of the user's ~/DinOS and switch to it, unless
   * it needs the computer to restart. sudo asks first, in the Assistant
   * conversation `session` if one's named. Resolves the commit built and
   * what's left to restart.
   */
  buildLocal(ref: string, session?: string): Promise<{ commit: string; restart: UpdateRestart | null }>;
  /** Restart Din, closing every app, to start a new Din a switch brought. */
  restartDin(): Promise<void>;
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
  merge: 'Merging in',
  space: 'Making room for',
  build: 'Building',
  install: 'Installing',
};

/** The default source (os/din-update.sh's DEFAULT_URL and DEFAULT_BRANCH). */
export const DEFAULT_UPDATE_URL =
  'nostr://npub10qdp2fc9ta6vraczxrcs8prqnv69fru2k6s2dj48gqjcylulmtjsg9arpj/git.shakespeare.diy/din';
export const DEFAULT_UPDATE_BRANCH = 'main';

/** A commit as people read them: its first seven characters. */
export function shortRevision(revision: string): string {
  return revision.replace(/^([0-9a-f]{7})[0-9a-f]*/, '$1');
}
