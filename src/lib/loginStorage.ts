import type { NLoginStorage } from '@nostrify/react/login';

/** Whether `value` is a list of saved logins NostrLoginProvider can revive. */
function isLoginList(value: unknown): boolean {
  return Array.isArray(value) && value.every((login: unknown) => (
    typeof login === 'object' && login !== null
    && 'id' in login && typeof login.id === 'string'
    && 'type' in login && typeof login.type === 'string'
    && 'pubkey' in login && typeof login.pubkey === 'string'
  ));
}

/**
 * localStorage for NostrLoginProvider, checking what it reads first: the
 * provider parses the saved logins as it starts, and a value that isn't
 * JSON leaves it rendering nothing forever (one that isn't a list breaks it
 * later). Such a value is set aside under `<key>:invalid`, since the
 * provider writes its state straight back, and Din starts signed out.
 */
export const loginStorage: NLoginStorage = {
  getItem(key) {
    const stored = localStorage.getItem(key);
    if (!stored) return null;
    try {
      if (isLoginList(JSON.parse(stored))) return stored;
    } catch {
      // Not JSON: set aside below, like any other value that isn't logins.
    }
    localStorage.setItem(`${key}:invalid`, stored);
    console.warn(`Saved logins in ${key} were unreadable; starting signed out (the old value is in ${key}:invalid).`);
    return null;
  },
  setItem(key, value) {
    localStorage.setItem(key, value);
  },
};
