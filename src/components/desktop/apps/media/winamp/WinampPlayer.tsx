import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWindowIsTop } from '@/contexts/WindowFocusContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { cleanFsError, getFsBridge } from '@/lib/fs';
import { displayTitle, formatTime, player, usePlaybackTime, usePlayer } from '../engine';
import { EQ_PRESETS, parseEqf, writeEqf } from '../eq';
import { setPrefs, setWinampPrefs, usePrefs } from '../prefs';
import type { Commands } from '../useCommands';
import { regionClip, type WinampSkin } from './skin';
import { SkinText, Sprite, SpriteButton, WinampVis } from './parts';
import { SkinContext, spriteStyle, useSkin, useSliderDrag, useWindowDrag } from './hooks';
import { MAIN_H, SHADE_H, W, winampLayout } from './layout';
import { PL_MENUS, SPRITES } from './sprites';

/** "SEEK TO: 1:23/4:56 (30%)" and friends replace the title while dragging. */
function useMarqueeOverride(): [string | null, (text: string | null) => void] {
  const [text, setText] = useState<string | null>(null);
  return [text, setText];
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function TimeDisplay({ x, y }: { x: number; y: number }) {
  const skin = useSkin();
  const { position, duration } = usePlaybackTime();
  const status = usePlayer((s) => s.status);
  const remaining = usePrefs((p) => p.winamp.remaining);
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    if (status !== 'paused') return;
    const t = window.setInterval(() => setBlink((b) => !b), 1000);
    return () => {
      window.clearInterval(t);
      setBlink(true);
    };
  }, [status]);
  if (status === 'stopped' || (status === 'paused' && !blink)) return null;
  const seconds = Math.floor(remaining && duration > 0 ? Math.max(0, duration - position) : position);
  const m = Math.min(99, Math.floor(seconds / 60));
  const s = seconds % 60;
  const digits = [Math.floor(m / 10), m % 10, Math.floor(s / 10), s % 10];
  const ex = skin.sheets.nums_ex;
  const sheet = ex ?? skin.sheets.numbers;
  const digit = (d: number, dx: number) => (
    <div style={{ position: 'absolute', left: x + dx, top: y, width: 9, height: 13, backgroundImage: sheet ? `url("${sheet.url}")` : undefined, backgroundPosition: `-${d * 9}px 0` }} />
  );
  return (
    <div onPointerDown={(e) => e.stopPropagation()} onClick={() => setWinampPrefs({ remaining: !remaining })} aria-label={`Time ${formatTime(seconds)}${remaining ? ' remaining' : ''}`} role="button" style={{ position: 'absolute', left: x - 2, top: y, width: 63, height: 13, cursor: 'default' }}>
      <div style={{ position: 'absolute', left: -x + 2, top: -y }}>
        {remaining &&
          (ex ? (
            <div style={{ position: 'absolute', left: x, top: y, width: 9, height: 13, backgroundImage: `url("${ex.url}")`, backgroundPosition: '-99px 0' }} />
          ) : (
            <div style={{ position: 'absolute', left: x + 2, top: y + 6, width: 5, height: 1, backgroundImage: sheet ? `url("${sheet.url}")` : undefined, backgroundPosition: '-20px -6px' }} />
          ))}
        {digit(digits[0], 9)}
        {digit(digits[1], 21)}
        {digit(digits[2], 39)}
        {digit(digits[3], 51)}
      </div>
    </div>
  );
}

function Marquee({ override }: { override: string | null }) {
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const index = usePlayer((s) => s.current);
  const text = useMemo(() => {
    if (!track) return 'Din Classic';
    const duration = track.duration ? ` (${formatTime(track.duration)})` : '';
    return `${index + 1}. ${displayTitle(track)}${duration}`;
  }, [track, index]);
  const [scrolled, setScrolled] = useState({ text, offset: 0 });
  const offset = scrolled.text === text ? scrolled.offset : 0;
  const width = text.length * 5;
  const scrolls = width > 154 && !override;
  useEffect(() => {
    if (!scrolls) return;
    const t = window.setInterval(
      () => setScrolled((s) => ({ text, offset: s.text === text ? (s.offset + 5) % (width + 35) : 5 })),
      220,
    );
    return () => window.clearInterval(t);
  }, [scrolls, width, text]);
  const shown = override ?? text;
  return (
    <div style={{ position: 'absolute', left: 111, top: 27, width: 154, height: 6, overflow: 'hidden' }} title={text}>
      <SkinText text={scrolls ? `${shown}  ***  ${shown}` : shown} x={-offset} y={0} />
    </div>
  );
}

function Volume({ x, y, setOverride }: { x: number; y: number; setOverride: (t: string | null) => void }) {
  const skin = useSkin();
  const volume = usePlayer((s) => (s.muted ? 0 : s.volume));
  const { active, handlers } = useSliderDrag('x', (f, done) => {
    player.setVolume(f);
    setOverride(done ? null : `VOLUME: ${Math.round(f * 100)}%`);
  }, 14);
  const frame = Math.round(volume * 27);
  const sheet = skin.sheets.volume;
  return (
    <div
      {...handlers}
      role="slider"
      aria-label="Volume"
      aria-valuenow={Math.round(volume * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') player.setVolume(volume + 0.05);
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') player.setVolume(volume - 0.05);
      }}
      onWheel={(e) => player.setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05))}
      style={{ position: 'absolute', left: x, top: y, width: 68, height: 13, backgroundImage: sheet ? `url("${sheet.url}")` : undefined, backgroundPosition: `0 -${frame * 15}px`, outline: 'none' }}
    >
      {sheet && sheet.height >= 433 && <Sprite name={active ? 'volThumbDown' : 'volThumb'} x={Math.round(volume * 54)} y={1} />}
    </div>
  );
}

