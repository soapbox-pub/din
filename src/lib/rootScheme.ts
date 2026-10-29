import type { Theme } from '@/contexts/AppContext';

/**
 * The desktop's `light`/`dark` class on <html>, which `dark:` variants,
 * built-in apps (through din.theme) and the Terminal all read. Two things
 * decide it: the Light/Dark/System setting, and a painted profile theme,
 * which wins. They used to write the class separately, so a change in the
 * system's preference rewrote it under a dark profile theme, and the
 * desktop drew dark colors while saying it was light.
 */
let configured: Theme = 'light';
let painted: 'light' | 'dark' | null = null;
let listening = false;

function systemScheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(): void {
  const scheme = painted ?? (configured === 'system' ? systemScheme() : configured);
  const { classList } = document.documentElement;
  classList.toggle('dark', scheme === 'dark');
  classList.toggle('light', scheme === 'light');
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (configured === 'system') apply();
  });
}

/** The Light/Dark/System setting. */
export function setConfiguredTheme(theme: Theme): void {
  configured = theme;
  listen();
  apply();
}

/** A painted profile theme's own mode, or null when none is painted. */
export function setPaintedScheme(scheme: 'light' | 'dark' | null): void {
  painted = scheme;
  apply();
}
