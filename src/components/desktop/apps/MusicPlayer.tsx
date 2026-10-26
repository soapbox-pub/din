import { useEffect, useRef, useState } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { getFsBridge, cleanFsError } from '@/lib/fs';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { areaFor } from '@/lib/monitors';
import { FILES_MIME } from './files/dnd';
import { openPaths } from './music/actions';
import { player, usePlayer } from './music/engine';
import { getPrefs, setPrefs, setWinampPrefs, usePrefs, type SkinChoice } from './music/prefs';
import { useCommands, type Commands } from './music/useCommands';
import { DinSkin } from './music/din/DinSkin';
import { TextPromptHost } from './music/din/TextPrompt';
import { loadWinampSkin, type WinampSkin } from './music/winamp/skin';
import { WinampPlayer } from './music/winamp/WinampPlayer';
import { winampLayout } from './music/winamp/layout';
import { WmpPlayer } from './music/wmp/WmpPlayer';
import { openWmz, type WmzPackage } from './music/wmp/wms';
import './music/din/player.css';

/** The Din skin's window size in full mode, and the Mini Player's. */
const FULL_SIZE = { width: 1040, height: 680 };
const MINI_SIZE = { width: 460, height: 128 };

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
        const bytes = choice.path ? (await getFsBridge()!.readFile(choice.path, 64 * 1024 * 1024)).data : null;
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
function FitWindow({ windowId, frameless, width, height }: { windowId: string; frameless: boolean; width: number; height: number }) {
  const { windows } = useWindowManager();
  const { resize, setFrameless } = useWindowActions();
  const areas = useWorkAreas();
  const current = useRef({ windows, areas });
  useEffect(() => {
    current.current = { windows, areas };
  }, [windows, areas]);
  useEffect(() => {
    const { windows, areas } = current.current;
    const win = windows.find((w) => w.id === windowId);
    if (!win || win.maximized || win.snapped) return;
    if (win.frameless === frameless && win.width === width && win.height === height) return;
    let { x, y } = win;
    if (areas.length > 0) {
      const area = areaFor(areas, win);
      x = Math.max(area.x, Math.min(x, area.x + area.width - Math.min(width, area.width)));
      y = Math.max(area.y, Math.min(y, area.y + area.height - Math.min(height, area.height)));
    }
    if (win.frameless !== frameless) setFrameless(windowId, frameless, { x, y, width, height });
    else resize(windowId, { x, y, width, height });
  }, [windowId, frameless, width, height, resize, setFrameless]);
  return null;
}

/** Remember the full-mode window size as the user resizes it. */
function RememberSize({ windowId }: { windowId: string }) {
  const { windows } = useWindowManager();
  const win = windows.find((w) => w.id === windowId);
  const width = win && !win.frameless && !win.maximized && !win.snapped ? win.width : null;
  const height = win?.height ?? null;
  useEffect(() => {
    if (width === null || height === null || height <= MINI_SIZE.height + 40) return;
    const saved = getPrefs().dinSize;
    if (saved?.width !== width || saved?.height !== height) setPrefs({ dinSize: { width, height } });
  }, [width, height]);
  return null;
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
    else if (e.key === 'MediaPlayPause') player.toggle();
    else if (e.key === 'MediaTrackNext') player.next();
    else if (e.key === 'MediaTrackPrevious') player.previous();
    else if (e.key === 'MediaStop') player.stop();
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
 * Music Player: Windows Media Player's look and library with Winamp's
 * soul. Plays music and video, internet radio and playlists, and wears
 * Winamp (.wsz) and Windows Media Player (.wmz) skins.
 *
 * Launch params: `{ paths: string[] }` or `{ path }` (songs, videos,
 * playlists, folders or skin files) with `how: 'play' | 'enqueue'`, and
 * `at` to repeat an identical request.
 */
export function MusicPlayer({ windowId, params }: AppComponentProps) {
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
      {size && <FitWindow windowId={windowId} frameless={size.frameless} width={size.width} height={size.height} />}
      {skin?.kind === 'din' && !mini && <RememberSize windowId={windowId} />}
      {skin?.kind === 'din' && <DinSkin commands={commands} />}
      {skin?.kind === 'winamp' && <WinampPlayer skin={skin.skin} commands={commands} />}
      {skin?.kind === 'wmp' && <WmpPlayer pkg={skin.pkg} commands={commands} onSize={setWmpSize} />}
      {dragOver && <div aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] ring-4 ring-inset ring-sky-400/70" />}
      <TextPromptHost />
    </div>
  );
}
