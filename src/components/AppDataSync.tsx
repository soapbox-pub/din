import { useEffect, useRef } from 'react';
import { z } from 'zod';
import { useAppContext } from '@/hooks/useAppContext';
import { useAppData } from '@/hooks/useAppData';

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
 * Mirrors the `NostrSync` pattern: renders nothing, runs globally.
 */
export function AppDataSync() {
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

  // Remote → local: apply newer remote settings into AppContext.
  useEffect(() => {
    if (!remote) return;
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
