import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, Gamepad2, Minimize2, RefreshCw, Square } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Game, GameSystem, GamesStatus } from '@/lib/games';
import { cn } from '@/lib/utils';
import { useDin, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { ContentPane, EmptyState, PillButton, SearchField, ToolButton } from '@/shared/appChrome';
import { focusRing, titleSearch, toolIcon } from '@/shared/appChromeStyles';
import { appLink } from '@/shared/launch';
import { toast } from '@/shared/toast';
import { backdropOf } from './games/colors';
import { cleanError, useBridge, useGameActions, useGamesChanges, useLibrary, useResumeImage, useStatus } from './games/bridge';
import { Detail } from './games/Detail';
import { GameGrid, type TileContext } from './games/GameGrid';
import type { GameAction } from './games/GameMenu';
import { Home } from './games/Home';
import { focusFirst, moveFocus, useNavInput, type NavAction } from './games/input';
import { Sidebar } from './games/Sidebar';

const SECTION_KEY = 'games:section';

function TitleBar({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <WindowDragRegion className={cn('flex h-12 shrink-0 items-center gap-2 px-3', className)}>
      {children}
      <div className="flex-1" />
      <WindowControls />
    </WindowDragRegion>
  );
}

/**
 * Games - the games in ~/roms, as an Apple TV would show them: box art to
 * browse by system, the game last played up top to pick up where it was
 * left, and Play, which opens it full screen in an emulator Din set up for
 * it (din.system.games, the `games` permission; electron/games.mts). Full
 * screen, it's a TV's: big, dark, and driven by a controller.
 */
export function Games() {
  const bridge = useBridge();
  useGamesChanges();
  const { data: status } = useStatus();
  if (!bridge) {
    return (
      <div className="flex h-full w-full flex-col text-foreground">
        <TitleBar />
        <ContentPane inset={false} className="border-t-0">
          <p className="m-auto max-w-sm p-8 text-center text-sm text-muted-foreground">Games works in Din’s desktop app.</p>
        </ContentPane>
      </div>
    );
  }
  return <Library status={status} />;
}

/** Whether the window is full screen, and a way to change it. */
function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const update = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);
  return [on, toggle];
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

type Confirm = { kind: 'startOver'; game: Game } | { kind: 'switch'; game: Game; fresh: boolean };

