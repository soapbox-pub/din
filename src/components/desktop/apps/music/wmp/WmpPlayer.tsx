import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { makeTrack, player, type PlayerState } from '../engine';
import { EQ_PRESETS } from '../eq';
import { isUrl } from '../metadata';
import { setPrefs } from '../prefs';
import type { Commands } from '../useCommands';
import { useCover } from '../din/useCover';
import { Element } from './elements';
import { WMP_EFFECTS } from './effects';
import { SkinImages } from './images';
import { Mirror, ViewContext } from './mirror';
import { prepareView, themeViews } from './prepare';
import type { HostToVm, PlayerSnapshot, VmToHost } from './protocol';
import { wmpVmRuntime } from './vm';
import type { WmsNode, WmzPackage } from './wms';
import { decodeSkinText } from './wms';

const RUNTIME_SOURCE = `(${wmpVmRuntime.toString()})();`;

/** The player as a WMP skin sees it (no local paths: file names only). */
function snapshot(): PlayerSnapshot {
  const s: PlayerState = player.getState();
  const t = player.getTime();
  const track = s.queue[s.current];
  const playState = s.status === 'playing'
    ? s.scan === 'ffwd' ? 4 : s.scan === 'rew' ? 5 : s.waiting ? 6 : 3
    : s.status === 'paused' ? 2 : track ? 1 : 10;
  const status = playState === 3 ? 'Playing' : playState === 2 ? 'Paused' : playState === 4 ? 'Fast Forward' : playState === 5 ? 'Rewind'
    : playState === 6 ? 'Buffering' : playState === 1 ? 'Stopped' : 'Ready';
  const fileName = (location: string) => (isUrl(location) ? location : location.slice(location.lastIndexOf('/') + 1));
  return {
    playState,
    openState: track ? 13 : 0,
    status,
    url: track ? fileName(track.location) : '',
    position: Math.round(t.position * 10) / 10,
    duration: t.duration || track?.duration || 0,
    name: track?.title ?? '',
    artist: track?.artist ?? '',
    album: track?.album ?? '',
    genre: '',
    year: '',
    trackNumber: '',
    bitrate: s.info.bitrate ?? 0,
    volume: Math.round(s.volume * 100),
    mute: s.muted,
    balance: Math.round(s.balance * 100),
    rate: s.rate,
    loop: s.repeat !== 'off',
    shuffle: s.shuffle,
    eqOn: s.eqOn,
    bands: s.bands.map((b) => Math.round(b * 10) / 10),
    eqPreset: EQ_PRESETS.findIndex((p) => p.name === s.eqPreset),
    mediaKey: track?.key ?? '',
    current: s.current,
    items: s.queue.slice(0, 1000).map((q) => ({ name: q.title, artist: q.artist, album: q.album, duration: q.duration ?? 0 })),
    isVideo: !!track?.video,
  };
}

const prefsKey = (pkg: WmzPackage) => `din:music-player:wmp-prefs:${pkg.name}`;

function loadSkinPrefs(pkg: WmzPackage): Record<string, string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(prefsKey(pkg)) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let soundCtx: AudioContext | null = null;
async function playSkinSound(pkg: WmzPackage, name: string) {
  const data = pkg.file(name);
  if (!data) return;
  soundCtx ??= new AudioContext();
  const buffer = await soundCtx.decodeAudioData(data.slice().buffer);
  const source = soundCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(soundCtx.destination);
  source.start();
}

