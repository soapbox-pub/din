/**
 * Games full screen, the TV view: made to be read from the couch and driven
 * by a controller. The game in focus fills the screen behind everything, its
 * own picture sharp at the top right and fading into the dark, drifting
 * slowly; the sections run across the top (the shoulder buttons step through
 * them), with the time and the battery at the right; a menu slides in from
 * the left (View, or the guide button); search has a keyboard of its own that
 * a controller can type on; what each button does right now runs along the
 * bottom, and each of those can be clicked too. Moving about ticks softly.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Battery,
  BatteryCharging,
  BatteryLow,
  BatteryMedium,
  Clock,
  Delete,
  Gamepad2,
  House,
  Menu,
  Minimize2,
  Search,
  Star,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import type { Game, GameSystem } from '@/lib/games';
import { cn } from '@/lib/utils';
import { ArtImage, BoxArt } from './art';
import { useResumeImage } from './bridge';
import { systemColors } from './colors';
import type { InputKind, NavAction } from './input';
import { tvRing } from './tv';

// ---------------------------------------------------------------------------
// The backdrop

interface Layer {
  id: number;
  src: string;
  sharp: boolean;
}

let layerId = 0;

/** One picture of the backdrop, faded in once it's loaded and drifting slowly back. */
function BackdropLayer({ layer }: { layer: Layer }) {
  const [loaded, setLoaded] = useState(false);
  if (!layer.sharp) {
    return (
      <ArtImage
        src={layer.src}
        alt=""
        onLoad={() => setLoaded(true)}
        className={cn('absolute inset-0 size-full scale-125 object-cover blur-3xl saturate-150 transition-opacity duration-700', loaded ? 'opacity-45' : 'opacity-0')}
      />
    );
  }
  return (
    <div
      className={cn('absolute top-0 right-0 h-[82%] w-[76%] overflow-hidden transition-opacity duration-700 ease-out', loaded ? 'opacity-100' : 'opacity-0')}
      style={{
        maskImage: 'linear-gradient(to right, transparent, black 45%), linear-gradient(to top, transparent, black 55%)',
        maskComposite: 'intersect',
      }}
    >
      <ArtImage
        src={layer.src}
        alt=""
        onLoad={() => setLoaded(true)}
        className="size-full object-cover [image-rendering:pixelated] motion-safe:animate-in motion-safe:zoom-in-110 motion-safe:duration-[14000ms] motion-safe:ease-out"
      />
    </div>
  );
}

/**
 * Behind everything: the game in focus, its screenshot (or where it was left)
 * sharp, or its box blurred where there's no screenshot, over a glow of its
 * system's colors. The picture changes once focus settles, not with every
 * tile passed, the new one fading in over the old.
 */
