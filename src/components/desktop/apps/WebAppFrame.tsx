import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
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
 * The only chrome is a pair of back/forward buttons published into the window
 * title bar (alongside the app's icon and name), so the page still fills the
 * body. Back/forward drive the webview's own history and thus only work on the
 * Electron surface; the iframe fallback reports no navigations, so they stay
 * disabled there.
 *
 * The URL is sanitized (https-only) even though it was validated at install
 * time — stored data is never trusted blindly.
 */
export function WebAppFrame({
  url,
  name,
  icon,
  themeColor,
}: {
  url: string;
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
  const src = sanitizeUrl(url);

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
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <NavButton
          label="Go back"
          disabled={!nav.canBack}
          onClick={() => viewRef.current?.goBack()}
          className={cn(muted, hover)}
        >
          <ArrowLeft className="size-4" />
        </NavButton>
        <NavButton
          label="Go forward"
          disabled={!nav.canForward}
          onClick={() => viewRef.current?.goForward()}
          className={cn(muted, hover)}
        >
          <ArrowRight className="size-4" />
        </NavButton>
        <AppIcon icon={icon} className={cn('ml-1 size-4 shrink-0', muted)} />
        <span className={cn('flex-1 truncate text-sm font-medium', text)}>
          {name}
        </span>
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
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
}
