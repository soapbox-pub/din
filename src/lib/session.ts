/**
 * Typed access to the session bridge exposed by the Electron preload
 * (`window.dinos.session`, see electron/preload.cjs).
 *
 * Ending the session quits the shell; under din-session.sh that ends the
 * login session and returns to the display manager. Saved Nostr accounts are
 * left alone. In a plain browser there is no session to end.
 */

export interface SessionBridge {
  /** End the desktop session (quits Din). */
  end(): void;
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
