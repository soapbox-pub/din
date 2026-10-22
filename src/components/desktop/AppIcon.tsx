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
      src={!src || failed ? WEB_APP_ICON : src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