function Balance({ x, y, setOverride }: { x: number; y: number; setOverride: (t: string | null) => void }) {
  const skin = useSkin();
  const balance = usePlayer((s) => s.balance);
  const { active, handlers } = useSliderDrag('x', (f, done) => {
    const b = f * 2 - 1;
    player.setBalance(b);
    const pct = Math.round(Math.abs(b) * 100);
    setOverride(done ? null : `BALANCE: ${pct === 0 || Math.abs(b) < 0.04 ? 'CENTER' : `${pct}% ${b < 0 ? 'LEFT' : 'RIGHT'}`}`);
  }, 14);
  const frame = Math.round(Math.abs(balance) * 27);
  const sheet = skin.sheets.balance;
  return (
    <div
      {...handlers}
      role="slider"
      aria-label="Balance"
      aria-valuenow={Math.round(balance * 100)}
      aria-valuemin={-100}
      aria-valuemax={100}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') player.setBalance(balance + 0.1);
        if (e.key === 'ArrowLeft') player.setBalance(balance - 0.1);
      }}
      style={{ position: 'absolute', left: x, top: y, width: 38, height: 13, backgroundImage: sheet ? `url("${sheet.url}")` : undefined, backgroundPosition: `-9px -${frame * 15}px`, outline: 'none' }}
    >
      {sheet && sheet.height >= 433 && <Sprite name={active ? 'balThumbDown' : 'balThumb'} x={Math.round(((balance + 1) / 2) * 24)} y={1} />}
    </div>
  );
}

function Position({ setOverride }: { setOverride: (t: string | null) => void }) {
  const { position, duration } = usePlaybackTime();
  const stopped = usePlayer((s) => s.status === 'stopped');
  const [drag, setDrag] = useState<number | null>(null);
  const { active, handlers } = useSliderDrag('x', (f, done) => {
    if (!(duration > 0)) return;
    if (done) {
      player.seek(f * duration);
      setDrag(null);
      setOverride(null);
    } else {
      setDrag(f);
      setOverride(`SEEK TO: ${formatTime(f * duration)}/${formatTime(duration)} (${Math.round(f * 100)}%)`);
    }
  }, 29);
  const f = drag ?? (duration > 0 ? Math.min(1, position / duration) : 0);
  return (
    <Sprite name="posBg" x={16} y={72} {...handlers} role="slider" aria-label="Seek" aria-valuenow={Math.round(position)} aria-valuemax={Math.round(duration)}>
      {!stopped && duration > 0 && <Sprite name={active ? 'posThumbDown' : 'posThumb'} x={Math.round(f * (248 - 29))} y={0} />}
    </Sprite>
  );
}

