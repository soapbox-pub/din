/**
 * Typed access to the session bridge exposed by the Electron preload
 * (`window.dinos.session`, see electron/preload.cjs).
 *
 * Ending the session quits the shell; as a login session that returns to
 * the display manager. Saved Nostr accounts are left alone. In a plain
 * browser there is no session to end.
 *
 * On another Linux, it also puts Din on the login screen, from `npm run dev`
 * or from the session itself (scripts/session.mjs, electron/login-session.mts).
 */

export type LoginSessionAction = 'install' | 'update' | 'rollback' | 'default' | 'restore' | 'uninstall';

/** A build of Din the login session runs. */
export interface LoginSessionRelease {
  id: string;
  commit?: string | null;
  dirty?: boolean;
  /** ISO time it was built. */
  built?: string;
}

export interface LoginSessionStatus {
  /** False where there's no checkout to build from (a DinOS build, say). */
  available: boolean;
  /** An action is running. */
  busy?: boolean;
  /** Whether this computer can have the session, and why not. */
  supported?: boolean;
  reason?: string | null;
  /** Din is on the login screen. */
  installed?: boolean;
  /** The login screen's files are what this checkout would install. */
  systemFilesCurrent?: boolean;
  current?: LoginSessionRelease | null;
  previous?: LoginSessionRelease | null;
  /** The build this Din is, when it's running as the session. */
  running?: string | null;
  /** The session the login screen picks for the user (`din` for Din). */
  defaultSession?: string | null;
  /** The one they had before Din. */
  previousSession?: string | null;
  /** The checkout builds come from, and where it is now. */
  source?: string;
  checkout?: { commit: string; dirty: boolean } | null;
}

export interface SessionBridge {
  /** End the desktop session (quits Din). */
  end(): void;
  /** Whether Din is running as another Linux's login session, which `end` logs out of. */
  isLoginSession(): Promise<boolean>;
  status(): Promise<LoginSessionStatus>;
  /** Run an action; with install, `makeDefault` makes Din the session you log in to. */
  run(action: LoginSessionAction, makeDefault?: boolean): Promise<void>;
  /** What the running action prints, line by line. Returns an unsubscribe fn. */
  onOutput(callback: (line: string) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    session?: SessionBridge;
  }
}

/** The session bridge, or undefined when running outside the Electron shell. */
export function getSessionBridge(): SessionBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.session;
}
