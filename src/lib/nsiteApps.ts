import { z } from 'zod';
import { NSITE_PROTOCOL, parseCanonicalNsiteHost } from '@/lib/nsite';
import type { NsiteLink } from '@/lib/nsiteStore';

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
  /**
   * False when the user turned off its opening the websites that name it
   * (its linked websites, NsiteLink); absent or true, it opens them.
   */
  openLinks?: boolean;
}

export const NsiteAppsSchema: z.ZodType<NsiteAppEntry[]> = z.array(
  z.object({
    host: z.string().refine((host) => parseCanonicalNsiteHost(host) !== null),
    installedAt: z.number(),
    name: z.string().min(1).max(64).optional(),
    openLinks: z.boolean().optional(),
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

/**
 * Where an https link opens in a site that a website named (an NsiteLink):
 * the same path, query and fragment on the site, or null when the link is
 * on another website or outside the scope the website allows.
 */
export function linkIntoNsite(url: string, host: string, link: NsiteLink): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== link.origin || !parsed.pathname.startsWith(link.scope)) return null;
  return `${NSITE_PROTOCOL}//${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** A linked website as a person reads it: its host, and the part of it if not all. */
export function websiteLabel(link: NsiteLink): string {
  const host = new URL(link.origin).host;
  return link.scope === '/' ? host : `${host}${link.scope}`;
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
