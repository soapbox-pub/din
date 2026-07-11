import { z } from 'zod';
import type { NostrEvent } from '@nostrify/nostrify';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * Profile Themes ("Profile Themes" NIP, published on NostrHub as
 * naddr1qvzqqqrcvypzqprpljlvcnpnw3pejvkkhrc3y6wvmd7vjuad0fg2ud3dky66gaxaqq88qun0ve5kcefdw35x2mt9wvvxzjzm).
 *
 * Kind 16767 is the user's replaceable "Active Profile Theme" event:
 * - `c` tags carry hex colors for the `background`, `text`, and `primary` roles.
 * - `f` tags carry optional web fonts for the `body` and `title` roles.
 * - a single optional `bg` tag carries a background image (imeta-style pairs).
 *
 * This module parses and strictly sanitizes those events. Every value that can
 * reach CSS or the network (colors, font families, URLs) is validated here at
 * the parse layer, per the project's Nostr security rules.
 */

/** Replaceable event kind for the user's active profile theme. */
export const ACTIVE_PROFILE_THEME_KIND = 16767;

const HEX_COLOR_REGEX = /^#[0-9a-f]{6}$/;

/**
 * Allowlist sanitizer for strings interpolated into CSS identifiers/strings
 * (e.g. font-family names). Keeps Unicode letters/numbers, spaces, hyphens,
 * underscores, apostrophes, and periods; strips everything else so the value
 * can never break out of a CSS string context.
 */
export function sanitizeCssString(value: string): string {
  return value.replace(/[^\p{L}\p{N} _\-'.]/gu, '');
}

const HexColorSchema = z.string().regex(HEX_COLOR_REGEX);
const HttpsUrlSchema = z.url().refine((url) => url.startsWith('https://'), {
  message: 'Only https: URLs are allowed',
});

const ThemeFontSchema = z.object({
  /** CSS font-family name (sanitized to a safe character allowlist). */
  family: z.string().min(1),
  /** Direct https URL to a font file (.woff2, .ttf, .otf). */
  url: HttpsUrlSchema,
});

export const ProfileThemeSchema = z.object({
  colors: z.object({
    background: HexColorSchema,
    text: HexColorSchema,
    primary: HexColorSchema,
  }),
  fonts: z.object({
    body: ThemeFontSchema.optional(),
    title: ThemeFontSchema.optional(),
  }),
  background: z
    .object({
      url: HttpsUrlSchema,
      mode: z.enum(['cover', 'tile']),
      mimeType: z.string().min(1),
    })
    .optional(),
  /** Human-readable theme name. */
  title: z.string().optional(),
});

export type ProfileTheme = z.infer<typeof ProfileThemeSchema>;
export type ThemeFont = z.infer<typeof ThemeFontSchema>;

/** Stored sync state for the logged-in user's active profile theme. */
export const ProfileThemeMetadataSchema = z.object({
  /** Parsed active theme, or null if the user has none (or it was invalid). */
  theme: ProfileThemeSchema.nullable(),
  /** Pubkey the theme belongs to (themes are per-account). */
  pubkey: z.string().nullable(),
  /** created_at of the kind 16767 event this state was derived from. */
  updatedAt: z.number(),
});

export type ProfileThemeMetadata = z.infer<typeof ProfileThemeMetadataSchema>;

function parseFontTag(tag: string[]): { role: 'body' | 'title'; font: ThemeFont } | null {
  const [, rawFamily, rawUrl, rawRole] = tag;
  if (!rawFamily || !rawUrl) return null;

  // Legacy f tags without a role marker are treated as "body" per the spec.
  const role = rawRole === undefined ? 'body' : rawRole;
  if (role !== 'body' && role !== 'title') return null;

  const family = sanitizeCssString(rawFamily).trim();
  const url = sanitizeUrl(rawUrl);
  if (!family || !url) return null;

  return { role, font: { family, url } };
}

function parseBackgroundTag(tag: string[]): ProfileTheme['background'] | null {
  // imeta-style variadic entries: "url <url>", "mode <mode>", "m <mime>", ...
  const pairs = new Map<string, string>();
  for (const entry of tag.slice(1)) {
    const spaceIndex = entry.indexOf(' ');
    if (spaceIndex <= 0) continue;
    const key = entry.slice(0, spaceIndex);
    const value = entry.slice(spaceIndex + 1).trim();
    if (!pairs.has(key)) pairs.set(key, value);
  }

  const url = sanitizeUrl(pairs.get('url') ?? '');
  const mode = pairs.get('mode');
  const mimeType = pairs.get('m');

  if (!url || !mimeType) return null;
  if (mode !== 'cover' && mode !== 'tile') return null;

  return { url, mode, mimeType };
}

/**
 * Parse a kind 16767 "Active Profile Theme" event into a sanitized
 * {@link ProfileTheme}. Returns `null` when the event doesn't carry the three
 * required color roles. Invalid optional parts (fonts, background) are
 * dropped gracefully rather than rejecting the whole theme.
 */
export function parseProfileThemeEvent(event: NostrEvent): ProfileTheme | null {
  if (event.kind !== ACTIVE_PROFILE_THEME_KIND) return null;

  const colors: Partial<ProfileTheme['colors']> = {};
  const fonts: ProfileTheme['fonts'] = {};
  let background: ProfileTheme['background'];
  let title: string | undefined;

  for (const tag of event.tags) {
    switch (tag[0]) {
      case 'c': {
        const [, rawColor, marker] = tag;
        const color = rawColor?.toLowerCase();
        if (!color || !HEX_COLOR_REGEX.test(color)) break;
        if (marker === 'background' || marker === 'text' || marker === 'primary') {
          colors[marker] ??= color;
        }
        break;
      }
      case 'f': {
        const parsed = parseFontTag(tag);
        if (parsed && !fonts[parsed.role]) {
          fonts[parsed.role] = parsed.font;
        }
        break;
      }
      case 'bg': {
        background ??= parseBackgroundTag(tag) ?? undefined;
        break;
      }
      case 'title': {
        title ??= tag[1];
        break;
      }
    }
  }

  // All three color roles are required by the spec.
  if (!colors.background || !colors.text || !colors.primary) return null;

  const result = ProfileThemeSchema.safeParse({
    colors,
    fonts,
    background,
    title,
  });

  return result.success ? result.data : null;
}

/** WCAG relative luminance of a "#rrggbb" color (0 = black, 1 = white). */
export function relativeLuminance(hexColor: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(hexColor.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Black or white, whichever has more contrast against the given color. */
export function contrastForeground(hexColor: string): '#000000' | '#ffffff' {
  const luminance = relativeLuminance(hexColor);
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#000000';
}
