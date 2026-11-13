import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sanitizeAppUrl, sameOrigin } from '@/lib/sanitizeUrl';
import { isDarkThemeColor, normalizeThemeColor } from '@/lib/themeColor';
import { BrowserView, type BrowserViewHandle } from '@/components/desktop/apps/BrowserView';
import { AppIcon } from '@/components/desktop/AppIcon';
import { NappInfoButton } from '@/components/desktop/apps/NappInfoButton';
import { useWindowAccent } from '@/contexts/WindowAccentContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useSlowLaunch } from '@/hooks/useSlowLaunch';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { SiteLimitPage } from '@/components/desktop/apps/SiteLimitPage';
import { useToast } from '@/hooks/useToast';
import { sharePageUrl, shareRequestBody, takePostShare } from '@/lib/share';
import { guestsAvailable } from '@/platform/guest';

/** How long a share waits for an nsite's service worker to be up before it goes without its files. */
const SERVICE_WORKER_WAIT_MS = 5000;

/**
 * Standalone, chrome-less window content for an installed web app: the site
 * fills the whole window with no address bar, like an installed PWA.
 *
 * The only chrome is a pair of back/forward carets published into the window
 * title bar, to the right of the app's icon and name, so the page still fills
 * the body. Each caret appears only when that move is possible. They drive the
 * webview's own history and thus only work on the Electron surface; the iframe
 * fallback reports no navigations, so the carets never appear there.
 *
 * The URL is sanitized (https, or an nsite's canonical host) even though it
 * was validated at install time — stored data is never trusted blindly.
 *
 * `initialUrl` opens the app at a deep link instead of its home URL — used
 * when a clicked link is routed into the app (see BrowserExtensionHost). It
 * is honored only when it shares the app's origin, so a stray param can never
 * point the app's logged-in session at a foreign site.
 *
 * In an installed nsite (`nsiteHost`) the title bar's favicon and name are a button
 * that opens its permissions, window.ENV and data (see NappInfoButton).
 *
 * `shareToken` is a POST share sent here from the share sheet
 * (src/lib/share.ts): once the page is up, the window POSTs it to the site's
 * share target, where its service worker (or, for a website, its server)
 * takes it, as a browser delivers one. An nsite with no service worker
 * active for the action after a few seconds gets the share's title, text
 * and link in the query instead, and the user hears its files didn't go.
 */
