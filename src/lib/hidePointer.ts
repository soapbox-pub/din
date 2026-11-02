/**
 * Hiding the pointer everywhere on the desktop for a moment, while Shake to
 * find the pointer draws a big one in its place (src/lib/cursorEffects).
 * The desktop's own document takes a class (its rule is in index.css); each
 * guest, whose page sets the pointer over it, takes a style sheet of its own.
 */
import { guest, guestElements, type GuestElement } from '@/platform/guest';

const CLASS = 'din-hide-pointer';
const CSS = 'html, html * { cursor: none !important; }';

/** Each guest's style sheet, by the key insertCSS gave, once it's in. */
const sheets = new Map<GuestElement, Promise<string | null>>();
let hidden = false;

/** Hide the pointer, or bring it back. */
export function setPointerHidden(hide: boolean): void {
  if (hide === hidden) return;
  hidden = hide;
  document.documentElement.classList.toggle(CLASS, hide);
  if (hide) {
    for (const el of guestElements()) {
      let added: Promise<string | null>;
      try {
        added = guest.insertCSS(el, CSS).catch(() => null);
      } catch {
        // Not attached yet.
        continue;
      }
      sheets.set(el, added);
    }
  } else {
    for (const [el, added] of sheets) {
      void added.then((key) => {
        if (key) guest.removeCSS(el, key).catch(() => {});
      });
    }
    sheets.clear();
  }
}
