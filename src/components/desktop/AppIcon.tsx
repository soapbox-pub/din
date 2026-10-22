import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { WEB_APP_ICON } from '@/lib/appIcons';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';

/**
 * Renders a desktop app icon: a root-relative image path for built-in apps
 * (bundled under public/icons/apps/), a remote image (favicon) for installed
 * web apps, or a Lucide component. Remote URLs are sanitized (https or inline
 * data:image URIs); local paths must be root-relative (`/...` but not `//...`).
 * Anything that fails validation or loading falls back to the globe icon.
 */
/**
 * Cancel a still-loading image when its icon unmounts. An <img> with a fetch
 * in flight stays alive until the fetch settles, and with it everything it
 * still references - for a closed App Store, its whole detached card grid
 * and the React tree behind it, held for as long as a slow host takes.
 * Module-level, so React only runs it at mount and its cleanup at unmount.
 */
function cancelLoadOnUnmount(img: HTMLImageElement | null) {
  return () => {
    if (img && !img.complete) img.removeAttribute('src');
  };
}

export function AppIcon({
  icon,
  className,
}: {
  icon: LucideIcon | string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (typeof icon !== 'string') {
    const Icon = icon;
    return <Icon className={className} aria-hidden />;
  }

  // Root-relative paths ship with the app itself; everything else must pass
  // the https-only sanitizer (protocol-relative `//` is remote, not local).
  const isLocal = icon.startsWith('/') && !icon.startsWith('//');
  const src = isLocal ? icon : sanitizeImageUrl(icon);

  return (
    <img
      ref={cancelLoadOnUnmount}
      src={!src || failed ? WEB_APP_ICON : src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
