import { useCallback, useEffect, useState } from 'react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import {
  APP_WEBVIEW_PARTITION,
  BrowserView,
} from '@/components/desktop/apps/BrowserView';
import { useWindowAccent } from '@/contexts/WindowAccentContext';

/**
 * Standalone, chrome-less window content for an installed web app: the site
 * fills the whole window with no address bar, like an installed PWA.
 *
 * The URL is sanitized (https-only) even though it was validated at install
 * time — stored data is never trusted blindly.
 */
export function WebAppFrame({ url, themeColor }: { url: string; themeColor?: string }) {
  const [loading, setLoading] = useState(false);
  // Chrome tint: the install-time theme color pre-tints the title bar; the
  // live page's reported color takes over once known (webview mode only),
  // falling back to the stored color when a page reports none. The Window
  // sanitizes the value before styling.
  const [pageColor, setPageColor] = useState<string | null>(themeColor ?? null);
  const setAccent = useWindowAccent();
  const src = sanitizeUrl(url);

  useEffect(() => {
    setAccent(pageColor);
    return () => setAccent(null);
  }, [pageColor, setAccent]);

  const onThemeColorChange = useCallback(
    (color: string | null) => setPageColor(color ?? themeColor ?? null),
    [themeColor],
  );

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
        src={src}
        // Installed apps run in their own session so they inherit the user's
        // Nostr login (window.nostr) - the ad-hoc Web Browser does not.
        partition={APP_WEBVIEW_PARTITION}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onThemeColorChange={onThemeColorChange}
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
