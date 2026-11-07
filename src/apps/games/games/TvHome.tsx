/**
 * The TV view's home: what's focused, big, across the top over its own
 * picture (the shell draws that), and rows beneath that come up to meet it as
 * a controller moves down them. The first row picks up where things were left,
 * the game last played a wide card of the moment it was left at; then
 * favorites and each system's.
 */
import { Play } from 'lucide-react';
import type { Game, GameSystem } from '@/lib/games';
import { cn } from '@/lib/utils';
import { ArtImage, BoxArt } from './art';
import { useResumeImage } from './bridge';
import { GameTile, type TileContext } from './GameGrid';
import { DEFAULT_BOX_SHAPE } from './colors';
import { tileShape, tileWidth } from './tiles';
import { lastPlayedText, playTimeText, sample, SHELF, shelfSeed } from './format';
import { tvLift } from './tv';

const ROW_TILE = 'lg' as const;

function FocusInfo({ game, system, running }: { game: Game | null; system: GameSystem | undefined; running: boolean }) {
  if (!game) return <div className="min-h-[34vh]" />;
  const facts = [game.resumable ? 'Saved where you left it' : null, playTimeText(game.playTime), lastPlayedText(game.lastPlayed)].filter(Boolean);
  return (
    <div key={game.id} className="flex min-h-[34vh] max-w-4xl flex-col justify-end gap-3 px-16 pb-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
      <span className="text-sm font-semibold tracking-[0.2em] text-white/70 uppercase">
        {system?.name}
        {system?.year ? ` · ${system.year}` : ''}
      </span>
      <h1 className="font-[family-name:var(--font-title)] text-6xl leading-[1.05] font-bold tracking-tight text-balance text-white drop-shadow-[0_2px_16px_rgb(0_0_0/0.6)]">
        {game.title}
      </h1>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg text-white/80">
        {running && (
          <span className="inline-flex items-center gap-2 font-semibold text-white">
            <span className="size-2.5 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
            Playing now
          </span>
        )}
        {facts.map((f, i) => (
          <span key={i} className="flex items-center gap-3">
            {(i > 0 || running) && <span aria-hidden className="size-1 rounded-full bg-white/50" />}
            {f}
          </span>
        ))}
        {!system?.playable && system?.unavailable && <span className="text-white/60">{system.unavailable}</span>}
      </p>
    </div>
  );
}

/** The game last played, as a wide card of where it was left: A resumes it. */
function ContinueCard({ game, ctx, height }: { game: Game; ctx: TileContext; height: number }) {
  const { data: resume } = useResumeImage(game);
  const picture = resume ?? game.art?.snap ?? game.art?.title ?? null;
  const running = ctx.running === game.id;
  const playable = ctx.playable(game.system);
  return (
    <button
      type="button"
      data-nav
      data-nav-default
      data-game={game.id}
      data-hint={running ? 'Details' : game.resumable ? 'Resume' : 'Play'}
      onClick={() => (playable && !running ? ctx.onPlay(game) : ctx.onOpen(game))}
      onFocus={() => ctx.onFocusGame?.(game)}
      aria-label={`${game.resumable ? 'Resume' : 'Play'} ${game.title}`}
      className={cn(
        'group/tile relative shrink-0 snap-start overflow-hidden rounded-2xl bg-neutral-800 text-left text-white shadow-xl outline-none',
        'transition-[transform,box-shadow] duration-200 ease-out motion-reduce:transition-none',
        'hover:ring-2 hover:ring-white/40 focus-visible:ring-[3px] focus-visible:ring-white',
        tvLift,
      )}
      style={{ height, width: Math.round((height * 16) / 9) }}
    >
      {picture ? (
        <ArtImage src={picture} alt="" className="absolute inset-0 size-full object-cover [image-rendering:pixelated]" />
      ) : (
        <div className="absolute inset-0 grid place-items-center p-8">
          <div className="w-28">
            <BoxArt game={game} systemName={ctx.systemName(game.system)} eager />
          </div>
        </div>
      )}
      <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-4 p-5">
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white text-black shadow-lg">
          <Play className="size-5 translate-x-px fill-current" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-white/75">{running ? 'Playing now' : game.resumable ? 'Pick up where you left off' : 'Play again'}</span>
          <span className="truncate text-2xl font-semibold">{game.title}</span>
        </span>
      </div>
    </button>
  );
}