function MainWindow({ y, commands, onMenu }: { y: number; commands: Commands; onMenu: (e: React.MouseEvent) => void }) {
  const skin = useSkin();
  const focused = useWindowIsTop();
  const drag = useWindowDrag();
  const prefs = usePrefs((p) => p.winamp);
  const status = usePlayer((s) => s.status);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const info = usePlayer((s) => s.info);
  const [override, setOverride] = useMarqueeOverride();
  const clip = regionClip(prefs.mainShade ? skin.regions.windowshade : skin.regions.normal);
  const style: CSSProperties = { position: 'absolute', left: 0, top: y, width: W, height: prefs.mainShade ? SHADE_H : MAIN_H, clipPath: clip, overflow: 'hidden' };

  if (prefs.mainShade) {
    return (
      <div style={style} onContextMenu={onMenu}>
        <Sprite name={focused ? 'shadeActive' : 'shade'} x={0} y={0} {...drag} />
        <SpriteButton up={null} down="optionsDown" x={6} y={3} width={9} height={9} label="Options" onClick={() => onMenu({ clientX: 0, clientY: 0 } as React.MouseEvent)} />
        <SpriteButton up={null} down="minimizeDown" x={244} y={3} width={9} height={9} label="Minimize" onClick={commands.minimize} />
        <SpriteButton up="unshadeBtn" down="unshadeBtnDown" x={254} y={3} label="Full mode" onClick={() => setWinampPrefs({ mainShade: false })} />
        <SpriteButton up={null} down="closeDown" x={264} y={3} width={9} height={9} label="Close" onClick={commands.close} />
        {(['previous', 'play', 'pause', 'stop', 'next', 'eject'] as const).map((what, i) => (
          <SpriteButton
            key={what}
            up={null}
            down={null}
            x={[169, 176, 186, 195, 204, 215][i]}
            y={2}
            width={[7, 10, 9, 9, 10, 10][i]}
            height={10}
            label={what}
            onClick={() => (what === 'eject' ? void commands.openFiles('play') : what === 'previous' ? player.previous() : what === 'play' ? player.play() : player[what]())}
          />
        ))}
        <ShadeTime />
        <WinampVis x={79} y={5} width={38} height={5} mode={prefs.vis} onClick={() => setWinampPrefs({ vis: (prefs.vis + 1) % 3 })} />
        <ShadePosition />
      </div>
    );
  }

  const kbps = info.bitrate ? String(Math.min(999, info.bitrate)).padStart(3, ' ') : '';
  const khz = info.sampleRate ? String(Math.round(info.sampleRate / 1000)).padStart(2, ' ') : '';
  return (
    <div style={style} onContextMenu={onMenu}>
      <Sprite name="mainBg" x={0} y={0} />
      <Sprite name={focused ? 'titleActive' : 'title'} x={0} y={0} {...drag} onDoubleClick={() => setWinampPrefs({ mainShade: true })} />
      <SpriteButton up={null} down="optionsDown" x={6} y={3} width={9} height={9} label="Options" onClick={() => onMenu({ clientX: 0, clientY: 0 } as React.MouseEvent)} />
      <SpriteButton up={null} down="minimizeDown" x={244} y={3} width={9} height={9} label="Minimize" onClick={commands.minimize} />
      <SpriteButton up={null} down="shadeBtnDown" x={254} y={3} width={9} height={9} label="Windowshade mode" onClick={() => setWinampPrefs({ mainShade: true })} />
      <SpriteButton up={null} down="closeDown" x={264} y={3} width={9} height={9} label="Close" onClick={commands.close} />

      <Sprite name="clutter" x={10} y={22} />
      <SpriteButton up={null} down="clutterO" x={10} y={25} width={8} height={8} label="Options menu" onClick={() => onMenu({ clientX: 0, clientY: 0 } as React.MouseEvent)} />
      <SpriteButton up={null} down="clutterA" x={10} y={33} width={8} height={7} label="Always on top" onClick={() => {}} />
      <SpriteButton up={null} down="clutterI" x={10} y={40} width={8} height={7} label="Return to Din’s skin" onClick={() => setPrefs({ skin: { kind: 'din' } })} />
      {prefs.double ? (
        <Sprite name="clutterD" x={10} y={47} onPointerDown={(e) => e.stopPropagation()} onClick={() => setWinampPrefs({ double: false })} title="Double size" />
      ) : (
        <SpriteButton up={null} down="clutterD" x={10} y={47} width={8} height={8} label="Double size" onClick={() => setWinampPrefs({ double: true })} />
      )}
      <SpriteButton up={null} down="clutterV" x={10} y={55} width={8} height={7} label="Visualization mode" onClick={() => setWinampPrefs({ vis: (prefs.vis + 1) % 3 })} />

      <Sprite name={status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'stopped'} x={26} y={28} />
      {status === 'playing' && <Sprite name="working" x={24} y={28} />}
      <TimeDisplay x={39} y={26} />
      <WinampVis x={24} y={43} width={76} height={16} mode={prefs.vis} onClick={() => setWinampPrefs({ vis: (prefs.vis + 1) % 3 })} />
      <Marquee override={override} />
      {status !== 'stopped' && <SkinText text={kbps} x={111} y={43} />}
      {status !== 'stopped' && <SkinText text={khz} x={156} y={43} />}
      <Sprite name={status !== 'stopped' && info.channels === 1 ? 'monoOn' : 'mono'} x={212} y={41} />
      <Sprite name={status !== 'stopped' && (info.channels ?? 2) >= 2 ? 'stereoOn' : 'stereo'} x={239} y={41} />
      <Volume x={107} y={57} setOverride={setOverride} />
      <Balance x={177} y={57} setOverride={setOverride} />
      <SpriteButton up={prefs.eq ? 'eqBtnOn' : 'eqBtn'} down={prefs.eq ? 'eqBtnOnDown' : 'eqBtnDown'} x={219} y={58} label="Toggle equalizer" onClick={() => setWinampPrefs({ eq: !prefs.eq })} />
      <SpriteButton up={prefs.playlist ? 'plBtnOn' : 'plBtn'} down={prefs.playlist ? 'plBtnOnDown' : 'plBtnDown'} x={242} y={58} label="Toggle playlist editor" onClick={() => setWinampPrefs({ playlist: !prefs.playlist })} />
      <Position setOverride={setOverride} />
      <SpriteButton up="prev" down="prevDown" x={16} y={88} label="Previous (Z)" onClick={() => player.previous()} />
      <SpriteButton up="play" down="playDown" x={39} y={88} label="Play (X)" onClick={() => player.play()} />
      <SpriteButton up="pause" down="pauseDown" x={62} y={88} label="Pause (C)" onClick={() => (status === 'paused' ? player.play() : player.pause())} />
      <SpriteButton up="stop" down="stopDown" x={85} y={88} label="Stop (V)" onClick={() => player.stop()} />
      <SpriteButton up="next" down="nextDown" x={108} y={88} label="Next (B)" onClick={() => player.next()} />
      <SpriteButton up="eject" down="ejectDown" x={136} y={89} label="Open file (L)" onClick={() => void commands.openFiles('play')} />
      <SpriteButton up={shuffle ? 'shuffleOn' : 'shuffle'} down={shuffle ? 'shuffleOnDown' : 'shuffleDown'} x={164} y={89} label="Shuffle (S)" onClick={() => player.setShuffle(!shuffle)} />
      <SpriteButton
        up={repeat !== 'off' ? 'repeatOn' : 'repeat'}
        down={repeat !== 'off' ? 'repeatOnDown' : 'repeatDown'}
        x={210}
        y={89}
        label="Repeat (R)"
        onClick={() => player.setRepeat(repeat === 'off' ? 'all' : 'off')}
      />
      <SpriteButton up={null} down={null} x={253} y={91} width={13} height={15} label="Back to Din’s skin" onClick={() => setPrefs({ skin: { kind: 'din' } })} />
    </div>
  );
}

