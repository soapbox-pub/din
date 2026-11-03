// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - giving them an EyeDropper that works under din-shell
// (see electron/eyedropper.mts).
//
// Chromium's own eyedropper hides the cursor and fills its magnifier from a
// capture of the screen it can't get under din-shell, leaving the page with
// no cursor and nothing to pick. This puts Din's in its place, in the page's
// world: open() asks Din, which freezes the screen and lets the user click a
// color on it, and resolves to `{ sRGBHex }` as Chrome's does. It keeps
// Chrome's rules: open() needs a user gesture, one pick at a time, Esc
// rejects with AbortError, and so does the page's AbortSignal, with its reason.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {() => Promise<{ color?: string, cancelled?: boolean, error?: string }>} pick
 * @param {() => void} abort
 */
function installEyeDropper(pick, abort) {
  // Chromium has one only in secure contexts, and that's where Din's goes too.
  const page = /** @type {Window & { EyeDropper?: { new (): object, prototype: object } }} */ (window);
  const NativeEyeDropper = page.EyeDropper;
  if (typeof NativeEyeDropper !== 'function') return;
  /** @type {WeakSet<object>} */
  const opening = new WeakSet();

  class EyeDropper {
    /**
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<{ sRGBHex: string }>}
     */
    open(options = {}) {
      const signal = options && options.signal;
      if (signal && signal.aborted) return Promise.reject(signal.reason);
      if (!(navigator.userActivation && navigator.userActivation.isActive)) {
        return Promise.reject(
          new DOMException("Failed to execute 'open' on 'EyeDropper': EyeDropper::open() requires user gesture.", 'NotAllowedError'),
        );
      }
      if (opening.has(this)) {
        return Promise.reject(
          new DOMException("Failed to execute 'open' on 'EyeDropper': EyeDropper is already open.", 'InvalidStateError'),
        );
      }
      opening.add(this);
      return new Promise((resolve, reject) => {
        let settled = false;
        /** @param {() => void} fn */
        const settle = (fn) => {
          if (settled) return;
          settled = true;
          opening.delete(this);
          if (signal) signal.removeEventListener('abort', onAbort);
          fn();
        };
        const onAbort = () => {
          settle(() => reject(signal ? signal.reason : new DOMException('The user aborted a request.', 'AbortError')));
          abort();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        pick().then(
          (result) => {
            if (result && typeof result.color === 'string') {
              const color = result.color;
              settle(() => resolve({ sRGBHex: color }));
            } else if (result && result.error === 'busy') {
              settle(() => reject(new DOMException("Failed to execute 'open' on 'EyeDropper': EyeDropper is already open.", 'InvalidStateError')));
            } else if (result && result.error) {
              settle(() => reject(new DOMException("Failed to execute 'open' on 'EyeDropper': EyeDropper is not available.", 'OperationError')));
            } else {
              settle(() => reject(new DOMException("Failed to execute 'open' on 'EyeDropper': The user canceled the selection.", 'AbortError')));
            }
          },
          () => settle(() => reject(new DOMException("Failed to execute 'open' on 'EyeDropper': EyeDropper is not available.", 'OperationError'))),
        );
      });
    }
  }

  // The same name and prototype chain as Chromium's, so `instanceof` and
  // feature checks still hold.
  Object.setPrototypeOf(EyeDropper.prototype, NativeEyeDropper.prototype);
  Object.defineProperty(page, 'EyeDropper', { configurable: true, writable: true, value: EyeDropper });
}

if (/^(https?|nsite|file):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installEyeDropper,
    args: [
      () => ipcRenderer.invoke('eyedropper:open'),
      () => ipcRenderer.send('eyedropper:abort'),
    ],
  });
}
