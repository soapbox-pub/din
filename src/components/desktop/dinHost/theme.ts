import type { ThemeSnapshot } from '@/sdk/din';
import { themeFontFaces } from '@/lib/themeFontFaces';
import { fileThemeIcons } from '@/shared/themeIcons';
import { INCREASE_CONTRAST_ATTRIBUTE } from '@/lib/accessibility';

/**
 * The desktop's look as apps get it: every design token as the desktop
 * computes it (profile theme included, and Increase contrast's stronger
 * ones), its scheme, fonts and file icons. Tailwind's own internals
 * (`--tw-*`) stay out. Settings → Accessibility reach apps as media
 * features instead (electron/accessibility.mts).
 */
export function themeSnapshot(): ThemeSnapshot {
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
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-icon-theme', INCREASE_CONTRAST_ATTRIBUTE],
  });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}