function ShadeTime() {
  const { position } = usePlaybackTime();
  const status = usePlayer((s) => s.status);
  if (status === 'stopped') return null;
  const t = formatTime(position).padStart(5, ' ');
  return <SkinText text={t} x={127} y={4} />;
}

function ShadePosition() {
  const { position, duration } = usePlaybackTime();
  const { handlers } = useSliderDrag('x', (f, done) => done && duration > 0 && player.seek(f * duration), 3);
  const f = duration > 0 ? position / duration : 0;
  const thumb = f < 0.33 ? 'shadePosThumbLeft' : f > 0.66 ? 'shadePosThumbRight' : 'shadePosThumb';
  return (
    <Sprite name="shadePosBg" x={226} y={4} {...handlers}>
      <Sprite name={thumb} x={Math.round(f * 14)} y={0} />
    </Sprite>
  );
}

// ---------------------------------------------------------------------------
// Equalizer
// ---------------------------------------------------------------------------

function EqSlider({ x, y, value, onValue, label }: { x: number; y: number; value: number; onValue: (db: number) => void; label: string }) {
  const skin = useSkin();
  const { active, handlers } = useSliderDrag('y', (f) => onValue((0.5 - f) * 24), 11);
  const v = (value + 12) / 24;
  const frame = Math.round(v * 27);
  const sheet = skin.sheets.eqmain;
  return (
    <div
      {...handlers}
      onDoubleClick={() => onValue(0)}
      role="slider"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={-12}
      aria-valuemax={12}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onValue(value + 1);
        if (e.key === 'ArrowDown') onValue(value - 1);
      }}
      style={{
        position: 'absolute', left: x, top: y, width: 14, height: 63, outline: 'none',
        backgroundImage: sheet ? `url("${sheet.url}")` : undefined,
        backgroundPosition: `-${13 + (frame % 14) * 15}px -${164 + (frame > 13 ? 65 : 0)}px`,
      }}
    >
      <Sprite name={active ? 'eqThumbDown' : 'eqThumb'} x={1} y={Math.round((1 - v) * 51)} />
    </div>
  );
}

function EqGraph() {
  const skin = useSkin();
  const bands = usePlayer((s) => s.bands);
  const preamp = usePlayer((s) => s.preamp);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, 113, 19);
    const toY = (db: number) => Math.round(9 - (db / 12) * 9);
    const py = toY(preamp);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, py, 113, 1);
    // A smooth line through the ten bands (Catmull-Rom).
    const pts = bands.map((db, i) => [2 + (i * 108) / 9, 9 - (db / 12) * 9] as const);
    let lastY = -1;
    for (let x = 0; x < 113; x++) {
      const t = Math.max(0, Math.min(8.999, ((x - 2) / 108) * 9));
      const i = Math.floor(t);
      const u = t - i;
      const p0 = pts[Math.max(0, i - 1)][1];
      const p1 = pts[i][1];
      const p2 = pts[Math.min(9, i + 1)][1];
      const p3 = pts[Math.min(9, i + 2)][1];
      const yv = 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
      const yy = Math.max(0, Math.min(18, Math.round(yv)));
      const from = lastY === -1 ? yy : lastY;
      for (let k = Math.min(from, yy); k <= Math.max(from, yy); k++) {
        ctx.fillStyle = skin.graphColors[k] ?? '#fff';
        ctx.fillRect(x, k, 1, 1);
      }
      lastY = yy;
    }
  }, [bands, preamp, skin]);
  return (
    <Sprite name="eqGraphBg" x={86} y={17}>
      <canvas ref={ref} width={113} height={19} aria-hidden style={{ position: 'absolute', inset: 0, imageRendering: 'pixelated' }} />
    </Sprite>
  );
}

