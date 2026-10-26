import type { ThemeFont } from '@/lib/profileTheme';

export type ThemeFontCategory = 'Sans serif' | 'Serif' | 'Monospace' | 'Display' | 'Handwriting';

export interface CuratedFont extends ThemeFont {
  category: ThemeFontCategory;
}

const variable = (slug: string) =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${slug}:vf@latest/latin-wght-normal.woff2`;
const regular = (slug: string) =>
  `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.woff2`;

/**
 * The fonts Settings offers for a theme: Fontsource's CDN copies, the same
 * files Ditto names in profile themes, so a theme picked in either looks the
 * same in both.
 */
export const CURATED_FONTS: CuratedFont[] = [
  { family: 'DM Sans', url: variable('dm-sans'), category: 'Sans serif' },
  { family: 'Outfit', url: variable('outfit'), category: 'Sans serif' },
  { family: 'Montserrat', url: variable('montserrat'), category: 'Sans serif' },
  { family: 'Nunito', url: variable('nunito'), category: 'Sans serif' },
  { family: 'Lora', url: variable('lora'), category: 'Serif' },
  { family: 'Merriweather', url: variable('merriweather'), category: 'Serif' },
  { family: 'Playfair Display', url: variable('playfair-display'), category: 'Serif' },
  { family: 'JetBrains Mono', url: variable('jetbrains-mono'), category: 'Monospace' },
  { family: 'Courier Prime', url: regular('courier-prime'), category: 'Monospace' },
  { family: 'Comfortaa', url: variable('comfortaa'), category: 'Display' },
  { family: 'Fredoka', url: variable('fredoka'), category: 'Display' },
  { family: 'Press Start 2P', url: regular('press-start-2p'), category: 'Display' },
  { family: 'Silkscreen', url: regular('silkscreen'), category: 'Display' },
  { family: 'Special Elite', url: regular('special-elite'), category: 'Display' },
  { family: 'Caveat', url: regular('caveat'), category: 'Handwriting' },
  { family: 'Pacifico', url: regular('pacifico'), category: 'Handwriting' },
  { family: 'Comic Neue', url: regular('comic-neue'), category: 'Handwriting' },
];

export const THEME_FONT_CATEGORIES: ThemeFontCategory[] = [
  'Sans serif',
  'Serif',
  'Monospace',
  'Display',
  'Handwriting',
];

const previewFaces = new Set<string>();

/**
 * Load a font so it can be shown in its own face, under a name of its own
 * so a preview never stands in for the theme's font of the same family.
 * Returns the family name to use; the face swaps in once it has loaded.
 */
export function previewFamily(font: ThemeFont): string {
  const family = `Din Preview ${font.family.replace(/'/g, '')}`;
  if (!previewFaces.has(family)) {
    previewFaces.add(family);
    const face = new FontFace(family, `url("${font.url}")`);
    document.fonts.add(face);
    face.load().catch(() => {});
  }
  return family;
}
