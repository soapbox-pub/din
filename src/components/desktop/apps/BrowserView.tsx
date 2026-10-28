import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { RotateCw, Unplug } from 'lucide-react';
import { activeFileDrag, fileDragActive, subscribeFileDrag } from '@/components/desktop/apps/files/dnd';
import { Button } from '@/components/ui/button';
import { isWebviewAvailable } from '@/lib/isElectron';
import { useAppContext } from '@/hooks/useAppContext';
import { COLLECT_ICONS_JS, type IconCandidate } from '@/lib/appIcon';
import { shownUrl } from '@/lib/tor';
import { useWindowVisible } from '@/contexts/WindowVisibleContext';

/**
 * The Electron session partition for the Web Browser app's tabs and for
 * installed web apps, which share the browser's profile as Chrome's installed
 * apps do. The Chrome extension system is attached to it (see
 * electron/main.mts).
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
 * The session partition for browser tabs on onion services, from normal and
 * private windows alike. Every request in it goes through Tor, and a tab
 * moves into it, and out again, as it goes to and from .onion addresses.
 * In memory only, like the private one. Must match WEBBROWSER_TOR_PARTITION
 * in electron/main.mts.
 */
export const WEBBROWSER_TOR_PARTITION = 'din-webbrowser-tor';

/**
 * What an installed app's <webview> carries in its `webpreferences`, telling
 * the main process it's the app's window and not a browser tab. Must match
 * APP_GUEST_MARK in electron/main.mts.
 */
const APP_GUEST_MARK = 'dinInstalledApp=yes';

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
  /** Give the page keyboard focus. */
  focus: () => void;
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
   * to the Web Browser's shared partition.
   */
  partition?: string;
  /**
   * The guest is an installed app's window (webview surface only): in the
   * browser's partition, but pinned to its origin and connected to the user's
   * Nostr account, and not a browser tab.
   */
  installedApp?: boolean;
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
  /**
   * The page's own zoom (Ctrl+= / Ctrl+- / Ctrl+0), on top of the shell's
   * interface zoom. 1 is 100%. Only applied on the Electron <webview> surface.
   */
  pageZoom?: number;
  /**
   * Whether the caller is hiding the surface (a background tab). The page is
   * told it's hidden - as it is, too, while the surface's window is
   * minimized - so it can pause itself. Only applied on the Electron
   * <webview> surface.
   */
  hidden?: boolean;
}

interface GuestVisibilityBridge {
  set(webContentsId: number, hidden: boolean): void;
}

interface GuestFileDropBridge {
  send(webContentsId: number, type: 'over' | 'drop' | 'cancel', x: number, y: number, paths: string[]): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    guestVisibility?: GuestVisibilityBridge;
    /** Present only inside the Electron shell. */
    guestFileDrop?: GuestFileDropBridge;
  }
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
 * Surfaces only ever receive https URLs (and view-source: views of them) -
 * plus chrome-extension:// URLs on the webview surface, for extension
 * options/dashboard pages (validated upstream, see `isAllowedTabUrl`).
 */
export const BrowserView = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function BrowserView(props, ref) {
    return isWebviewAvailable() ? (
      <WebviewSurface ref={ref} {...props} />
    ) : (
      <IframeSurface ref={ref} {...props} />
    );
  },
);

/**
 * Whether `iframe` is showing `url`, fully loaded. Only answerable for a
 * same-origin document (about:blank); a cross-origin one, or a navigation
 * still pending on the initial empty document, reads as not finished.
 */
function finishedLoading(iframe: HTMLIFrameElement | null, url: string): boolean {
  try {
    const win = iframe?.contentWindow;
    return win?.location.href === url && win.document.readyState === 'complete';
  } catch {
    return false;
  }
}

