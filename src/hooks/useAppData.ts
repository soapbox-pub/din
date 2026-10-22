import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { z } from 'zod';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import {
  APP_DATA_KIND,
  aggregateSyncState,
  appDataCacheKey,
  appDataDTag,
  deserializeAppData,
  getSyncStatesSnapshot,
  reportSyncState,
  serializeAppData,
  subscribeSyncStates,
  type AppDataRecord,
  type SyncState,
} from '@/lib/appData';

/** How long to wait after the last write before publishing to relays. */
const PUBLISH_DEBOUNCE_MS = 1500;

interface UseAppDataOptions {
  /**
   * A legacy plain-localStorage key to seed the initial value from when the
   * user has no per-pubkey cache yet (one-time migration path).
   */
  legacyKey?: string;
}

export interface AppDataMeta {
  /** Current relay-sync status of this key. */
  syncState: SyncState;
  /** Whether encrypted relay sync is possible (logged in + NIP-44 signer + sync enabled). */
  canSync: boolean;
  /** Unix seconds of the last local or remote write. */
  updatedAt: number;
}

/** Read a cached record from localStorage, validating with the schema. */
function readCache<T>(
  storageKey: string,
  schema: z.ZodType<T>,
  legacyKey: string | undefined,
  defaultValue: T,
): AppDataRecord<T> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'value' in parsed) {
        const record = parsed as { value: unknown; updatedAt?: unknown };
        return {
          value: schema.parse(record.value),
          updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
        };
      }
    }
  } catch (error) {
    console.warn(`Failed to load app data cache ${storageKey}:`, error);
  }

  // One-time migration from a legacy plain-localStorage key. Kept at
  // updatedAt 0 so any existing relay copy wins over the seed.
  if (legacyKey) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (raw !== null) {
        return { value: schema.parse(JSON.parse(raw)), updatedAt: 0 };
      }
    } catch (error) {
      console.warn(`Failed to migrate legacy key ${legacyKey}:`, error);
    }
  }

  return { value: defaultValue, updatedAt: 0 };
}

/** Persist a record to the localStorage cache. */
function writeCache<T>(storageKey: string, record: AppDataRecord<T>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(record));
  } catch (error) {
    console.warn(`Failed to write app data cache ${storageKey}:`, error);
  }
}

// ---------------------------------------------------------------------------
// Cross-instance write propagation
//
// Each `useAppData` call keeps its own React state, so without this a write in
// one component (e.g. the notifications panel advancing the read cursor) would
// not reach another mounted instance of the same key (e.g. the menu-bar clock's
// unread check) until the encrypted relay round-trip completed — making shared
// state feel laggy. Broadcasting every local write lets sibling instances of
// the same key adopt it immediately (last-write-wins by `updatedAt`), matching
// a shared-store model.
// ---------------------------------------------------------------------------

const valueListeners = new Map<string, Set<(rec: AppDataRecord<unknown>) => void>>();

/** Notify sibling instances of the same key about a fresh local write. */
function broadcastValue(storageKey: string, rec: AppDataRecord<unknown>): void {
  const listeners = valueListeners.get(storageKey);
  if (!listeners) return;
  for (const listener of listeners) listener(rec);
}

/** Subscribe to local writes for a storage key. Returns an unsubscribe fn. */
function subscribeValue(
  storageKey: string,
  listener: (rec: AppDataRecord<unknown>) => void,
): () => void {
  let listeners = valueListeners.get(storageKey);
  if (!listeners) {
    listeners = new Set();
    valueListeners.set(storageKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) valueListeners.delete(storageKey);
  };
}

/**
 * Encrypted, local-first app data storage on Nostr (NIP-78 + NIP-44).
 *
 * - **Local-first:** values load instantly from a per-pubkey localStorage
 *   cache and work fully offline or logged out.
 * - **Encrypted sync:** when the user is logged in with a NIP-44-capable
 *   signer (and sync is enabled), values are encrypted to the user's own
 *   pubkey and stored as kind 30078 events under `computer.din.<key>`.
 *   Relays only see ciphertext.
 * - **Last-write-wins:** remote and local copies reconcile by timestamp,
 *   so state roams across devices.
 *
 * @param key Din app-data key, e.g. `"pinned-apps"` (becomes `computer.din.pinned-apps`).
 * @param schema Zod schema used to validate cached and decrypted values.
 *   **Must be referentially stable** (define it at module level).
 * @param defaultValue Value used when nothing is stored yet. **Must be
 *   referentially stable** (define it at module level).
 */
