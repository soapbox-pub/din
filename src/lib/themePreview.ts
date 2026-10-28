import { useSyncExternalStore } from 'react';
import type { DesktopTheme } from '@/lib/profileTheme';

/**
 * A theme being tried on: the desktop paints it in place of the one worn
 * until it's kept or let go, and nothing is saved or published meanwhile.
 * Only what paints (ProfileThemeApplier, Wallpaper) reads it, through
 * usePaintedTheme; everything that saves reads the theme actually worn.
 */
let current: DesktopTheme | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function startThemePreview(theme: DesktopTheme) {
  current = theme;
  emit();
}

export function clearThemePreview() {
  if (!current) return;
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return current;
}

/** The theme being tried on, or null. */
export function useThemePreview(): DesktopTheme | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
