/**
 * Games laid out to browse: tiles of box art in a grid that fills the pane
 * (shown a screenful at a time as it's scrolled, since a system can have
 * thousands), or in a shelf that scrolls sideways. Each tile is a stop for
 * the controller (`data-nav`), and has the game's right-click menu.
 */
import { useEffect, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { Game } from '@/lib/games';
import { cn } from '@/lib/utils';
import { focusRing } from '@/shared/appChromeStyles';
import { BoxArt } from './art';
import { tileShape, tileWidth } from './tiles';
import { tvLift } from './tv';
import { GameMenuItems, type GameAction } from './GameMenu';

export type TileSize = 'md' | 'lg';

/** Everything a tile needs from the library around it. */
export interface TileContext {
  systemName: (id: string) => string;
  playable: (system: string) => boolean;
  running: string | null;
  /** Whether the tile says its system (in lists that mix them). */
  mixed?: boolean;
  onOpen: (game: Game) => void;
  onPlay: (game: Game) => void;
  onAction: (game: Game, action: GameAction) => void;
  onFocusGame?: (game: Game) => void;
  /** Whether tiles have their titles under them (the TV view's home shows the focused one's above the rows instead). */
  caption?: boolean;
}

export function GameTile({ game, size, ctx, ...props }: { game: Game; size: TileSize; ctx: TileContext } & Omit<React.ComponentProps<'button'>, 'children'>) {
  const subtitle = ctx.running === game.id ? 'Playing' : ctx.mixed ? ctx.systemName(game.system) : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-nav
          data-game={game.id}
          data-hint="Details"
          onClick={() => ctx.onOpen(game)}
          onDoubleClick={() => ctx.onPlay(game)}
          onFocus={() => ctx.onFocusGame?.(game)}
          aria-label={`${game.title}, ${ctx.systemName(game.system)}`}
          {...props}
          className={cn(
            'group/tile relative flex w-full min-w-0 flex-col items-stretch gap-2 rounded-xl p-2 text-left outline-none',
            'transition-[transform,background-color] duration-200 ease-out motion-reduce:transition-none',
            'hover:bg-foreground/5 focus-visible:bg-foreground/5',
            focusRing,
            // A controller's focus is the tile lifted toward you, as on a TV.
            'in-data-[input=pad]:focus:scale-[1.06] in-data-[input=pad]:focus:bg-foreground/[0.08] in-data-[input=pad]:focus:ring-[3px] in-data-[input=pad]:focus:ring-ring/70',
            tvLift,
            props.className,
          )}
        >
          <BoxArt game={game} systemName={ctx.systemName(game.system)} shape={tileShape(game.system, ctx)} />
          {ctx.caption === false ? (
            (game.favorite || ctx.running === game.id) && (
              <span className="absolute right-3 bottom-3 flex items-center gap-1">
                {ctx.running === game.id && <span className="rounded-full bg-success px-2 py-0.5 text-xs font-semibold text-white shadow">Playing</span>}
                {game.favorite && <Star className="size-5 fill-amber-400 text-amber-400 drop-shadow" aria-label="Favorite" />}
              </span>
            )
          ) : (
            <span className="min-w-0 px-0.5">
              <span className={cn('flex items-center gap-1 font-medium', size === 'lg' ? 'text-base' : 'text-sm')}>
                <span className="truncate">{game.title}</span>
                {game.favorite && <Star className="size-3.5 shrink-0 fill-current text-amber-500" aria-label="Favorite" />}
              </span>
              {subtitle && <span className={cn('block truncate text-muted-foreground', size === 'lg' ? 'text-sm' : 'text-xs')}>{subtitle}</span>}
            </span>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <GameMenuItems game={game} kind="context" playable={ctx.playable(game.system)} onAction={(action) => ctx.onAction(game, action)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

const PAGE = 120;

/** A grid of games, the rest shown as it's scrolled near. Keyed by what it lists, so a different list starts at its top. */
export function GameGrid({ games, size, ctx, className }: { games: Game[]; size: TileSize; ctx: TileContext; className?: string }) {
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= games.length) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(games.length, n + PAGE));
    }, { rootMargin: '1200px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown, games.length]);

  const shape = tileShape(games[0]?.system, ctx);
  return (
    <div className={className}>
      <div role="list" className="grid gap-x-2 gap-y-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${tileWidth(size, shape)}px, 1fr))` }}>
        {games.slice(0, shown).map((game) => (
          <div role="listitem" key={game.id} className="min-w-0">
            <GameTile game={game} size={size} ctx={ctx} />
          </div>
        ))}
      </div>
      {shown < games.length && <div ref={sentinel} className="h-px" aria-hidden />}
    </div>
  );
}

/** A row of games that scrolls sideways, under its heading. */
export function Shelf({
  title,
  detail,
  games,
  size,
  ctx,
  onSeeAll,
}: {
  title: string;
  detail?: string;
  games: Game[];
  size: TileSize;
  ctx: TileContext;
  onSeeAll?: () => void;
}) {
  if (!games.length) return null;
  const width = tileWidth(size, tileShape(games[0].system, ctx)) + 12;
  return (
    <section className="min-w-0" aria-label={title}>
      <div className="flex items-baseline gap-3 px-6">
        <h2 className={cn('font-[family-name:var(--font-title)] font-semibold tracking-tight', size === 'lg' ? 'text-2xl' : 'text-xl')}>{title}</h2>
        {detail && <span className="text-sm text-muted-foreground">{detail}</span>}
        <span className="flex-1" />
        {onSeeAll && (
          <button type="button" data-nav onClick={onSeeAll} className={cn('rounded-full px-3 py-1 text-sm font-medium text-ink-accent hover:bg-foreground/5', focusRing)}>
            See All
          </button>
        )}
      </div>
      <div data-shelf className="flex snap-x scroll-px-6 gap-2 overflow-x-auto px-4 pt-2 pb-4 [scrollbar-width:none]">
        {games.map((game) => (
          <div key={game.id} className="shrink-0 snap-start" style={{ width }}>
            <GameTile game={game} size={size} ctx={ctx} />
          </div>
        ))}
      </div>
    </section>
  );
}
