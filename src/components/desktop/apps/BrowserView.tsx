import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react';
import { isWebviewAvailable } from '@/lib/isElectron';
import { useAppContext } from '@/hooks/useAppContext';
import { GuestClickShield } from '@/components/desktop/GuestClickShield';
import { COLLECT_ICONS_JS, type IconCandidate } from '@/lib/appIcon';

/**
 * The Electron session partition for the ad-hoc Web Browser app's tabs. The
 * Chrome extension system is attached to it (see electron/main.cjs).
 */
export const WEBBROWSER_PARTITION = 'persist:webbrowser';

/**
 * The session partition for private ("incognito") browser windows. Unlike the
 * others it is deliberately NOT prefixed with `persist:`, so Electron keeps it
 * in memory only: cookies, storage, and cache live for the life of the session
 * and are discarded once the last private tab closes. Shared by every private
 * window (like a browser's single incognito profile). The Chrome extension
 * system and NIP-07/highlight bridges are bound to the persistent sessions, so
 * private tabs get none of them - just a hardened, ephemeral surface. Must
 * match WEBBROWSER_PRIVATE_PARTITION in electron/main.mts.
 */
export const WEBBROWSER_PRIVATE_PARTITION = 'din-webbrowser-private';

/**
 * The session partition for installed web apps (WebAppFrame). Guests here get
 * the NIP-07 identity bridge so they inherit Din's login; browser tabs do not.
 * Must match WEBAPP_PARTITION in electron/main.cjs.
 */
export const APP_WEBVIEW_PARTITION = 'persist:din-apps';

/** A failed navigation reported by the surface (network-level load error). */
export interface LoadErrorInfo {
  /** The URL whose load failed. */
  url: string;
  /** Chromium's numeric error code (e.g. -105 for ERR_NAME_NOT_RESOLVED). */
  errorCode: number;
  /** Chromium's error string (e.g. `ERR_NAME_NOT_RESOLVED`). */
  errorDescription: string;
}

/** Imperative controls a BrowserView surface exposes to its parent. */
export interface BrowserViewHandle {
  reload: () => void;
  /** Reload bypassing the cache (Ctrl+Shift+R / Shift+F5). */
  reloadIgnoringCache: () => void;
  /** Navigate the surface to a new URL. */
  loadURL: (url: string) => void;
  /** Go back in the surface's own history (webview only; no-op in iframe). */
  goBack: () => void;
  /** Go forward in the surface's own history (webview only). */
  goForward: () => void;
  /**
   * Harvest the page's icon hints (link rel=icon / apple-touch-icon /
   * mask-icon plus web-app-manifest icons) for choosing an install icon.
   * Webview only; the iframe fallback resolves to an empty list.
   */
  collectIcons: () => Promise<IconCandidate[]>;
  /**
   * The page's current selection text (for pre-filling the find bar).
   * Webview only; the iframe fallback resolves to an empty string.
   */
  getSelectionText: () => Promise<string>;
}

export interface BrowserViewProps {
  /** The URL to display when the surface mounts. */
  src: string;
  /**
   * Electron session partition for the guest (webview surface only). Defaults
   * to the Web Browser's shared partition; installed apps pass
   * APP_WEBVIEW_PARTITION so they receive the Nostr identity bridge.
   */
  partition?: string;
  /** Called when the surface starts loading a page. */
  onLoadStart?: () => void;
  /** Called when the surface finishes loading (success or failure). */
  onLoadEnd?: () => void;
  /**
   * Called when a main-frame navigation fails at the network level (DNS
   * failure, connection refused, timeout, ...), with the failed URL and
   * Chromium's error code/description. Not fired for aborted loads (a link
   * clicked mid-load, or a navigation that turned into a download) or for
   * subframe failures. Only available on the Electron <webview> surface.
   */
  onLoadError?: (info: LoadErrorInfo) => void;
  /**
   * Called when the loaded page reports its title.
   * Only available on the Electron <webview> surface.
   */
  onTitleChange?: (title: string) => void;
  /**
   * Called when the loaded page reports its favicon URLs.
   * Only available on the Electron <webview> surface.
   */
  onFaviconChange?: (favicons: string[]) => void;
  /**
   * Called when the loaded page's theme color changes (its
   * `<meta name="theme-color">`), with `null` when the page has none.
   * The raw reported string is untrusted; sanitize before styling.
   * Only available on the Electron <webview> surface.
   */
  onThemeColorChange?: (color: string | null) => void;
  /**
   * Called when the surface commits a navigation (link clicks, redirects,
   * history moves), with its current back/forward availability.
   * Only available on the Electron <webview> surface.
   */
  onNavigate?: (url: string, canGoBack: boolean, canGoForward: boolean) => void;
  /**
   * Called once the guest attaches, with its WebContents id. The browser app
   * reports this to the Chrome extension system (tab tracking).
   * Only available on the Electron <webview> surface.
   */
  onWebContentsId?: (id: number) => void;
}

