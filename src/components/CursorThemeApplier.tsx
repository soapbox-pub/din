import { useEffect, useRef } from 'react';
import { useAppContext } from '@/hooks/useAppContext';
import type {
  CssCursorKeyword,
  CursorImage,
  CursorTheme,
} from '@/lib/cursorTheme';

/**
 * The set of CSS cursor keywords the overlay understands, longest-first so
 * that when we scan a computed `cursor` string we match e.g. `nwse-resize`
 * before `w-resize`.
 */
const KNOWN_KEYWORDS: CssCursorKeyword[] = [
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
];

/**
 * `auto` and `default` both resolve to the arrow; everything unrecognised also
 * falls back to the default cursor so the pointer never disappears.
 */
function keywordFromComputed(value: string): CssCursorKeyword {
  // Computed values look like: "pointer", "auto", "url(...) 4 4, auto",
  // "ns-resize", etc. Take the final comma-separated fallback token.
  const last = value.split(',').pop()?.trim() ?? 'default';
  for (const keyword of KNOWN_KEYWORDS) {
    if (last === keyword) return keyword;
  }
  return 'default';
}

/**
 * CursorThemeApplier - applies the user's selected custom cursor theme
 * (e.g. a `.CurXPTheme`) to the entire OS, with animation.
 *
 * CSS `cursor:` can't animate, so instead of emitting CSS we hide the native
 * cursor (`cursor: none` under `html.custom-cursor`) and render our own cursor
 * as a fixed-position `<img>` that:
 *
 *   - follows the pointer (positioned so the theme's hot-spot sits under the
 *     real pointer location);
 *   - picks the themed image matching whatever CSS `cursor` the element under
 *     the pointer requests (so buttons show the hand, text shows the I-beam,
 *     resize edges show the resize glyphs, …); and
 *   - cycles the cursor's animation frames on a timer driven by the theme's
 *     per-cursor interval.
 *
 * Frames are PNG data URLs produced at parse time on a canvas (see
 * src/lib/cursorTheme.ts), so no event-sourced or remote strings reach the
 * DOM. Honors `prefers-reduced-motion` by freezing on the first frame.
 */
export function CursorThemeApplier() {
  const { config } = useAppContext();
  const theme = config.customCursor;

  // Keep the latest theme in a ref so the long-lived pointer/RAF loop doesn't
  // need to be torn down and rebuilt on unrelated config changes.
  const themeRef = useRef<CursorTheme | null>(theme);
  useEffect(() => {
    themeRef.current = theme;
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;

    if (!theme) {
      root.classList.remove('custom-cursor');
      return;
    }

    root.classList.add('custom-cursor');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // The cursor element. Rendered above everything, non-interactive.
    const el = document.createElement('img');
    el.setAttribute('aria-hidden', 'true');
    el.alt = '';
    el.decoding = 'sync';
    el.draggable = false;
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      imageRendering: 'auto',
      willChange: 'transform',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);

    // Current pointer position and which cursor/frame we're showing.
    let pointerX = 0;
    let pointerY = 0;
    let visible = false;
    let currentKeyword: CssCursorKeyword | null = null;
    let currentCursor: CursorImage | null = null;
    let frameIndex = 0;
    let lastFrameTime = 0;
    let rafId = 0;

    /** Choose the themed cursor for whatever is under the pointer. */
    const resolveCursor = (): void => {
      const active = themeRef.current;
      if (!active) return;

      const target = document.elementFromPoint(pointerX, pointerY);
      let keyword: CssCursorKeyword = 'default';
      if (target) {
        // Our hiding rule sets `cursor: none !important` on every element, so
        // reading computed style directly would always yield "none". Toggle
        // the class off, read the element's *intended* cursor, then toggle it
        // back — all synchronously, so the browser never paints in between and
        // there is no flicker.
        root.classList.remove('custom-cursor');
        const intended = getComputedStyle(target).cursor;
        root.classList.add('custom-cursor');
        keyword = keywordFromComputed(intended);
      }
      // Fall back to the theme's default arrow when the exact keyword isn't
      // themed (e.g. an unthemed `help` still gets *a* cursor).
      const cursor = active.cursors[keyword] ?? active.cursors.default ?? null;

      if (keyword !== currentKeyword || cursor !== currentCursor) {
        currentKeyword = keyword;
        currentCursor = cursor;
        frameIndex = 0;
        lastFrameTime = 0;
        if (cursor) {
          el.style.width = `${cursor.width}px`;
          el.style.height = `${cursor.height}px`;
          el.src = cursor.frames[0];
        }
      }
    };

    /** Position the element so its hot-spot lands on the pointer. */
    const place = (): void => {
      if (!currentCursor) return;
      const x = pointerX - currentCursor.hotX;
      const y = pointerY - currentCursor.hotY;
      el.style.transform = `translate(${x}px, ${y}px)`;
    };

    const loop = (now: number): void => {
      rafId = requestAnimationFrame(loop);
      if (!visible || !currentCursor) return;

      const frames = currentCursor.frames;
      if (frames.length > 1 && !reduceMotion.matches) {
        if (lastFrameTime === 0) lastFrameTime = now;
        if (now - lastFrameTime >= currentCursor.intervalMs) {
          frameIndex = (frameIndex + 1) % frames.length;
          el.src = frames[frameIndex];
          lastFrameTime = now;
        }
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      if (!visible) {
        visible = true;
        el.style.display = 'block';
      }
      resolveCursor();
      place();
    };

    const hide = (): void => {
      visible = false;
      el.style.display = 'none';
    };

    // Hide when the pointer leaves the document/window entirely. `pointerout`
    // with no relatedTarget fires when leaving the window; blur covers focus
    // loss (e.g. alt-tab) and mouseleave the document edge.
    const onPointerOut = (e: PointerEvent): void => {
      if (!e.relatedTarget) hide();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerMove, { passive: true });
    window.addEventListener('pointerout', onPointerOut, { passive: true });
    document.addEventListener('mouseleave', hide, { passive: true });
    window.addEventListener('blur', hide, { passive: true });

    rafId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerMove);
      window.removeEventListener('pointerup', onPointerMove);
      window.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('mouseleave', hide);
      window.removeEventListener('blur', hide);
      el.remove();
      root.classList.remove('custom-cursor');
    };
    // Re-run only when the *presence* of a theme toggles or the theme object
    // identity changes (a new theme selected). Frame data is read via the ref.
  }, [theme]);

  return null;
}
