import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { WEB_APP_ICON } from '@/lib/appIcons';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';

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
  web = false,
}: {
  icon: LucideIcon | string;
  className?: string;
  /**
   * Badge the icon with a small globe in its corner, marking a website
   * installed as an app (AppDefinition.web). Skipped when the icon already is
   * the globe.
   */
  web?: boolean;
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
  const shown = !src || failed ? WEB_APP_ICON : src;

  const img = (
    <img
      ref={cancelLoadOnUnmount}
      src={shown}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={web && shown !== WEB_APP_ICON ? 'size-full object-contain' : className}
    />
  );

  if (!web || shown === WEB_APP_ICON) return img;

  return (
    <span aria-hidden className={cn('relative inline-block', className)}>
      {img}
      <img
        src={WEB_APP_ICON}
        alt=""
        draggable={false}
        className="absolute -bottom-[4%] -right-[4%] size-[42%] drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.45)]"
      />
    </span>
  );
}
