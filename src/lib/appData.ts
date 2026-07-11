import { z } from 'zod';

/**
 * Din's encrypted app-data layer (NIP-78).
 *
 * Din stores per-user desktop state (settings, taskbar pins, …) as kind 30078
 * addressable events whose `content` is NIP-44 encrypted to the user's own
 * pubkey. Relays only ever see opaque ciphertext. Each piece of state gets a
 * globally-unique `d` tag under the `computer.din.*` reverse-DNS namespace,
 * per NIP-78's recommendation.
 *
 * See NIP.md for the full schema documentation.
 */

/** NIP-78 "Arbitrary custom app data" kind. */
export const APP_DATA_KIND = 30078;

/** Reverse-DNS namespace prefix for all of Din's `d` tags. */
export const APP_DATA_NAMESPACE = 'computer.din';

/** Build the `d` tag value for a Din app-data key (e.g. `settings`). */
export function appDataDTag(key: string): string {
  return `${APP_DATA_NAMESPACE}.${key}`;
}

/** localStorage cache key for a user's app-data record (keyed by pubkey to prevent cross-account leakage). */
export function appDataCacheKey(pubkey: string, key: string): string {
  return `din:appdata:${pubkey}:${key}`;
}

/**
 * Versioned plaintext envelope. This is what gets JSON-serialized and NIP-44
 * encrypted into the event `content`.
 */
export const AppDataEnvelopeSchema = z.object({
  v: z.literal(1),
  data: z.unknown(),
});

/** Serialize a value into the plaintext envelope for encryption. */
export function serializeAppData(data: unknown): string {
  return JSON.stringify({ v: 1, data });
}

/**
 * Parse a decrypted envelope string back into its inner data.
 * Throws if the envelope is malformed.
 */
export function deserializeAppData(plaintext: string): unknown {
  const envelope = AppDataEnvelopeSchema.parse(JSON.parse(plaintext));
  return envelope.data;
}

/** A locally-cached app-data value plus its last-write timestamp. */
export interface AppDataRecord<T> {
  value: T;
  /** Unix seconds. Compared against event `created_at` for last-write-wins. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Sync-status store
//
// A tiny module-level store (useSyncExternalStore-compatible) so that any
// part of the UI (e.g. the Settings app) can display the aggregate sync
// status of every `useAppData` key without prop drilling.
// ---------------------------------------------------------------------------

export type SyncState = 'local' | 'syncing' | 'synced' | 'error';

let syncStates: ReadonlyMap<string, SyncState> = new Map();
const syncListeners = new Set<() => void>();

/** Report the sync state for an app-data key. Called by `useAppData`. */
export function reportSyncState(key: string, state: SyncState): void {
  if (syncStates.get(key) === state) return;
  const next = new Map(syncStates);
  next.set(key, state);
  syncStates = next;
  for (const listener of syncListeners) listener();
}

/** Subscribe to sync-state changes (for `useSyncExternalStore`). */
export function subscribeSyncStates(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}

/** Current snapshot of all reported sync states (for `useSyncExternalStore`). */
export function getSyncStatesSnapshot(): ReadonlyMap<string, SyncState> {
  return syncStates;
}

/**
 * Collapse the per-key states into one overall status:
 * error > syncing > synced > local.
 */
export function aggregateSyncState(states: ReadonlyMap<string, SyncState>): SyncState {
  const values = [...states.values()];
  if (values.includes('error')) return 'error';
  if (values.includes('syncing')) return 'syncing';
  if (values.includes('synced')) return 'synced';
  return 'local';
}
