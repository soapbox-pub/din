import { z } from 'zod';
import type { NostrEvent } from '@nostrify/nostrify';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import { isDarkThemeColor } from '@/lib/themeColor';

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

/** Addressable event kind for a named, shareable theme (see src/lib/themeDefinition.ts). */
export const THEME_DEFINITION_KIND = 36767;

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

const HEX_PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/** Who made a theme someone wears: its author, and its `d` tag when it's a named theme. */
const ThemeSourceSchema = z.object({
  pubkey: z.string().regex(HEX_PUBKEY_REGEX),
  identifier: z.string().optional(),
});

export type ThemeSource = z.infer<typeof ThemeSourceSchema>;

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
  /**
   * The named theme this one was taken from, credited in the profile theme's
   * `a`/`p` tags. Editing someone else's theme drops it.
   */
  source: ThemeSourceSchema.optional(),
});

export type ProfileTheme = z.infer<typeof ProfileThemeSchema>;
export type ThemeFont = z.infer<typeof ThemeFontSchema>;

/** The prefix of a local file's URL (see `localFileUrl` in src/lib/fs.ts). */
const LOCAL_FILE_PREFIX = 'din-file://localhost/';

/**
 * A desktop background's URL: https, or a local file on this computer, which
 * only a theme kept off the profile can use. Quotes, backslashes and line
 * breaks never appear in either once normalized, so the URL is safe inside a
 * CSS `url("…")`.
 */