function Library({ status }: { status: GamesStatus | undefined }) {
  const din = useDin();
  const { data: library, isLoading, refetch, isFetching } = useLibrary();
  const actions = useGameActions();
  const [couch, toggleFullscreen] = useFullscreen();
  const [chosenSection, setSectionState] = useState(() => localStorage.getItem(SECTION_KEY) ?? 'home');
  const [openId, setOpenId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState<Game | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The tile a game's page was opened from, to come back to. */
  const cameFrom = useRef<string | null>(null);

  const systems = useMemo(() => library?.systems ?? [], [library]);
  const games = useMemo(() => library?.games ?? [], [library]);
  const systemById = useMemo(() => new Map(systems.map((s) => [s.id, s])), [systems]);
  const gameById = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const open = openId ? (gameById.get(openId) ?? null) : null;
  // A system that's gone (its folder removed) leaves Home showing.
  const section = library && chosenSection.startsWith('system:') && !systemById.has(chosenSection.slice(7)) ? 'home' : chosenSection;
  const running = status?.running ?? null;
  const installed = status?.installed ?? false;

  const setSection = useCallback((next: string) => {
    setSectionState(next);
    setOpenId(null);
    setQuery('');
    localStorage.setItem(SECTION_KEY, next);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);


  const sectionList = useMemo(() => ['home', 'favorites', 'recent', ...systems.map((s) => `system:${s.id}`)], [systems]);
  const sectionLabel = (id: string) =>
    id === 'home' ? 'Home' : id === 'favorites' ? 'Favorites' : id === 'recent' ? 'Recently Played' : (systemById.get(id.slice(7))?.name ?? 'Games');

  const listed = useMemo(() => {
    const q = normalize(query);
    if (q) {
      const hits = games.filter((g) => normalize(g.title).includes(q));
      return hits.sort((a, b) => Number(normalize(b.title).startsWith(q)) - Number(normalize(a.title).startsWith(q)));
    }
    if (section === 'favorites') return games.filter((g) => g.favorite).sort((a, b) => a.title.localeCompare(b.title));
    if (section === 'recent') return games.filter((g) => g.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
    if (section.startsWith('system:')) return games.filter((g) => g.system === section.slice(7));
    return null;
  }, [games, query, section]);

  useWindowTitle(open ? open.title : query ? 'Search' : sectionLabel(section));

  const play = useCallback(
    (game: Game, fresh = false) => {
      const system = systemById.get(game.system);
      if (!system?.playable) {
        if (!installed) window.open(appLink('settings', { section: 'features' }));
        else toast(`${game.title} can’t be played yet`, { body: system?.unavailable ?? undefined });
        return;
      }
      if (running && running.id !== game.id) {
        setConfirm({ kind: 'switch', game, fresh });
        return;
      }
      if (running?.id === game.id) return;
      actions.play.mutate({ game, options: { fresh } });
    },
    [systemById, installed, running, actions.play],
  );

  const showInFiles = useCallback(
    async (path: string) => {
      try {
        const dir = path.slice(0, path.lastIndexOf('/')) || '/';
        const handle = await din.files.fromPath(dir);
        await din.app.launch(appLink('file-browser', { select: path.slice(path.lastIndexOf('/') + 1) }), [handle]);
      } catch (error) {
        toast('Couldn’t show it in Files', { body: cleanError(error), destructive: true });
      }
    },
    [din],
  );

  const onAction = useCallback(
    (game: Game, action: GameAction) => {
      switch (action.kind) {
        case 'play':
          play(game);
          return;
        case 'startOver':
          setConfirm({ kind: 'startOver', game });
          return;
        case 'favorite':
          actions.favorite.mutate(game);
          return;
        case 'version':
          actions.setVersion.mutate({ game, path: action.path });
          return;
        case 'show':
          void showInFiles(game.path);
          return;
      }
    },
    [play, actions.favorite, actions.setVersion, showInFiles],
  );

  const openGame = useCallback((game: Game) => {
    cameFrom.current = game.id;
    setOpenId(game.id);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  const closeGame = useCallback(() => {
    setOpenId(null);
    const id = cameFrom.current;
    requestAnimationFrame(() => {
      const tile = id ? document.querySelector<HTMLElement>(`[data-game="${CSS.escape(id)}"]`) : null;
      if (tile) {
        tile.focus({ preventScroll: true });
        tile.scrollIntoView({ block: 'center' });
      }
    });
  }, []);

  // A game's page opens with Play focused, for A to start it.
  useEffect(() => {
    if (openId) requestAnimationFrame(() => focusFirst(scrollRef.current ?? document));
  }, [openId]);

  const focusedGame = (): Game | null => {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-game]') : null;
    return (el && gameById.get(el.dataset.game ?? '')) || open;
  };

  const onNav = (action: NavAction) => {
    switch (action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        moveFocus(action);
        return;
      case 'accept': {
        const el = document.activeElement;
        if (el instanceof HTMLElement && el !== document.body) el.click();
        else focusFirst();
        return;
      }
      case 'back':
        if (confirm) setConfirm(null);
        else if (open) closeGame();
        else if (query) setQuery('');
        else if (section !== 'home') setSection('home');
        return;
      case 'play': {
        const game = focusedGame();
        if (game) play(game);
        return;
      }
      case 'favorite': {
        const game = focusedGame();
        if (game) actions.favorite.mutate(game);
        return;
      }
      case 'search':
        searchRef.current?.focus();
        return;
      case 'prevSection':
      case 'nextSection': {
        const i = sectionList.indexOf(section);
        const next = sectionList[(i + (action === 'nextSection' ? 1 : sectionList.length - 1)) % sectionList.length];
        setSection(next);
        return;
      }
      case 'fullscreen':
        toggleFullscreen();
        return;
    }
  };
  const { connected, input } = useNavInput(onNav, !running);

  const ctx: TileContext = {
    systemName: (id) => systemById.get(id)?.name ?? id,
    playable: (id) => !!systemById.get(id)?.playable,
    running: running?.id ?? null,
    mixed: !!query || section === 'favorites' || section === 'recent',
    onOpen: openGame,
    onPlay: (game) => play(game),
    onAction,
    onFocusGame: setFocused,
  };
  const size = couch ? 'lg' : 'md';

  let body: React.ReactNode;
  if (isLoading || !library) {
    body = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4 p-6">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="space-y-2 p-2">
            <Skeleton className="aspect-[3/4] w-full rounded-lg" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  } else if (!systems.length) {
    body = (
      <EmptyState
        icon={Gamepad2}
        title="Put your games in your games folder"
        className="m-auto py-24"
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <PillButton variant="primary" onClick={() => void showInFiles(`${library.root}/.`)}>
              <FolderOpen aria-hidden />
              Open Games Folder
            </PillButton>
            <PillButton onClick={() => void refetch()} disabled={isFetching}>
              <RefreshCw aria-hidden className={cn(isFetching && 'motion-safe:animate-spin')} />
              Check Again
            </PillButton>
          </div>
        }
      >
        <p className="text-base">
          Make a folder in {library.root.replace(/^\/home\/[^/]+/, '~')} for each system, named as RetroArch names them (snes, gba, n64,
          psx…), and put its games in it. Zipped games are fine.
        </p>
      </EmptyState>
    );
  } else if (open) {
    body = (
      <Detail
        game={open}
        system={systemById.get(open.system)}
        running={running?.id === open.id}
        installed={installed}
        couch={couch}
        onPlay={(fresh) => play(open, fresh)}
        onAction={(action) => onAction(open, action)}
        onQuit={() => actions.stop.mutate()}
      />
    );
  } else if (listed) {
    const system = section.startsWith('system:') && !query ? systemById.get(section.slice(7)) : undefined;
    body = (
      <div className="flex flex-col gap-4 px-4 pt-6 pb-10">
        <SectionHeader title={query ? `Results for “${query}”` : sectionLabel(section)} system={system} count={listed.length} couch={couch} />
        {listed.length ? (
          <GameGrid key={query ? `search:${query}` : section} games={listed} size={size} ctx={ctx} />
        ) : (
          <EmptyState className="py-16" title={query ? 'No games match' : section === 'favorites' ? 'No favorites yet' : 'Nothing played yet'}>
            {query
              ? 'Try fewer letters, or another spelling.'
              : section === 'favorites'
                ? 'Right-click a game, or press X on a controller, to make it a favorite.'
                : 'Games you play show up here, newest first.'}
          </EmptyState>
        )}
      </div>
    );
  } else {
    body = <Home games={games} systems={systems} ctx={ctx} size={size} couch={couch} onSection={setSection} />;
  }

  const banners = (
    <>
      {status && !installed && (
        <Banner>
          <span className="min-w-0 flex-1">
            {status.optionalFeature
              ? 'To play, install Games: RetroArch and its emulators, an optional feature of DinOS, about 410 MB.'
              : 'To play, install RetroArch and its cores with your package manager.'}
          </span>
          {status.optionalFeature && (
            <PillButton size="sm" variant="primary" onClick={() => void window.open(appLink('settings', { section: 'features' }))}>
              Install Games
            </PillButton>
          )}
        </Banner>
      )}
      {running && (
        <Banner>
          <span className="size-2 shrink-0 rounded-full bg-success motion-safe:animate-pulse" aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            Playing <span className="font-semibold">{running.title}</span>. Start+Select on a controller, or Escape, quits back here.
          </span>
          <PillButton size="sm" onClick={() => actions.stop.mutate()}>
            <Square aria-hidden />
            Quit
          </PillButton>
        </Banner>
      )}
    </>
  );

  const dialogs = (
    <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
      <AlertDialogContent>
        {confirm?.kind === 'startOver' && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Start {confirm.game.title} over?</AlertDialogTitle>
              <AlertDialogDescription>Where you left it is forgotten, and it starts from the beginning. Saves you made in the game stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-nav>Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-nav
                variant="destructive"
                onClick={() => {
                  const game = confirm.game;
                  actions.startOver.mutate(game, { onSuccess: () => play({ ...game, resumable: false }, true) });
                }}
              >
                Start Over
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
        {confirm?.kind === 'switch' && running && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Quit {running.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                To play {confirm.game.title}, {running.title} quits. Where you are in it is kept for next time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-nav>Cancel</AlertDialogCancel>
              <AlertDialogAction data-nav onClick={() => actions.play.mutate({ game: confirm.game, options: { fresh: confirm.fresh } })}>
                Quit and Play
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );

  if (couch) {
    return (
      <Couch
        input={input}
        connected={connected}
        backdropGame={open ?? focused}
        sections={sectionList}
        section={query ? null : section}
        sectionLabel={sectionLabel}
        onSection={setSection}
        query={query}
        onQuery={setQuery}
        searchRef={searchRef}
        open={!!open}
        onBack={open ? closeGame : null}
        onExit={toggleFullscreen}
        scrollRef={scrollRef}
      >
        {banners}
        {body}
        {dialogs}
      </Couch>
    );
  }

  return (
    <div data-input={input} className="flex h-full w-full text-foreground">
      <Sidebar
        systems={systems}
        loading={isLoading}
        section={query ? '' : section}
        favorites={games.filter((g) => g.favorite).length}
        onSection={setSection}
        onFullscreen={toggleFullscreen}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar>
          {open && (
            <ToolButton label="Back" onClick={closeGame}>
              <ArrowLeft {...toolIcon} />
            </ToolButton>
          )}
          <SearchField ref={searchRef} value={query} onValueChange={(v) => { setQuery(v); setOpenId(null); }} placeholder="Search Games" aria-label="Search games" className={titleSearch} />
        </TitleBar>
        <ContentPane>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {banners}
            {body}
          </div>
        </ContentPane>
      </div>
      {dialogs}
    </div>
  );
}

function SectionHeader({ title, system, count, couch }: { title: string; system?: GameSystem; count: number; couch: boolean }) {
  return (
    <header className="flex flex-col gap-1 px-2">
      <h1 className={cn('font-[family-name:var(--font-title)] font-semibold tracking-tight', couch ? 'text-5xl' : 'text-4xl')}>{title}</h1>
      <p className="text-base text-muted-foreground">
        {system ? `${system.maker} · ${system.year} · ` : ''}
        {count.toLocaleString()} {count === 1 ? 'game' : 'games'}
        {system?.unavailable ? ` · ${system.unavailable}` : ''}
      </p>
    </header>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 px-4 pt-4">
      <div className="glass-surface flex items-center gap-3 rounded-2xl px-4 py-3 text-sm shadow-sm">{children}</div>
    </div>
  );
}

/** A controller's button, drawn for the hints along the bottom of the TV view. */
function ButtonHint({ glyph, label }: { glyph: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="grid h-7 min-w-7 place-items-center rounded-full bg-white/15 px-2 text-xs font-bold text-white">{glyph}</span>
      <span className="text-sm text-white/80">{label}</span>
    </span>
  );
}

/**
 * Full screen, Games is a TV's: dark, over a soft wash of the game in focus,
 * its sections across the top (the shoulder buttons step through them), big
 * tiles, and what a controller's buttons do along the bottom.
 */
function Couch({
  children,
  input,
  connected,
  backdropGame,
  sections,
  section,
  sectionLabel,
  onSection,
  query,
  onQuery,
  searchRef,
  open,
  onBack,
  onExit,
  scrollRef,
}: {
  children: React.ReactNode;
  input: string;
  connected: boolean;
  backdropGame: Game | null;
  sections: string[];
  section: string | null;
  sectionLabel: (id: string) => string;
  onSection: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  open: boolean;
  onBack: (() => void) | null;
  onExit: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { data: resume } = useResumeImage(backdropGame);
  const backdrop = backdropOf(backdropGame, resume);
  const [shown, setShown] = useState<string | null>(backdrop);
  // The wash changes after focus settles, not with every tile passed.
  useEffect(() => {
    const t = setTimeout(() => setShown(backdrop), 250);
    return () => clearTimeout(t);
  }, [backdrop]);
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [section]);

  return (
    <div data-input={input} className="dark relative isolate flex h-full w-full flex-col overflow-hidden bg-neutral-950 text-foreground">
      <div aria-hidden className="absolute inset-0 -z-10">
        {shown && <img key={shown} src={shown} alt="" className="size-full scale-110 object-cover opacity-35 blur-3xl saturate-150 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-700" />}
        <div className="absolute inset-0 bg-gradient-to-b from-neutral-950/30 via-neutral-950/70 to-neutral-950" />
      </div>
      <header className="flex h-20 shrink-0 items-center gap-4 px-8">
        {onBack ? (
          <button type="button" data-nav onClick={onBack} aria-label="Back" className={cn('grid size-11 shrink-0 place-items-center rounded-full bg-white/10 hover:bg-white/15', focusRing)}>
            <ArrowLeft className="size-5" aria-hidden />
          </button>
        ) : (
          <img src="/icons/apps/games.png" alt="" aria-hidden className="size-9 shrink-0" />
        )}
        <div ref={stripRef} role="tablist" aria-label="Sections" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
          {!open &&
            sections.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                data-nav
                aria-selected={section === id}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => onSection(id)}
                className={cn(
                  'h-10 shrink-0 rounded-full px-4 text-base font-medium whitespace-nowrap transition-colors',
                  focusRing,
                  section === id ? 'bg-white text-black' : 'text-white/75 hover:bg-white/10 hover:text-white',
                  'in-data-[input=pad]:focus:ring-[3px] in-data-[input=pad]:focus:ring-white/80',
                )}
              >
                {sectionLabel(id)}
              </button>
            ))}
        </div>
        <SearchField ref={searchRef} value={query} onValueChange={onQuery} placeholder="Search" aria-label="Search games" className="w-64 shrink-0" />
        <button type="button" onClick={onExit} aria-label="Exit Full Screen" title="Exit Full Screen" className={cn('grid size-11 shrink-0 place-items-center rounded-full text-white/75 hover:bg-white/10 hover:text-white', focusRing)}>
          <Minimize2 className="size-5" aria-hidden />
        </button>
      </header>
      <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
      {connected && (
        <footer className="flex h-14 shrink-0 items-center justify-end gap-6 px-8">
          <ButtonHint glyph="A" label="Select" />
          <ButtonHint glyph="B" label="Back" />
          <ButtonHint glyph="X" label="Favorite" />
          <ButtonHint glyph="Y" label="Search" />
          <ButtonHint glyph="LB RB" label="Sections" />
          <ButtonHint glyph="START" label="Play" />
        </footer>
      )}
    </div>
  );
}