export function useAppData<T>(
  key: string,
  schema: z.ZodType<T>,
  defaultValue: T,
  options: UseAppDataOptions = {},
): [T, (value: T | ((prev: T) => T)) => void, AppDataMeta] {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const dTag = appDataDTag(key);
  const pubkey = user?.pubkey ?? 'local';
  const storageKey = appDataCacheKey(pubkey, key);
  const legacyKey = options.legacyKey;

  const syncEnabled = config.syncToNostr;
  const canSync = Boolean(user?.signer.nip44) && syncEnabled;

  const [record, setRecordState] = useState<AppDataRecord<T>>(() =>
    readCache(storageKey, schema, legacyKey, defaultValue),
  );
  // Mirror of `record` for event handlers / async callbacks. Synced below.
  const recordRef = useRef(record);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  const [syncState, setSyncState] = useState<SyncState>('local');

  // Reload from the correct per-pubkey cache when the account changes.
  const prevStorageKeyRef = useRef(storageKey);
  useEffect(() => {
    if (prevStorageKeyRef.current === storageKey) return;
    prevStorageKeyRef.current = storageKey;
    const next = readCache(storageKey, schema, legacyKey, defaultValue);
    recordRef.current = next;
    // Legitimate "sync with external store" pattern (account switch).
     
    setRecordState(next);
  }, [storageKey, schema, legacyKey, defaultValue]);

  // ------------------------------------------------------------------
  // Remote fetch: pull the user's encrypted event and decrypt it.
  // ------------------------------------------------------------------
  const { data: remote } = useQuery({
    queryKey: ['app-data', pubkey, key],
    enabled: Boolean(user) && canSync,
    staleTime: 30_000,
    queryFn: async (c): Promise<AppDataRecord<T> | null> => {
      if (!user?.signer.nip44) return null;

      const signal = AbortSignal.any([c.signal, AbortSignal.timeout(8000)]);
      const events = await nostr.query(
        [{ kinds: [APP_DATA_KIND], authors: [user.pubkey], '#d': [dTag], limit: 1 }],
        { signal },
      );
      const event = events[0];
      if (!event) return null;

      try {
        const plaintext = await user.signer.nip44.decrypt(user.pubkey, event.content);
        const value = schema.parse(deserializeAppData(plaintext));
        return { value, updatedAt: event.created_at };
      } catch (error) {
        console.warn(`Failed to decrypt app data ${dTag}:`, error);
        return null;
      }
    },
  });

  // Adopt fresher writes broadcast from sibling instances of the same key, so
  // shared state (e.g. the notifications read cursor) propagates instantly
  // instead of waiting for the encrypted relay round-trip.
  useEffect(() => {
    return subscribeValue(storageKey, (rec) => {
      if (rec.updatedAt <= recordRef.current.updatedAt) return;
      const parsed = schema.safeParse(rec.value);
      if (!parsed.success) return;
      const adopted: AppDataRecord<T> = { value: parsed.data, updatedAt: rec.updatedAt };
      recordRef.current = adopted;
      setRecordState(adopted);
    });
  }, [storageKey, schema]);

  // Merge a newer remote copy into local state (last-write-wins).
  useEffect(() => {
    if (!remote) return;
    if (remote.updatedAt <= recordRef.current.updatedAt) return;
    writeCache(storageKey, remote);
    recordRef.current = remote;
    // Legitimate "sync external source" pattern, same as NostrSync.
     
    setRecordState(remote);
  }, [remote, storageKey]);

  // ------------------------------------------------------------------
  // Publish: debounced, encrypted write-back to relays.
  // ------------------------------------------------------------------
  const pendingRef = useRef<AppDataRecord<T> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishNow = useCallback(
    async (rec: AppDataRecord<T>) => {
      if (!user?.signer.nip44 || !syncEnabled) return;
      setSyncState('syncing');
      try {
        const content = await user.signer.nip44.encrypt(
          user.pubkey,
          serializeAppData(rec.value),
        );
        const event = await user.signer.signEvent({
          kind: APP_DATA_KIND,
          content,
          tags: [['d', dTag]],
          created_at: rec.updatedAt,
        });
        await nostr.event(event, { signal: AbortSignal.timeout(10_000) });
        setSyncState('synced');
      } catch (error) {
        console.error(`Failed to publish app data ${dTag}:`, error);
        setSyncState('error');
      }
    },
    [user, nostr, dTag, syncEnabled],
  );

  // Latest publish function for use in timers/cleanup without re-scheduling.
  const publishNowRef = useRef(publishNow);
  useEffect(() => {
    publishNowRef.current = publishNow;
  }, [publishNow]);

  const schedulePublish = useCallback((rec: AppDataRecord<T>) => {
    pendingRef.current = rec;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void publishNowRef.current(pending);
    }, PUBLISH_DEBOUNCE_MS);
  }, []);

  // Flush any pending publish on unmount so quick edits aren't lost.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void publishNowRef.current(pending);
    };
  }, []);

  // ------------------------------------------------------------------
  // Local writes
  // ------------------------------------------------------------------
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const next =
        value instanceof Function ? value(recordRef.current.value) : value;
      const rec: AppDataRecord<T> = {
        value: next,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      recordRef.current = rec;
      setRecordState(rec);
      writeCache(storageKey, rec);
      broadcastValue(storageKey, rec);
      schedulePublish(rec);
    },
    [storageKey, schedulePublish],
  );

  // ------------------------------------------------------------------
  // Sync-status bookkeeping
  // ------------------------------------------------------------------
  const effectiveSyncState: SyncState = canSync ? syncState : 'local';

  useEffect(() => {
    if (!canSync) {
      if (syncState !== 'local') {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSyncState('local');
      }
    } else if (remote !== undefined && syncState === 'local') {
      // Initial fetch settled (found or not) and no publish in flight.
       
      setSyncState('synced');
    }
  }, [canSync, remote, syncState]);

  useEffect(() => {
    reportSyncState(key, effectiveSyncState);
  }, [key, effectiveSyncState]);

  const meta = useMemo<AppDataMeta>(
    () => ({
      syncState: effectiveSyncState,
      canSync,
      updatedAt: record.updatedAt,
    }),
    [effectiveSyncState, canSync, record.updatedAt],
  );

  return [record.value, setValue, meta];
}

/**
 * Aggregate sync status across every `useAppData` key currently in use.
 * error > syncing > synced > local.
 */
export function useAppDataSyncStatus(): SyncState {
  const states = useSyncExternalStore(subscribeSyncStates, getSyncStatesSnapshot);
  return aggregateSyncState(states);
}
