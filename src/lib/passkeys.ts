/**
 * Typed access to the Web Browser's passkeys (electron/passkeys.mts):
 * `window.dinos.passkeys`, the desktop's alone. A web page asking to make a
 * passkey, or to sign in with one, comes here as a request for the user to
 * answer; the passkeys themselves stay in main, in the Passwords vault.
 */

/** A page's request, as the desktop shows it. */
export interface PasskeyRequest {
  requestId: number;
  /** The page's webContents. */
  wcId: number;
  kind: 'create' | 'get';
  /** The site (relying party) the passkey is for. */
  site: string;
  /** What the site calls itself, when making one. */
  rpName: string;
  /** The account a new passkey is for. */
  username: string;
  vault: 'open' | 'locked' | 'missing';
  /** Signing in: the vault's passkeys the site may use. */
  accounts: { id: string; username: string; title: string }[];
  /** Making one: the vault has one for this account already, which the site asked not to replace. */
  excluded: boolean;
  /** Making one: it replaces the vault's passkey for this account. */
  replaces: boolean;
}

export type PasskeyAnswer =
  | { type: 'create' }
  | { type: 'get'; id: string }
  | { type: 'security-key' }
  | { type: 'cancel' };

export interface PasskeysDesktopBridge {
  answer(requestId: number, answer: PasskeyAnswer): Promise<void>;
  /** What's waiting, for a desktop that just loaded. */
  pending(): Promise<PasskeyRequest[]>;
  /** A new request, or one whose choices changed (the vault unlocked). */
  onRequest(callback: (request: PasskeyRequest) => void): () => void;
  /** Answered, timed out, or given up on by its page. */
  onGone(callback: (requestId: number) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    passkeys?: PasskeysDesktopBridge;
  }
}

export function getPasskeysBridge(): PasskeysDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.passkeys;
}
