import type { DetailedHTMLProps, HTMLAttributes } from 'react';

/**
 * JSX typing for Electron-shell-only elements used by the web browser app.
 * (<webview> is deliberately absent: guests are created only by
 * src/platform/, see docs/guest-surfaces.md.)
 *
 *   - <browser-action-list>: the Chrome extension toolbar-actions custom
 *     element injected by electron-chrome-extensions' preload (see
 *     `ensureBrowserActionPreload` in electron/main.cjs).
 *
 * Only the attributes the shell actually sets are declared.
 */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          /** Session partition the extensions are loaded in. */
          partition?: string;
          /** WebContents id of the tab whose action state to display. */
          tab?: string;
          /** Popup alignment relative to the action button. */
          alignment?: string;
        },
        HTMLElement
      >;
    }
  }
}

export {};