/**
 * A web-content rendering surface.
 *
 * Abstracts over two implementations chosen at runtime:
 *   - Electron <webview>: a real embedder that loads arbitrary sites,
 *     bypassing the X-Frame-Options / frame-ancestors restrictions that block
 *     iframes. Used when running inside the Electron shell. Navigation
 *     history is the guest's own (goBack/goForward drive the webContents).
 *   - <iframe>: the web fallback (e.g. `make dev-browser`). Subject to remote
 *     sites' framing policies, so many sites will refuse to load. Back and
 *     forward are handled by the caller (manual history).
 *
 * Surfaces only ever receive https URLs - plus chrome-extension:// URLs on
 * the webview surface, for extension options/dashboard pages (validated
 * upstream, see `isAllowedTabUrl`).
 */
export const BrowserView = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function BrowserView(props, ref) {
    return (
      // The wrapper hosts GuestClickShield: while this surface's window is
      // not on top, the shield covers an iframe guest so a click into its
      // content raises the window (iframe input never reaches this document).
      // Webview guests don't need it; see GuestClickShield.
      <div className="relative h-full w-full">
        {isWebviewAvailable() ? (
          <WebviewSurface ref={ref} {...props} />
        ) : (
          <IframeSurface ref={ref} {...props} />
        )}
        <GuestClickShield />
      </div>
    );
  },
);

const IframeSurface = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function IframeSurface({ src, onLoadStart, onLoadEnd }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    // The last URL the caller requested (reload re-requests it).
    const currentSrc = useRef(src);

    useImperativeHandle(ref, () => ({
      reload: () => {
        if (iframeRef.current) iframeRef.current.src = currentSrc.current;
        onLoadStart?.();
      },
      // The iframe fallback has no cache-bypassing reload; re-requesting the
      // URL is the closest available.
      reloadIgnoringCache: () => {
        if (iframeRef.current) iframeRef.current.src = currentSrc.current;
        onLoadStart?.();
      },
      loadURL: (url: string) => {
        currentSrc.current = url;
        if (iframeRef.current) iframeRef.current.src = url;
        onLoadStart?.();
      },
      goBack: () => {},
      goForward: () => {},
      // The iframe fallback can't reach into cross-origin guest DOM.
      collectIcons: () => Promise.resolve([]),
      getSelectionText: () => Promise.resolve(''),
    }), [onLoadStart]);

    // An <iframe> has no reliable "load started" event, so signal start once
    // on mount and end on its `load` event (loadURL signals its own starts).
    useEffect(() => {
      onLoadStart?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
      <iframe
        ref={iframeRef}
        src={src}
        title="Web content"
        className="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={onLoadEnd}
      />
    );
  },
);

