/**
 * Games' front page: the game last played, big, to pick up where it was
 * left, then shelves of recently played games, favorites, and each system's.
 */
import { useState } from 'react';
import { Play } from 'lucide-react';
import type { Game, GameSystem } from '@/lib/games';
import { cn } from '@/lib/utils';
import { focusRing } from '@/shared/appChromeStyles';
import { BoxArt } from './art';
import { backdropOf, systemColors } from './colors';
import { useResumeImage } from './bridge';
import { Shelf, type TileContext, type TileSize } from './GameGrid';

const SHELF = 24;

function hash(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 1_000_003;
  return h;
}

/** A day's worth of variety on each system's shelf, the same all day: not always the A's. */
function sample(games: Game[], seed: number): Game[] {
  if (games.length <= SHELF) return games;
  // Games from here, with box art: what people know, not a shelf of imports and oddities.
  const picked = games.filter((g) => g.art?.boxart && g.local);
  const pool = picked.length >= SHELF ? picked : games;
  // The first SHELF of a Fisher-Yates shuffle, by mulberry32 from the seed.
  const order = pool.slice();
  let t = seed >>> 0;
  const random = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.min(SHELF, order.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (order.length - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, n);
}

function Hero({ game, system, ctx, couch }: { game: Game; system: GameSystem | undefined; ctx: TileContext; couch: boolean }) {
  const { data: resume } = useResumeImage(game);
  const backdrop = backdropOf(game, resume);
  const [from, to] = systemColors(game.system);
  const running = ctx.running === game.id;
  return (
    <section aria-label="Continue playing" className="px-6 pt-6">
      <div
        className={cn('relative isolate flex overflow-hidden rounded-2xl text-white shadow-lg', couch ? 'min-h-80' : 'min-h-64')}
        style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
      >
        {/* The picture twice: blurred across the whole card, and itself, whole, at its right. */}
        {backdrop && <img src={backdrop} alt="" aria-hidden className="absolute inset-0 -z-10 size-full scale-110 object-cover opacity-60 blur-2xl saturate-150" />}
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-black/75 via-black/40 to-black/10" />
        {backdrop && (
          <div className="absolute inset-y-0 right-0 -z-10 hidden w-1/2 items-center justify-end p-6 @3xl:flex">
            <img src={backdrop} alt="" aria-hidden className="max-h-full max-w-full rounded-xl object-contain shadow-2xl [image-rendering:pixelated]" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 items-end gap-6 p-8">
          <div className="hidden w-32 shrink-0 @2xl:block">
            <BoxArt game={game} systemName={system?.name} eager />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-sm font-medium text-white/75">{running ? 'Playing now' : game.resumable ? 'Pick up where you left off' : 'Play again'}</span>
            <h2 className={cn('font-[family-name:var(--font-title)] font-semibold tracking-tight text-balance', couch ? 'text-5xl' : 'text-4xl')}>{game.title}</h2>
            <span className="text-sm text-white/75">{system?.name}</span>
            <div className="mt-3">
              <button
                type="button"
                data-nav
                data-nav-default
                data-game={game.id}
                disabled={!system?.playable || running}
                onClick={() => ctx.onPlay(game)}
                onFocus={() => ctx.onFocusGame?.(game)}
                className={cn(
                  'inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-base font-semibold text-black shadow-md hover:bg-white/90 disabled:opacity-60',
                  focusRing,
                  'focus-visible:ring-white/70 in-data-[input=pad]:focus:ring-4 in-data-[input=pad]:focus:ring-white/80',
                )}
              >
                <Play className="size-5 fill-current" aria-hidden />
                {running ? 'Playing' : game.resumable ? 'Resume' : 'Play'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Home({
  games,
  systems,
  ctx,
  size,
  couch,
  onSection,
}: {
  games: Game[];
  systems: GameSystem[];
  ctx: TileContext;
  size: TileSize;
  couch: boolean;
  onSection: (section: string) => void;
}) {
  const recent = games.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
  const favorites = games.filter((g) => g.favorite);
  const bySystem = new Map<string, Game[]>();
  for (const g of games) {
    const list = bySystem.get(g.system);
    if (list) list.push(g);
    else bySystem.set(g.system, [g]);
  }
  const [day] = useState(() => Math.floor(Date.now() / 86_400_000));
  const systemById = new Map(systems.map((s) => [s.id, s]));
  const hero = recent[0];
  const mixed = { ...ctx, mixed: true };
  // Playable systems first: a shelf of games that can't be played yet is a disappointment.
  const ordered = [...systems].sort((a, b) => Number(b.playable) - Number(a.playable));

  return (
    <div className="flex flex-col gap-6 pb-10">
      {hero && <Hero game={hero} system={systemById.get(hero.system)} ctx={ctx} couch={couch} />}
      {!hero && <div className="h-2" />}
      <Shelf title="Recently Played" games={recent.slice(hero ? 1 : 0, SHELF + 1)} size={size} ctx={mixed} onSeeAll={recent.length > SHELF ? () => onSection('recent') : undefined} />
      <Shelf title="Favorites" games={favorites.slice(0, SHELF)} size={size} ctx={mixed} onSeeAll={favorites.length > SHELF ? () => onSection('favorites') : undefined} />
      {ordered.map((s) => (
        <Shelf
          key={s.id}
          title={s.name}
          detail={s.playable ? `${s.count.toLocaleString()} games` : 'Not playable yet'}
          games={sample(bySystem.get(s.id) ?? [], day + hash(s.id))}
          size={size}
          ctx={ctx}
          onSeeAll={() => onSection(`system:${s.id}`)}
        />
      ))}
    </div>
  );
}
