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
import { ArtImage, BoxArt } from './art';
import { backdropOf } from './colors';
import { useResumeImage } from './bridge';
import { GameMenuItems, type GameAction } from './GameMenu';
import { lastPlayedText, playTimeText } from './format';
import { tvRing } from './tv';

const big = 'h-12 gap-2 px-6 text-base [&_svg]:size-5';

export function Detail({
  game,
  system,
  running,
  installed,
  onPlay,
  onAction,
  onQuit,
}: {
  game: Game;
  system: GameSystem | undefined;
  running: boolean;
  installed: boolean;
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
          <ArtImage src={backdrop} alt="" className="size-full scale-125 object-cover opacity-50 blur-3xl saturate-150 dark:opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/60 to-background" />
        </div>
      )}
      <div className="relative mx-auto flex max-w-5xl flex-col gap-8 px-8 pt-10 pb-12">
        <div className="flex flex-col gap-8 @2xl:flex-row @2xl:items-end">
          <div className="w-48 shrink-0 self-center @2xl:w-56 @2xl:self-end">
            <BoxArt game={game} systemName={system?.name} eager />
          </div>
          <div className="flex min-w-0 flex-col gap-3 pb-1">
            <h1 className="font-[family-name:var(--font-title)] text-4xl font-semibold tracking-tight text-balance @3xl:text-[2.75rem]">{game.title}</h1>
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
                <ArtImage
                  key={src}
                  src={src}
                  alt=""
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

/** A fact about a game in the TV view's game page: a small label over a big value. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-[0.18em] text-white/60 uppercase">{label}</span>
      <span className="text-xl font-medium text-white">{value}</span>
    </div>
  );
}

const tvButton = cn(
  'inline-flex h-16 items-center gap-3 rounded-full px-8 text-xl font-semibold outline-none [&_svg]:size-6',
  'transition-[transform,box-shadow,background-color] duration-150 ease-out motion-reduce:transition-none',
  'focus-visible:ring-[3px] focus-visible:ring-white in-data-[tv-focus]:focus:scale-105',
  tvRing,
);

/**
 * One game in the TV view: its picture fills the screen behind (the shell
 * draws it), its box and title stand at the bottom of the first screenful with
 * Play, big, and what's been played below; the rest is a scroll away.
 */
