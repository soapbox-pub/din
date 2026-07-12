import { useEffect } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import type { CssCursorKeyword, CursorImage } from '@/lib/cursorTheme';

/**
 * The set of CSS cursor keywords the applier understands.
 */
const KNOWN_KEYWORDS = new Set<CssCursorKeyword>([
  'not-allowed',
  'nwse-resize',
  'nesw-resize',
  'all-scroll',
  'col-resize',
  'row-resize',
  'nw-resize',
  'ne-resize',
  'sw-resize',
  'se-resize',
  'ns-resize',
  'ew-resize',
  'crosshair',
  'progress',
  'grabbing',
  'pointer',
  'default',
  'n-resize',
  's-resize',
  'e-resize',
  'w-resize',
  'grab',
  'move',
  'text',
  'wait',
  'help',
]);

/** Elements whose `cursor: auto` resolves to the text I-beam. */
const TEXT_ENTRY_SELECTOR = [
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="email"]',
  'input[type="password"]',
  'input[type="number"]',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Map a computed `cursor` value (e.g. "pointer", "auto",
 * "url(...) 4 4, ns-resize") to the keyword we should theme. `auto` resolves
 * to `text` over text-entry elements and `default` everywhere else; anything
 * unrecognised falls back to `default` so the pointer never disappears.
 */
function keywordFromComputed(value: string, el: Element): CssCursorKeyword {
  // Take the final comma-separated fallback token of the computed value.
  const last = value.split(',').pop()?.trim() ?? 'default';
  if (last === 'auto') {
    return el.closest(TEXT_ENTRY_SELECTOR) ? 'text' : 'default';
  }
  return KNOWN_KEYWORDS.has(last as CssCursorKeyword)
    ? (last as CssCursorKeyword)
    : 'default';
}

/**
 * CursorThemeApplier - applies the user's selected custom cursor theme
 * (e.g. a `.CurXPTheme`) to the entire OS, with animation.
 *
 * CSS can't animate `cursor` declaratively, but JS can swap the
 * `cursor: url(...)` value on a timer - and then the *browser* renders the
 * cursor natively at the OS level. Compared to a JS overlay that chases the
 * pointer, this has zero movement latency, can't flash the native arrow
 * (the native cursor *is* the themed image), and costs nothing while the
 * pointer moves.
 *
 * How it works:
 *
 *   - A constructed stylesheet forces every element to `cursor: inherit`, so
 *     the single inline `cursor` value we set on `<html>` applies everywhere.
 *   - Animation is one `setTimeout` chain that rewrites that inline value
 *     with the next frame (pre-encoded PNG data URLs from parse time).
 *   - Which cursor *role* to show (arrow/hand/I-beam/resize/...) only changes
 *     when the pointer crosses into a new element, so detection runs on
 *     `pointerover` - not on every move - and is memoised per element in a
 *     WeakMap with a short TTL. A cache miss briefly lifts the overrides
 *     (synchronously, so nothing paints in between) and reads the element's
 *     intended computed cursor.
 *   - Every themed value keeps the real keyword as a fallback
 *     (`url(...) x y, pointer`), so if the browser rejects an image (e.g.
 *     oversized) the correct native cursor shows instead of nothing.
 *
 * Honors `prefers-reduced-motion` by freezing on the first frame, and pauses
 * the frame timer while the document is hidden.
 */
