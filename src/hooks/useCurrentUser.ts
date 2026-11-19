import { type NLoginType, NUser, useNostrLogin } from '@nostrify/react/login';
import { useNostr } from '@nostrify/react';
import { NSecSigner } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { useCallback, useMemo } from 'react';

import { useAuthor } from './useAuthor.ts';
import { NOSTRD_LOGIN, NostrdSigner } from '@/lib/nostrd';
import { NBrowserBitcoinSigner, NConnectBitcoinSigner, NSecBitcoinSigner } from '@/lib/bitcoinSigners';

export function useCurrentUser() {
  const { nostr } = useNostr();
  const { logins } = useNostrLogin();

  const loginToUser = useCallback((login: NLoginType): NUser  => {
    switch (login.type) {
      // Each signer can sign Bitcoin transactions too (src/lib/bitcoinSigners.ts).
      case 'nsec': { // Nostr login with secret key
        const sk = nip19.decode(login.data.nsec);
        if (sk.type !== 'nsec') throw new Error('Not a secret key');
        return new NUser(login.type, login.pubkey, new NSecBitcoinSigner(sk.data));
      }
      case 'bunker': { // Nostr login with NIP-46 "bunker://" URI
        const clientSk = nip19.decode(login.data.clientNsec);
        if (clientSk.type !== 'nsec') throw new Error('Not a secret key');
        return new NUser(login.type, login.pubkey, new NConnectBitcoinSigner({
          relay: nostr.group(login.data.relays),
          pubkey: login.data.bunkerPubkey,
          signer: new NSecSigner(clientSk.data),
          timeout: 60_000,
        }));
      }
      case 'extension': // Nostr login with NIP-07 browser extension
        return new NUser(login.type, login.pubkey, new NBrowserBitcoinSigner());
      case NOSTRD_LOGIN: // An account kept in nostrd, the system's signer
        return new NUser(NOSTRD_LOGIN, login.pubkey, new NostrdSigner(login.pubkey));
      // Other login types can be defined here
      default:
        throw new Error(`Unsupported login type: ${login.type}`);
    }
  }, [nostr]);

  const users = useMemo(() => {
    const users: NUser[] = [];

    for (const login of logins) {
      try {
        const user = loginToUser(login);
        users.push(user);
      } catch (error) {
        console.warn('Skipped invalid login', login.id, error);
      }
    }

    return users;
  }, [logins, loginToUser]);

  const user = users[0] as NUser | undefined;
  const author = useAuthor(user?.pubkey);

  return {
    user,
    users,
    ...author.data,
  };
}
