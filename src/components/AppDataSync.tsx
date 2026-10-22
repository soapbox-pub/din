import { useEffect, useRef } from 'react';
import { useNostr } from '@nostrify/react';
import { z } from 'zod';
import { useAppContext } from '@/hooks/useAppContext';
import { useAppData } from '@/hooks/useAppData';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { APP_DATA_KIND, RETIRED_APP_DATA_KEYS, appDataDTag } from '@/lib/appData';

/** Accounts whose retired app data has been looked for this session. */
const retiredChecked = new Set<string>();

/** localStorage flag recording that an account's retired app data is gone. */
function retiredDoneKey(pubkey: string): string {
  return `din:appdata-retired:${pubkey}`;
}

/**
 * Delete the events of app-data keys Din no longer syncs (NIP-09), once per
 * account, so relays stop holding e.g. the dock layout or browser history.
 */
function useDeleteRetiredAppData() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();

  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const pubkey = user?.pubkey;
  const syncEnabled = config.syncToNostr;

  useEffect(() => {
    const signer = userRef.current?.signer;
    if (!pubkey || !signer || !syncEnabled) return;
    const marker = RETIRED_APP_DATA_KEYS.join(',');
    if (localStorage.getItem(retiredDoneKey(pubkey)) === marker) return;
    if (retiredChecked.has(pubkey)) return;
    retiredChecked.add(pubkey);

    (async () => {
      const events = await nostr.query(
        [{
          kinds: [APP_DATA_KIND],
          authors: [pubkey],
          '#d': RETIRED_APP_DATA_KEYS.map(appDataDTag),
        }],
        { signal: AbortSignal.timeout(8000) },
      );
      const owned = events.filter((event) => event.pubkey === pubkey);
      const dTags = new Set(
        owned
          .map((event) => event.tags.find(([name]) => name === 'd')?.[1])
          .filter((d): d is string => d !== undefined),
      );

      if (dTags.size > 0) {
        // Some relays only honor an `a` deletion alongside the `e` of the
        // event it currently holds, so name every version we saw too.
        const deletion = await signer.signEvent({
          kind: 5,
          content: '',
          tags: [
            ...[...dTags].map((d) => ['a', `${APP_DATA_KIND}:${pubkey}:${d}`]),
            ...[...new Set(owned.map((event) => event.id))].map((id) => ['e', id]),
            ['k', String(APP_DATA_KIND)],
          ],
          created_at: Math.floor(Date.now() / 1000),
        });
        await nostr.event(deletion, { signal: AbortSignal.timeout(10_000) });
      }

      localStorage.setItem(retiredDoneKey(pubkey), marker);
    })().catch((error: unknown) => {
      retiredChecked.delete(pubkey);
      console.warn('Failed to delete retired app data:', error);
    });
  }, [pubkey, syncEnabled, nostr]);
}

/**
 * The subset of AppConfig that roams across devices via Din's encrypted
 * app-data layer. Relay and Blossom server lists are NOT included here —
 * they already have canonical homes as kinds 10002 / 10063 (see NostrSync).
 */
const SyncedSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  useAppBlossomServers: z.boolean(),
});

type SyncedSettings = z.infer<typeof SyncedSettingsSchema>;

const StoredSchema = SyncedSettingsSchema.nullable();

/**
 * AppDataSync - roams desktop settings via encrypted Nostr app data.
 *
 * Bridges `AppContext` and the `computer.din.settings` record (NIP-78 kind
 * 30078, NIP-44 encrypted to self):
 *
 * - **Remote → local:** when a newer settings record arrives (login, another
 *   device), it is applied into `AppContext`.
 * - **Local → remote:** when the user edits a synced setting (e.g. switches
 *   theme in Settings), the change is encrypted and published.
 *
 * It also deletes the relay copies of keys that are now local-only.
 *
 * Mirrors the `NostrSync` pattern: renders nothing, runs globally.
 */
export function AppDataSync() {
  useDeleteRetiredAppData();

  const { config, updateConfig } = useAppContext();
  const [remote, setRemote] = useAppData<SyncedSettings | null>(
    'settings',
    StoredSchema,
    null,
  );

  const theme = config.theme;
  const useAppBlossomServers = config.useAppBlossomServers;

  // Set when a config change originates from a remote apply, so the
  // local-edit effect doesn't echo it straight back to relays.
  const skipPushRef = useRef(false);
  // Synced fields as of the previous render; null until mounted.
  const prevConfigRef = useRef<SyncedSettings | null>(null);
  // The remote record most recently applied. A record is applied once, when
  // it arrives; re-applying it whenever local config changes would undo
  // every local edit before it could be pushed.
  const appliedRemoteRef = useRef<SyncedSettings | null>(null);

  // Remote → local: apply newer remote settings into AppContext.
  useEffect(() => {
    if (!remote || remote === appliedRemoteRef.current) return;
    appliedRemoteRef.current = remote;
    if (remote.theme === theme && remote.useAppBlossomServers === useAppBlossomServers) return;

    skipPushRef.current = true;
    updateConfig((current) => ({
      ...current,
      theme: remote.theme,
      useAppBlossomServers: remote.useAppBlossomServers,
    }));
  }, [remote, theme, useAppBlossomServers, updateConfig]);

  // Local → remote: push actual user edits (changes after mount), never the
  // initial value — otherwise a fresh device would clobber roamed settings
  // before the remote copy has a chance to load.
  useEffect(() => {
    const current: SyncedSettings = { theme, useAppBlossomServers };
    const prev = prevConfigRef.current;
    prevConfigRef.current = current;

    if (prev === null) return; // mount: nothing changed yet
    if (prev.theme === current.theme && prev.useAppBlossomServers === current.useAppBlossomServers) {
      return; // no synced field changed
    }
    if (skipPushRef.current) {
      skipPushRef.current = false; // change came from a remote apply
      return;
    }

    setRemote(current);
  }, [theme, useAppBlossomServers, setRemote]);

  return null;
}