const IframeSurface = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function IframeSurface({ src, onLoadStart, onLoadEnd }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    // The last URL the caller requested (reload re-requests it).
    const currentSrc = useRef(src);

    useImperativeHandle(ref, () => ({
      reload: () => {
        onLoadStart?.();
        if (iframeRef.current) iframeRef.current.src = currentSrc.current;
      },
      // The iframe fallback has no cache-bypassing reload; re-requesting the
      // URL is the closest available.
      reloadIgnoringCache: () => {
        onLoadStart?.();
        if (iframeRef.current) iframeRef.current.src = currentSrc.current;
      },
      loadURL: (url: string) => {
        currentSrc.current = url;
        // Start before navigating: about:blank can finish synchronously,
        // inside the assignment, and an end before its start sticks.
        onLoadStart?.();
        if (iframeRef.current) iframeRef.current.src = url;
      },
      goBack: () => {},
      goForward: () => {},
      focus: () => iframeRef.current?.focus(),
      // The iframe fallback can't reach into cross-origin guest DOM.
      collectIcons: () => Promise.resolve([]),
      getSelectionText: () => Promise.resolve(''),
    }), [onLoadStart]);

    // An <iframe> has no reliable "load started" event, so signal start once
    // on mount and end on its `load` event (loadURL signals its own starts).
    // Unless the requested document already finished: about:blank (every new
    // tab) loads synchronously as React inserts the iframe, and React drops
    // events fired during its commit, so that `load` never arrives and the
    // tab would sit "loading" - spinner and progress bar animating - forever.
    useEffect(() => {
      if (!finishedLoading(iframeRef.current, currentSrc.current)) onLoadStart?.();
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
      installedApp = false,
      onLoadStart,
      onLoadEnd,
      onLoadError,
      onTitleChange,
      onFaviconChange,
      onThemeColorChange,
      onNavigate,
      onWebContentsId,
      pageZoom = 1,
      hidden = false,
    },
    ref,
  ) {
    const windowVisible = useWindowVisible();
    const pageHidden = hidden || !windowVisible;
    // The partition is fixed for the element's lifetime (like the initial src),
    // and so is whether it's an installed app's window.
    const partitionRef = useRef(partition);
    const installedAppRef = useRef(installedApp);
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
    const zoomFactor = (config.zoomLevel / 100) * pageZoom;

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
      // Web Browser's partition, which installed apps share, is where the
      // Chrome extension system and the Nostr identity bridge are attached
      // (see electron/main.mts).
      el.setAttribute('partition', partitionRef.current);
      if (installedAppRef.current) el.setAttribute('webpreferences', APP_GUEST_MARK);
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
      focus: () => webviewRef.current?.focus(),
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
          url: typeof validatedURL === 'string' ? shownUrl(validatedURL) : '',
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
        // A page-source view commits its inner URL; only getURL() has the
        // `view-source:` prefix the tab must keep.
        const current = el.getURL();
        onNavigate?.(
          current === `view-source:${url}` ? `view-source:${shownUrl(url)}` : shownUrl(url),
          el.canGoBack(),
          el.canGoForward(),
        );
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
    // reapplied on every dom-ready as well as when the interface zoom (or the
    // tab's own page zoom) changes.
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

    // The page's renderer went away: it crashed, ran out of memory, or was
    // ended from the System Monitor. Chromium leaves the guest blank, so say
    // what happened and offer a reload (which starts a fresh renderer).
    const [gone, setGone] = useState(false);
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const crashed = () => {
        setGone(true);
        onLoadEnd?.();
      };
      const loading = () => setGone(false);
      el.addEventListener('render-process-gone', crashed);
      el.addEventListener('did-start-loading', loading);
      return () => {
        el.removeEventListener('render-process-gone', crashed);
        el.removeEventListener('did-start-loading', loading);
      };
    }, [onLoadEnd]);

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

    // Tell the page whether it's showing. Electron hands a guest its window's
    // visibility, so a background tab or a minimized window's page would
    // otherwise think it's visible and keep its videos and loops running
    // (see guestVisibility in electron/main.mts). Restated once the guest
    // attaches, since there's no WebContents to address before then; the
    // main process ignores repeats.
    useEffect(() => {
      const el = webviewRef.current;
      const bridge = window.guestVisibility;
      if (!el || !bridge) return;
      const report = () => {
        try {
          bridge.set(el.getWebContentsId(), pageHidden);
        } catch {
          // Guest not attached yet; did-attach retries.
        }
      };
      report();
      el.addEventListener('did-attach', report);
      el.addEventListener('dom-ready', report);
      return () => {
        el.removeEventListener('did-attach', report);
        el.removeEventListener('dom-ready', report);
      };
    }, [pageHidden]);

    // Files dragged from Files: a drag over the guest would go to the page,
    // as paths it can't open, so the shell takes it and has the page dropped
    // on with the files themselves (see guestFileDrop in electron/main.mts).
    const fileDrag = useSyncExternalStore(subscribeFileDrag, fileDragActive);
    const sendFileDrag = (type: 'over' | 'drop' | 'cancel', event: React.DragEvent<HTMLElement>) => {
      const el = webviewRef.current;
      const bridge = window.guestFileDrop;
      if (!el || !bridge) return;
      // The page's CSS pixels: the shell's, through any transform on the
      // window, then the page's own zoom on top of the interface zoom.
      const rect = event.currentTarget.getBoundingClientRect();
      const scaleX = rect.width > 0 ? event.currentTarget.clientWidth / rect.width : 1;
      const scaleY = rect.height > 0 ? event.currentTarget.clientHeight / rect.height : 1;
      const x = ((event.clientX - rect.left) * scaleX) / pageZoom;
      const y = ((event.clientY - rect.top) * scaleY) / pageZoom;
      try {
        bridge.send(el.getWebContentsId(), type, x, y, activeFileDrag(event)?.paths ?? []);
      } catch {
        // Guest not attached yet.
      }
    };
    // A drag that ended without leaving the page (dropped elsewhere by a key,
    // say) still lets go of it; one already dropped or left is ignored.
    useEffect(() => {
      const el = webviewRef.current;
      if (fileDrag || !el || !window.guestFileDrop) return;
      try {
        window.guestFileDrop.send(el.getWebContentsId(), 'cancel', 0, 0, []);
      } catch {
        // Guest not attached yet.
      }
    }, [fileDrag]);

    // Host for the guest built in the mount effect above. The <webview> itself
    // is not rendered by React so its attributes can be set before insertion.
    return (
      <div className="relative h-full w-full" style={{ display: 'flex' }}>
        <div ref={containerRef} className="h-full w-full" style={{ display: 'flex' }} />
        {fileDrag && window.guestFileDrop && (
          <div
            className="absolute inset-0 z-10"
            onDragOver={(event) => {
              if (!activeFileDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              sendFileDrag('over', event);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) sendFileDrag('cancel', event);
            }}
            onDrop={(event) => {
              if (!activeFileDrag(event)) return;
              event.preventDefault();
              sendFileDrag('drop', event);
            }}
          />
        )}
        {gone && <PageGone onReload={() => webviewRef.current?.reload()} />}
      </div>
    );
  },
);

/** Shown over a page whose renderer is gone, with a way to start it again. */
function PageGone({ onReload }: { onReload: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-background p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Unplug className="size-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold leading-tight">This page stopped</h2>
          <p className="text-sm text-muted-foreground">
            It crashed, ran out of memory, or was ended from System Monitor.
          </p>
        </div>
        <Button onClick={onReload} className="min-w-32">
          <RotateCw className="mr-2 size-4" aria-hidden />
          Reload
        </Button>
      </div>
    </div>
  );
}

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
  getURL(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
}