export function TvDetail({
  game,
  system,
  running,
  installed,
  onPlay,
  onAction,
  onQuit,
}: {
  game: Game;
  system: GameSystem | undefined;
  running: boolean;
  installed: boolean;
  onPlay: (fresh?: boolean) => void;
  onAction: (action: GameAction) => void;
  onQuit: () => void;
}) {
  const { data: resume } = useResumeImage(game);
  const playable = !!system?.playable;
  const pictures = [game.art?.title, game.art?.snap].filter((p): p is string => !!p);
  const time = playTimeText(game.playTime);
  const last = lastPlayedText(game.lastPlayed);

  return (
    <div className="flex flex-col gap-14 pb-16 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="flex min-h-[calc(100vh-10rem)] items-end gap-10 px-16 pb-4">
        <div className="w-60 shrink-0 drop-shadow-[0_24px_48px_rgb(0_0_0/0.6)] motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-500">
          <BoxArt game={game} systemName={system?.name} eager />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold tracking-[0.2em] text-white/70 uppercase">
              {system?.name}
              {system?.maker ? ` · ${system.maker}` : ''}
            </span>
            <h1 className="font-[family-name:var(--font-title)] text-7xl leading-[1.02] font-bold tracking-tight text-balance text-white drop-shadow-[0_2px_24px_rgb(0_0_0/0.6)]">
              {game.title}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {running ? (
              <>
                <span className="inline-flex h-16 items-center gap-3 rounded-full bg-white/10 px-8 text-xl font-semibold text-white">
                  <span className="size-3 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
                  Playing
                </span>
                <button type="button" data-nav data-nav-default data-hint="Quit" onClick={onQuit} className={cn(tvButton, 'bg-white/15 text-white hover:bg-white/25')}>
                  <Square aria-hidden />
                  Quit
                </button>
              </>
            ) : (
              <button
                type="button"
                data-nav
                data-nav-default
                data-hint={!playable ? (installed ? undefined : 'Install') : game.resumable ? 'Resume' : 'Play'}
                disabled={!playable && installed}
                onClick={() => (playable ? onPlay() : void window.open(appLink('settings', { section: 'features' })))}
                className={cn(tvButton, 'min-w-60 justify-center bg-pigment text-primary-foreground clay-pigment hover:brightness-110 disabled:opacity-50')}
              >
                <Play className="fill-current" aria-hidden />
                {!playable ? (installed ? 'Can’t Play Yet' : 'Install to Play') : game.resumable ? 'Resume' : 'Play'}
              </button>
            )}
            {game.resumable && !running && playable && (
              <button type="button" data-nav data-hint="Start Over" onClick={() => onAction({ kind: 'startOver' })} className={cn(tvButton, 'bg-white/10 text-white hover:bg-white/20')}>
                <RotateCcw aria-hidden />
                Start Over
              </button>
            )}
            <button
              type="button"
              data-nav
              data-hint={game.favorite ? 'Unfavorite' : 'Favorite'}
              aria-pressed={game.favorite}
              aria-label={game.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
              title={game.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
              onClick={() => onAction({ kind: 'favorite' })}
              className={cn(tvButton, 'size-16 justify-center bg-white/10 px-0 text-white hover:bg-white/20')}
            >
              <Star className={cn(game.favorite && 'fill-amber-400 text-amber-400')} aria-hidden />
            </button>
          </div>
          {!playable && system?.unavailable && <p className="max-w-prose text-lg text-white/70">{system.unavailable}</p>}
          <div className="mt-2 flex flex-wrap gap-x-12 gap-y-4">
            {system && <Stat label="System" value={`${system.name}${system.year ? `, ${system.year}` : ''}`} />}
            <Stat label="Play time" value={time ? time.replace(/ played$/, '') : 'Not played yet'} />
            {last && <Stat label="Last played" value={last.replace(/^Played /, '').replace(/^\w/, (c) => c.toUpperCase())} />}
            {game.versions.length > 1 && <Stat label="Versions" value={String(game.versions.length)} />}
          </div>
        </div>
      </div>

      {(resume || pictures.length > 0) && (
        <section aria-label="Pictures" data-nav-row className="flex flex-col gap-4 px-16">
          <h2 className="text-2xl font-semibold text-white">{resume ? 'Where You Left It' : 'Pictures'}</h2>
          <div className="flex flex-wrap gap-6">
            {resume && <img src={resume} alt={`${game.title}, where you left it`} className="h-72 rounded-2xl shadow-2xl [image-rendering:pixelated]" />}
            {pictures.map((src) => (
              <ArtImage
                key={src}
                src={src}
                alt=""
                onError={(e) => (e.currentTarget.style.display = 'none')}
                className="h-72 rounded-2xl bg-white/5 object-contain shadow-2xl [image-rendering:pixelated]"
              />
            ))}
          </div>
        </section>
      )}

      {game.versions.length > 1 && (
        <section aria-label="Versions" className="flex max-w-4xl flex-col gap-4 px-16">
          <h2 className="text-2xl font-semibold text-white">Versions</h2>
          <div className="flex flex-col gap-1">
            {game.versions.map((v) => (
              <button
                key={v.path}
                type="button"
                data-nav
                data-hint="Play This One"
                onClick={() => onAction({ kind: 'version', path: v.path })}
                aria-current={v.path === game.path || undefined}
                className={cn(
                  'flex h-14 items-center gap-4 rounded-xl px-5 text-left text-lg text-white outline-none focus-visible:ring-[3px] focus-visible:ring-white',
                  tvRing,
                  v.path === game.path ? 'bg-white/15 font-semibold' : 'hover:bg-white/10',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
                {v.path === game.path && <span className="text-base text-white/70">Plays</span>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
