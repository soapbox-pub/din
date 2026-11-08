import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { RotateCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isWebviewAvailable } from '@/lib/isElectron';
import { COLLECT_ICONS_JS, type IconCandidate } from '@/lib/appIcon';
import {
  COLLECT_PROTOCOL_HANDLERS_JS,
  parseNostrProtocolHandler,
  type NostrHandler,
} from '@/lib/nostrUri';
import { parseManifestShortcuts, type WebAppShortcut } from '@/lib/webAppShortcuts';
import { shownUrl } from '@/lib/tor';
import { getBrowserBridge } from '@/lib/browser';
import { GuestSurface, type GuestSurfaceHandle } from '@/platform/GuestSurface';

/** What a page's web app manifest says for installing its site as an app. */
export interface InstallManifest {
  nostr: NostrHandler | null;
  shortcuts: WebAppShortcut[];
}

const NO_INSTALL_MANIFEST: InstallManifest = { nostr: null, shortcuts: [] };

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
  /** Put the page in full screen, or take it out (F11). Webview only. */
  toggleFullscreen: () => void;
  /**
   * Harvest the page's icon hints (link rel=icon / apple-touch-icon /
   * mask-icon plus web-app-manifest icons) for choosing an install icon.
   * Webview only; the iframe fallback resolves to an empty list.
   */
  collectIcons: () => Promise<IconCandidate[]>;
  /**
   * What the page's web app manifest says for installing the site as an app:
   * how it opens `nostr:` links (or null) and its shortcuts. Not yet checked
   * against the site's origin. Webview only.
   */
  collectManifest: () => Promise<InstallManifest>;
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
 * options/dashboard pages (validated upstream, see `isAllowedTabUrl`), and
 * file: URLs the user asked for (`resolveNavigation`).
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
      toggleFullscreen: () => {},
      // The iframe fallback can't reach into cross-origin guest DOM.
      collectIcons: () => Promise.resolve([]),
      collectManifest: () => Promise.resolve(NO_INSTALL_MANIFEST),
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
    const surface = useRef<GuestSurfaceHandle>(null);

    // Tabs show only the local files the user asked for (electron/local-files.mts),
    // and what reaches a tab's surface from the browser was asked for: the
    // address bar, a bookmark, history. Pages never get here. Told just before
    // the load, so main has it first.
    const allowLocal = useCallback((url: string) => {
      if (installedApp || !/^file:/i.test(url)) return;
      if (partition !== WEBBROWSER_PARTITION && partition !== WEBBROWSER_PRIVATE_PARTITION) return;
      getBrowserBridge()?.allowLocalFile(url, partition === WEBBROWSER_PRIVATE_PARTITION);
    }, [installedApp, partition]);
    // The first URL, before GuestSurface's layout effect attaches the guest.
    useState(() => allowLocal(src));

    useImperativeHandle(ref, () => ({
      reload: () => surface.current?.reload(),
      reloadIgnoringCache: () => surface.current?.reloadIgnoringCache(),
      loadURL: (url: string) => {
        allowLocal(url);
        surface.current?.loadURL(url);
      },
      goBack: () => surface.current?.goBack(),
      goForward: () => surface.current?.goForward(),
      focus: () => surface.current?.focus(),
      toggleFullscreen: () => surface.current?.toggleFullscreen(),
      collectIcons: async () => {
        try {
          const result = await surface.current?.executeJavaScript(COLLECT_ICONS_JS);
          return Array.isArray(result) ? (result as IconCandidate[]) : [];
        } catch {
          return [];
        }
      },
      collectManifest: async () => {
        if (!surface.current) return NO_INSTALL_MANIFEST;
        try {
          const result: unknown = await surface.current.executeJavaScript(COLLECT_PROTOCOL_HANDLERS_JS);
          if (typeof result !== 'object' || result === null) return NO_INSTALL_MANIFEST;
          const { base, manifest } = result as { base?: unknown; manifest?: unknown };
          if (typeof base !== 'string') return NO_INSTALL_MANIFEST;
          return {
            nostr: parseNostrProtocolHandler(manifest, base),
            shortcuts: parseManifestShortcuts(manifest, base, null),
          };
        } catch {
          return NO_INSTALL_MANIFEST;
        }
      },
      getSelectionText: async () => {
        try {
          const result = await surface.current?.executeJavaScript(
            'window.getSelection ? String(window.getSelection()) : ""',
          );
          return typeof result === 'string' ? result : '';
        } catch {
          return '';
        }
      },
    }), [allowLocal]);

    // The page's renderer went away: it crashed, ran out of memory, or was
    // ended from the System Monitor. The engine leaves the guest blank, so say
    // what happened and offer a reload (which starts a fresh renderer).
    const [gone, setGone] = useState(false);

    // The page loading next draws over whatever the guest showed last, and
    // until it draws, the engine keeps that frame up: a backdrop, never a
    // cover. Before a guest's first page that's the element's own theme
    // background. The about:blank a new tab parks on would paint Chromium's
    // blank color (white, or #121212 in dark mode), so it's painted the
    // theme's background instead, and a page that leaves its canvas to the
    // default gets white from its own first frame, not before.
    const paintBlank = () => {
      const el = surface.current?.element();
      const color = el ? getComputedStyle(el).backgroundColor : '';
      if (!/^[a-z]+\([\d\s.,%/a-z-]+\)$/i.test(color)) return;
      surface.current?.insertCSS(`:root { background: ${color} !important; }`).catch(() => {});
    };

    return (
      <div className="relative h-full w-full" style={{ display: 'flex' }}>
        <GuestSurface
          ref={surface}
          src={src}
          partition={partition}
          webpreferences={installedApp ? APP_GUEST_MARK : undefined}
          // Guest-initiated popups, which main routes into tabs and apps.
          allowPopups
          // An installed app paints nothing under its page, so the window's
          // color (the title bar's) is all that shows through the sliver a
          // transformed window leaves at the page's edge while it's dragged.
          // It never parks on about:blank, which paintBlank colors from this.
          guestClassName={installedApp ? 'h-full w-full' : 'h-full w-full bg-background'}
          pageZoom={pageZoom}
          hidden={hidden}
          acceptFileDrops
          onAttach={onWebContentsId}
          onLoadStart={() => {
            setGone(false);
            onLoadStart?.();
          }}
          onLoadEnd={onLoadEnd}
          onLoadError={(error) => {
            onLoadError?.({ ...error, url: shownUrl(error.url) });
          }}
          onTitle={onTitleChange}
          onFavicons={onFaviconChange}
          onThemeColor={onThemeColorChange}
          onNavigate={(url, current, canBack, canForward) => {
            if (url === 'about:blank') paintBlank();
            // A page-source view commits its inner URL; only the current URL
            // has the `view-source:` prefix the tab must keep.
            onNavigate?.(
              current === `view-source:${url}` ? `view-source:${shownUrl(url)}` : shownUrl(url),
              canBack,
              canForward,
            );
          }}
          onGone={() => {
            setGone(true);
            onLoadEnd?.();
          }}
        />
        {gone && <PageGone onReload={() => surface.current?.reload()} />}
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