function Backdrop({ game }: { game: Game | null }) {
  const { data: resume } = useResumeImage(game);
  const sharp = resume ?? game?.art?.snap ?? game?.art?.title ?? null;
  const src = sharp ?? game?.art?.boxart ?? null;
  const [layers, setLayers] = useState<Layer[]>([]);
  const [glow, setGlow] = useState<string | null>(game?.system ?? null);
  useEffect(() => {
    const t = setTimeout(() => {
      setGlow(game?.system ?? null);
      setLayers((old) => {
        if ((old.at(-1)?.src ?? null) === src) return old;
        return src ? [...old.slice(-1), { id: ++layerId, src, sharp: !!sharp }] : [];
      });
    }, 180);
    return () => clearTimeout(t);
  }, [src, sharp, game?.system]);
  const [from, to] = systemColors(glow ?? '');

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-neutral-950">
      <div
        className="absolute inset-0 opacity-70 transition-[background] duration-1000"
        style={{ background: `radial-gradient(ellipse 80% 70% at 15% 100%, ${from}aa, transparent 70%), radial-gradient(ellipse 60% 60% at 100% 0%, ${to}cc, transparent 70%)` }}
      />
      {layers.map((layer) => (
        <BackdropLayer key={layer.id} layer={layer} />
      ))}
      <div className="absolute inset-0 bg-gradient-to-r from-neutral-950/90 via-neutral-950/40 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-neutral-950 via-neutral-950/80 to-transparent" />
      <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-neutral-950/70 to-transparent" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons, the clock and the battery

type PadButton = 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'START' | 'VIEW';

/** Each button by where it sits on a controller, colored as most are. */
const PAD_GLYPH: Record<PadButton, { label: string; className: string }> = {
  A: { label: 'A', className: 'size-8 rounded-full bg-[#2f9e44] text-white' },
  B: { label: 'B', className: 'size-8 rounded-full bg-[#d6453d] text-white' },
  X: { label: 'X', className: 'size-8 rounded-full bg-[#3a7bd5] text-white' },
  Y: { label: 'Y', className: 'size-8 rounded-full bg-[#f0b429] text-black' },
  LB: { label: 'LB', className: 'h-7 rounded-md bg-white/90 px-2 text-black' },
  RB: { label: 'RB', className: 'h-7 rounded-md bg-white/90 px-2 text-black' },
  START: { label: '☰', className: 'size-8 rounded-full bg-white/90 text-black' },
  VIEW: { label: '⧉', className: 'size-8 rounded-full bg-white/90 text-black' },
};

/** The same buttons on the keyboard, for when there's no controller. */
const KEY_GLYPH: Record<PadButton, string> = {
  A: 'Enter',
  B: 'Backspace',
  X: 'F',
  Y: '/',
  LB: '[',
  RB: ']',
  START: 'P',
  VIEW: 'M',
};

function Glyph({ button, pad }: { button: PadButton; pad: boolean }) {
  if (!pad) {
    return <kbd className="grid h-7 min-w-7 place-items-center rounded-md border border-white/30 bg-white/10 px-2 font-sans text-sm font-semibold text-white">{KEY_GLYPH[button]}</kbd>;
  }
  const g = PAD_GLYPH[button];
  return <span className={cn('grid shrink-0 place-items-center text-sm font-bold shadow-[inset_0_-2px_0_rgb(0_0_0/0.25)]', g.className)}>{g.label}</span>;
}

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

interface BatteryState {
  level: number;
  charging: boolean;
}

/** The battery, where there is one: a computer that's always plugged in and full says nothing. */
function useBattery(): BatteryState | null {
  const [state, setState] = useState<BatteryState | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    let battery: BatteryManager | null = null;
    const update = () => {
      if (!battery) return;
      const full = battery.charging && battery.level >= 1 && battery.chargingTime === 0;
      setState(full ? null : { level: battery.level, charging: battery.charging });
    };
    void nav.getBattery?.().then((b) => {
      battery = b;
      b.addEventListener('levelchange', update);
      b.addEventListener('chargingchange', update);
      update();
    }, () => {});
    return () => {
      battery?.removeEventListener('levelchange', update);
      battery?.removeEventListener('chargingchange', update);
    };
  }, []);
  return state;
}

interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  level: number;
}

// ---------------------------------------------------------------------------
// The menu

function MenuRow({
  icon: Icon,
  label,
  detail,
  current,
  dim,
  onClick,
  ...props
}: { icon: LucideIcon; label: string; detail?: string; current?: boolean; dim?: boolean; onClick: () => void } & Omit<React.ComponentProps<'button'>, 'onClick'>) {
  return (
    <button
      type="button"
      data-nav
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      {...props}
      className={cn(
        'flex h-14 w-full shrink-0 items-center gap-4 rounded-xl px-4 text-left text-lg outline-none',
        'transition-colors hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white',
        tvRing,
        'in-data-[tv-focus]:focus:bg-white/15',
        current ? 'bg-white/[0.08] font-semibold text-white' : dim ? 'text-white/55' : 'text-white/90',
      )}
    >
      <Icon className={cn('size-6 shrink-0', current ? 'text-white' : 'text-white/70')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="text-base text-white/50 tabular-nums">{detail}</span>}
      {current && <span aria-hidden className="size-2 rounded-full bg-white" />}
    </button>
  );
}

