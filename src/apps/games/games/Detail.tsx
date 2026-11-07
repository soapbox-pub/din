/**
 * One game, as a page: its box art over a soft wash of its screenshot (or
 * the moment it was left at), what it is, how long it's been played, and
 * Play, which resumes where it was left when it was. Its other copies and
 * its pictures below.
 */
import { MoreHorizontal, Play, RotateCcw, Square, Star } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { Game, GameSystem } from '@/lib/games';
import { cn } from '@/lib/utils';
import { focusRing } from '@/shared/appChromeStyles';
import { appLink } from '@/shared/launch';
import { BoxArt } from './art';
import { backdropOf } from './colors';
import { useResumeImage } from './bridge';
import { GameMenuItems, type GameAction } from './GameMenu';

function playTimeText(seconds: number): string | null {
  if (seconds < 60) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} played`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'} played`;
}

function lastPlayedText(at: number | null): string | null {
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1) return 'Played today';
  if (days < 2) return 'Played yesterday';
  if (days < 7) return `Played ${days} days ago`;
  return `Played ${new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}`;
}

const big = 'h-12 gap-2 px-6 text-base [&_svg]:size-5';

export function Detail({
  game,
  system,
  running,
  installed,
  couch,
  onPlay,
  onAction,
  onQuit,
}: {
  game: Game;
  system: GameSystem | undefined;
  running: boolean;
  installed: boolean;
  couch: boolean;
  onPlay: (fresh?: boolean) => void;
  onAction: (action: GameAction) => void;
  onQuit: () => void;
}) {
  const { data: resume } = useResumeImage(game);
  const backdrop = backdropOf(game, resume);
  const playable = !!system?.playable;
  const meta = [system?.name, playTimeText(game.playTime), lastPlayedText(game.lastPlayed)].filter(Boolean).join(' · ');
  const pictures = [game.art?.title, game.art?.snap].filter((p): p is string => !!p);

  return (
    <div className="relative min-h-full">
      {/* The wash: the game's own picture, blurred far back. */}
      {backdrop && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[28rem] overflow-hidden">
          <img src={backdrop} alt="" className="size-full scale-125 object-cover opacity-50 blur-3xl saturate-150 dark:opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/60 to-background" />
        </div>
      )}
      <div className={cn('relative mx-auto flex max-w-5xl flex-col gap-8 px-8 pt-10 pb-12', couch && 'max-w-6xl pt-14')}>
        <div className="flex flex-col gap-8 @2xl:flex-row @2xl:items-end">
          <div className={cn('w-48 shrink-0 self-center @2xl:self-end', couch ? 'w-64' : '@2xl:w-56')}>
            <BoxArt game={game} systemName={system?.name} eager />
          </div>
          <div className="flex min-w-0 flex-col gap-3 pb-1">
            <h1 className={cn('font-[family-name:var(--font-title)] font-semibold tracking-tight text-balance', couch ? 'text-5xl' : 'text-4xl @3xl:text-[2.75rem]')}>{game.title}</h1>
            {meta && <p className="text-base text-muted-foreground">{meta}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {running ? (
                <>
                  <span className={cn('inline-flex items-center rounded-full bg-foreground/[0.07] font-medium', big)}>
                    <span className="size-2 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
                    Playing
                  </span>
                  <button type="button" data-nav data-nav-default onClick={onQuit} className={cn('inline-flex items-center rounded-full border border-border/70 bg-background font-medium clay hover:bg-foreground/[0.05]', big, focusRing)}>
                    <Square aria-hidden />
                    Quit
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-nav
                  data-nav-default
                  disabled={!playable && installed}
                  onClick={() => (playable ? onPlay() : void window.open(appLink('settings', { section: 'features' })))}
                  className={cn(
                    'inline-flex items-center rounded-full bg-pigment font-semibold text-primary-foreground clay-pigment hover:brightness-110 disabled:opacity-50',
                    big,
                    focusRing,
                    'in-data-[input=pad]:focus:ring-4',
                  )}
                >
                  <Play className="fill-current" aria-hidden />
                  {!playable ? (installed ? 'Can’t Play Yet' : 'Install to Play') : game.resumable ? 'Resume' : 'Play'}
                </button>
              )}
              {game.resumable && !running && playable && (
                <button type="button" data-nav onClick={() => onAction({ kind: 'startOver' })} className={cn('inline-flex items-center rounded-full border border-border/70 bg-background font-medium clay hover:bg-foreground/[0.05]', big, focusRing)}>
                  <RotateCcw aria-hidden />
                  Start Over
                </button>
              )}
              <button
                type="button"
                data-nav
                aria-pressed={game.favorite}
                aria-label={game.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
                title={game.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
                onClick={() => onAction({ kind: 'favorite' })}
                className={cn('grid size-12 place-items-center rounded-full border border-border/70 bg-background clay hover:bg-foreground/[0.05]', focusRing)}
              >
                <Star className={cn('size-5', game.favorite && 'fill-amber-500 text-amber-500')} aria-hidden />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" data-nav aria-label="More" title="More" className={cn('grid size-12 place-items-center rounded-full border border-border/70 bg-background clay hover:bg-foreground/[0.05]', focusRing)}>
                    <MoreHorizontal className="size-5" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <GameMenuItems game={game} kind="dropdown" playable={playable} onAction={onAction} />
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {!playable && system?.unavailable && <p className="max-w-prose text-sm text-muted-foreground">{system.unavailable}</p>}
          </div>
        </div>

        {resume && (
          <section aria-label="Where you left it" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Where You Left It</h2>
            <img src={resume} alt={`${game.title}, where you left it`} className="w-full max-w-md rounded-xl shadow-md [image-rendering:pixelated]" />
          </section>
        )}

        {pictures.length > 0 && (
          <section aria-label="Pictures" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Pictures</h2>
            <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
              {pictures.map((src) => (
                <img
                  key={src}
                  src={src}
                  alt=""
                  loading="lazy"
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                  className="w-full rounded-xl bg-foreground/5 object-contain shadow-sm [image-rendering:pixelated]"
                />
              ))}
            </div>
          </section>
        )}

        {game.versions.length > 1 && (
          <section aria-label="Versions" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Versions</h2>
            <div className="flex flex-col gap-0.5">
              {game.versions.map((v) => (
                <button
                  key={v.path}
                  type="button"
                  data-nav
                  onClick={() => onAction({ kind: 'version', path: v.path })}
                  aria-current={v.path === game.path || undefined}
                  className={cn(
                    'flex h-10 items-center gap-3 rounded-lg px-3 text-left text-sm',
                    focusRing,
                    v.path === game.path ? 'bg-selected font-medium' : 'hover:bg-foreground/5',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{v.label}</span>
                  {v.path === game.path && <span className="text-xs text-muted-foreground">Plays</span>}
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