export function WebAppFrame({
  windowId,
  url,
  initialUrl,
  navigateAt,
  name,
  icon,
  favicon,
  themeColor,
  nsiteHost,
  appId,
  shareToken,
}: {
  /** The app's window, which a limited site's page closes. */
  windowId?: string;
  /** The app's id, which a POST share is held for. */
  appId?: string;
  /** The `share` launch param: a POST share waiting for this window. */
  shareToken?: unknown;
  url: string;
  initialUrl?: string;
  /** Changes when the app is asked to go to `initialUrl` again (a shortcut chosen twice). */
  navigateAt?: unknown;
  name: string;
  icon: LucideIcon | string;
  /** Drawn in the title bar instead of the icon, when the site has one. */
  favicon?: string;
  themeColor?: string;
  /** The canonical host, when the app is an installed nsite. */
  nsiteHost?: string;
}) {
  // A web app always opens by loading `src`, so start in the loading state to
  // show the launch splash from the very first frame (no white gap).
  const [loading, setLoading] = useState(true);
  // Whether the first page load has completed. Until it has, a full-cover
  // splash hides the guest's blank white surface; afterwards only the thin
  // progress bar shows, so later in-app navigations don't re-flash a splash.
  const [ready, setReady] = useState(false);
  const slowLaunch = useSlowLaunch();
  // Chrome tint: the install-time theme color pre-tints the title bar; the
  // live page's reported color takes over once known (webview mode only),
  // falling back to the stored color when a page reports none. The Window
  // sanitizes the value before styling.
  const [pageColor, setPageColor] = useState<string | null>(themeColor ?? null);
  // Back/forward availability, reported by the webview on each navigation.
  const [nav, setNav] = useState({ canBack: false, canForward: false });
  const viewRef = useRef<BrowserViewHandle>(null);
  const [wcId, setWcId] = useState<number | null>(null);
  const { close: closeWindow } = useWindowActions();
  const setAccent = useWindowAccent();
  const setTitlebar = useWindowTitlebar();
  const home = sanitizeAppUrl(url);
  const deepLink = initialUrl ? sanitizeAppUrl(initialUrl) : null;
  const src =
    deepLink && home && sameOrigin(home, deepLink) ? deepLink : home;

  // Opaque: a page's alpha would make the window frosted, which is for Din's apps.
  useEffect(() => {
    setAccent(normalizeThemeColor(pageColor));
    return () => setAccent(null);
  }, [pageColor, setAccent]);

  // The window is reused for this single-instance app, so a link routed into
  // an already-open app (see BrowserExtensionHost) changes the `url` param
  // without remounting. The webview's src is fixed at mount, so drive the
  // navigation imperatively. `src` already covers the initial deep link, so
  // only react to *changes* after mount.
  // A share arriving replaces the launch params, which takes the deep link
  // away: the share's own load goes instead of going home.
  const lastNavigated = useRef({ src, at: navigateAt, share: shareToken });
  useEffect(() => {
    const last = lastNavigated.current;
    const shared = shareToken !== undefined && shareToken !== last.share;
    if (src && !shared && (src !== last.src || (deepLink && navigateAt !== last.at))) {
      viewRef.current?.loadURL(src);
    }
    lastNavigated.current = { src, at: navigateAt, share: shareToken };
  }, [src, deepLink, navigateAt, shareToken]);

  // A POST share, once the first page is up (so an nsite's service worker
  // has had its chance to start).
  const { toast } = useToast();
  const sentShare = useRef<unknown>(undefined);
  useEffect(() => {
    if (!ready || shareToken === undefined || sentShare.current === shareToken || !appId) return;
    sentShare.current = shareToken;
    const share = takePostShare(shareToken, appId);
    const view = viewRef.current;
    if (!share || !view || !home || !sameOrigin(home, share.target.action)) return;
    const { target, data } = share;
    const withoutFiles = () => {
      view.loadURL(sharePageUrl(target, data));
      if (data.files.length > 0) {
        toast({
          title: `${name} couldn’t take the ${data.files.length === 1 ? 'file' : 'files'}`,
          description: 'Nothing on the site is set up to receive shared files yet, so it got the text and link only.',
          variant: 'destructive',
        });
      }
    };
    if (!guestsAvailable()) return withoutFiles();
    void (async () => {
      // An nsite has no server: only its service worker can take a POST.
      if (nsiteHost && !(await view.hasServiceWorker(target.action, SERVICE_WORKER_WAIT_MS))) return withoutFiles();
      view.loadURL(target.action, shareRequestBody(target, data));
    })();
  }, [ready, shareToken, appId, home, name, nsiteHost, toast]);

  const onThemeColorChange = useCallback(
    (color: string | null) => setPageColor(color ?? themeColor ?? null),
    [themeColor],
  );

  const onNavigate = useCallback(
    (_url: string, canGoBack: boolean, canGoForward: boolean) =>
      setNav({ canBack: canGoBack, canForward: canGoForward }),
    [],
  );

  // Publish back/forward controls (plus the app's icon + name) into the window
  // title bar, keeping the body chrome-less. Cleared on unmount so the Window
  // restores its default title. The title bar is tinted by the page's theme
  // color, so the controls pick their contrast from it.
  useEffect(() => {
    if (!src) {
      setTitlebar(null);
      return;
    }
    // The Window tints this slot with the page's color and its tokens
    // (themeColorTokens), so the theme's classes read on it.
    const muted = 'text-muted-foreground';
    const hover = 'hover:bg-foreground/[0.07]';
    const text = 'text-foreground';

    setTitlebar(
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Back and forward lead, as a browser's do, shown only when a move
            is available (webview only reports history depth). */}
        {nav.canBack && (
          <NavButton
            label="Go back"
            onClick={() => viewRef.current?.goBack()}
            className={cn(muted, hover)}
          >
            <ChevronLeft className="size-4" />
          </NavButton>
        )}
        {nav.canForward && (
          <NavButton
            label="Go forward"
            onClick={() => viewRef.current?.goForward()}
            className={cn(muted, hover)}
          >
            <ChevronRight className="size-4" />
          </NavButton>
        )}
        {nsiteHost ? (
          <NappInfoButton
            host={nsiteHost}
            name={name}
            icon={icon}
            favicon={favicon}
            onReload={() => viewRef.current?.reload()}
            className="mr-auto"
            hoverClassName={hover}
            iconClassName={muted}
            textClassName={text}
          />
        ) : (
          <>
            <AppIcon icon={favicon ?? icon} className={cn('size-5 shrink-0', muted)} />
            <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', text)}>
              {name}
            </span>
          </>
        )}
      </div>,
    );
    return () => setTitlebar(null);
  }, [src, name, icon, favicon, pageColor, nav.canBack, nav.canForward, nsiteHost, setTitlebar]);

  if (!src) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This app's URL is invalid and cannot be loaded.
        </p>
      </div>
    );
  }

  // Splash tint: the app's (sanitized) theme color when known, so the launch
  // reads as this specific app rather than a blank rectangle.
  const splashColor = normalizeThemeColor(pageColor);
  const splashDark = splashColor ? isDarkThemeColor(splashColor) : false;

  return (
    // No background of its own: the window paints its color under the title
    // bar and the page alike (see BrowserView's installedApp).
    <div className="relative h-full w-full overflow-hidden">
      <BrowserView
        ref={viewRef}
        src={src}
        // An installed app shares the browser's profile, so it's signed in
        // wherever the site is in a tab. Its window is pinned to its origin,
        // and connected to the user's Nostr account (window.nostr) by being
        // installed; browser tabs have to ask to connect.
        installedApp
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => {
          setLoading(false);
          setReady(true);
        }}
        onThemeColorChange={onThemeColorChange}
        onNavigate={onNavigate}
        onWebContentsId={setWcId}
      />
      {/* Until the first paint lands, cover the guest's blank white surface
          with a splash tinted by the app's theme color, so opening an app
          reads as an intentional launch instead of a broken white flash. The
          icon joins it only if the launch is slow (useSlowLaunch). It
          fades out on first load and never returns, so later in-app
          navigations show only the thin progress bar below. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 grid place-items-center bg-background transition-opacity duration-300',
          ready ? 'opacity-0' : 'opacity-100',
        )}
        style={splashColor ? { backgroundColor: splashColor } : undefined}
      >
        {slowLaunch && <AppIcon
          icon={icon}
          className={cn(
            'size-14',
            !ready && 'animate-pulse',
            splashColor
              ? splashDark
                ? 'text-white/90'
                : 'text-black/80'
              : 'text-muted-foreground',
          )}
        />}
      </div>
      {ready && loading && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-ink-accent"
        />
      )}
      {/* A site the user limited (electron/site-limits.mts): the app itself,
          when they limited the site it's on. */}
      {windowId && (
        <SiteLimitPage wcId={wcId} closeLabel="Close window" onClose={() => closeWindow(windowId)} />
      )}
    </div>
  );
}

/** A single title-bar navigation button, sized to match the window controls. */
function NavButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}
