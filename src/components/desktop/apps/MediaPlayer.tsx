import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { getFsBridge, cleanFsError } from '@/lib/fs';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { areaFor } from '@/lib/monitors';
import { MIN_HEIGHT, MIN_WIDTH } from '@/hooks/useWindows';
import { FILES_MIME } from './files/dnd';
import { openPaths } from './media/actions';
import { player, usePlayer } from './media/engine';
import { getPrefs, setPrefs, setWinampPrefs, usePrefs, type SkinChoice } from './media/prefs';
import { useCommands, type Commands } from './media/useCommands';
import { AppMenus } from './media/din/AppMenus';
import { DinSkin } from './media/din/DinSkin';
import { TextPromptHost } from './media/din/TextPrompt';
import { loadWinampSkin, type WinampSkin } from './media/winamp/skin';
import { WinampPlayer } from './media/winamp/WinampPlayer';
import { winampLayout } from './media/winamp/layout';
import { WmpPlayer } from './media/wmp/WmpPlayer';
import { openWmz, type WmzPackage } from './media/wmp/wms';
import { builtinSkinBytes, isBuiltinSkin } from './media/wmp/builtin';
import './media/din/player.css';

/** The Din skin's window size in full mode, and the Mini Player's. */
const FULL_SIZE = { width: 1040, height: 680 };
const MINI_SIZE = { width: 460, height: 168 };

type LoadedSkin =
  | { kind: 'din' }
  | { kind: 'winamp'; skin: WinampSkin }
  | { kind: 'wmp'; pkg: WmzPackage };

const DIN_SKIN: LoadedSkin = { kind: 'din' };

/** Load the skin the prefs name, falling back to Din's own if it won't. */
function useLoadedSkin(choice: SkinChoice, onError: (message: string) => void): LoadedSkin | null {
  const [loaded, setLoaded] = useState<{ key: string; skin: LoadedSkin } | null>(null);
  const key = choice.kind === 'din' ? 'din' : `${choice.kind}:${choice.path}`;
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  });
  useEffect(() => {
    if (choice.kind === 'din') return;
    let live = true;
    let made: WinampSkin | null = null;
    void (async () => {
      try {
        const bytes = !choice.path ? null
          : isBuiltinSkin(choice.path) ? await builtinSkinBytes(choice.path)
            : (await getFsBridge()!.readFile(choice.path, 64 * 1024 * 1024)).data;
        if (choice.kind === 'winamp') {
          made = await loadWinampSkin(bytes, choice.path ? choice.path.slice(choice.path.lastIndexOf('/') + 1) : 'Din Classic');
          if (live) setLoaded({ key, skin: { kind: 'winamp', skin: made } });
          else made.dispose();
        } else {
          if (!bytes) throw new Error('No skin file');
          const pkg = openWmz(bytes);
          if (live) setLoaded({ key, skin: { kind: 'wmp', pkg } });
        }
      } catch (error) {
        if (!live) return;
        onErrorRef.current(`Couldn’t load that skin: ${cleanFsError(error)}`);
        setPrefs({ skin: { kind: 'din' } });
      }
    })();
    return () => {
      live = false;
      made?.dispose();
    };
  }, [key, choice]);
  if (choice.kind === 'din') return DIN_SKIN;
  return loaded?.key === key ? loaded.skin : null;
}

/**
 * Sizes the window for what it shows: Din's skin in a normal window (full or
 * mini), any other skin frameless at exactly the skin's size. A component
 * of its own because it follows every window change.
 */
