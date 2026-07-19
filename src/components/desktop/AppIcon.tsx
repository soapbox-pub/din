import { useState } from 'react';
import { Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';

/**
 * Renders a desktop app icon: a root-relative image path for built-in apps
 * (bundled under public/icons/apps/), a remote image (favicon) for installed
 * web apps, or a Lucide component. Remote URLs are sanitized (https or inline
 * data:image URIs); local paths must be root-relative (`/...` but not `//...`).
 * Anything that fails validation or loading falls back to a Globe glyph.
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
  if (!src || failed) {
    return <Globe className={className} aria-hidden />;
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
