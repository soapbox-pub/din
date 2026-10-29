import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { cleanFsError } from '@/lib/fs';
import { DRAG_MIME, type FrameMode, type LaunchContext, type Rect } from '@/sdk';
import { useCurrentDrag, useDin, useWindowState, useWindowTitle } from '@/sdk/react';
import { openHandles } from './media/actions';
import { readLocal } from './media/grants';
import { keepGrants } from './media/keep';
import { connectMediaSession, player, usePlayer } from './media/engine';
import { getPrefs, setPrefs, setWinampPrefs, usePrefs, type SkinChoice } from './media/prefs';
import { useCommands, type Commands } from './media/useCommands';
import { AppMenus } from './media/din/AppMenus';
import { DinSkin } from './media/din/DinSkin';
import { TextPromptHost } from './media/din/TextPrompt';
import { loadWinampSkin, type WinampSkin } from './media/winamp/skin';
import { WinampPlayer } from './media/winamp/WinampPlayer';
import { W, winampLayout } from './media/winamp/layout';
import { WmpPlayer } from './media/wmp/WmpPlayer';
import { openWmz, type WmzPackage } from './media/wmp/wms';
import { builtinSkinBytes, isBuiltinSkin } from './media/wmp/builtin';
import './media/din/player.css';

/** The Din skin's window size in full mode, and the Mini Player's. */
const FULL_SIZE = { width: 1040, height: 680 };
const MINI_SIZE = { width: 460, height: 168 };
/** The smallest a framed window gets (the desktop's own minimum). */
const MIN_WIDTH = 280;
const MIN_HEIGHT = 160;

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
    void (async () => {
      try {
        const bytes = !choice.path ? null
          : isBuiltinSkin(choice.path) ? await builtinSkinBytes(choice.path)
            : await readLocal(choice.path, 64 * 1024 * 1024);
        if (choice.kind === 'winamp') {
          const made = await loadWinampSkin(bytes, choice.path ? choice.path.slice(choice.path.lastIndexOf('/') + 1) : 'Din Classic');
          if (live) setLoaded({ key, skin: { kind: 'winamp', skin: made } });
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
  frame, width: wantWidth, height: wantHeight, remember,
}: {
  frame: FrameMode;
  width: number;
  height: number;
  /** Keep the size the user drags it to (Din's full mode). */
  remember: boolean;
}) {
  const din = useDin();
  const state = useWindowState();
  const chrome = useRef<FrameMode | null>(null);
  const target = useRef<{ width: number; height: number; settled: boolean } | null>(null);
  useEffect(() => {
    const frameless = frame === 'none';
    if (chrome.current !== frame) {
      chrome.current = frame;
      din.window.setChrome({ frame });
    }
    const { bounds, workArea: area, maximized, snapped } = din.window.state;
    if (maximized || snapped) return;
    let width = Math.round(wantWidth);
    let height = Math.round(wantHeight);
    // A framed window is never smaller than the window manager allows.
    if (!frameless) {
      width = Math.max(MIN_WIDTH, width);
      height = Math.max(MIN_HEIGHT, height);
    }
    // No bigger than the monitor it's on.
    if (area.width > 0 && area.height > 0) {
      width = Math.min(width, Math.max(frameless ? 1 : MIN_WIDTH, area.width));
      height = Math.min(height, Math.max(frameless ? 1 : MIN_HEIGHT, area.height));
    }
    const fits = bounds.width === width && bounds.height === height;
    target.current = { width, height, settled: fits };
    if (fits) return;
    let { x, y } = bounds;
    if (area.width > 0 && area.height > 0) {
      x = Math.max(area.x, Math.min(x, area.x + area.width - Math.min(width, area.width)));
      y = Math.max(area.y, Math.min(y, area.y + area.height - Math.min(height, area.height)));
    }
    din.window.setBounds({ x, y, width, height });
  }, [din, frame, wantWidth, wantHeight]);

  // Once the window has reached the size asked for, later changes are the
  // user's: remember them. (Before then they're the window manager's.)
  const free = frame !== 'none' && !state.maximized && !state.snapped;
  const width = Math.round(state.bounds.width);
  const height = Math.round(state.bounds.height);
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

/** Open what Files (or a Dock shortcut) asked for. */
function useLaunches(setMessage: (message: string) => void) {
  const din = useDin();
  useEffect(() => {
    const take = ({ params, files, shortcut }: LaunchContext) => {
      if (files.length > 0) {
        void openHandles(files, params.how === 'enqueue' ? 'enqueue' : 'play').then((message) => message && setMessage(message));
      }
      // A jump-list shortcut from the Dock or the apps menu.
      const show = shortcut ?? (typeof params.show === 'string' ? params.show : null);
      if (show === 'din-skin') setPrefs({ skin: { kind: 'din' } });
      else if (show === 'mini') setPrefs({ skin: { kind: 'din' }, mini: true });
      else if (show === 'library') setPrefs({ skin: { kind: 'din' }, mini: false, tab: 'library' });
    };
    take(din.app.launch);
    return din.app.onLaunch(take);
  }, [din, setMessage]);
}

/**
 * Media Player: Windows Media Player's look and library with Winamp's
 * soul. Plays music and video, internet radio and playlists, and wears
 * Winamp (.wsz) and Windows Media Player (.wmz) skins.
 *
 * Opened with files (songs, videos, playlists, folders or skin files) and
 * `how: 'play' | 'enqueue'`. It reaches its own folders by path (Music,
 * Videos, its skins and library index) and the folders of files it's
 * handed (`file-folders`): playlists name songs by path.
 */
export function MediaPlayer() {
  const din = useDin();
  const commands = useCommands();
  const choice = usePrefs((p) => p.skin);
  const mini = usePrefs((p) => p.mini);
  const dinSize = usePrefs((p) => p.dinSize);
  const winampPrefs = usePrefs((p) => p.winamp);
  const skin = useLoadedSkin(choice, commands.setMessage);
  const [wmpSize, setWmpSize] = useState<{ width: number; height: number; shape: Rect[] } | null>(null);
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const playing = usePlayer((s) => s.status === 'playing');
  const rootRef = useRef<HTMLDivElement>(null);
  const drag = useCurrentDrag();
  const [dragOver, setDragOver] = useState(false);
  useWindowTitle(track && playing ? `${track.title}${track.artist ? ` – ${track.artist}` : ''}` : null);
  useLaunches(commands.setMessage);

  useEffect(() => connectMediaSession(din), [din]);
  useEffect(() => keepGrants(), []);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    return () => player.shutdown();
  }, []);

  const onKeyDown = useShortcuts(commands, skin?.kind === 'winamp');

  let size: { width: number; height: number; frame: FrameMode; shape?: Rect[] } | null = null;
  if (skin?.kind === 'din') size = { ...(mini ? MINI_SIZE : (dinSize ?? FULL_SIZE)), frame: mini ? 'standard' : 'custom' };
  else if (skin?.kind === 'winamp') {
    const layout = winampLayout(winampPrefs, skin.skin);
    const scale = winampPrefs.double ? 2 : 1;
    // Main window, equalizer and playlist, stacked; a playlist wider than
    // the others leaves a gap beside them.
    const shape = [
      { x: 0, y: 0, width: W, height: layout.mainH + layout.eqH },
      { x: 0, y: layout.mainH + layout.eqH, width: layout.plW, height: layout.plH },
    ].filter((r) => r.width > 0 && r.height > 0).map((r) => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale }));
    size = { width: layout.width * scale, height: layout.height * scale, frame: 'none', shape };
  } else if (skin?.kind === 'wmp' && wmpSize) size = { ...wmpSize, frame: 'none' };
  const shapeKey = JSON.stringify(size?.shape ?? null);
  useEffect(() => {
    din.window.setShape(JSON.parse(shapeKey) as Rect[] | null);
  }, [din, shapeKey]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (drag?.kind !== 'files' && !e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        setDragOver(false);
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        void din.drag.accept(e.nativeEvent, 'copy').then((result) => {
          if (result?.kind !== 'files') return;
          return openHandles(result.files, player.getState().queue.length === 0 ? 'play' : 'enqueue').then((m) => m && commands.setMessage(m));
        });
      }}
      className="relative size-full outline-none"
    >
      {size && <FitWindow frame={size.frame} width={size.width} height={size.height} remember={skin?.kind === 'din' && !mini} />}
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