function FitWindow({
  windowId, frameless, width: wantWidth, height: wantHeight, remember,
}: {
  windowId: string;
  frameless: boolean;
  width: number;
  height: number;
  /** Keep the size the user drags it to (Din's full mode). */
  remember: boolean;
}) {
  const { windows } = useWindowManager();
  const { resize, setFrameless } = useWindowActions();
  const areas = useWorkAreas();
  const current = useRef({ windows, areas });
  const target = useRef<{ width: number; height: number; settled: boolean } | null>(null);
  useEffect(() => {
    current.current = { windows, areas };
  }, [windows, areas]);
  useEffect(() => {
    const { windows, areas } = current.current;
    const win = windows.find((w) => w.id === windowId);
    if (!win || win.maximized || win.snapped) return;
    let width = Math.round(wantWidth);
    let height = Math.round(wantHeight);
    // A framed window is never smaller than the window manager allows.
    if (!frameless) {
      width = Math.max(MIN_WIDTH, width);
      height = Math.max(MIN_HEIGHT, height);
    }
    let { x, y } = win;
    if (areas.length > 0) {
      const area = areaFor(areas, win);
      // No bigger than the monitor it's on.
      width = Math.min(width, Math.max(frameless ? 1 : MIN_WIDTH, area.width));
      height = Math.min(height, Math.max(frameless ? 1 : MIN_HEIGHT, area.height));
    }
    const fits = win.frameless === frameless && win.width === width && win.height === height;
    target.current = { width, height, settled: fits };
    if (fits) return;
    if (areas.length > 0) {
      const area = areaFor(areas, win);
      x = Math.max(area.x, Math.min(x, area.x + area.width - Math.min(width, area.width)));
      y = Math.max(area.y, Math.min(y, area.y + area.height - Math.min(height, area.height)));
    }
    if (win.frameless !== frameless) setFrameless(windowId, frameless, { x, y, width, height });
    else resize(windowId, { x, y, width, height });
  }, [windowId, frameless, wantWidth, wantHeight, resize, setFrameless]);

  // Once the window has reached the size asked for, later changes are the
  // user's: remember them. (Before then they're the window manager's.)
  const win = windows.find((w) => w.id === windowId);
  const free = !!win && !win.frameless && !win.maximized && !win.snapped;
  const width = win ? Math.round(win.width) : 0;
  const height = win ? Math.round(win.height) : 0;
  useEffect(() => {
    const t = target.current;
    if (!t || !free) return;
    if (width === t.width && height === t.height) {
      t.settled = true;
      return;
    }
    if (!t.settled || !remember || height <= MINI_SIZE.height + 40) return;
    const saved = getPrefs().dinSize;
    if (saved?.width !== width || saved?.height !== height) setPrefs({ dinSize: { width, height } });
  }, [free, width, height, remember]);
  return null;
}

/** A skin that throws while drawing gives way to Din's own, saying why. */
class SkinBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(`That skin stopped working, so Din’s own is back: ${error instanceof Error ? error.message : String(error)}`);
    setPrefs({ skin: { kind: 'din' } });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Keyboard shortcuts: Windows Media Player's everywhere, Winamp's too in a Winamp skin. */