function Row({ title, detail, children, onSeeAll }: { title: string; detail?: string; children: React.ReactNode; onSeeAll?: () => void }) {
  return (
    <section data-nav-row aria-label={title} className="min-w-0 scroll-mt-2">
      <div className="flex items-baseline gap-4 px-16">
        <h2 className="text-2xl font-semibold tracking-tight text-white">{title}</h2>
        {detail && <span className="text-base text-white/60">{detail}</span>}
      </div>
      <div data-shelf className="flex snap-x scroll-px-16 items-end gap-4 overflow-x-auto px-14 pt-4 pb-8 [scrollbar-width:none]">
        {children}
        {onSeeAll && (
          <button
            type="button"
            data-nav
            data-hint="See All"
            onClick={onSeeAll}
            className={cn(
              'grid shrink-0 snap-start place-items-center self-stretch rounded-2xl border-2 border-dashed border-white/25 px-10 text-lg font-semibold text-white/80 outline-none',
              'transition-[transform,background-color] duration-200 hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white',
              tvLift,
            )}
          >
            See All
          </button>
        )}
      </div>
    </section>
  );
}

export function TvHome({
  games,
  systems,
  ctx,
  focused,
  onSection,
}: {
  games: Game[];
  systems: GameSystem[];
  ctx: TileContext;
  focused: Game | null;
  onSection: (section: string) => void;
}) {
  const recent = games.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
  const favorites = games.filter((g) => g.favorite).sort((a, b) => a.title.localeCompare(b.title));
  const bySystem = new Map<string, Game[]>();
  for (const g of games) {
    const list = bySystem.get(g.system);
    if (list) list.push(g);
    else bySystem.set(g.system, [g]);
  }
  const systemById = new Map(systems.map((s) => [s.id, s]));
  const ordered = [...systems].sort((a, b) => Number(b.playable) - Number(a.playable));
  const bare: TileContext = { ...ctx, caption: false };
  const shown = focused ?? recent[0] ?? null;
  // Every box in a row stands as tall as a 3:4 one, each as wide as its system's
  // boxes are, so a row that mixes systems is a shelf of boxes one height.
  const boxHeight = Math.round(tileWidth(ROW_TILE, DEFAULT_BOX_SHAPE) / DEFAULT_BOX_SHAPE);
  const widthOf = (game: Game) => Math.round(boxHeight * tileShape(game.system, bare)) + 16;
  // The continue card stands as tall as the boxes beside it (with a tile's padding).
  const cardHeight = boxHeight + 16;
  const [hero, ...more] = recent;
  const tile = (game: Game) => (
    <div key={game.id} className="shrink-0 snap-start" style={{ width: widthOf(game) }}>
      <GameTile game={game} size={ROW_TILE} ctx={bare} />
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <FocusInfo game={shown} system={shown ? systemById.get(shown.system) : undefined} running={!!shown && ctx.running === shown.id} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-[40vh] [scrollbar-width:none]">
        {hero && (
          <Row title="Continue Playing" onSeeAll={recent.length > SHELF ? () => onSection('recent') : undefined}>
            <ContinueCard game={hero} ctx={bare} height={cardHeight} />
            {more.slice(0, SHELF).map(tile)}
          </Row>
        )}
        {favorites.length > 0 && (
          <Row title="Favorites" detail={`${favorites.length.toLocaleString()} games`} onSeeAll={favorites.length > SHELF ? () => onSection('favorites') : undefined}>
            {favorites.slice(0, SHELF).map(tile)}
          </Row>
        )}
        {ordered.map((s) => {
          const list = sample(bySystem.get(s.id) ?? [], shelfSeed(s.id));
          if (!list.length) return null;
          return (
            <Row key={s.id} title={s.name} detail={s.playable ? `${s.count.toLocaleString()} games` : 'Not playable yet'} onSeeAll={() => onSection(`system:${s.id}`)}>
              {list.map(tile)}
            </Row>
          );
        })}
      </div>
    </div>
  );
}
