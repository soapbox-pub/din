/**
 * Typed access to the phone login bridge exposed by the Electron preload
 * (`window.dinos.bluetoothLogin`, see electron/preload.cjs +
 * electron/bluetooth-login.mts).
 *
 * The main process advertises a Bluetooth LE service and runs the handshake;
 * this side makes the ephemeral key the phone encrypts to and decrypts what
 * arrives, so the account key never passes through the main process. In a
 * plain browser the bridge is absent and the login screen doesn't offer it.
 */

import { nip19, nip44 } from 'nostr-tools';

export type BluetoothLoginEvent =
  | { type: 'waiting' }
  | { type: 'connected' }
  | { type: 'code'; code: string }
  | { type: 'key'; phone: string; payload: string }
  | { type: 'ended'; reason: 'timeout' | 'error'; message?: string };

export interface BluetoothLoginBridge {
  available(): Promise<boolean>;
  /** Advertise for a login encrypted to `din`, an x-only pubkey in hex. */
  start(din: string): Promise<void>;
  stop(): Promise<void>;
  onEvent(callback: (event: BluetoothLoginEvent) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    bluetoothLogin?: BluetoothLoginBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getBluetoothLoginBridge(): BluetoothLoginBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.bluetoothLogin;
}

/**
 * The nsec in a `key` event, decrypted with the secret half of the key the
 * login was started with. Throws if it doesn't decrypt to a secret key.
 */
export function openKeyPayload(sk: Uint8Array, event: { phone: string; payload: string }): string {
  const conversationKey = nip44.v2.utils.getConversationKey(sk, event.phone);
  const hex = nip44.v2.decrypt(event.payload, conversationKey);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('The phone sent something that is not a key.');
  return nip19.nsecEncode(Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16)));
}

/** Strip Electron's IPC wrapper from an error message. */
export function cleanBluetoothError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
