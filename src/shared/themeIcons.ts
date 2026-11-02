import { useCallback, useSyncExternalStore } from 'react';
import type { FileCategory } from '@/lib/fileTypes';
import { useDinOptional } from '@/sdk/react';

/**
 * Icons from the system's icon theme, for Din's own UI: data URLs keyed by
 * freedesktop icon name. Empty while Din shows its own icons (the Din
 * theme, or a browser), and for any name the theme doesn't have; callers
 * fall back to Din's.
 *
 * The desktop looks them up (IconThemeSync) and keeps them here; apps get
 * the file-type ones in `din.theme.current.icons`.
 */

/** Icon names for each kind of file, best first; looked up by the first that the theme has. */
export const FILE_ICON_NAMES: Record<FileCategory, string[]> = {
  folder: ['folder'],
  image: ['image-x-generic'],
  video: ['video-x-generic'],
  audio: ['audio-x-generic'],
  text: ['text-x-generic'],
  code: ['text-x-script', 'text-x-generic'],
  archive: ['package-x-generic', 'application-x-archive'],
  pdf: ['application-pdf'],
  document: ['x-office-document'],
  program: ['application-x-executable'],
  disk: ['application-x-cd-image', 'media-optical'],
  other: ['unknown', 'application-octet-stream'],
};

const NO_ICONS: Record<string, string> = {};

let desktopIcons: Record<string, string> = NO_ICONS;
/** The desktop's theme icons that are glyphs to tint (a monochrome theme's), by URL. */
let desktopGlyphs = new Set<string>();
const listeners = new Set<() => void>();

function subscribeDesktop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getDesktop(): Record<string, string> {
  return desktopIcons;
}

/** Replace the desktop's theme icons, and say which of them are glyphs, by name. */
export function setDesktopThemeIcons(icons: Record<string, string>, glyphs: string[]): void {
  desktopIcons = Object.keys(icons).length > 0 ? icons : NO_ICONS;
  desktopGlyphs = new Set(glyphs.flatMap((name) => (icons[name] ? [icons[name]] : [])));
  for (const listener of listeners) listener();
}

/** The theme's file-type icons, for apps (din.theme.current.icons). */
export function fileThemeIcons(): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const names of Object.values(FILE_ICON_NAMES)) {
    const url = desktopIcons[names[0]];
    if (url) icons[names[0]] = url;
  }
  return icons;
}

/** The theme's icons, in an app or in the desktop. */
export function useThemeIcons(): Record<string, string> {
  const din = useDinOptional();
  const subscribe = useCallback(
    (listener: () => void) => (din ? din.theme.onChange(listener) : subscribeDesktop(listener)),
    [din],
  );
  const get = useCallback(() => (din ? din.theme.current.icons : getDesktop()), [din]);
  return useSyncExternalStore(subscribe, get);
}

/**
 * Whether an icon the desktop shows is one of a monochrome theme's glyphs,
 * which AppIcon draws on a tile in the colour scheme's colours. Desktop only.
 */
export function isGlyphIcon(url: string): boolean {
  return desktopGlyphs.has(url);
}

/** A theme icon, if the theme has one and it's an inline image. */
export function themeIcon(icons: Record<string, string>, names: string[]): string | null {
  const url = icons[names[0]];
  return url && url.startsWith('data:image/') ? url : null;
}