function EqPresetsMenu({ children }: { children: ReactNode }) {
  const { pickFile, pickFiles } = useFilePicker();
  const bands = usePlayer((s) => s.bands);
  const preamp = usePlayer((s) => s.preamp);
  const [error, setError] = useState<string | null>(null);
  return (
    <DropdownMenu onOpenChange={(open) => open && setError(null)}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Load</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
            {EQ_PRESETS.map((p) => (
              <DropdownMenuItem key={p.name} onSelect={() => player.applyPreset(p)}>{p.name}</DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          onSelect={async () => {
            const path = await pickFile({ title: 'Load EQ Preset', extensions: ['.eqf', '.q1'] });
            const fs = getFsBridge();
            if (!path || !fs) return;
            try {
              const presets = parseEqf((await fs.readFile(path)).data);
              if (presets[0]) player.applyPreset(presets[0]);
            } catch (e) {
              setError(cleanFsError(e));
            }
          }}
        >
          From EQF File…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const result = await pickFiles({ mode: 'save', title: 'Save EQ Preset', currentName: 'Preset.eqf', extensions: ['.eqf'] });
            const fs = getFsBridge();
            if (!result || !fs) return;
            const path = /\.eqf$/i.test(result.paths[0]) ? result.paths[0] : `${result.paths[0]}.eqf`;
            await fs.writeFile(path, writeEqf([{ name: path.slice(path.lastIndexOf('/') + 1, -4), preamp, bands }]));
          }}
        >
          Save to EQF File…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => player.applyPreset(EQ_PRESETS[0])}>Reset (Flat)</DropdownMenuItem>
        {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EqWindow({ y, commands }: { y: number; commands: Commands }) {
  const skin = useSkin();
  const focused = useWindowIsTop();
  const drag = useWindowDrag();
  const prefs = usePrefs((p) => p.winamp);
  const eqOn = usePlayer((s) => s.eqOn);
  const eqAuto = usePlayer((s) => s.eqAuto);
  const bands = usePlayer((s) => s.bands);
  const preamp = usePlayer((s) => s.preamp);
  const volume = usePlayer((s) => s.volume);
  const balance = usePlayer((s) => s.balance);
  const shade = prefs.eqShade && !!skin.sheets.eq_ex;
  const clip = regionClip(shade ? skin.regions.equalizerws : skin.regions.equalizer);
  const volDrag = useSliderDrag('x', (f) => player.setVolume(f), 3);
  const balDrag = useSliderDrag('x', (f) => player.setBalance(f * 2 - 1), 3);
  void commands;
  if (shade) {
    const vx = Math.round(volume * (97 - 3));
    const bx = Math.round(((balance + 1) / 2) * (43 - 3));
    return (
      <div style={{ position: 'absolute', left: 0, top: y, width: W, height: SHADE_H, clipPath: clip }}>
        <Sprite name={focused ? 'eqShadeActive' : 'eqShade'} x={0} y={0} {...drag} />
        <div {...volDrag.handlers} aria-label="Volume" role="slider" style={{ position: 'absolute', left: 61, top: 4, width: 97, height: 7 }}>
          <Sprite name={vx < 31 ? 'eqShadeVolLeft' : vx > 62 ? 'eqShadeVolRight' : 'eqShadeVolCenter'} x={vx} y={0} />
        </div>
        <div {...balDrag.handlers} aria-label="Balance" role="slider" style={{ position: 'absolute', left: 164, top: 4, width: 43, height: 7 }}>
          <Sprite name={bx < 13 ? 'eqShadeBalLeft' : bx > 26 ? 'eqShadeBalRight' : 'eqShadeBalCenter'} x={bx} y={0} />
        </div>
        <SpriteButton up={null} down="eqMaxDown" x={254} y={3} width={9} height={9} label="Full size" onClick={() => setWinampPrefs({ eqShade: false })} />
        <SpriteButton up="eqShadeClose" down="eqShadeCloseDown" x={264} y={3} label="Close equalizer" onClick={() => setWinampPrefs({ eq: false })} />
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', left: 0, top: y, width: W, height: MAIN_H, clipPath: clip, overflow: 'hidden' }}>
      <Sprite name="eqBg" x={0} y={0} />
      <Sprite name={focused ? 'eqTitleActive' : 'eqTitle'} x={0} y={0} {...drag} onDoubleClick={() => skin.sheets.eq_ex && setWinampPrefs({ eqShade: true })} />
      {skin.sheets.eq_ex && <SpriteButton up={null} down="eqMinDown" x={254} y={3} width={9} height={9} label="Windowshade mode" onClick={() => setWinampPrefs({ eqShade: true })} />}
      <SpriteButton up={null} down="eqCloseDown" x={264} y={3} width={9} height={9} label="Close equalizer" onClick={() => setWinampPrefs({ eq: false })} />
      <SpriteButton up={eqOn ? 'eqOnSel' : 'eqOn'} down={eqOn ? 'eqOnSelDown' : 'eqOnDown'} x={14} y={18} label="Equalizer on" onClick={() => player.setEqOn(!eqOn)} />
      <SpriteButton up={eqAuto ? 'eqAutoSel' : 'eqAuto'} down={eqAuto ? 'eqAutoSelDown' : 'eqAutoDown'} x={40} y={18} label="Auto" onClick={() => player.setEqAuto(!eqAuto)} />
      <EqGraph />
      <EqPresetsMenu>
        <button type="button" aria-label="Presets" title="Presets" onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', left: 217, top: 18, ...spriteStyle(skin, SPRITES.eqPresets) }} />
      </EqPresetsMenu>
      <EqSlider x={21} y={38} value={preamp} onValue={(v) => player.setPreamp(v)} label="Preamp" />
      {bands.map((db, i) => (
        <EqSlider key={i} x={78 + i * 18} y={38} value={db} onValue={(v) => player.setBand(i, v)} label={`Band ${i + 1}`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Playlist editor
// ---------------------------------------------------------------------------

function Tiles({ name, x, y, count, axis }: { name: 'plTopTile' | 'plTopTileActive' | 'plLeft' | 'plRight' | 'plBottomTile' | 'plShadeBg'; x: number; y: number; count: number; axis: 'x' | 'y' }) {
  const [, , , w, h] = SPRITES[name];
  return (
    <>
      {Array.from({ length: Math.max(0, count) }, (_, i) => (
        <Sprite key={i} name={name} x={axis === 'x' ? x + i * w : x} y={axis === 'y' ? y + i * h : y} />
      ))}
    </>
  );
}

function PlMenu({ which, x, y, actions }: { which: keyof typeof PL_MENUS; x: number; y: number; actions: (() => void)[] }) {
  const skin = useSkin();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(-1);
  const menu = PL_MENUS[which];
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const n = menu.items.length;
  return (
    <>
      <button
        type="button"
        aria-label={`${which} menu`}
        aria-expanded={open}
        title={which.toUpperCase()}
        onPointerDown={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        style={{ position: 'absolute', left: x, top: y, width: 22, height: 18, background: 'transparent' }}
      />
      {open && (
        <div role="menu" onPointerDown={(e) => e.stopPropagation()} style={{ position: 'absolute', left: x, top: y + 18 - n * 18, width: 22, height: n * 18 }}>
          <div style={{ position: 'absolute', left: -3, top: 0, ...spriteStyle(skin, ['pledit', ...menu.bar] as const) }} />
          {menu.items.map(([sx, sy], i) => {
            const index = n - 1 - i;
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(-1)}
                onClick={() => {
                  setOpen(false);
                  actions[index]?.();
                }}
                style={{ position: 'absolute', left: 0, top: index * 18, ...spriteStyle(skin, ['pledit', hover === i ? sx + 23 : sx, sy, 22, 18] as const) }}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function PlaylistWindow({ y, width, height, commands }: { y: number; width: number; height: number; commands: Commands }) {
  const skin = useSkin();
  const focused = useWindowIsTop();
  const drag = useWindowDrag();
  const prefs = usePrefs((p) => p.winamp);
  const queue = usePlayer((s) => s.queue);
  const current = usePlayer((s) => s.current);
  const { position } = usePlaybackTime();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scroll, setScroll] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const colors = skin.playlist;

  const listTop = 20;
  const listH = height - 58;
  const rows = Math.max(1, Math.floor((listH - 6) / 13));
  const maxScroll = Math.max(0, queue.length - rows);
  const top = Math.min(scroll, maxScroll);

  const total = queue.reduce((n, t) => n + (t.duration ?? 0), 0);
  const selectedTotal = queue.filter((t) => selected.has(t.key)).reduce((n, t) => n + (t.duration ?? 0), 0);

  const resizing = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const scale = prefs.double ? 2 : 1;

  const scrollDrag = useSliderDrag('y', (f) => setScroll(Math.round(f * maxScroll)), 18);

  if (prefs.playlistShade) {
    const track = queue[current];
    return (
      <div style={{ position: 'absolute', left: 0, top: y, width, height: SHADE_H }}>
        <Sprite name="plShadeLeft" x={0} y={0} {...drag} />
        <Tiles name="plShadeBg" x={25} y={0} count={Math.ceil((width - 75) / 25)} axis="x" />
        <Sprite name={focused ? 'plShadeRightActive' : 'plShadeRight'} x={width - 50} y={0} {...drag} />
        <div {...drag} style={{ position: 'absolute', left: 25, top: 0, width: width - 75, height: 14 }} />
        <SkinText text={track ? `${current + 1}. ${displayTitle(track)}`.slice(0, Math.floor((width - 70) / 5)) : ''} x={5} y={4} />
        <SkinText text={track?.duration ? formatTime(track.duration) : ''} x={width - 30 - 25} y={4} />
        <SpriteButton up={null} down="plExpandDown" x={width - 21} y={3} width={9} height={9} label="Full size" onClick={() => setWinampPrefs({ playlistShade: false })} />
        <SpriteButton up={null} down="plCloseDown" x={width - 11} y={3} width={9} height={9} label="Close playlist" onClick={() => setWinampPrefs({ playlist: false })} />
      </div>
    );
  }

  const fill = width - 150;
  const fillEach = (width - 150) / 2;
  return (
    <div style={{ position: 'absolute', left: 0, top: y, width, height }}>
      {/* Top */}
      <Sprite name={focused ? 'plTopLeftActive' : 'plTopLeft'} x={0} y={0} {...drag} />
      <Tiles name={focused ? 'plTopTileActive' : 'plTopTile'} x={25} y={0} count={Math.ceil(fill / 25)} axis="x" />
      <Sprite name={focused ? 'plTitleActive' : 'plTitle'} x={25 + Math.floor(fillEach)} y={0} {...drag} onDoubleClick={() => setWinampPrefs({ playlistShade: true })} />
      <Sprite name={focused ? 'plTopRightActive' : 'plTopRight'} x={width - 25} y={0} {...drag} />
      <div {...drag} style={{ position: 'absolute', left: 25, top: 0, width: width - 50, height: 20 }} />
      <Sprite name="plTitle" x={25 + Math.floor(fillEach)} y={0} style={{ opacity: 0, pointerEvents: 'none' }} />
      <SpriteButton up={null} down="plCollapseDown" x={width - 21} y={3} width={9} height={9} label="Windowshade mode" onClick={() => setWinampPrefs({ playlistShade: true })} />
      <SpriteButton up={null} down="plCloseDown" x={width - 11} y={3} width={9} height={9} label="Close playlist" onClick={() => setWinampPrefs({ playlist: false })} />

      {/* Sides */}
      <div style={{ position: 'absolute', left: 0, top: listTop, width: 12, height: listH, overflow: 'hidden' }}>
        <Tiles name="plLeft" x={0} y={0} count={Math.ceil(listH / 29)} axis="y" />
      </div>
      <div style={{ position: 'absolute', left: width - 20, top: listTop, width: 20, height: listH, overflow: 'hidden' }}>
        <Tiles name="plRight" x={0} y={0} count={Math.ceil(listH / 29)} axis="y" />
        <div {...scrollDrag.handlers} role="scrollbar" aria-controls="winamp-playlist" aria-valuenow={top} aria-valuemax={maxScroll} style={{ position: 'absolute', left: 5, top: 0, width: 8, height: listH }}>
          <Sprite name={scrollDrag.active ? 'plScrollDown' : 'plScroll'} x={0} y={maxScroll > 0 ? Math.round((top / maxScroll) * (listH - 18)) : 0} />
        </div>
      </div>

      {/* Tracks */}
      <div
        id="winamp-playlist"
        ref={listRef}
        role="listbox"
        aria-label="Playlist"
        aria-multiselectable
        tabIndex={0}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => setScroll(Math.max(0, Math.min(maxScroll, top + (e.deltaY > 0 ? 3 : -3))))}
        onKeyDown={(e) => {
          if (e.key === 'Delete') {
            player.remove(selected);
            setSelected(new Set());
          } else if (e.key === 'a' && e.ctrlKey) {
            e.preventDefault();
            setSelected(new Set(queue.map((t) => t.key)));
          } else if (e.key === 'Enter') {
            const i = queue.findIndex((t) => selected.has(t.key));
            if (i >= 0) player.playIndex(i);
          }
        }}
        style={{
          position: 'absolute', left: 12, top: listTop, width: width - 32, height: listH, background: colors.normalBg, overflow: 'hidden',
          fontFamily: `"${colors.font}", Arial, sans-serif`, fontSize: 9, lineHeight: '13px', letterSpacing: 0.5, outline: 'none', paddingTop: 3,
        }}
      >
        {queue.slice(top, top + rows + 1).map((t, n) => {
          const i = top + n;
          const sel = selected.has(t.key);
          return (
            <div
              key={t.key}
              role="option"
              aria-selected={sel}
              onClick={(e) => {
                if (e.ctrlKey) {
                  const next = new Set(selected);
                  if (next.has(t.key)) next.delete(t.key);
                  else next.add(t.key);
                  setSelected(next);
                } else if (e.shiftKey && selected.size > 0) {
                  const first = queue.findIndex((q) => selected.has(q.key));
                  const [lo, hi] = first < i ? [first, i] : [i, first];
                  setSelected(new Set(queue.slice(lo, hi + 1).map((q) => q.key)));
                } else setSelected(new Set([t.key]));
              }}
              onDoubleClick={() => player.playIndex(i)}
              style={{ display: 'flex', height: 13, paddingLeft: 3, paddingRight: 3, color: i === current ? colors.current : colors.normal, background: sel ? colors.selectedBg : undefined, whiteSpace: 'nowrap', cursor: 'default' }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{i + 1}. {displayTitle(t)}</span>
              <span style={{ paddingLeft: 4 }}>{t.duration ? formatTime(t.duration) : ''}</span>
            </div>
          );
        })}
      </div>

      {/* Bottom */}
      <div style={{ position: 'absolute', left: 0, top: height - 38, width, height: 38 }}>
        <Tiles name="plBottomTile" x={125} y={0} count={Math.ceil((width - 275) / 25)} axis="x" />
        {width >= 350 && <Sprite name="plVisBg" x={width - 225} y={0} />}
        <Sprite name="plBottomLeft" x={0} y={0} />
        <Sprite name="plBottomRight" x={width - 150} y={0} />
        <PlMenu which="add" x={14} y={8} actions={[() => void commands.openUrl(), () => void commands.openFolder('enqueue'), () => void commands.openFiles('enqueue')]} />
        <PlMenu
          which="rem"
          x={43}
          y={8}
          actions={[
            () => player.removeFailed(),
            () => player.clear(),
            () => player.crop(selected),
            () => {
              player.remove(selected);
              setSelected(new Set());
            },
          ]}
        />
        <PlMenu
          which="sel"
          x={72}
          y={8}
          actions={[
            () => setSelected(new Set(queue.filter((t) => !selected.has(t.key)).map((t) => t.key))),
            () => setSelected(new Set()),
            () => setSelected(new Set(queue.map((t) => t.key))),
          ]}
        />
        <PlMenu which="misc" x={101} y={8} actions={[() => player.sort('title'), () => setPrefs({ skin: { kind: 'din' }, tab: 'now-playing' }), () => player.sort('random')]} />
        <PlMenu which="list" x={width - 44} y={8} actions={[() => player.clear(), () => void commands.savePlaylist(), () => void commands.openFiles('play')]} />
        <SkinText text={`${formatTime(selectedTotal)}/${formatTime(total)}`.slice(0, 15)} x={width - 143} y={10} />
        {(['previous', 'play', 'pause', 'stop', 'next', 'eject'] as const).map((what, i) => (
          <button
            key={what}
            type="button"
            aria-label={what}
            title={what}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => (what === 'eject' ? void commands.openFiles('play') : what === 'pause' ? player.toggle() : player[what]())}
            style={{ position: 'absolute', left: width - 147 + [0, 8, 18, 28, 38, 47][i], top: 22, width: [8, 10, 10, 10, 9, 9][i], height: 10, background: 'transparent' }}
          />
        ))}
        <SkinText text={current >= 0 ? formatTime(position).padStart(5, ' ') : ''} x={width - 84} y={23} />
        <div
          aria-label="Resize playlist"
          role="separator"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            resizing.current = { x: e.clientX, y: e.clientY, w: prefs.playlistW, h: prefs.playlistH };
          }}
          onPointerMove={(e) => {
            const r = resizing.current;
            if (!r) return;
            const w = Math.max(0, r.w + Math.round((e.clientX - r.x) / (25 * scale)));
            const h = Math.max(0, r.h + Math.round((e.clientY - r.y) / (29 * scale)));
            if (w !== prefs.playlistW || h !== prefs.playlistH) setWinampPrefs({ playlistW: w, playlistH: h });
          }}
          onPointerUp={() => (resizing.current = null)}
          style={{ position: 'absolute', right: 0, bottom: 0, width: 20, height: 20, cursor: 'nwse-resize' }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OptionsMenu({ commands, at, onClose }: { commands: Commands; at: { x: number; y: number } | null; onClose: () => void }) {
  const prefs = usePrefs((p) => p.winamp);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  return (
    <DropdownMenu open={at !== null} onOpenChange={(o) => !o && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden style={{ position: 'fixed', left: at?.x ?? 0, top: at?.y ?? 0, width: 1, height: 1 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuItem onSelect={() => void commands.openFiles('play')}>Play File…<DropdownMenuShortcut>L</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.openFolder('play')}>Play Folder…<DropdownMenuShortcut>Shift+L</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.openUrl()}>Play URL…<DropdownMenuShortcut>Ctrl+L</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={prefs.eq} onCheckedChange={(v) => setWinampPrefs({ eq: v })}>Equalizer<DropdownMenuShortcut>Alt+G</DropdownMenuShortcut></DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.playlist} onCheckedChange={(v) => setWinampPrefs({ playlist: v })}>Playlist Editor<DropdownMenuShortcut>Alt+E</DropdownMenuShortcut></DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.mainShade} onCheckedChange={(v) => setWinampPrefs({ mainShade: v })}>Windowshade Mode</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={prefs.double} onCheckedChange={(v) => setWinampPrefs({ double: v })}>Double Size<DropdownMenuShortcut>Ctrl+D</DropdownMenuShortcut></DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Skins</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'din' }, tab: 'skins' })}>Skin Browser…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.loadSkin()}>Load Skin File…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'winamp', path: '' } })}>Din Classic</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'din' } })}>Back to Din’s Skin</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Playback</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onSelect={() => player.previous()}>Previous<DropdownMenuShortcut>Z</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => player.play()}>Play<DropdownMenuShortcut>X</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => player.toggle()}>Pause<DropdownMenuShortcut>C</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => player.stop()}>Stop<DropdownMenuShortcut>V</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => player.next()}>Next<DropdownMenuShortcut>B</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => player.seekBy(-5)}>Back 5 Seconds<DropdownMenuShortcut>←</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => player.seekBy(5)}>Forward 5 Seconds<DropdownMenuShortcut>→</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={repeat !== 'off'} onCheckedChange={(v) => player.setRepeat(v ? 'all' : 'off')}>Repeat<DropdownMenuShortcut>R</DropdownMenuShortcut></DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={shuffle} onCheckedChange={(v) => player.setShuffle(v)}>Shuffle<DropdownMenuShortcut>S</DropdownMenuShortcut></DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Visualization</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={String(prefs.vis)} onValueChange={(v) => setWinampPrefs({ vis: Number(v) })}>
              <DropdownMenuRadioItem value="1">Spectrum Analyzer</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="2">Oscilloscope</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="0">Off</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem checked={prefs.remaining} onCheckedChange={(v) => setWinampPrefs({ remaining: v })}>Time Remaining</DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={commands.close}>Exit</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Winamp 2's three windows, docked in a column, wearing a classic skin. */
