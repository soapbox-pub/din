import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import {
  THEME_DEFINITION_KIND,
  buildThemeLookTags,
  parseThemeTags,
  type ProfileTheme,
} from '@/lib/profileTheme';

/**
 * Named themes (kind 36767, the "Profile Themes" NIP, shared with Ditto):
 * addressable, so a user can publish many, each under its own `d` tag, and
 * edit one by publishing it again under the same `d`. The look is carried in
 * the same `c`/`f`/`bg` tags as the profile theme (kind 16767), and parsed by
 * the same sanitizing code.
 */

export { THEME_DEFINITION_KIND };

/** The longest title and description the editor accepts, as in Ditto. */
export const THEME_TITLE_MAX = 80;
export const THEME_DESCRIPTION_MAX = 200;

export interface ThemeDefinition {
  event: NostrEvent;
  pubkey: string;
  /** The `d` tag. */
  identifier: string;
  title: string;
  description: string;
  /** The look, credited to this definition, ready to wear. */
  theme: ProfileTheme;
  createdAt: number;
}

/** Parse a kind 36767 event, or `null` without a `d` tag, a title, and the three colors. */
export function parseThemeDefinition(event: NostrEvent): ThemeDefinition | null {
  if (event.kind !== THEME_DEFINITION_KIND) return null;
  const identifier = event.tags.find(([name]) => name === 'd')?.[1];
  const title = event.tags.find(([name]) => name === 'title')?.[1]?.trim();
  if (!identifier || !title) return null;
  const look = parseThemeTags(event.tags);
  if (!look) return null;
  const description = event.tags.find(([name]) => name === 'description')?.[1]?.trim() ?? '';
  return {
    event,
    pubkey: event.pubkey,
    identifier,
    title,
    description,
    theme: { ...look, title, source: { pubkey: event.pubkey, identifier } },
    createdAt: event.created_at,
  };
}

/** The tags of a kind 36767 event, as Ditto writes them. */
export function buildThemeDefinitionTags(
  theme: ProfileTheme,
  { identifier, title, description }: { identifier: string; title: string; description?: string },
): string[][] {
  const tags: string[][] = [['d', identifier], ...buildThemeLookTags(theme), ['title', title]];
  if (description) tags.push(['description', description]);
  tags.push(['alt', `Custom theme: ${title}`], ['t', 'theme']);
  return tags;
}

/** A `d` tag made from a title, the way Ditto makes them. */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 64);
}

/** The `<kind>:<pubkey>:<d>` coordinate of a named theme. */
export function themeCoordinate(theme: { pubkey: string; identifier: string }): string {
  return `${THEME_DEFINITION_KIND}:${theme.pubkey}:${theme.identifier}`;
}

/** A named theme's shareable address. */
export function themeNaddr(theme: { pubkey: string; identifier: string }): string {
  return nip19.naddrEncode({
    kind: THEME_DEFINITION_KIND,
    pubkey: theme.pubkey,
    identifier: theme.identifier,
  });
}

/** The named theme an `naddr1…` (or `nostr:naddr1…`) names, or null. */
export function parseThemeNaddr(text: string): { pubkey: string; identifier: string } | null {
  const value = text.trim().replace(/^nostr:/, '');
  if (!value.startsWith('naddr1')) return null;
  try {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'naddr' || decoded.data.kind !== THEME_DEFINITION_KIND) return null;
    return { pubkey: decoded.data.pubkey, identifier: decoded.data.identifier };
  } catch {
    return null;
  }
}

/**
 * The newest version of each named theme, newest first, leaving out any
 * deleted (NIP-09) after it was published. Deletions only count when signed
 * by the theme's own author.
 */
export function buildThemeCatalog(events: NostrEvent[]): ThemeDefinition[] {
  const deleted = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 5) continue;
    for (const [name, value] of event.tags) {
      if (name !== 'a' || !value) continue;
      if (value.split(':')[1] !== event.pubkey) continue;
      deleted.set(value, Math.max(deleted.get(value) ?? 0, event.created_at));
    }
  }

  const newest = new Map<string, ThemeDefinition>();
  for (const event of events) {
    const theme = parseThemeDefinition(event);
    if (!theme) continue;
    const key = themeCoordinate(theme);
    const seen = newest.get(key);
    if (!seen || seen.createdAt < theme.createdAt) newest.set(key, theme);
  }

  return [...newest.values()]
    .filter((theme) => (deleted.get(themeCoordinate(theme)) ?? -1) < theme.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt);
}