function TvMenu({
  systems,
  favorites,
  section,
  sounds,
  onSection,
  onSearch,
  onSounds,
  onExit,
  onClose,
}: {
  systems: GameSystem[];
  favorites: number;
  section: string | null;
  sounds: boolean;
  onSection: (id: string) => void;
  onSearch: () => void;
  onSounds: () => void;
  onExit: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close menu" onClick={onClose} className="absolute inset-0 z-30 bg-black/55 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200" />
      <nav
        aria-label="Games menu"
        data-tv-menu
        className="absolute inset-y-0 left-0 z-40 flex w-[26rem] max-w-full flex-col gap-2 bg-neutral-900/90 px-4 pt-8 pb-6 shadow-[24px_0_64px_-16px_rgb(0_0_0/0.7)] backdrop-blur-2xl motion-safe:animate-in motion-safe:slide-in-from-left motion-safe:duration-300 motion-safe:ease-out"
      >
        <div className="flex items-center gap-3 px-4 pb-4">
          <img src="/icons/apps/games.png" alt="" aria-hidden className="size-10" />
          <span className="font-[family-name:var(--font-title)] text-3xl font-semibold text-white">Games</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto [scrollbar-width:none]">
          <MenuRow icon={House} label="Home" current={section === 'home'} onClick={() => onSection('home')} />
          <MenuRow icon={Star} label="Favorites" detail={favorites ? String(favorites) : undefined} current={section === 'favorites'} onClick={() => onSection('favorites')} />
          <MenuRow icon={Clock} label="Recently Played" current={section === 'recent'} onClick={() => onSection('recent')} />
          <MenuRow icon={Search} label="Search" onClick={onSearch} />
          <div className="px-4 pt-5 pb-2 text-sm font-semibold tracking-[0.18em] text-white/50 uppercase">Systems</div>
          {systems.map((s) => (
            <MenuRow
              key={s.id}
              icon={Gamepad2}
              label={s.name}
              detail={s.count.toLocaleString()}
              dim={!s.playable}
              current={section === `system:${s.id}`}
              onClick={() => onSection(`system:${s.id}`)}
            />
          ))}
        </div>
        <div className="mx-4 my-2 h-px bg-white/10" />
        <MenuRow icon={sounds ? Volume2 : VolumeX} label={sounds ? 'Sounds On' : 'Sounds Off'} aria-pressed={sounds} onClick={onSounds} />
        <MenuRow icon={Minimize2} label="Leave Full Screen" onClick={onExit} />
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// Search, with a keyboard a controller can type on

const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl\'', 'zxcvbnm-.:'];

function Key({
  children,
  className,
  onPress,
  label,
  hint = 'Type',
  start,
}: {
  children: React.ReactNode;
  className?: string;
  onPress: () => void;
  label?: string;
  hint?: string;
  /** The key focus starts on. */
  start?: boolean;
}) {
  return (
    <button
      type="button"
      data-nav
      data-key-start={start || undefined}
      data-hint={hint}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPress}
      className={cn(
        'grid h-14 min-w-14 flex-1 place-items-center rounded-xl bg-white/10 text-2xl font-medium text-white outline-none',
        'transition-[transform,background-color] duration-100 hover:bg-white/20 active:scale-95 focus-visible:ring-[3px] focus-visible:ring-white',
        tvRing,
        'in-data-[tv-focus]:focus:scale-110 in-data-[tv-focus]:focus:bg-white in-data-[tv-focus]:focus:text-black',
        className,
      )}
    >
      {children}
    </button>
  );
}

