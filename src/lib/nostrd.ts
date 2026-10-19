/**
 * Typed access to nostrd, the signer daemon that holds the account keys
 * (`window.nostrd`, see electron/preload.cjs + electron/nostrd.mts).
 *
 * An account kept in nostrd is a login of type `x-nostrd`: just a pubkey. Its
 * signer asks nostrd for every signature, naming the account, so the key never
 * reaches Din. In a plain browser the bridge is absent and logins work as they
 * always have.
 */

import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import { NLogin, type NLoginType } from '@nostrify/react/login';

export const NOSTRD_LOGIN = 'x-nostrd';

/** nostrd's error codes (see nostrd's README). */
export const NostrdCode = {
  InvalidParams: 3,
  NotFound: 4,
  WrongPassword: 6,
  Internal: 10,
} as const;

export interface NostrdInfo {
  /** Keep accounts in nostrd: always on DinOS, elsewhere when one is running. */
  use: boolean;
  connected: boolean;
  managed: boolean;
}

export interface NostrdStatus {
  locked: boolean;
  has_password: boolean;
  active: string | null;
  accounts: string[];
}

export type NostrdEvent = {
  event: 'locked' | 'unlocked' | 'accounts_changed' | 'active_changed' | 'connected' | 'disconnected';
};

type Reply = { result: unknown } | { error: { code: number; message: string } };

export interface NostrdBridge {
  info(): Promise<NostrdInfo>;
  call(method: string, params: unknown[]): Promise<Reply>;
  onEvent(callback: (event: NostrdEvent) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    nostrd?: NostrdBridge;
  }
}

export class NostrdError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'NostrdError';
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getNostrdBridge(): NostrdBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.nostrd;
}

/** Call a nostrd method; throws NostrdError with nostrd's code on failure. */
export async function nostrdCall<T>(method: string, params: unknown[] = []): Promise<T> {
  const bridge = getNostrdBridge();
  if (!bridge) throw new NostrdError(NostrdCode.Internal, 'The signer is not available here.');
  const reply = await bridge.call(method, params);
  if ('error' in reply) throw new NostrdError(reply.error.code, reply.error.message);
  return reply.result as T;
}

let infoPromise: Promise<NostrdInfo> | null = null;

/** Whether Din keeps its accounts in nostrd here. Asked once per session. */
export function nostrdManagesAccounts(): Promise<boolean> {
  const bridge = getNostrdBridge();
  if (!bridge) return Promise.resolve(false);
  infoPromise ??= bridge.info().catch(() => ({ use: false, connected: false, managed: false }));
  return infoPromise.then((info) => info.use);
}

/** A login for an account kept in nostrd. */
export function nostrdLogin(pubkey: string): NLoginType {
  return new NLogin(NOSTRD_LOGIN, pubkey, {}).toJSON() as NLoginType;
}

/** Add an account's secret key to nostrd, or find it there already. Returns its pubkey. */
export async function importToNostrd(nsec: string): Promise<string> {
  const { getPublicKey, nip19 } = await import('nostr-tools');
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec') throw new Error('Not a secret key.');
  const pubkey = getPublicKey(decoded.data);
  const status = await nostrdCall<NostrdStatus>('status');
  if (!status.accounts.includes(pubkey)) {
    await nostrdCall<string>('import_account', [nsec]);
  }
  return pubkey;
}

/** Signs as one nostrd account, whichever account nostrd has active. */
export class NostrdSigner implements NostrSigner {
  constructor(private readonly pubkey: string) {}

  getPublicKey(): Promise<string> {
    return Promise.resolve(this.pubkey);
  }

  signEvent(event: Omit<NostrEvent, 'id' | 'pubkey' | 'sig'>): Promise<NostrEvent> {
    return nostrdCall<NostrEvent>('sign_event', [event, this.pubkey]);
  }

  readonly nip04 = {
    encrypt: (pubkey: string, plaintext: string) =>
      nostrdCall<string>('nip04_encrypt', [pubkey, plaintext, this.pubkey]),
    decrypt: (pubkey: string, ciphertext: string) =>
      nostrdCall<string>('nip04_decrypt', [pubkey, ciphertext, this.pubkey]),
  };

  readonly nip44 = {
    encrypt: (pubkey: string, plaintext: string) =>
      nostrdCall<string>('nip44_encrypt', [pubkey, plaintext, this.pubkey]),
    decrypt: (pubkey: string, ciphertext: string) =>
      nostrdCall<string>('nip44_decrypt', [pubkey, ciphertext, this.pubkey]),
  };
}
