/**
 * A game's pictures: its box art from libretro-thumbnails, or, where there's
 * none, a cover made for it in its system's colors with its title on it, so
 * every game in the library has something to look at. The pictures come
 * from the app's own cache (artCache.ts), never straight from the server.
 */
import { useEffect, useState, type ComponentProps, type Ref } from 'react';
import type { Game } from '@/lib/games';
import { cn } from '@/lib/utils';
import { useCachedArt } from './artCache';
import { systemColors } from './colors';

/** How far off screen a tile starts looking for its picture, so it's there by the time it scrolls in. */
const NEAR = '600px';

/**
 * Whether the element has come on screen or near it (true from the start for
 * `eager`), and the ref that says which element. Once near it stays so: a
 * picture found is kept while its tile is there to show it.
 */
function useNearScreen(eager: boolean | undefined): [(el: HTMLDivElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [seen, setNear] = useState(false);
  const near = !!eager || seen;
  useEffect(() => {
    if (near || !el) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: NEAR });
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, el]);
  return [setEl, near];
}

/**
 * An <img> of one of a game's pictures (or a resume image), through the
 * cache; nothing while it's being looked up or where there's none.
 */
export function ArtImage({ src, alt = '', ...props }: Omit<ComponentProps<'img'>, 'src'> & { src: string | null | undefined }) {
  const shown = useCachedArt(src);
  if (!shown) return null;
  return <img {...props} alt={alt} src={shown} />;
}

/** A cover for a game with no box art: its title on its system's colors. */
export function MadeCover({ game, systemName, className, ref }: { game: Game; systemName?: string; className?: string; ref?: Ref<HTMLDivElement> }) {
  const [from, to] = systemColors(game.system);
  return (
    <div
      ref={ref}
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
  const [ref, near] = useNearScreen(eager);
  const [failed, setFailed] = useState<string | null>(null);
  const remote = game.art?.boxart ?? null;
  const src = useCachedArt(remote, near);
  // Still looking it up: an empty space the size of a box, not a made cover that would then be swapped.
  if (game.art === null || (remote && src === undefined)) {
    return <div ref={ref} className={cn('aspect-[3/4] w-full rounded-lg bg-foreground/[0.06]', className)} aria-hidden />;
  }
  if (!src || failed === src) return <MadeCover ref={ref} game={game} systemName={systemName} className={className} />;
  return (
    <div ref={ref} className={cn('flex aspect-[3/4] w-full items-end justify-center', className)}>
      <img
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailed(src)}
        className="max-h-full max-w-full rounded-md object-contain shadow-[0_6px_16px_-6px_rgb(0_0_0/0.45)]"
      />
    </div>
  );
}