const BackgroundUrlSchema = z
  .string()
  .refine((url) => !/["\\\n\r]/.test(url), { message: 'Invalid URL' })
  .refine((url) => url.startsWith(LOCAL_FILE_PREFIX) || HttpsUrlSchema.safeParse(url).success, {
    message: 'Only https: and local file URLs are allowed',
  });

/**
 * The theme the desktop wears: a profile theme, or one kept on this computer
 * only, whose background may also be a local file.
 */
export const DesktopThemeSchema = ProfileThemeSchema.extend({
  background: z
    .object({
      url: BackgroundUrlSchema,
      mode: z.enum(['cover', 'tile']),
      mimeType: z.string().min(1),
    })
    .optional(),
});

export type DesktopTheme = z.infer<typeof DesktopThemeSchema>;

/** Whether a background URL names a file on this computer. */
export function isLocalBackground(url: string): boolean {
  return url.startsWith(LOCAL_FILE_PREFIX);
}

/** A desktop theme as a profile theme, or null when it can't be one (a local background). */
export function toProfileTheme(theme: DesktopTheme): ProfileTheme | null {
  const result = ProfileThemeSchema.safeParse(theme);
  return result.success ? result.data : null;
}

/**
 * The core colors of Din's built-in light and dark themes (index.css), which
 * a new custom theme starts from.
 */
export const PRESET_THEME_COLORS: Record<'light' | 'dark', ProfileTheme['colors']> = {
  light: { background: '#ffffff', text: '#020817', primary: '#0f172a' },
  dark: { background: '#020817', text: '#f8fafc', primary: '#f8fafc' },
};

/** A theme's look as `c`, `f` and `bg` tags, shared by kinds 16767 and 36767. */
export function buildThemeLookTags(theme: ProfileTheme): string[][] {
  const tags: string[][] = [
    ['c', theme.colors.background, 'background'],
    ['c', theme.colors.text, 'text'],
    ['c', theme.colors.primary, 'primary'],
  ];
  if (theme.fonts.body) tags.push(['f', theme.fonts.body.family, theme.fonts.body.url, 'body']);
  if (theme.fonts.title) tags.push(['f', theme.fonts.title.family, theme.fonts.title.url, 'title']);
  if (theme.background) {
    const { url, mode, mimeType } = theme.background;
    tags.push(['bg', `url ${url}`, `mode ${mode}`, `m ${mimeType}`]);
  }
  return tags;
}

/**
 * The tags of a kind 16767 event for a theme, as `parseProfileThemeEvent`
 * reads them. A theme taken from a named one credits it with an `a` tag, and
 * its maker with a `p` tag when that's someone other than `author`.
 */
export function buildProfileThemeTags(theme: ProfileTheme, author?: string): string[][] {
  const tags = buildThemeLookTags(theme);
  if (theme.title) tags.push(['title', theme.title]);
  const { source } = theme;
  if (source?.identifier) {
    tags.push(['a', `${THEME_DEFINITION_KIND}:${source.pubkey}:${source.identifier}`]);
  }
  if (source && source.pubkey !== author) tags.push(['p', source.pubkey]);
  tags.push(['alt', 'Active profile theme']);
  return tags;
}

/** Whether two themes look the same: colors, fonts and background. */
export function sameThemeLook(a: ProfileTheme | DesktopTheme, b: ProfileTheme | DesktopTheme): boolean {
  const font = (f?: ThemeFont) => (f ? `${f.family}\u0000${f.url}` : '');
  const bg = (theme: ProfileTheme | DesktopTheme) =>
    theme.background ? `${theme.background.url}\u0000${theme.background.mode}` : '';
  return (
    a.colors.background === b.colors.background &&
    a.colors.text === b.colors.text &&
    a.colors.primary === b.colors.primary &&
    font(a.fonts.body) === font(b.fonts.body) &&
    font(a.fonts.title) === font(b.fonts.title) &&
    bg(a) === bg(b)
  );
}

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
 * The credit on a profile theme: the named theme in its `a` tag, or else the
 * maker in its `p` tag.
 */
function parseThemeSource(tags: string[][]): ThemeSource | undefined {
  const a = tags.find(([name]) => name === 'a')?.[1];
  if (a) {
    const [kind, pubkey, ...rest] = a.split(':');
    const identifier = rest.join(':');
    if (kind === String(THEME_DEFINITION_KIND) && HEX_PUBKEY_REGEX.test(pubkey ?? '') && identifier) {
      return { pubkey, identifier };
    }
  }
  const p = tags.find(([name]) => name === 'p')?.[1];
  return p && HEX_PUBKEY_REGEX.test(p) ? { pubkey: p } : undefined;
}

/**
 * Parse a kind 16767 "Active Profile Theme" event into a sanitized
 * {@link ProfileTheme}. Returns `null` when the event doesn't carry the three
 * required color roles. Invalid optional parts (fonts, background) are
 * dropped gracefully rather than rejecting the whole theme.
 */
export function parseProfileThemeEvent(event: NostrEvent): ProfileTheme | null {
  if (event.kind !== ACTIVE_PROFILE_THEME_KIND) return null;
  const theme = parseThemeTags(event.tags);
  if (!theme) return null;
  const source = parseThemeSource(event.tags);
  return source ? { ...theme, source } : theme;
}

/**
 * A theme's look and title from the `c`, `f`, `bg` and `title` tags kinds
 * 16767 and 36767 share, or `null` without the three required colors.
 */
export function parseThemeTags(tags: string[][]): ProfileTheme | null {
  const colors: Partial<ProfileTheme['colors']> = {};
  const fonts: ProfileTheme['fonts'] = {};
  let background: ProfileTheme['background'];
  let title: string | undefined;

  for (const tag of tags) {
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

/**
 * Whether a background color should be treated as a dark theme.
 * Same WCAG-luminance < 0.2 cutoff Ditto uses for profile themes.
 */
export function isDarkTheme(backgroundHex: string): boolean {
  return relativeLuminance(backgroundHex) < 0.2;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Convert "#rrggbb" to HSL (h 0-360, s/l 0-100). */
function hexToHsl(hexColor: string): Hsl {
  const r = parseInt(hexColor.slice(1, 3), 16) / 255;
  const g = parseInt(hexColor.slice(3, 5), 16) / 255;
  const b = parseInt(hexColor.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        break;
      case g:
        h = ((b - r) / d + 2) * 60;
        break;
      default:
        h = ((r - g) / d + 4) * 60;
    }
  }

  return { h, s: s * 100, l: l * 100 };
}

function formatHsl(h: number, s: number, l: number): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  return `hsl(${round(h)} ${round(Math.min(100, Math.max(0, s)))}% ${round(Math.min(100, Math.max(0, l)))}%)`;
}

function lighten(color: Hsl, amount: number): string {
  return formatHsl(color.h, color.s, color.l + amount);
}

function darken(color: Hsl, amount: number): string {
  return formatHsl(color.h, color.s, color.l - amount);
}

/**
 * Foreground for on-primary text: white or near-black, with the same cutoff
 * as tinted window chrome ({@link isDarkThemeColor}) — vivid mid-tone
 * primaries keep white text, bright ones get dark text.
 */
function onColorForeground(hexColor: string): string {
  return isDarkThemeColor(hexColor) ? 'hsl(0 0% 100%)' : 'hsl(222.2 84% 4.9%)';
}

/**
 * Derive the full shadcn token set from a profile theme's three core colors,
 * using the same formulas as Ditto's `deriveTokensFromCore`
 * (ditto/src/lib/colorUtils.ts):
 *
 * - card/popover: bg lightened +2 (dark) or bg as-is (light)
 * - secondary/muted: bg +8 (dark) / bg -4 (light)
 * - border/input: primary hue at reduced saturation, L 30 (dark) / 82 (light)
 * - mutedForeground: dimmed text color
 * - ring: the primary color itself
 *
 * Unlike Ditto, accent is a subtle primary-tinted surface carrying the text
 * color, as in index.css: it's the hover/selected fill for every menu item,
 * ghost button and toggle, and the full primary there drowns the UI.
 *
 * Values are emitted as full `hsl(...)` strings, matching the token format in
 * index.css.
 */
export function deriveThemeTokens(colors: ProfileTheme['colors']): Record<string, string> {
  const { background: bgHex, text: textHex, primary: primaryHex } = colors;
  const dark = isDarkTheme(bgHex);

  const bg = hexToHsl(bgHex);
  const text = hexToHsl(textHex);
  const primary = hexToHsl(primaryHex);

  // Surface colors derived from the background.
  const card = dark ? lighten(bg, 2) : formatHsl(bg.h, bg.s, bg.l);
  const secondary = dark ? lighten(bg, 8) : darken(bg, 4);
  const border = dark
    ? formatHsl(primary.h, primary.s * 0.4, 30)
    : formatHsl(primary.h, primary.s * 0.5, 82);
  const accent = dark
    ? formatHsl(primary.h, primary.s * 0.4, Math.min(bg.l + 12, 30))
    : formatHsl(primary.h, primary.s * 0.5, Math.max(bg.l - 8, 88));

  // Muted foreground: a dimmer version of the main text color.
  const mutedForeground = dark
    ? formatHsl(text.h, Math.max(text.s - 20, 0), Math.max(text.l - 30, 40))
    : formatHsl(text.h, Math.max(text.s - 30, 0), Math.min(text.l + 35, 55));

  const primaryForeground = onColorForeground(primaryHex);
  const destructive = dark ? 'hsl(0 72% 51%)' : 'hsl(0 84.2% 60.2%)';
  const destructiveForeground = dark ? 'hsl(0 0% 95%)' : 'hsl(210 40% 98%)';

  return {
    '--background': bgHex,
    '--foreground': textHex,
    '--card': card,
    '--card-foreground': textHex,
    '--popover': card,
    '--popover-foreground': textHex,
    '--primary': primaryHex,
    '--primary-foreground': primaryForeground,
    '--secondary': secondary,
    '--secondary-foreground': textHex,
    '--muted': secondary,
    '--muted-foreground': mutedForeground,
    '--accent': accent,
    '--accent-foreground': textHex,
    '--destructive': destructive,
    '--destructive-foreground': destructiveForeground,
    '--border': border,
    '--input': border,
    '--ring': primaryHex,
    '--sidebar': card,
    '--sidebar-foreground': textHex,
    '--sidebar-primary': primaryHex,
    '--sidebar-primary-foreground': primaryForeground,
    '--sidebar-accent': secondary,
    '--sidebar-accent-foreground': textHex,
    '--sidebar-border': border,
    '--sidebar-ring': primaryHex,
  };
}
