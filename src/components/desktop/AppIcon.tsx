import { useState } from 'react';
import { Globe } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * Renders a desktop app icon: a Lucide component for built-in apps, or an
 * https image (favicon) for installed web apps. Image URLs are sanitized
 * (https-only) and fall back to a Globe glyph when they fail to load.
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

  const src = sanitizeUrl(icon);
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