function SearchSheet({
  query,
  results,
  pad,
  inputRef,
  onType,
  onDelete,
  onQuery,
  onDone,
  onClose,
}: {
  query: string;
  results: number | null;
  pad: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onType: (text: string) => void;
  onDelete: () => void;
  onQuery: (q: string) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Opened from a controller, focus is on the keys; otherwise in the field, to type on a keyboard.
  useEffect(() => {
    requestAnimationFrame(() => {
      if (pad) ref.current?.querySelector<HTMLElement>('[data-key-start]')?.focus();
      else inputRef.current?.focus();
    });
  }, [pad, inputRef]);
  // A keyboard typed on while the keys are focused types into the search too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target === inputRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 && e.key !== ' ' && e.key !== '/') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onType(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onDelete();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [inputRef, onType, onDelete]);

  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close search" onClick={onClose} className="absolute inset-0 z-30 bg-black/30" />
      <div
        ref={ref}
        role="search"
        className="absolute inset-x-0 bottom-0 z-40 rounded-t-[2rem] bg-neutral-900/92 px-8 pt-8 pb-20 shadow-[0_-24px_64px_-16px_rgb(0_0_0/0.7)] backdrop-blur-2xl motion-safe:animate-in motion-safe:slide-in-from-bottom motion-safe:duration-300 motion-safe:ease-out"
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <div className="flex h-18 items-center gap-4 rounded-2xl bg-white/10 px-6 ring-white/30 focus-within:ring-2">
            <Search className="size-7 shrink-0 text-white/70" aria-hidden />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onDone();
                else if (e.key === 'Escape') {
                  e.preventDefault();
                  onClose();
                }
              }}
              placeholder="Search for a game"
              aria-label="Search games"
              className="min-w-0 flex-1 bg-transparent text-3xl text-white outline-none placeholder:text-white/40 [&::-webkit-search-cancel-button]:hidden"
            />
            {results !== null && query && (
              <span className="shrink-0 text-lg text-white/60 tabular-nums">
                {results.toLocaleString()} {results === 1 ? 'game' : 'games'}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            {KEY_ROWS.map((row, r) => (
              <div key={row} className={cn('flex gap-2', r === 2 && 'px-6', r === 3 && 'px-12')}>
                {[...row].map((ch, i) => (
                  <Key key={ch} start={r === 1 && i === 0} onPress={() => onType(ch)}>
                    {ch.toUpperCase()}
                  </Key>
                ))}
              </div>
            ))}
            <div className="flex gap-2">
              <Key className="flex-[5] text-lg" label="Space" onPress={() => onType(' ')}>
                Space
              </Key>
              <Key className="flex-[2]" label="Delete" hint="Delete" onPress={onDelete}>
                <Delete className="size-7" aria-hidden />
              </Key>
              <Key className="flex-[2] text-lg" hint="Clear" onPress={() => onQuery('')}>
                Clear
              </Key>
              <Key className="flex-[3] bg-white text-lg font-semibold text-black hover:bg-white/85" hint="Done" onPress={onDone}>
                Done
              </Key>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The game starting

function Launching({ game, systemName }: { game: Game; systemName?: string }) {
  return (
    <div role="status" aria-live="polite" className="absolute inset-0 z-50 grid place-items-center bg-neutral-950/85 backdrop-blur-xl motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="flex flex-col items-center gap-8">
        <div className="relative w-56 motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:duration-500">
          <div aria-hidden className="absolute -inset-10 rounded-full bg-white/10 blur-3xl motion-safe:animate-pulse" />
          <div className="relative">
            <BoxArt game={game} systemName={systemName} eager />
          </div>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="text-sm font-semibold tracking-[0.25em] text-white/60 uppercase">Starting</span>
          <span className="max-w-2xl text-4xl font-semibold text-balance text-white">{game.title}</span>
        </div>
        <div className="h-1 w-64 overflow-hidden rounded-full bg-white/15">
          <div className="h-full w-full rounded-full bg-white motion-safe:animate-in motion-safe:slide-in-from-left motion-safe:repeat-infinite motion-safe:duration-[1400ms] motion-safe:ease-in-out" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The shell

export interface TvHint {
  button: PadButton;
  label: string;
  action: NavAction;
}

export function TvShell({
  children,
  input,
  connected,
  backdropGame,
  sections,
  section,
  sectionLabel,
  onSection,
  systems,
  favorites,
  query,
  onQuery,
  results,
  searching,
  searchRef,
  onSearch,
  onSearchDone,
  onSearchClose,
  menuOpen,
  onMenu,
  sounds,
  onSounds,
  open,
  canGoBack,
  onAction,
  onExit,
  scrollRef,
  launching,
  systemName,
}: {
  children: React.ReactNode;
  input: InputKind;
  connected: boolean;
  backdropGame: Game | null;
  sections: string[];
  section: string | null;
  sectionLabel: (id: string) => string;
  onSection: (id: string) => void;
  systems: GameSystem[];
  favorites: number;
  query: string;
  onQuery: (q: string) => void;
  results: number | null;
  searching: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSearch: () => void;
  onSearchDone: () => void;
  onSearchClose: () => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  sounds: boolean;
  onSounds: () => void;
  open: Game | null;
  canGoBack: boolean;
  onAction: (action: NavAction) => void;
  onExit: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  launching: Game | null;
  systemName: (id: string) => string;
}) {
  const now = useClock();
  const battery = useBattery();
  const pad = connected;
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [section]);

  // What's focused says what A does to it, and whether it's a game (for Play and Favorite).
  const [focus, setFocus] = useState<{ hint: string | null; game: boolean }>({ hint: null, game: false });
  useEffect(() => {
    const update = () => {
      const el = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFocus({ hint: el?.closest<HTMLElement>('[data-hint]')?.dataset.hint ?? null, game: !!el?.closest('[data-game]') || !!open });
    };
    update();
    const later = () => requestAnimationFrame(update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', later);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', later);
    };
  }, [open]);

  const overlay = menuOpen || searching;
  let hints: TvHint[];
  if (searching && !pad) {
    // Typing on a keyboard: Enter finishes, and the keys on screen can be clicked.
    hints = [{ button: 'A', label: 'Done', action: 'play' }];
  } else if (searching) {
    hints = [
      { button: 'A', label: focus.hint ?? 'Type', action: 'accept' },
      { button: 'X', label: 'Delete', action: 'favorite' },
      { button: 'Y', label: 'Space', action: 'search' },
      { button: 'START', label: 'Done', action: 'play' },
      { button: 'B', label: 'Close', action: 'back' },
    ];
  } else if (menuOpen) {
    hints = [
      { button: 'A', label: 'Select', action: 'accept' },
      { button: 'B', label: 'Close', action: 'back' },
    ];
  } else {
    hints = [
      { button: 'A', label: focus.hint ?? 'Select', action: 'accept' },
      // Play, unless A already plays what's focused.
      ...(focus.game && !/^(Play|Resume)$/.test(focus.hint ?? '') ? [{ button: 'START', label: 'Play', action: 'play' } as TvHint] : []),
      ...(focus.game ? [{ button: 'X', label: 'Favorite', action: 'favorite' } as TvHint] : []),
      { button: 'Y', label: 'Search', action: 'search' },
      { button: 'VIEW', label: 'Menu', action: 'menu' },
      ...(canGoBack ? [{ button: 'B', label: 'Back', action: 'back' } as TvHint] : []),
    ];
  }

  return (
    <div
      data-input={input}
      data-tv-focus={input === 'pointer' ? undefined : ''}
      className="dark relative isolate flex h-full w-full flex-col overflow-hidden text-white motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-[1.02] motion-safe:duration-500"
    >
      <Backdrop game={backdropGame} />
      <div inert={overlay} className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-20 shrink-0 items-center gap-3 px-10">
          {open ? (
            <button
              type="button"
              data-nav
              data-hint="Back"
              onClick={() => onAction('back')}
              aria-label="Back"
              className={cn('grid size-12 shrink-0 place-items-center rounded-full bg-white/10 outline-none hover:bg-white/20 focus-visible:ring-[3px] focus-visible:ring-white', tvRing)}
            >
              <ArrowLeft className="size-6" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              data-nav
              data-hint="Menu"
              onClick={() => onMenu(true)}
              aria-label="Menu"
              className={cn('flex h-12 shrink-0 items-center gap-2 rounded-full pr-4 pl-1.5 outline-none hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white', tvRing)}
            >
              <img src="/icons/apps/games.png" alt="" aria-hidden className="size-9" />
              <Menu className="size-5 text-white/70" aria-hidden />
            </button>
          )}
          {!open && (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {pad && <Glyph button="LB" pad />}
              <div
                ref={stripRef}
                role="tablist"
                aria-label="Sections"
                className="flex min-w-0 gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none]"
                style={{ maskImage: 'linear-gradient(to right, transparent, black 16px, black calc(100% - 48px), transparent)' }}
              >
                {sections.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    data-nav
                    aria-selected={section === id}
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => onSection(id)}
                    className={cn(
                      'h-11 shrink-0 rounded-full px-5 text-lg font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-white',
                      tvRing,
                      section === id ? 'bg-white text-black' : 'text-white/70 hover:bg-white/10 hover:text-white',
                    )}
                  >
                    {sectionLabel(id)}
                  </button>
                ))}
              </div>
              {pad && <Glyph button="RB" pad />}
            </div>
          )}
          {open && <div className="flex-1" />}
          {query && !searching ? (
            <button
              type="button"
              data-nav
              data-hint="Search"
              onClick={onSearch}
              className={cn('flex h-11 max-w-72 shrink-0 items-center gap-2 rounded-full bg-white/15 pr-2 pl-4 text-lg outline-none hover:bg-white/25 focus-visible:ring-[3px] focus-visible:ring-white', tvRing)}
            >
              <Search className="size-5 shrink-0 text-white/70" aria-hidden />
              <span className="truncate pr-2">{query}</span>
            </button>
          ) : (
            <button
              type="button"
              data-nav
              data-hint="Search"
              onClick={onSearch}
              aria-label="Search"
              className={cn('grid size-12 shrink-0 place-items-center rounded-full outline-none hover:bg-white/10 focus-visible:ring-[3px] focus-visible:ring-white', tvRing)}
            >
              <Search className="size-6" aria-hidden />
            </button>
          )}
          <div className="ml-2 flex shrink-0 items-center gap-5 text-lg font-medium text-white/85 tabular-nums">
            {connected && <Gamepad2 className="size-6" aria-label="Controller connected" />}
            {battery && <BatteryReadout battery={battery} />}
            <span>{now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        </header>
        <div ref={scrollRef} className="@container min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
          {children}
        </div>
      </div>
      <footer className="relative z-50 flex h-16 shrink-0 items-center justify-end gap-2 bg-gradient-to-t from-black/60 to-transparent px-8">
        {hints.map((h) => (
          <button
            key={h.button}
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAction(h.action)}
            className="flex h-11 items-center gap-2.5 rounded-full px-3 text-base text-white/85 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Glyph button={h.button} pad={pad} />
            <span>{h.label}</span>
          </button>
        ))}
      </footer>
      {menuOpen && (
        <TvMenu
          systems={systems}
          favorites={favorites}
          section={section}
          sounds={sounds}
          onSection={(id) => {
            onMenu(false);
            onSection(id);
          }}
          onSearch={() => {
            onMenu(false);
            onSearch();
          }}
          onSounds={onSounds}
          onExit={onExit}
          onClose={() => onMenu(false)}
        />
      )}
      {searching && (
        <SearchSheet
          query={query}
          results={results}
          pad={input === 'pad'}
          inputRef={searchRef}
          onType={(t) => onQuery(query + t)}
          onDelete={() => onQuery(query.slice(0, -1))}
          onQuery={onQuery}
          onDone={onSearchDone}
          onClose={onSearchClose}
        />
      )}
      {launching && <Launching game={launching} systemName={systemName(launching.system)} />}
    </div>
  );
}

function BatteryReadout({ battery }: { battery: BatteryState }) {
  const pct = Math.round(battery.level * 100);
  const Icon = battery.charging ? BatteryCharging : pct <= 20 ? BatteryLow : pct <= 60 ? BatteryMedium : Battery;
  return (
    <span className={cn('flex items-center gap-1.5', !battery.charging && pct <= 15 && 'text-red-400')} aria-label={`Battery ${pct}%${battery.charging ? ', charging' : ''}`}>
      <Icon className="size-6" aria-hidden />
      {pct}%
    </span>
  );
}
