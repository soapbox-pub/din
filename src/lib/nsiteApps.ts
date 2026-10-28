import { z } from 'zod';
import { NSITE_PROTOCOL, parseCanonicalNsiteHost } from '@/lib/nsite';

/**
 * An nsite installed as a desktop app. Like Tenna's wall, the roaming list
 * holds addresses only: the signed manifest, the files, and the name and icon
 * derived from them live in the OS-level nsite store on each device, which
 * installs whatever the list names that it doesn't have yet.
 */
export interface NsiteAppEntry {
  /**
   * Canonical, key-derived host (`npub1…` or `<pubkeyB36><dtag>`), the
   * origin the app's storage and Nostr connection belong to.
   */
  host: string;
  /** Unix seconds. */
  installedAt: number;
  /** A name the user gave the app, over the one the site declares. */
  name?: string;
}

export const NsiteAppsSchema: z.ZodType<NsiteAppEntry[]> = z.array(
  z.object({
    host: z.string().refine((host) => parseCanonicalNsiteHost(host) !== null),
    installedAt: z.number(),
    name: z.string().min(1).max(64).optional(),
  }),
);

/** App-data key: `computer.din.nsite-apps`. */
export const NSITE_APPS_KEY = 'nsite-apps';

export const NO_NSITE_APPS: NsiteAppEntry[] = [];

/** The desktop app id for an installed nsite. */
export function nsiteAppId(host: string): string {
  return `nsite-${host}`;
}

/** The URL an installed nsite opens at. */
export function nsiteAppUrl(host: string): string {
  return `${NSITE_PROTOCOL}//${host}/`;
}

/** The canonical host of an nsite URL, or null for anything else (an `naddr` included). */
export function canonicalHostOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== NSITE_PROTOCOL) return null;
    const host = parsed.hostname.toLowerCase();
    return parseCanonicalNsiteHost(host) ? host : null;
  } catch {
    return null;
  }
}
