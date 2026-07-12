import { useState } from 'react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';
import {
  BrowserView,
} from '@/components/desktop/apps/BrowserView';

/**
 * Standalone, chrome-less window content for an installed web app: the site
 * fills the whole window with no address bar, like an installed PWA.
 *
 * The URL is sanitized (https-only) even though it was validated at install
 * time — stored data is never trusted blindly.
 */
export function WebAppFrame({ url }: { url: string }) {
  const [loading, setLoading] = useState(false);
  const src = sanitizeUrl(url);

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
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
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
