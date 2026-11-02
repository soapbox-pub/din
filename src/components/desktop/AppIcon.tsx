import { useState, type CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { THEMED_APP_ICONS, WEB_APP_ICON } from '@/lib/appIcons';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { isGlyphIcon, themeIcon, useThemeIcons } from '@/shared/themeIcons';

/**
 * Renders a desktop app icon: a root-relative image path for built-in apps
 * (bundled under public/icons/apps/, or the icon theme's counterpart, see
 * THEMED_APP_ICONS), a remote image (favicon) for installed web apps, or a
 * Lucide component. Remote URLs are sanitized (https or inline
 * data:image URIs); local paths must be root-relative (`/...` but not `//...`).
 * Anything that fails validation or loading falls back to the globe icon.
 * A monochrome icon theme's glyphs are drawn on a tile in the colour
 * scheme's card and primary colours, so they follow light and dark mode and
 * the user's theme, as Android's themed icons do.
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

/**
 * A monochrome icon theme's glyph (an inline image) on a tile: the glyph in
 * the colour scheme's primary colour on its card colour.
 */
export function GlyphTile({ src, className }: { src: string; className?: string }) {
  return (
    <span
      aria-hidden
      style={{ '--glyph': `url("${src}")` } as CSSProperties}
      className={cn('relative inline-block rounded-[22%] bg-card shadow-sm ring-1 ring-foreground/10', className)}
    >
      <span className="absolute inset-[18%] bg-primary [mask:var(--glyph)_center/contain_no-repeat]" />
    </span>
  );
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
  const themeIcons = useThemeIcons();

  if (typeof icon !== 'string') {
    const Icon = icon;
    return <Icon className={className} aria-hidden />;
  }

  // Root-relative paths ship with the app itself; everything else must pass
  // the https-only sanitizer (protocol-relative `//` is remote, not local).
  const isLocal = icon.startsWith('/') && !icon.startsWith('//');
  const themed = isLocal && THEMED_APP_ICONS[icon] ? themeIcon(themeIcons, THEMED_APP_ICONS[icon]) : null;
  const src = themed ?? (isLocal ? icon : sanitizeImageUrl(icon));
  const shown = !src || failed ? WEB_APP_ICON : src;

  const img = isGlyphIcon(shown) ? (
    <GlyphTile src={shown} className={web ? 'size-full' : className} />
  ) : (
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
