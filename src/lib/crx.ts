/**
 * Typed access to the Chrome extension bridge exposed by the Electron preload
 * (`window.dinos.crx`, see electron/preload.cjs + electron/main.cjs).
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
  /** Where it came from: the Chrome Web Store, a folder here, a .crx file, or Nostr. */
  source: 'webstore' | 'local' | 'file' | 'nostr';
  /** The folder it's loaded from, for one loaded from a folder. */
  path?: string;
  /** The `<kind>:<pubkey>:<d>` it was installed from, for one from Nostr. */
  coordinate?: string;
}

/** An installed extension made ready to publish (electron/browser-extensions.mts). */
export interface CrxExtensionExport {
  /** What its `d` tag should be. */
  identifier: string;
  /** The id it has once installed from the package. */
  extensionId: string;
  name: string;
  version: string;
  description: string;
  manifestVersion: number | null;
  /** Its manifest's `minimum_chrome_version`. */
  minimumChrome: string | null;
  permissions: string[];
  hosts: string[];
  /** The .crx. */
  crx: Uint8Array;
  icon: { name: string; mime: string; data: Uint8Array } | null;
  /** The signing key made for it, when it had none yet (PKCS#8 PEM), to keep under its `d`. */
  newKey: string | null;
}

/** Where an extension installed from Nostr came from: its app, its release's date, its asset's hash. */
export interface CrxPublishedSource {
  coordinate: string;
  publishedAt: number;
  sha256?: string;
}

/** What installing a published extension sends the main process. */
export interface CrxPublishedInstall {
  identifier: string;
  name: string;
  /** The app's `32267:<pubkey>:<d>`. */
  coordinate: string;
  /** The release's `created_at`. */
  publishedAt: number;
  inherits: string[];
  servers: string[];
  asset: { sha256: string };
}

/** The pop-up window a page's window.open asked for. */
export interface CrxPopupFeatures {
  /** Size of the page in the window, in CSS px. */
  width: number;
  height: number;
  /** Opened from a private window, so private too. */
  private: boolean;
  /** Opened from a Tor tab, so in Tor too. */
  tor?: boolean;
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
      /**
       * The page asked for a pop-up window (window.open with a size), not a
       * tab: it opens in a small window of its own, as in Chrome.
       */
      popup?: CrxPopupFeatures;
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
  /** Uninstall an installed extension by id; one loaded from a folder is only forgotten. */
  uninstallExtension(id: string): Promise<void>;
  /** Load an extension from a folder, and keep loading it from there. */
  loadUnpacked(path: string): Promise<CrxExtension>;
  /** Install an extension from a .crx file, asking the user first. */
  installFile(path: string): Promise<CrxExtension>;
  /** Load an installed extension again from its files. */
  reloadExtension(id: string): Promise<CrxExtension>;
  /** An installed extension as a .crx and its icon, for publishing it; a folder's is signed with its key in `keys`, by `d`. */
  exportExtension(id: string, keys: Record<string, string>): Promise<CrxExtensionExport>;
  /** The extensions installed from Nostr, and where each was published. */
  published(): Promise<{ id: string; source: CrxPublishedSource }[]>;
  /** Install (or update) a published extension, asking the user first. */
  installPublished(manifest: CrxPublishedInstall): Promise<{ id: string; name: string }>;
  /**
   * Subscribe to action-popup open/close requests (chrome.action popups
   * hosted in-shell). Returns an unsubscribe fn.
   */
  onActionPopup(callback: (command: CrxActionPopupCommand) => void): () => void;
  /** Report the in-shell action popup was dismissed by the user. */
  actionPopupClosed(): void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    crx?: CrxBridge;
  }
}

/** The crx bridge, or undefined when running outside the Electron shell. */
export function getCrxBridge(): CrxBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.crx;
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
