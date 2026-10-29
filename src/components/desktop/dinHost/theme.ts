import type { ThemeSnapshot } from '@/sdk/din';
import { themeFontFaces } from '@/lib/themeFontFaces';
import { fileThemeIcons } from '@/shared/themeIcons';

/**
 * The desktop's look as apps get it: every design token as the desktop
 * computes it (profile theme included), its scheme, fonts and file icons. Tailwind's own
 * internals (`--tw-*`) stay out.
 */
export function themeSnapshot(zoom: number): ThemeSnapshot {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (let i = 0; i < computed.length; i++) {
    const name = computed[i];
    if (!name.startsWith('--') || name.startsWith('--tw-')) continue;
    tokens[name.slice(2)] = computed.getPropertyValue(name).trim();
  }
  return {
    scheme: root.classList.contains('dark') ? 'dark' : 'light',
    tokens,
    fontFaces: themeFontFaces(),
    zoom,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    icons: fileThemeIcons(),
  };
}

/** Hear when the desktop's look may have changed (its root's class, style or icon theme). */
export function onThemeChange(listener: () => void): () => void {
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(listener);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-icon-theme'] });
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', schedule);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    motion.removeEventListener('change', schedule);
  };
}