export function CursorThemeApplier() {
  const { config } = useAppContext();
  const theme = config.customCursor;

  useEffect(() => {
    if (!theme) return;
    const root = document.documentElement;

    // Constructed stylesheet (CSSOM rules aren't subject to CSP style-src):
    // every element inherits the cursor set inline on <html>. `!important`
    // beats Tailwind `cursor-*` utilities and component styles.
    const sheet = new CSSStyleSheet();
    sheet.insertRule('html.custom-cursor * { cursor: inherit !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    root.classList.add('custom-cursor');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Pre-decode every frame once so swaps never wait on image decode.
    const uniqueFrames = new Set<string>();
    for (const cursor of Object.values(theme.cursors)) {
      for (const frame of cursor.frames) uniqueFrames.add(frame);
    }
    const warm: HTMLImageElement[] = [];
    for (const frame of uniqueFrames) {
      const img = new Image();
      img.src = frame;
      warm.push(img);
    }

    // Precomputed CSS cursor value per keyword per frame:
    // `url("data:...") hotX hotY, keyword`.
    const valueCache = new Map<CssCursorKeyword, string[]>();
    const frameValues = (keyword: CssCursorKeyword): string[] => {
      let values = valueCache.get(keyword);
      if (!values) {
        const cursor = theme.cursors[keyword] ?? theme.cursors.default;
        values = cursor
          ? cursor.frames.map(
              (f) => `url("${f}") ${cursor.hotX} ${cursor.hotY}, ${keyword}`,
            )
          : [];
        valueCache.set(keyword, values);
      }
      return values;
    };

    let currentKeyword: CssCursorKeyword = 'default';
    let currentCursor: CursorImage | null =
      theme.cursors.default ?? Object.values(theme.cursors)[0] ?? null;
    let frameIndex = 0;
    let timer = 0;

    const applyFrame = (): void => {
      const values = frameValues(currentKeyword);
      root.style.cursor = values[frameIndex % values.length] ?? '';
    };

    const stopAnimation = (): void => {
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
    };

    const scheduleAnimation = (): void => {
      stopAnimation();
      const cursor = currentCursor;
      if (!cursor || cursor.frames.length <= 1) return;
      if (reduceMotion.matches || document.hidden) return;
      timer = window.setTimeout(() => {
        frameIndex = (frameIndex + 1) % cursor.frames.length;
        applyFrame();
        scheduleAnimation();
      }, cursor.intervalMs);
    };

    const setKeyword = (keyword: CssCursorKeyword): void => {
      if (keyword === currentKeyword) return;
      currentKeyword = keyword;
      currentCursor = theme.cursors[keyword] ?? theme.cursors.default ?? null;
      frameIndex = 0;
      applyFrame();
      scheduleAnimation();
    };

    // Per-element keyword cache. Rotated on a short TTL so elements whose
    // cursor changes (e.g. a button becoming disabled) don't stay stale.
    let cache = new WeakMap<Element, CssCursorKeyword>();
    let cacheStamp = performance.now();

    const probe = (el: Element, bypassCache = false): CssCursorKeyword => {
      const now = performance.now();
      if (now - cacheStamp > 5000) {
        cache = new WeakMap();
        cacheStamp = now;
      }
      if (!bypassCache) {
        const hit = cache.get(el);
        if (hit) return hit;
      }
      // Lift both overrides so the computed style reveals the cursor the
      // element actually asks for. All synchronous - the browser never paints
      // in between, so there is no flicker. This forces one style recalc, but
      // only on cache misses (first hover of an element), never per move.
      sheet.disabled = true;
      const previous = root.style.cursor;
      root.style.cursor = '';
      const computed = getComputedStyle(el).cursor;
      root.style.cursor = previous;
      sheet.disabled = false;
      const keyword = keywordFromComputed(computed, el);
      cache.set(el, keyword);
      return keyword;
    };

    const onPointerOver = (e: PointerEvent): void => {
      if (e.target instanceof Element) setKeyword(probe(e.target));
    };

    // `:active` styles can change an element's cursor (grab -> grabbing)
    // without a pointerover, so re-probe on button transitions.
    const onPointerButton = (e: PointerEvent): void => {
      if (e.target instanceof Element) setKeyword(probe(e.target, true));
    };

    const onVisibilityOrMotion = (): void => {
      frameIndex = 0;
      applyFrame();
      scheduleAnimation();
    };

    window.addEventListener('pointerover', onPointerOver, {
      passive: true,
      capture: true,
    });
    window.addEventListener('pointerdown', onPointerButton, {
      passive: true,
      capture: true,
    });
    window.addEventListener('pointerup', onPointerButton, {
      passive: true,
      capture: true,
    });
    document.addEventListener('visibilitychange', onVisibilityOrMotion);
    reduceMotion.addEventListener('change', onVisibilityOrMotion);

    applyFrame();
    scheduleAnimation();

    return () => {
      stopAnimation();
      window.removeEventListener('pointerover', onPointerOver, {
        capture: true,
      });
      window.removeEventListener('pointerdown', onPointerButton, {
        capture: true,
      });
      window.removeEventListener('pointerup', onPointerButton, {
        capture: true,
      });
      document.removeEventListener('visibilitychange', onVisibilityOrMotion);
      reduceMotion.removeEventListener('change', onVisibilityOrMotion);
      root.style.cursor = '';
      root.classList.remove('custom-cursor');
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (s) => s !== sheet,
      );
      warm.length = 0;
    };
  }, [theme]);

  return null;
}
