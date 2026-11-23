/**
 * Which account each site's window.nostr acts as (NostrBridgeHost).
 *
 * A site holds the identities the user gave it, one at a time: an account
 * holds a site when the account's grant for it is connected
 * (signerPermissions.ts, kept and roaming with the account). Of those, the
 * one the site was given first is window.nostr's own, recorded here, on this
 * device, since which accounts are signed in is this device's. It never
 * changes underneath the site: switching Din's account leaves it alone, and
 * only disconnecting that account from the site (or signing it out of Din)
 * lets the site be given another.
 *
 * Din's own apps (din://, din+file://) aren't here: they act as the
 * desktop's account, as the system's apps do.
 */

const STORAGE_KEY = 'din:site-identities';

type SiteIdentities = Record<string, string>;

const listeners = new Set<() => void>();
let cache: SiteIdentities | null = null;

function read(): SiteIdentities {
  if (cache) return cache;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const valid: SiteIdentities = {};
    if (parsed && typeof parsed === 'object') {
      for (const [origin, pubkey] of Object.entries(parsed)) {
        if (typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey)) valid[origin] = pubkey;
      }
    }
    cache = valid;
  } catch {
    cache = {};
  }
  return cache;
}

/** Whether an origin is one of Din's own apps, which act as the desktop's account. */
export function isDinAppOrigin(origin: string): boolean {
  return origin.startsWith('din://') || origin.startsWith('din+file://');
}

/** The account a site's window.nostr acts as, if it has been given one. */
export function siteIdentity(origin: string): string | undefined {
  return read()[origin];
}

/** Record (or, with null, forget) the account a site's window.nostr acts as. */
export function setSiteIdentity(origin: string, pubkey: string | null): void {
  const next = { ...read() };
  if (pubkey) next[origin] = pubkey;
  else delete next[origin];
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to save site identities:', error);
  }
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore. */
export function subscribeSiteIdentities(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For useSyncExternalStore: changes identity whenever any site's account does. */
export function siteIdentitiesSnapshot(): SiteIdentities {
  return read();
}
