import { StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PasswordSummary } from '@/lib/passwords';
import { displayTitle, siteHost } from './vault';

/** A stable hue for a site, so its tile is the same color everywhere. */
function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

const SIZES = {
  sm: 'size-8 rounded-lg text-sm',
  lg: 'size-16 rounded-2xl text-2xl',
};

/** An item's tile: its site's first letter on a color of its own, or a note's page. */
export function ItemIcon({
  item,
  size = 'sm',
  className,
}: {
  item: Pick<PasswordSummary, 'title' | 'url' | 'kind'>;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  if (item.kind === 'note') {
    return (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center bg-foreground/10 text-ink-accent clay',
          SIZES[size],
          className,
        )}
      >
        <StickyNote className={size === 'lg' ? 'size-8' : 'size-4'} />
      </span>
    );
  }
  const name = siteHost(item.url) || displayTitle(item);
  const hue = hueOf(name.toLowerCase());
  return (
    <span
      aria-hidden
      className={cn('grid shrink-0 place-items-center font-semibold text-white shadow-sm', SIZES[size], className)}
      style={{ backgroundImage: `linear-gradient(to bottom, hsl(${hue} 62% 48%), hsl(${hue} 66% 36%))` }}
    >
      {name.charAt(0).toUpperCase() || '?'}
    </span>
  );
}
