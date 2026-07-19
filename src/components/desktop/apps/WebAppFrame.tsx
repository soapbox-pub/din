import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sanitizeUrl, sameOrigin } from '@/lib/sanitizeUrl';
import { isDarkThemeColor, normalizeThemeColor } from '@/lib/themeColor';
import {
  APP_WEBVIEW_PARTITION,
  BrowserView,
  type BrowserViewHandle,
} from '@/components/desktop/apps/BrowserView';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useWindowAccent } from '@/contexts/WindowAccentContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';

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
 * The URL is sanitized (https-only) even though it was validated at install
 * time — stored data is never trusted blindly.
 *
 * `initialUrl` opens the app at a deep link instead of its home URL — used
 * when a clicked link is routed into the app (see BrowserExtensionHost). It
 * is honored only when it shares the app's origin, so a stray param can never
 * point the app's logged-in session at a foreign site.
 */
export function WebAppFrame({
  url,
  initialUrl,
  name,
  icon,
  themeColor,
}: {
  url: string;
  initialUrl?: string;
  name: string;
  icon: LucideIcon | string;
  themeColor?: string;
}) {
  const [loading, setLoading] = useState(false);
  // Chrome tint: the install-time theme color pre-tints the title bar; the
  // live page's reported color takes over once known (webview mode only),
  // falling back to the stored color when a page reports none. The Window
  // sanitizes the value before styling.
  const [pageColor, setPageColor] = useState<string | null>(themeColor ?? null);
  // Back/forward availability, reported by the webview on each navigation.
  const [nav, setNav] = useState({ canBack: false, canForward: false });
  const viewRef = useRef<BrowserViewHandle>(null);
  const setAccent = useWindowAccent();
  const setTitlebar = useWindowTitlebar();
  const home = sanitizeUrl(url);
  const deepLink = initialUrl ? sanitizeUrl(initialUrl) : null;
  const src =
    deepLink && home && sameOrigin(home, deepLink) ? deepLink : home;

  useEffect(() => {
    setAccent(pageColor);
    return () => setAccent(null);
  }, [pageColor, setAccent]);

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
    const accent = normalizeThemeColor(pageColor);
    const dark = accent !== null && isDarkThemeColor(accent);
    const muted = accent
      ? dark ? 'text-white/80' : 'text-black/70'
      : 'text-foreground/80';
    const hover = accent
      ? dark ? 'hover:bg-white/15' : 'hover:bg-black/10'
      : 'hover:bg-foreground/10';
    const text = accent
      ? dark ? 'text-white' : 'text-black'
      : 'text-foreground';

    setTitlebar(
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AppIcon icon={icon} className={cn('size-4 shrink-0', muted)} />
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', text)}>
          {name}
        </span>
        {/* Carets to the right of the title, shown only when a move is
            available (webview only reports history depth). */}
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
      </div>,
    );
    return () => setTitlebar(null);
  }, [src, name, icon, pageColor, nav.canBack, nav.canForward, setTitlebar]);

  if (!src) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          This app's URL is invalid and cannot be loaded.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-white">
      <BrowserView
        ref={viewRef}
        src={src}
        // Installed apps run in their own session so they inherit the user's
        // Nostr login (window.nostr) - the ad-hoc Web Browser does not.
        partition={APP_WEBVIEW_PARTITION}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onThemeColorChange={onThemeColorChange}
        onNavigate={onNavigate}
      />
      {loading && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary"
        />
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