function useShortcuts(commands: Commands, winamp: boolean) {
  return (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') && e.key !== 'Escape') return;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const s = player.getState();
    let handled = true;
    if (ctrl && e.shiftKey && key === 'f') player.fastForward();
    else if (ctrl && e.shiftKey && key === 'b') player.rewind();
    else if (ctrl && !e.shiftKey && key === 'p') player.toggle();
    else if (ctrl && !e.shiftKey && key === 's') player.stop();
    else if (ctrl && !e.shiftKey && key === 'b') player.previous();
    else if (ctrl && !e.shiftKey && key === 'f') player.next();
    else if (ctrl && key === 'h') player.setShuffle(!s.shuffle);
    else if (ctrl && key === 't') player.cycleRepeat();
    else if (ctrl && key === 'o') void commands.openFiles('play');
    else if (ctrl && (key === 'u' || (winamp && key === 'l'))) void commands.openUrl();
    else if (ctrl && (key === 'w' || key === 'q')) commands.close();
    else if (ctrl && key === '1') setPrefs({ skin: { kind: 'din' }, mini: false });
    else if (ctrl && key === 'd' && winamp) setWinampPrefs({ double: !getPrefs().winamp.double });
    else if (e.key === 'F7') player.setMuted(!s.muted);
    else if (e.key === 'F8') player.setVolume(s.volume - 0.05);
    else if (e.key === 'F9') player.setVolume(s.volume + 0.05);
    else if (ctrl || e.altKey) {
      if (winamp && e.altKey && key === 'g') setWinampPrefs({ eq: !getPrefs().winamp.eq });
      else if (winamp && e.altKey && key === 'e') setWinampPrefs({ playlist: !getPrefs().winamp.playlist });
      else handled = false;
    } else if (key === ' ' && !target.closest('button, [role=option], [role=row]')) player.toggle();
    else if (winamp && key === 'z') player.previous();
    else if (winamp && key === 'x') player.play();
    else if (winamp && key === 'c') player.toggle();
    else if (winamp && key === 'v') player.stop();
    else if (winamp && key === 'b') player.next();
    else if (winamp && key === 'l') void (e.shiftKey ? commands.openFolder('play') : commands.openFiles('play'));
    else if (winamp && key === 's') player.setShuffle(!s.shuffle);
    else if (winamp && key === 'r') player.setRepeat(s.repeat === 'off' ? 'all' : 'off');
    else if (winamp && key === 'arrowleft') player.seekBy(-5);
    else if (winamp && key === 'arrowright') player.seekBy(5);
    else if (winamp && key === 'arrowup') player.setVolume(s.volume + 0.02);
    else if (winamp && key === 'arrowdown') player.setVolume(s.volume - 0.02);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
}

/**
 * Media Player: Windows Media Player's look and library with Winamp's
 * soul. Plays music and video, internet radio and playlists, and wears
 * Winamp (.wsz) and Windows Media Player (.wmz) skins.
 *
 * Launch params: `{ paths: string[] }` or `{ path }` (songs, videos,
 * playlists, folders or skin files) with `how: 'play' | 'enqueue'`, and
 * `at` to repeat an identical request.
 */
export function MediaPlayer({ windowId, params }: AppComponentProps) {
  const commands = useCommands(windowId);
  const choice = usePrefs((p) => p.skin);
  const mini = usePrefs((p) => p.mini);
  const dinSize = usePrefs((p) => p.dinSize);
  const winampPrefs = usePrefs((p) => p.winamp);
  const skin = useLoadedSkin(choice, commands.setMessage);
  const [wmpSize, setWmpSize] = useState<{ width: number; height: number } | null>(null);
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const playing = usePlayer((s) => s.status === 'playing');
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  useWindowTitle(track && playing ? `${track.title}${track.artist ? ` – ${track.artist}` : ''}` : null);

  // Files asked this window to open something.
  const paths = Array.isArray(params?.paths) ? (params.paths as string[]) : typeof params?.path === 'string' ? [params.path] : [];
  const request = paths.length > 0 ? JSON.stringify({ paths, how: params?.how === 'enqueue' ? 'enqueue' : 'play', at: params?.at ?? null }) : null;
  const setMessage = commands.setMessage;
  useEffect(() => {
    if (!request) return;
    const { paths, how } = JSON.parse(request) as { paths: string[]; how: 'play' | 'enqueue' };
    void openPaths(paths, how).then((message) => message && setMessage(message));
  }, [request, setMessage]);

  // A jump-list action from the Dock or the apps menu.
  const show = typeof params?.show === 'string' ? params.show : null;
  const showRequest = show ? `${show}:${String(params?.actionAt ?? '')}` : null;
  useEffect(() => {
    if (!showRequest) return;
    const what = showRequest.slice(0, showRequest.indexOf(':'));
    if (what === 'din-skin') setPrefs({ skin: { kind: 'din' } });
    else if (what === 'mini') setPrefs({ skin: { kind: 'din' }, mini: true });
    else if (what === 'library') setPrefs({ skin: { kind: 'din' }, mini: false, tab: 'library' });
  }, [showRequest]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    return () => player.shutdown();
  }, []);

  const onKeyDown = useShortcuts(commands, skin?.kind === 'winamp');

  let size: { width: number; height: number; frameless: boolean } | null = null;
  if (skin?.kind === 'din') size = { ...(mini ? MINI_SIZE : (dinSize ?? FULL_SIZE)), frameless: false };
  else if (skin?.kind === 'winamp') {
    const layout = winampLayout(winampPrefs, skin.skin);
    const scale = winampPrefs.double ? 2 : 1;
    size = { width: layout.width * scale, height: layout.height * scale, frameless: true };
  } else if (skin?.kind === 'wmp' && wmpSize) size = { ...wmpSize, frameless: true };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILES_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        const raw = e.dataTransfer.getData(FILES_MIME);
        if (!raw) return;
        e.preventDefault();
        const dropped = JSON.parse(raw) as string[];
        void openPaths(dropped, player.getState().queue.length === 0 ? 'play' : 'enqueue').then((m) => m && commands.setMessage(m));
      }}
      className="relative size-full outline-none"
    >
      {size && <FitWindow windowId={windowId} frameless={size.frameless} width={size.width} height={size.height} remember={skin?.kind === 'din' && !mini} />}
      {skin?.kind === 'din' && <DinSkin commands={commands} />}
      {skin?.kind === 'winamp' && (
        <SkinBoundary key={`winamp:${skin.skin.name}`} onError={commands.setMessage}>
          <WinampPlayer skin={skin.skin} commands={commands} />
        </SkinBoundary>
      )}
      {skin?.kind === 'wmp' && (
        <SkinBoundary key={`wmp:${skin.pkg.name}`} onError={commands.setMessage}>
          <WmpPlayer pkg={skin.pkg} commands={commands} onSize={setWmpSize} />
        </SkinBoundary>
      )}
      <AppMenus commands={commands} />
      {dragOver && <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-4 ring-inset ring-sky-400/70" />}
      <TextPromptHost />
    </div>
  );
}
