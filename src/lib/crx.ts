/**
 * Typed access to the Chrome extension bridge exposed by the Electron preload
 * (`window.crx`, see electron/preload.cjs + electron/main.cjs).
 *
 * The bridge lets the Web Browser app coordinate its tab UI with the Chrome
 * extension system running in the main process (electron-chrome-extensions):
 *   - extensions issue tab commands (create/open/select/close) that the shell
 *     must apply to its <webview>-based tabs
 *   - the shell reports the active tab and answers tab-creation requests with
 *     the new guest's WebContents id
 *   - the extensions manager UI lists/uninstalls installed extensions
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getCrxBridge()` and hide extension UI.
 */

/** An installed Chrome extension, as reported by the main process. */
export interface CrxExtension {
  id: string;
  name: string;
  version: string;
  description: string;
}

/** A tab command initiated by the extension system (or a page's window.open). */
export type CrxTabCommand =
  | {
      /** chrome.tabs.create: open a tab and answer with resolveCreateTab. */
      type: 'create';
      requestId: number;
      url?: string;
      active: boolean;
    }
  | {
      /** target=_blank / window.open from a page: open a tab. */
      type: 'open';
      url: string;
      /**
       * WebContents id of the tab that opened the link, when the command came
       * from a page (absent for desktop-initiated opens like terminal links).
       * Routes the new tab into the *same* browser window - and therefore the
       * same session - as its opener, so a private-window link never lands in
       * the persistent, authenticated session (or vice versa).
       */
      openerWcId?: number;
      /**
       * Open the tab in the background, Chrome-style: don't activate it or
       * raise the window. Set for middle-click / Ctrl+Cmd-click opens and the
       * "Open link in new tab" context-menu item; absent (foreground) for
       * plain target=_blank, window.open, and desktop-initiated opens.
       */
      background?: boolean;
    }
  | {
      /** chrome.tabs.update({ active: true }): activate the matching tab. */
      type: 'select';
      wcId: number;
    }
  | {
      /** chrome.tabs.remove: close the matching tab. */
      type: 'close';
      wcId: number;
    };

/** The bounding rect of an extension action button, in shell-viewport CSS px. */
export interface CrxPopupAnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * An action-popup command from the main process: open the given popup URL in
 * an in-shell overlay anchored to the action button, or close the open one.
 * See ExtensionPopupHost and the activateClick override in electron/main.mts.
 */
export type CrxActionPopupCommand =
  | {
      type: 'open';
      extensionId: string;
      url: string;
      anchorRect: CrxPopupAnchorRect;
    }
  | { type: 'close' };

export interface CrxBridge {
  /** Report the active browser tab's webContents id. */
  tabActivated(wcId: number): void;
  /** Answer a `create` command with the new guest's webContents id. */
  resolveCreateTab(requestId: number, wcId: number): void;
  /** Subscribe to extension-initiated tab commands. Returns unsubscribe fn. */
  onTabCommand(callback: (command: CrxTabCommand) => void): () => void;
  /** Installed extensions. */
  listExtensions(): Promise<CrxExtension[]>;
  /** Uninstall an installed extension by id. */
  uninstallExtension(id: string): Promise<void>;
  /**
   * Subscribe to action-popup open/close requests (chrome.action popups
   * hosted in-shell). Returns an unsubscribe fn.
   */
  onActionPopup(callback: (command: CrxActionPopupCommand) => void): () => void;
  /** Report the in-shell action popup was dismissed by the user. */
  actionPopupClosed(): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    crx?: CrxBridge;
  }
}

/** The crx bridge, or undefined when running outside the Electron shell. */
export function getCrxBridge(): CrxBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.crx;
}

/**
 * Whether a URL may be loaded in a browser tab. Mirrors the top-level
 * navigation policy (see `sanitizeNavigationUrl`): `https:` plus `http:` so
 * dev servers and plain-http sites reachable from the address bar are equally
 * reachable when a tab is opened for you (terminal link clicks, target=_blank,
 * chrome.tabs.create). Safe because tabs load in the out-of-CSP `<webview>`,
 * not the app DOM. `chrome-extension:` is additionally allowed for extension
 * pages (options/dashboard), which only exist inside the browser's extension
 * system, and `nsite:` for NIP-5A sites Din serves itself.
 */
export function isAllowedTabUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return (
      protocol === 'https:' ||
      protocol === 'http:' ||
      protocol === 'chrome-extension:' ||
      protocol === 'nsite:'
    );
  } catch {
    return false;
  }
}

/** Icon URL for an installed extension (served by the crx:// protocol). */
export function crxIconUrl(extensionId: string, size = 32): string {
  return `crx://extension-icon/${extensionId}/${size}/1`;
}
