import { useEffect, useRef } from 'react';
import { useNostrLogin } from '@nostrify/react/login';
import { useQueryClient } from '@tanstack/react-query';

import { NOSTRD_STATUS_KEY, useNostrd } from '@/hooks/useNostrd';
import { getNostrdBridge, importToNostrd, nostrdCall, nostrdLogin, NOSTRD_LOGIN } from '@/lib/nostrd';

/**
 * Keeps Din's logins in step with nostrd, where nostrd holds the accounts.
 *
 * nostrd is the source of truth: its active account is Din's current login,
 * its other accounts are the ones to switch to, and with no active account
 * Din is signed out of them. Din's account menu changes nostrd, and this
 * follows. Logins nostrd doesn't hold (a bunker, an extension) are left as
 * they are.
 *
 * It also moves secret keys out of Din: an `nsec` login, kept in plain text
 * in localStorage, is added to nostrd and replaced by its nostrd login as soon
 * as nostrd is unlocked.
 */
export function NostrdSync() {
  const { use, status } = useNostrd();
  const { logins, addLogin, removeLogin, setLogin } = useNostrLogin();
  const queryClient = useQueryClient();
  const migrating = useRef(false);

  useEffect(() => {
    const bridge = getNostrdBridge();
    if (!use || !bridge) return;
    return bridge.onEvent(() => {
      queryClient.invalidateQueries({ queryKey: NOSTRD_STATUS_KEY });
    });
  }, [use, queryClient]);

  useEffect(() => {
    if (!use || !status || status.locked || migrating.current) return;
    const nsecLogins = logins.filter((login) => login.type === 'nsec');
    if (nsecLogins.length === 0) return;
    migrating.current = true;
    (async () => {
      for (const login of nsecLogins) {
        try {
          const pubkey = await importToNostrd(login.data.nsec);
          if (login.id === logins[0]?.id) await nostrdCall('set_active', [pubkey]);
          removeLogin(login.id);
        } catch (error) {
          console.error('nostrd: moving a key out of Din failed:', error);
        }
      }
    })().finally(() => {
      migrating.current = false;
      queryClient.invalidateQueries({ queryKey: NOSTRD_STATUS_KEY });
    });
  }, [use, status, logins, removeLogin, queryClient]);

  useEffect(() => {
    if (!use || !status) return;
    const accounts = new Set(status.accounts);
    const kept = new Map<string, string>();
    for (const login of logins) {
      if (login.type !== NOSTRD_LOGIN) continue;
      if (!status.active || !accounts.has(login.pubkey) || kept.has(login.pubkey)) {
        removeLogin(login.id);
      } else {
        kept.set(login.pubkey, login.id);
      }
    }
    if (!status.active) return;

    let activeId = kept.get(status.active);
    if (!activeId) {
      const login = nostrdLogin(status.active);
      addLogin(login);
      activeId = login.id;
    }
    if (logins[0]?.id !== activeId) setLogin(activeId);
    for (const pubkey of status.accounts) {
      if (pubkey !== status.active && !kept.has(pubkey)) addLogin(nostrdLogin(pubkey));
    }
  }, [use, status, logins, addLogin, removeLogin, setLogin]);

  return null;
}