/** Perform what a skin's script asked for. */
function useCallHandler(pkg: WmzPackage, commands: Commands, views: { open: (id: string, l?: number, t?: number) => void; close: (id: string) => void; switchTo: (id: string) => void }, viewId: string, main: boolean) {
  const openUrl = useOpenUrl();
  return useCallback(
    (msg: Extract<VmToHost, { type: 'call' }>) => {
      const [a0, a1] = msg.args;
      const n0 = Number(a0);
      const s = player.getState();
      switch (`${msg.target}.${msg.method}`) {
        case 'controls.play': player.play(); break;
        case 'controls.pause': player.pause(); break;
        case 'controls.stop': player.stop(); break;
        case 'controls.next': player.next(); break;
        case 'controls.previous': player.previous(); break;
        case 'controls.fastForward': player.fastForward(); break;
        case 'controls.fastReverse': player.rewind(); break;
        case 'controls.seek': if (Number.isFinite(n0)) player.seek(n0); break;
        case 'settings.volume': if (Number.isFinite(n0)) player.setVolume(n0 / 100); break;
        case 'settings.mute': player.setMuted(!!a0); break;
        case 'settings.balance': if (Number.isFinite(n0)) player.setBalance(n0 / 100); break;
        case 'settings.rate': if (Number.isFinite(n0) && n0 > 0) player.setRate(n0); break;
        case 'settings.setMode':
          if (a0 === 'loop') player.setRepeat(a1 ? 'all' : 'off');
          else if (a0 === 'shuffle') player.setShuffle(!!a1);
          break;
        case 'player.url':
          if (typeof a0 === 'string' && /^https?:\/\//i.test(a0)) player.setQueue([makeTrack(a0)], 0, true);
          break;
        case 'player.launchURL':
          if (typeof a0 === 'string' && /^https?:\/\//i.test(a0)) openUrl(a0);
          break;
        case 'playlist.move': {
          const key = s.queue[n0]?.key;
          if (key) player.move([key], Number(a1) > n0 ? Number(a1) + 1 : Number(a1));
          break;
        }
        case 'playlist.remove':
          if (Array.isArray(a0)) player.remove((a0 as number[]).map((i) => s.queue[i]?.key).filter((k): k is string => !!k));
          break;
        case 'playlist.moveUp':
        case 'playlist.moveDown':
          if (Array.isArray(a0) && a0.length > 0) {
            const indices = (a0 as number[]).slice().sort((x, y) => x - y);
            const keys = indices.map((i) => s.queue[i]?.key).filter((k): k is string => !!k);
            player.move(keys, msg.method === 'moveUp' ? Math.max(0, indices[0] - 1) : indices[indices.length - 1] + 2);
          }
          break;
        case 'playlist.sort': player.sort(n0 === 1 ? 'duration' : 'title'); break;
        case 'eq.band': if (Number.isFinite(n0)) player.setBand(n0, Number(a1)); break;
        case 'eq.on': player.setEqOn(!!a0); break;
        case 'eq.preset': if (EQ_PRESETS[n0]) player.applyPreset(EQ_PRESETS[n0]); break;
        case 'eq.reset': player.applyPreset(EQ_PRESETS[0]); break;
        case 'eq.crossfade': player.setCrossfade(a0 ? Math.max(1, Number(a1) / 1000) : 0); break;
        case 'eq.quiet': player.setQuiet(!!a0); break;
        case 'eq.bass': player.setBassBoost((Number(a0) / 100) * 12); break;
        case 'theme.savePreference': {
          const prefs = loadSkinPrefs(pkg);
          prefs[String(a0)] = String(a1);
          localStorage.setItem(prefsKey(pkg), JSON.stringify(prefs));
          break;
        }
        case 'theme.playSound': void playSkinSound(pkg, String(a0)).catch(() => {}); break;
        case 'theme.openDialog': void commands.openFiles('play'); break;
        case 'theme.openView': views.open(String(a0), msg.args.length > 1 ? Number(a1) : undefined, msg.args.length > 2 ? Number(msg.args[2]) : undefined); break;
        case 'theme.closeView': views.close(String(a0)); break;
        case 'theme.switchView': views.switchTo(String(a0)); break;
        case 'view.close':
          if (main) commands.close();
          else views.close(viewId);
          break;
        case 'view.minimize': commands.minimize(); break;
        case 'view.returnToMediaCenter': setPrefs({ skin: { kind: 'din' } }); break;
        case 'automenu.show': void commands.openFiles('play'); break;
      }
    },
    [pkg, commands, views, viewId, main, openUrl],
  );
}

/**
 * The play and open state names Windows Media Player's own script resource
 * (res://wmploc.dll/RT_TEXT/#132) gave skins, which compare against them.
 */
const WMPLOC_CONSTANTS = [
  'var psUndefined = 0, psStopped = 1, psPaused = 2, psPlaying = 3, psScanForward = 4, psScanReverse = 5, psBuffering = 6,',
  '  psWaiting = 7, psMediaEnded = 8, psTransitioning = 9, psReady = 10, psReconnecting = 11;',
  'var osUndefined = 0, osPlaylistChanging = 1, osPlaylistLocating = 2, osPlaylistConnecting = 3, osPlaylistLoading = 4,',
  '  osPlaylistOpening = 5, osPlaylistOpenNoMedia = 6, osPlaylistChanged = 7, osMediaChanging = 8, osMediaLocating = 9,',
  '  osMediaConnecting = 10, osMediaLoading = 11, osMediaOpening = 12, osMediaOpen = 13, osBeginCodecAcquisition = 14,',
  '  osEndCodecAcquisition = 15, osBeginLicenseAcquisition = 16, osEndLicenseAcquisition = 17, osBeginIndividualization = 18,',
  '  osEndIndividualization = 19, osMediaWaiting = 20, osOpeningUnknownURL = 21;',
].join('\n');

function scriptsFor(pkg: WmzPackage, view: WmsNode): string[] {
  const names = [`${pkg.name}.js`, ...String(view.attrs.scriptfile ?? '').split(/[;,]/).map((s) => s.trim()).filter((s) => s && !/^res:/i.test(s))];
  const seen = new Set<string>();
  const sources: string[] = [WMPLOC_CONSTANTS];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const data = pkg.file(name);
    if (data) sources.push(decodeSkinText(data));
  }
  return sources;
}

/** One VIEW of a skin: its sandboxed script runtime and its elements. */
function WmpView({
  pkg, images, view, commands, main, views, onSize,
}: {
  pkg: WmzPackage;
  images: SkinImages;
  view: WmsNode;
  commands: Commands;
  main: boolean;
  views: { open: (id: string, l?: number, t?: number) => void; close: (id: string) => void; switchTo: (id: string) => void };
  onSize: (size: { width: number; height: number }) => void;
}) {
  const prepared = useMemo(() => prepareView(view), [view]);
  const mirror = useMemo(() => new Mirror(), []);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const viewId = view.attrs.id ?? '';
  const handleCall = useCallHandler(pkg, commands, views, viewId, main);
  const callRef = useRef(handleCall);
  useEffect(() => {
    callRef.current = handleCall;
  });
  const albumArt = useCover(useTrackLocation());

  const send = useCallback((msg: HostToVm) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  useEffect(() => {
    let booted = false;
    let loads = 0;
    const onMessage = (e: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return;
      const msg = e.data as VmToHost;
      switch (msg.type) {
        case 'loaded':
          // The sandbox loads once; a second load means it navigated: stop talking to it.
          if (++loads > 1) {
            iframeRef.current?.remove();
            return;
          }
          frame.postMessage({ type: 'runtime', source: RUNTIME_SOURCE }, '*');
          break;
        case 'booted':
          if (booted) return;
          booted = true;
          frame.postMessage(
            {
              type: 'init',
              view: prepared,
              theme: pkg.theme.attrs,
              scripts: scriptsFor(pkg, view),
              images: images.sizes(),
              prefs: loadSkinPrefs(pkg),
              player: snapshot(),
              eqPresets: EQ_PRESETS.map((p) => p.name),
              effects: WMP_EFFECTS.map(({ type, title, presets }) => ({ type, title, presets })),
              viewWidth: 300,
              viewHeight: 200,
            } satisfies HostToVm,
            '*',
          );
          break;
        case 'patch':
          mirror.apply(msg.patch);
          break;
        case 'ready':
          setReady(true);
          break;
        case 'call':
          callRef.current(msg);
          break;
        case 'error':
          console.warn('[WMP skin]', msg.message);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mirror, pkg, prepared, view, images]);

  // The player's state, to the skin's script, at most a few times a second.
  useEffect(() => {
    if (!ready) return;
    let last = '';
    let queued = false;
    const push = () => {
      queued = false;
      const snap = snapshot();
      const json = JSON.stringify(snap);
      if (json === last) return;
      last = json;
      send({ type: 'player', player: snap });
    };
    const schedule = () => {
      if (queued) return;
      queued = true;
      window.setTimeout(push, 100);
    };
    push();
    const a = player.subscribe(schedule);
    const b = player.subscribeTime(schedule);
    return () => {
      a();
      b();
    };
  }, [ready, send]);

  const root = useSyncExternalStore(
    (l) => mirror.subscribe(prepared.iid, l),
    () => mirror.get(prepared.iid),
  );
  const width = Number(root?.width ?? 0);
  const height = Number(root?.height ?? 0);
  useEffect(() => {
    if (ready && width > 0 && height > 0) onSize({ width, height });
  }, [ready, width, height, onSize]);

  const ctx = useMemo(() => ({ mirror, images, send, albumArt }), [mirror, images, send, albumArt]);
  return (
    <>
      <iframe
        ref={iframeRef}
        src="/wmp-sandbox.html"
        sandbox="allow-scripts"
        title="Skin script"
        aria-hidden
        tabIndex={-1}
        style={{ position: 'absolute', width: 0, height: 0, border: 0, visibility: 'hidden' }}
      />
      {ready && (
        <ViewContext.Provider value={ctx}>
          <Element node={prepared} />
        </ViewContext.Provider>
      )}
    </>
  );
}

function useTrackLocation(): string | null {
  const [location, setLocation] = useState<string | null>(() => player.currentTrack?.location ?? null);
  useEffect(() => player.subscribe(() => setLocation(player.currentTrack?.location ?? null)), []);
  return location;
}

/**
 * A Windows Media Player skin: its first view (or the one theme.currentViewID
 * names), plus any views it opens beside it, all in one frameless window.
 */
export function WmpPlayer({ pkg, commands, onSize }: { pkg: WmzPackage; commands: Commands; onSize: (size: { width: number; height: number }) => void }) {
  const all = useMemo(() => themeViews(pkg.theme), [pkg]);
  const [mainIndex, setMainIndex] = useState(0);
  const [extra, setExtra] = useState<{ index: number; x: number; y: number }[]>([]);
  const [sizes, setSizes] = useState<Record<number, { width: number; height: number }>>({});
  const [images, setImages] = useState<SkinImages | null>(null);

  useEffect(() => {
    let live = true;
    void SkinImages.load(pkg, pkg.names().filter((n) => /\.(bmp|png|jpe?g|gif)$/i.test(n))).then((store) => live && setImages(store));
    return () => {
      live = false;
    };
  }, [pkg]);

  const indexOf = useCallback((id: string) => all.findIndex((v) => (v.attrs.id ?? '').toLowerCase() === id.toLowerCase()), [all]);
  const views = useMemo(
    () => ({
      open: (id: string, l?: number, t?: number) => {
        const index = indexOf(id);
        if (index < 0) return;
        setExtra((list) => (list.some((v) => v.index === index) || index === mainIndex ? list : [...list, { index, x: l ?? NaN, y: t ?? NaN }]));
      },
      close: (id: string) => {
        const index = indexOf(id);
        setExtra((list) => list.filter((v) => v.index !== index));
      },
      switchTo: (id: string) => {
        const index = indexOf(id);
        if (index >= 0) {
          setMainIndex(index);
          setExtra((list) => list.filter((v) => v.index !== index));
        }
      },
    }),
    [indexOf, mainIndex],
  );

  // Lay the views out: the main one at the origin, others where they asked
  // (or to its right), the window growing to hold them all.
  const mainSize = sizes[mainIndex];
  const placed = extra.map((v, i) => ({
    ...v,
    x: Number.isFinite(v.x) ? v.x : (mainSize?.width ?? 0) + 8 * (i + 1),
    y: Number.isFinite(v.y) ? v.y : 0,
  }));
  const minX = Math.min(0, ...placed.map((p) => p.x));
  const minY = Math.min(0, ...placed.map((p) => p.y));
  const maxX = Math.max(mainSize?.width ?? 0, ...placed.map((p) => p.x + (sizes[p.index]?.width ?? 0)));
  const maxY = Math.max(mainSize?.height ?? 0, ...placed.map((p) => p.y + (sizes[p.index]?.height ?? 0)));
  const width = maxX - minX;
  const height = maxY - minY;
  useEffect(() => {
    if (width > 0 && height > 0) onSize({ width, height });
  }, [width, height, onSize]);

  const sizeSetter = useCallback((index: number) => (size: { width: number; height: number }) => setSizes((s) => (s[index]?.width === size.width && s[index]?.height === size.height ? s : { ...s, [index]: size })), []);
  const mainSetter = useMemo(() => sizeSetter(mainIndex), [sizeSetter, mainIndex]);
  const extraSetters = useMemo(() => new Map(extra.map((v) => [v.index, sizeSetter(v.index)])), [extra, sizeSetter]);

  if (!images || all.length === 0) return null;
  return (
    <div style={{ position: 'relative', width: width || 1, height: height || 1 }} className="select-none">
      <div style={{ position: 'absolute', left: -minX, top: -minY }}>
        <WmpView key={`main-${mainIndex}`} pkg={pkg} images={images} view={all[mainIndex]} commands={commands} main views={views} onSize={mainSetter} />
      </div>
      {placed.map((v) => (
        <div key={v.index} style={{ position: 'absolute', left: v.x - minX, top: v.y - minY }}>
          <WmpView pkg={pkg} images={images} view={all[v.index]} commands={commands} main={false} views={views} onSize={extraSetters.get(v.index)!} />
        </div>
      ))}
    </div>
  );
}
