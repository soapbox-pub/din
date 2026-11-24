import { CreditCard, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PasswordSummary } from '@/lib/passwords';
import { displayTitle, siteHost } from './vault';

/** A stable hue for a site, so its tile is the same color everywhere. */
function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

/** A card's tile in its network's colors, as on the card itself. */
const BRAND_COLORS: Record<string, [string, string]> = {
  Visa: ['#1a3fb0', '#0f2470'],
  Mastercard: ['#3a3a3f', '#1c1c20'],
  'American Express': ['#2d7fd1', '#155a9e'],
  Discover: ['#f08a24', '#c7600c'],
  'Diners Club': ['#3b6fa8', '#244b78'],
  JCB: ['#1d8a4e', '#0f5e33'],
  UnionPay: ['#d1323b', '#9c1d25'],
};

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
  item: Pick<PasswordSummary, 'title' | 'url' | 'kind'> & { card?: { brand: string } | null };
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
  if (item.kind === 'card') {
    const [top, bottom] = BRAND_COLORS[item.card?.brand ?? ''] ?? ['#5b6472', '#3a414c'];
    return (
      <span
        aria-hidden
        className={cn('grid shrink-0 place-items-center text-white shadow-sm', SIZES[size], className)}
        style={{ backgroundImage: `linear-gradient(to bottom, ${top}, ${bottom})` }}
      >
        <CreditCard className={size === 'lg' ? 'size-8' : 'size-4'} strokeWidth={1.75} />
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
