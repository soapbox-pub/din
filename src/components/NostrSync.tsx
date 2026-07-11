import { useEffect } from 'react';
import { useNostr } from '@nostrify/react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import { parseBlossomServerList } from '@/lib/appBlossom';
import { ACTIVE_PROFILE_THEME_KIND, parseProfileThemeEvent } from '@/lib/profileTheme';

/**
 * NostrSync - Syncs user's Nostr data
 *
 * This component runs globally to sync various Nostr data when the user logs in.
 * Currently syncs:
 * - NIP-65 relay list (kind 10002)
 * - BUD-03 Blossom server list (kind 10063)
 * - Active profile theme (kind 16767, Profile Themes NIP)
 */
export function NostrSync() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config, updateConfig } = useAppContext();

  useEffect(() => {
    if (!user) return;

    const syncRelaysFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [10002], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        if (events.length > 0) {
          const event = events[0];

          // Only update if the event is newer than our stored data
          if (event.created_at > config.relayMetadata.updatedAt) {
            const fetchedRelays = event.tags
              .filter(([name]) => name === 'r')
              .map(([_, url, marker]) => ({
                url,
                read: !marker || marker === 'read',
                write: !marker || marker === 'write',
              }));

            if (fetchedRelays.length > 0) {
              console.log('Syncing relay list from Nostr:', fetchedRelays);
              updateConfig((current) => ({
                ...current,
                relayMetadata: {
                  relays: fetchedRelays,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync relays from Nostr:', error);
      }
    };

    syncRelaysFromNostr();
  }, [user, config.relayMetadata.updatedAt, nostr, updateConfig]);

  useEffect(() => {
    if (!user) return;

    const syncBlossomServersFromNostr = async () => {
      try {
        const events = await nostr.query(
          [{ kinds: [10063], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        if (events.length > 0) {
          const event = events[0];

          // Only update if the event is newer than our stored data
          if (event.created_at > config.blossomServerMetadata.updatedAt) {
            const fetchedServers = parseBlossomServerList(event);

            if (fetchedServers.length > 0) {
              console.log('Syncing Blossom server list from Nostr:', fetchedServers);
              updateConfig((current) => ({
                ...current,
                blossomServerMetadata: {
                  servers: fetchedServers,
                  updatedAt: event.created_at,
                },
              }));
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync Blossom servers from Nostr:', error);
      }
    };

    syncBlossomServersFromNostr();
  }, [user, config.blossomServerMetadata.updatedAt, nostr, updateConfig]);

  const profileThemePubkey = config.profileThemeMetadata.pubkey;
  const profileThemeUpdatedAt = config.profileThemeMetadata.updatedAt;

  useEffect(() => {
    if (!user) return;

    const syncProfileThemeFromNostr = async () => {
      try {
        // Author filter is mandatory: kind 16767 is a user-owned replaceable
        // event, so only the logged-in user's own event may be trusted.
        const events = await nostr.query(
          [{ kinds: [ACTIVE_PROFILE_THEME_KIND], authors: [user.pubkey], limit: 1 }],
          { signal: AbortSignal.timeout(5000) }
        );

        // Stored theme belongs to a different account: replace regardless of age.
        const isStale = profileThemePubkey !== user.pubkey;

        if (events.length > 0) {
          const event = events[0];

          if (isStale || event.created_at > profileThemeUpdatedAt) {
            const theme = parseProfileThemeEvent(event);
            console.log('Syncing profile theme from Nostr:', theme);
            updateConfig((current) => ({
              ...current,
              profileThemeMetadata: {
                theme,
                pubkey: user.pubkey,
                updatedAt: event.created_at,
              },
            }));
          }
        } else if (isStale && profileThemePubkey !== null) {
          // Clear a previous account's theme so it doesn't leak across logins.
          updateConfig((current) => ({
            ...current,
            profileThemeMetadata: { theme: null, pubkey: null, updatedAt: 0 },
          }));
        }
      } catch (error) {
        console.error('Failed to sync profile theme from Nostr:', error);
      }
    };

    syncProfileThemeFromNostr();
  }, [user, profileThemePubkey, profileThemeUpdatedAt, nostr, updateConfig]);

  return null;
}