const WebviewSurface = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function WebviewSurface(
    {
      src,
      partition = WEBBROWSER_PARTITION,
      onLoadStart,
      onLoadEnd,
      onLoadError,
      onTitleChange,
      onFaviconChange,
      onThemeColorChange,
      onNavigate,
      onWebContentsId,
    },
    ref,
  ) {
    // The partition is fixed for the element's lifetime (like the initial src).
    const partitionRef = useRef(partition);
    // The <webview> is created imperatively (see the mount effect below), so
    // this starts null and is filled in before any listener effect runs.
    const webviewRef = useRef<ElectronWebviewElement | null>(null);
    // Host for the imperatively-created guest.
    const containerRef = useRef<HTMLDivElement>(null);
    // The initial src is fixed for the element's lifetime; navigations go
    // through loadURL so the guest keeps its own history.
    const initialSrc = useRef(src);
    // The shell's interface zoom, applied to the guest so its content scales
    // in lockstep with the rest of the desktop (see the zoom-sync effect).
    const { config } = useAppContext();
    const zoomFactor = config.zoomLevel / 100;

    // Create the <webview> imperatively and configure it *before* inserting it
    // into the DOM. Electron reads a guest's attributes when the element is
    // connected and the guest attaches; several - notably `allowpopups` - are
    // silently ignored if set afterwards. React (both its own attribute
    // handling and ref callbacks) only sets attributes after the element is
    // already in the document, so a JSX `<webview allowpopups>` never takes
    // effect: the guest attaches with popups disabled, every target=_blank /
    // window.open dies inside the guest, and the main process's
    // setWindowOpenHandler (which re-routes those URLs to a browser tab or
    // installed app) never even fires. Building the element off-DOM and
    // appending it fully-configured is the only reliable order. Runs once;
    // the guest's own history/navigation is driven through the ref handle.
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container || webviewRef.current) return;
      const el = document.createElement('webview') as unknown as ElectronWebviewElement;
      // A partition isolates cookies/storage from the shell's own origin. The
      // Web Browser's partition is where the Chrome extension system is
      // attached (see electron/main.cjs); installed apps use their own
      // partition, which is where the Nostr identity bridge is attached.
      el.setAttribute('partition', partitionRef.current);
      // Enable guest-initiated popups (see the note above).
      el.setAttribute('allowpopups', 'true');
      el.setAttribute('src', initialSrc.current);
      el.className = 'h-full w-full bg-white';
      el.style.display = 'flex';
      webviewRef.current = el;
      container.appendChild(el);
      return () => {
        el.remove();
        webviewRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      reload: () => webviewRef.current?.reload(),
      reloadIgnoringCache: () => webviewRef.current?.reloadIgnoringCache(),
      loadURL: (url: string) => {
        webviewRef.current?.loadURL(url).catch(() => {
          // Aborted/failed loads reject; the did-fail-load path handles UI.
        });
      },
      goBack: () => webviewRef.current?.goBack(),
      goForward: () => webviewRef.current?.goForward(),
      collectIcons: async () => {
        const el = webviewRef.current;
        if (!el) return [];
        try {
          const result = await el.executeJavaScript(COLLECT_ICONS_JS);
          return Array.isArray(result) ? (result as IconCandidate[]) : [];
        } catch {
          return [];
        }
      },
      getSelectionText: async () => {
        const el = webviewRef.current;
        if (!el) return '';
        try {
          const result = await el.executeJavaScript(
            'window.getSelection ? String(window.getSelection()) : ""',
          );
          return typeof result === 'string' ? result : '';
        } catch {
          return '';
        }
      },
    }), []);

    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const start = () => onLoadStart?.();
      const stop = () => onLoadEnd?.();
      el.addEventListener('did-start-loading', start);
      el.addEventListener('did-stop-loading', stop);
      return () => {
        el.removeEventListener('did-start-loading', start);
        el.removeEventListener('did-stop-loading', stop);
      };
    }, [onLoadStart, onLoadEnd]);

    // Network-level load failures (DNS, connection refused, timeout, ...).
    // Chromium would otherwise swap in its own generic error page; the browser
    // app renders a branded interstitial over the surface instead. Subframe
    // failures and aborts (errorCode -3 / ERR_ABORTED - e.g. a load cancelled
    // because the user navigated again, or because the response turned into a
    // download) are ignored: they aren't page-level errors worth surfacing.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const failed = (e: Event) => {
        const {
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
        } = e as Event & {
          errorCode?: number;
          errorDescription?: string;
          validatedURL?: string;
          isMainFrame?: boolean;
        };
        if (isMainFrame === false || errorCode === -3) return;
        onLoadError?.({
          url: typeof validatedURL === 'string' ? validatedURL : '',
          errorCode: typeof errorCode === 'number' ? errorCode : 0,
          errorDescription:
            typeof errorDescription === 'string' ? errorDescription : '',
        });
      };
      el.addEventListener('did-fail-load', failed);
      return () => el.removeEventListener('did-fail-load', failed);
    }, [onLoadError]);

    // Page metadata (title / favicon), reported only by the Electron webview.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const title = (e: Event) => {
        const { title } = e as Event & { title?: string };
        if (typeof title === 'string') onTitleChange?.(title);
      };
      const favicon = (e: Event) => {
        const { favicons } = e as Event & { favicons?: string[] };
        if (Array.isArray(favicons)) onFaviconChange?.(favicons);
      };
      const themeColor = (e: Event) => {
        const { themeColor } = e as Event & { themeColor?: string | null };
        onThemeColorChange?.(typeof themeColor === 'string' ? themeColor : null);
      };
      el.addEventListener('page-title-updated', title);
      el.addEventListener('page-favicon-updated', favicon);
      el.addEventListener('did-change-theme-color', themeColor);
      return () => {
        el.removeEventListener('page-title-updated', title);
        el.removeEventListener('page-favicon-updated', favicon);
        el.removeEventListener('did-change-theme-color', themeColor);
      };
    }, [onTitleChange, onFaviconChange, onThemeColorChange]);

    // Committed navigations (link clicks, redirects, back/forward) keep the
    // address bar and back/forward buttons in sync with the guest.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const report = (url: unknown) => {
        if (typeof url !== 'string') return;
        onNavigate?.(url, el.canGoBack(), el.canGoForward());
      };
      const navigate = (e: Event) => {
        report((e as Event & { url?: string }).url);
      };
      const navigateInPage = (e: Event) => {
        const { url, isMainFrame } = e as Event & { url?: string; isMainFrame?: boolean };
        if (isMainFrame) report(url);
      };
      el.addEventListener('did-navigate', navigate);
      el.addEventListener('did-navigate-in-page', navigateInPage);
      return () => {
        el.removeEventListener('did-navigate', navigate);
        el.removeEventListener('did-navigate-in-page', navigateInPage);
      };
    }, [onNavigate]);

    // Keep the guest's page zoom in lockstep with the shell's interface zoom.
    // The interface zoom is applied to the shell frame via
    // webFrame.setZoomFactor (see AppProvider), which - per Electron - only
    // scales the shell frame and does NOT propagate to <webview> guests.
    // Beyond the visual mismatch, a shell frame zoomed to anything other than
    // 1 offsets the guest's mouse hit-testing, so links stop being clickable;
    // matching the guest's own zoom factor keeps its content scaled *and* its
    // clicks aligned. Chromium resets a guest's zoom on navigation, so it is
    // reapplied on every dom-ready as well as when the interface zoom changes.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const apply = () => {
        try {
          el.setZoomFactor(zoomFactor);
        } catch {
          // Guest not attached yet; the dom-ready listener retries.
        }
      };
      apply();
      el.addEventListener('dom-ready', apply);
      return () => el.removeEventListener('dom-ready', apply);
    }, [zoomFactor]);

    // Report the guest's WebContents id once it attaches (used to register
    // the tab with the Chrome extension system).
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const attached = () => {
        try {
          onWebContentsId?.(el.getWebContentsId());
        } catch {
          // Guest not attached yet; dom-ready below retries.
        }
      };
      el.addEventListener('did-attach', attached);
      el.addEventListener('dom-ready', attached);
      return () => {
        el.removeEventListener('did-attach', attached);
        el.removeEventListener('dom-ready', attached);
      };
    }, [onWebContentsId]);

    // Host for the guest built in the mount effect above. The <webview> itself
    // is not rendered by React so its attributes can be set before insertion.
    return <div ref={containerRef} className="h-full w-full" style={{ display: 'flex' }} />;
  },
);

/** Minimal typing for the Electron <webview> element methods we use. */
interface ElectronWebviewElement extends HTMLElement {
  reload(): void;
  reloadIgnoringCache(): void;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  setZoomFactor(factor: number): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
}