export function WinampPlayer({ skin, commands }: { skin: WinampSkin; commands: Commands }) {
  const prefs = usePrefs((p) => p.winamp);
  const layout = winampLayout(prefs, skin);
  const scale = prefs.double ? 2 : 1;
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onMenu = (e: React.MouseEvent) => {
    e.preventDefault?.();
    const rect = rootRef.current?.getBoundingClientRect();
    setMenuAt(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: (rect?.left ?? 0) + 6 * scale, y: (rect?.top ?? 0) + 14 * scale });
  };
  return (
    <SkinContext.Provider value={skin}>
      <div ref={rootRef} style={{ width: layout.width * scale, height: layout.height * scale, overflow: 'hidden' }} className="select-none">
        <div style={{ position: 'relative', width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: '0 0', imageRendering: 'pixelated' }}>
          <MainWindow y={0} commands={commands} onMenu={onMenu} />
          {prefs.eq && <EqWindow y={layout.mainH} commands={commands} />}
          {prefs.playlist && <PlaylistWindow y={layout.mainH + layout.eqH} width={layout.plW} height={layout.plH} commands={commands} />}
        </div>
      </div>
      <OptionsMenu commands={commands} at={menuAt} onClose={() => setMenuAt(null)} />
    </SkinContext.Provider>
  );
}
