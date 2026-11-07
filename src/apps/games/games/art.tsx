/**
 * A game's pictures: its box art from libretro-thumbnails, or, where there's
 * none, a cover made for it in its system's colors with its title on it, so
 * every game in the library has something to look at.
 */
import { useState } from 'react';
import type { Game } from '@/lib/games';
import { cn } from '@/lib/utils';
import { systemColors } from './colors';

/** A cover for a game with no box art: its title on its system's colors. */
export function MadeCover({ game, systemName, className }: { game: Game; systemName?: string; className?: string }) {
  const [from, to] = systemColors(game.system);
  return (
    <div
      className={cn('flex aspect-[3/4] w-full flex-col justify-between overflow-hidden rounded-lg p-3 text-left text-white shadow-md', className)}
      style={{ backgroundImage: `linear-gradient(160deg, ${from}, ${to})` }}
      aria-hidden
    >
      <span className="text-[10px] font-semibold tracking-wide text-white/70 uppercase">{systemName}</span>
      <span className="line-clamp-4 text-base leading-tight font-semibold text-balance">{game.title}</span>
    </div>
  );
}

/**
 * A game's box art, sitting on the tile's floor as a box would on a shelf,
 * whatever shape it is; its made cover where there's none or it won't load.
 */
export function BoxArt({ game, systemName, className, eager }: { game: Game; systemName?: string; className?: string; eager?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = game.art?.boxart ?? null;
  if (!src || failed === src) {
    // Still looking it up: an empty space the size of a box, not a made cover that would then be swapped.
    if (game.art === null) return <div className={cn('aspect-[3/4] w-full rounded-lg bg-foreground/[0.06]', className)} aria-hidden />;
    return <MadeCover game={game} systemName={systemName} className={className} />;
  }
  return (
    <div className={cn('flex aspect-[3/4] w-full items-end justify-center', className)}>
      <img
        src={src}
        alt=""
        draggable={false}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        onError={() => setFailed(src)}
        className="max-h-full max-w-full rounded-md object-contain shadow-[0_6px_16px_-6px_rgb(0_0_0/0.45)]"
      />
    </div>
  );
}
