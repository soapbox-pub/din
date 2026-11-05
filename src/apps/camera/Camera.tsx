import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Camera as CameraIcon, ChevronLeft, ChevronRight, Grid2x2, MoreHorizontal, Play, RotateCcw, Settings2, Sparkles, Square, Video } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { appLink, onLaunch, wasReopened, windowLaunch, type Launch } from '@/shared/launch';
import { CENTERED_EFFECTS, EFFECT_PAGES, effectById, pageOf } from '@/shared/cameraEffects';
import type { Menu, MenuItem } from '@/sdk/din';
import { useCloseGuard, useDin, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { itemEntries, type ItemAction } from './actions';
import { ItemContextItems, ItemDropdownItems } from './items';
import { stampedName, useLibrary, type CameraItem } from './library';
import { deviceName, useDevices, useStream } from './media';
import { createRenderer, type Renderer } from './renderer';
import { useCameraSettings, type CameraMode } from './settings';
import { beep, shutter } from './sound';

type Phase = 'idle' | 'countdown' | 'shooting' | 'recording' | 'saving';

/** What Camera was asked to do from outside (`din camera`). */
interface Action {
  action: 'take' | 'record' | 'stop';
  nonce: unknown;
  mode?: 'photo' | 'four-up';
  effect?: string;
  countdown?: boolean;
}

function actionOf({ params }: Pick<Launch, 'params'>, reopened = false): Action | null {
  // A window Din reopens keeps its last params: what they asked for was done then.
  if (reopened) return null;
  const { action, nonce } = params;
  if (action !== 'take' && action !== 'record' && action !== 'stop') return null;
  return {
    action,
    nonce,
    mode: params.mode === 'four-up' ? 'four-up' : params.mode === 'photo' ? 'photo' : undefined,
    effect: typeof params.effect === 'string' ? params.effect : undefined,
    countdown: typeof params.countdown === 'boolean' ? params.countdown : undefined,
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MODES: { value: CameraMode; label: string; icon: typeof CameraIcon }[] = [
  { value: 'photo', label: 'Take a photo', icon: CameraIcon },
  { value: 'four-up', label: 'Take four photos', icon: Grid2x2 },
  { value: 'video', label: 'Record a video', icon: Video },
];

const ROUND =
  'grid size-10 shrink-0 place-items-center rounded-full text-white/80 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-40';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fileUrl(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Four frames as one picture, two by two, at the size of one. */
async function fourUp(frames: ImageBitmap[]): Promise<Blob> {
  const { width, height } = frames[0]!;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  const gap = Math.round(width / 160);
  const w = (width - gap) / 2;
  const h = (height - gap) / 2;
  frames.forEach((frame, i) => ctx.drawImage(frame, (i % 2) * (w + gap), Math.floor(i / 2) * (h + gap), w, h));
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the picture'))), 'image/jpeg', 0.92));
}

/**
 * Camera: photos and videos of yourself from the computer's camera, with
 * effects, a countdown and a flash. Photo Booth's idea: the live picture
 * fills the window, the shutter is one big button, and what's taken lines up
 * in a strip underneath, kept in ~/Pictures/Camera.
 */
export function Camera() {
  const din = useDin();
  const library = useLibrary(din.system.fs);
  const [settings, update] = useCameraSettings();
  const devices = useDevices();

  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState<number | null>(null);
  const [shot, setShot] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [effectsOpen, setEffectsOpen] = useState(false);
  const [page, setPage] = useState(() => pageOf(settings.effect));
  const [center, setCenter] = useState({ x: 0.5, y: 0.5 });
  const [recordStart, setRecordStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [retry, setRetry] = useState(0);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [glError, setGlError] = useState<string | null>(null);

  // The camera runs while the window is seen, and a little after, so
  // flicking away and back doesn't restart it; and always while taking.
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') setAsleep(false);
      else timer = setTimeout(() => setAsleep(true), 20_000);
    };
    document.addEventListener('visibilitychange', changed);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', changed);
    };
  }, []);
  const running = !asleep || phase !== 'idle';

  const cam = useStream(
    running ? `camera:${settings.cameraId ?? ''}:${retry}` : null,
    () =>
      navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: settings.cameraId ? { ideal: settings.cameraId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      }),
    'camera',
  );
  const mic = useStream(
    running && settings.mode === 'video' ? `mic:${settings.micId ?? ''}` : null,
    () => navigator.mediaDevices.getUserMedia({ audio: { deviceId: settings.micId ? { ideal: settings.micId } : undefined, echoCancellation: false }, video: false }),
    'microphone',
  );

  // A camera plugged in after one wasn't found, or came back.
  const camError = useRef(cam.error);
  useEffect(() => {
    camError.current = cam.error;
  }, [cam.error]);
  useEffect(() => {
    const plugged = () => camError.current && setRetry((n) => n + 1);
    navigator.mediaDevices.addEventListener('devicechange', plugged);
    return () => navigator.mediaDevices.removeEventListener('devicechange', plugged);
  }, []);

  // ---- drawing ----
  const videoRef = useRef<HTMLVideoElement>(null);
  const renderer = useRef<Renderer | null>(null);
  /** Whether effects can be drawn here (WebGL 2). */
  const [canEffect, setCanEffect] = useState(true);
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas) return;
    try {
      renderer.current = createRenderer(canvas);
      setCanEffect(renderer.current.effects);
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);

  const effect = effectById(settings.effect);
  const grid = useMemo(() => (effectsOpen ? EFFECT_PAGES[page]!.map((e) => e.code) : null), [effectsOpen, page]);
  const drawOptions = useRef({ effect: effect.code, grid, mirror: settings.mirror, center });
  useEffect(() => {
    drawOptions.current = { effect: effect.code, grid, mirror: settings.mirror, center };
  }, [effect.code, grid, settings.mirror, center]);

  // Live once the camera's first frame is drawn.
  const [drawn, setDrawn] = useState<MediaStream | null>(null);
  const live = !!cam.stream && drawn === cam.stream;
  useEffect(() => {
    const video = videoRef.current;
    const stream = cam.stream;
    if (!video) return;
    video.srcObject = stream;
    if (!stream) return;
    void video.play().catch(() => {});
    let handle = 0;
    let stopped = false;
    let shown = false;
    const frame = () => {
      if (stopped) return;
      if (renderer.current?.draw(video, drawOptions.current) && !shown) {
        shown = true;
        setDrawn(stream);
        setSize({ width: video.videoWidth, height: video.videoHeight });
      }
      handle = video.requestVideoFrameCallback(frame);
    };
    handle = video.requestVideoFrameCallback(frame);
    const resized = () => video.videoWidth && setSize({ width: video.videoWidth, height: video.videoHeight });
    video.addEventListener('resize', resized);
    return () => {
      stopped = true;
      video.cancelVideoFrameCallback(handle);
      video.removeEventListener('resize', resized);
    };
  }, [cam.stream]);

  // ---- taking ----
  const cancelled = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);

  /** Draw the picture now (without the grid) and keep it. */
  const grab = useCallback(async (): Promise<ImageBitmap> => {
    const r = renderer.current;
    const video = videoRef.current;
    if (!r || !video || !r.draw(video, { ...drawOptions.current, grid: null })) throw new Error('The camera isn’t ready');
    return createImageBitmap(r.canvas);
  }, []);

  const exposure = useCallback(async (): Promise<ImageBitmap> => {
    if (settings.flash) {
      setFlash(true);
      // Long enough for the white screen to light the face before the frame is kept.
      await wait(160);
    }
    if (settings.sound) shutter();
    try {
      return await grab();
    } finally {
      setFlash(false);
    }
  }, [grab, settings.flash, settings.sound]);

  const countDown = useCallback(
    async (on: boolean): Promise<boolean> => {
      if (!on) return true;
      setPhase('countdown');
      for (const n of [3, 2, 1]) {
        if (cancelled.current) break;
        setCount(n);
        if (settings.sound) beep();
        await wait(1000);
      }
      setCount(null);
      return !cancelled.current;
    },
    [settings.sound],
  );

  const failed = useCallback((what: string) => (e: unknown) => {
    setNotice(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    setPhase('idle');
    setShot(null);
  }, []);

  const toBlob = (bitmap: ImageBitmap): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t make the picture'))), 'image/jpeg', 0.92));
  };

  const stopRecording = useCallback(() => {
    const rec = recorder.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  }, []);

  const take = useCallback(
    async ({ mode = settings.mode, countdown = settings.countdown }: { mode?: CameraMode; countdown?: boolean } = {}) => {
      if (phase === 'recording') {
        stopRecording();
        return;
      }
      if (phase !== 'idle') {
        // Pressed again during the countdown: stop.
        if (phase === 'countdown') cancelled.current = true;
        return;
      }
      if (!live) return;
      cancelled.current = false;
      setSelected(null);
      setEffectsOpen(false);
      setNotice(null);
      if (!(await countDown(countdown))) {
        setPhase('idle');
        return;
      }
      if (mode === 'video') {
        const canvas = renderer.current?.canvas;
        if (!canvas) return;
        const stream = canvas.captureStream(30);
        for (const track of mic.stream?.getAudioTracks() ?? []) stream.addTrack(track);
        const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
        const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
        const chunks: Blob[] = [];
        const name = stampedName('Video');
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        rec.onstop = () => {
          for (const track of stream.getVideoTracks()) track.stop();
          recorder.current = null;
          setRecordStart(null);
          setPhase('saving');
          library
            .save(name, 'webm', new Blob(chunks, { type: 'video/webm' }))
            .then(() => setPhase('idle'), failed('Couldn’t save the video'));
        };
        recorder.current = rec;
        rec.start(1000);
        if (settings.sound) beep(true);
        setRecordStart(Date.now());
        setPhase('recording');
        return;
      }
      setPhase('shooting');
      try {
        if (mode === 'four-up') {
          const frames: ImageBitmap[] = [];
          for (let i = 0; i < 4; i++) {
            setShot(i + 1);
            if (i > 0) await wait(650);
            frames.push(await exposure());
          }
          setShot(null);
          setPhase('saving');
          await library.save(stampedName('Photo'), 'jpg', await fourUp(frames));
          for (const f of frames) f.close();
        } else {
          const frame = await exposure();
          setPhase('saving');
          await library.save(stampedName('Photo'), 'jpg', await toBlob(frame));
          frame.close();
        }
        setPhase('idle');
      } catch (e) {
        failed('Couldn’t take the photo')(e);
      }
    },
    [settings.mode, settings.countdown, settings.sound, phase, live, countDown, exposure, mic.stream, library, failed, stopRecording],
  );

  // Recording's clock.
  useEffect(() => {
    if (recordStart === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [recordStart]);

  // Closing mid-recording would lose it.
  useCloseGuard(phase === 'recording' || phase === 'saving' ? () => true : null);

  // ---- asked from outside ----
  const handled = useRef<unknown>(null);
  const pending = useRef<Action | null>(null);
  const latest = useRef({ take, stopRecording, update, phase, live });
  useEffect(() => {
    latest.current = { take, stopRecording, update, phase, live };
  });
  const runPending = useCallback(() => {
    const a = pending.current;
    const l = latest.current;
    if (!a) return;
    if (a.action === 'stop') {
      pending.current = null;
      if (l.phase === 'recording') l.stopRecording();
      return;
    }
    if (!l.live || l.phase !== 'idle') return;
    pending.current = null;
    void l.take({ mode: a.action === 'record' ? 'video' : (a.mode ?? 'photo'), countdown: a.countdown });
  }, []);
  const perform = useCallback(
    (a: Action | null) => {
      if (!a || a.nonce === undefined || handled.current === a.nonce) return;
      handled.current = a.nonce;
      const change: Parameters<typeof update>[0] = {};
      if (a.effect) change.effect = effectById(a.effect).id;
      if (a.action === 'record') change.mode = 'video';
      else if (a.action === 'take') change.mode = a.mode ?? 'photo';
      if (Object.keys(change).length) latest.current.update(change);
      pending.current = a;
      // Once the microphone's up, for a video.
      setTimeout(runPending, a.action === 'record' ? 600 : 0);
    },
    [runPending],
  );
  useEffect(() => perform(actionOf(windowLaunch(), wasReopened())), [perform]);
  useEffect(() => onLaunch((launch) => perform(actionOf(launch))), [perform]);
  useEffect(() => {
    if (live && phase === 'idle') runPending();
  }, [live, phase, runPending]);

  // ---- what's been taken ----
  const items = library.items;
  const current = selected ? (items.find((i) => i.path === selected) ?? null) : null;
  const strip = useRef<HTMLDivElement>(null);
  const count_ = items.length;
  useEffect(() => {
    // The newest is at the end: keep it in view as more come.
    strip.current?.scrollTo({ left: strip.current.scrollWidth, behavior: 'smooth' });
  }, [count_]);

  const handleFor = useCallback((path: string) => din.files.fromPath(path), [din]);

  const itemAction = useCallback(
    (item: CameraItem, action: ItemAction) => {
      const fail = (what: string) => (e: unknown) => setNotice(`${what}: ${e instanceof Error ? e.message : String(e)}`);
      switch (action) {
        case 'open':
          void handleFor(item.path)
            .then((h) => din.app.openFiles([h]))
            .catch(fail('Couldn’t open it'));
          break;
        case 'edit':
          void handleFor(item.path)
            .then((h) => din.app.launch(appLink('photo-editor'), [h]))
            .catch(fail('Couldn’t open it'));
          break;
        case 'show':
          if (!library.dir) return;
          void handleFor(library.dir)
            .then((h) => din.app.launch(appLink('file-browser', { select: item.name }), [h]))
            .catch(fail('Couldn’t show it'));
          break;
        case 'copy':
          void fetch(din.files.pathUrl(item.path))
            .then((r) => r.blob())
            .then(createImageBitmap)
            .then(async (bitmap) => {
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
              const png = await canvas.convertToBlob({ type: 'image/png' });
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
            })
            .catch(fail('Couldn’t copy it'));
          break;
        case 'trash': {
          const at = items.findIndex((i) => i.path === item.path);
          void library.trash(item).then(() => {
            if (selected === item.path) {
              const next = items[at + 1] ?? items[at - 1];
              setSelected(next ? next.path : null);
            }
          }, fail('Couldn’t move it to the Trash'));
          break;
        }
      }
    },
    [din, handleFor, items, library, selected],
  );

  const step = useCallback(
    (delta: number) => {
      if (!items.length) return;
      const at = current ? items.indexOf(current) : items.length;
      const next = items[Math.min(items.length - 1, Math.max(0, at + delta))];
      if (next) setSelected(next.path);
    },
    [items, current],
  );

  const backToCamera = useCallback(() => {
    setSelected(null);
    setEffectsOpen(false);
  }, []);

  const pickEffect = useCallback(
    (id: string) => {
      update({ effect: id });
      setCenter({ x: 0.5, y: 0.5 });
      setEffectsOpen(false);
    },
    [update],
  );

  const toggleEffects = useCallback(() => {
    if (phase !== 'idle' || !canEffect) return;
    setSelected(null);
    setEffectsOpen((open) => {
      if (!open) setPage(pageOf(settings.effect));
      return !open;
    });
  }, [phase, settings.effect, canEffect]);

  // Keys the menu bar doesn't carry: Escape and the arrows.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [role="menu"], video')) return;
      if (e.key === 'Escape') {
        if (phase === 'countdown') cancelled.current = true;
        else if (effectsOpen || current) backToCamera();
        else return;
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (effectsOpen) {
          if (target?.closest('[data-effect-cell]')) return;
          setPage((p) => (p + (e.key === 'ArrowRight' ? 1 : EFFECT_PAGES.length - 1)) % EFFECT_PAGES.length);
        } else if (current) step(e.key === 'ArrowRight' ? 1 : -1);
        else return;
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, effectsOpen, current, backToCamera, step]);

  // ---- the menu bar ----
  const busy = phase !== 'idle';
  const shutterLabel = phase === 'recording' ? 'Stop Recording' : settings.mode === 'video' ? 'Start Recording' : settings.mode === 'four-up' ? 'Take Four Photos' : 'Take Photo';
  const menus = useMemo((): Menu[] => {
    const itemMenu: MenuItem[] = current
      ? itemEntries(current).flatMap((e): MenuItem[] => [
          ...(e.separated ? [{ type: 'separator' as const }] : []),
          {
            id: `item:${e.id}`,
            label: e.label,
            destructive: e.destructive,
            accelerator: e.id === 'trash' ? 'Delete' : e.id === 'open' ? 'Ctrl+O' : undefined,
            notInFields: e.id === 'trash',
          },
        ])
      : [];
    return [
      {
        label: 'File',
        items: [
          { id: 'take', label: shutterLabel, accelerator: 'Ctrl+T', enabled: live && (phase === 'idle' || phase === 'recording') },
          { type: 'separator' },
          ...itemMenu.filter((m) => !('id' in m) || m.id !== 'item:copy'),
        ],
      },
      { label: 'Edit', items: [{ id: 'item:copy', label: 'Copy', accelerator: 'Ctrl+C', notInFields: true, enabled: current?.kind === 'photo' }] },
      {
        label: 'View',
        items: [
          { id: 'effects', type: 'checkbox', checked: effectsOpen, label: 'Show Effects', accelerator: 'Ctrl+E', enabled: !busy && canEffect },
          { id: 'next-page', label: 'Next Effects Page', enabled: effectsOpen },
          { id: 'previous-page', label: 'Previous Effects Page', enabled: effectsOpen },
          { id: 'normal', label: 'No Effect', accelerator: 'Ctrl+Shift+E', enabled: canEffect && settings.effect !== 'normal' },
          { type: 'separator' },
          { id: 'camera', label: 'Back to Camera', enabled: !!current || effectsOpen },
          { id: 'previous', label: 'Previous Photo', enabled: items.length > 0 },
          { id: 'next', label: 'Next Photo', enabled: !!current },
        ],
      },
      {
        label: 'Camera',
        items: [
          ...MODES.map((m, i): MenuItem => ({ id: `mode:${m.value}`, type: 'radio', group: 'mode', checked: settings.mode === m.value, label: m.label, accelerator: `Ctrl+${i + 1}`, enabled: !busy })),
          { type: 'separator' },
          { id: 'mirror', type: 'checkbox', checked: settings.mirror, label: 'Mirror' },
          { id: 'countdown', type: 'checkbox', checked: settings.countdown, label: 'Count Down' },
          { id: 'flash', type: 'checkbox', checked: settings.flash, label: 'Flash the Screen' },
          { id: 'sound', type: 'checkbox', checked: settings.sound, label: 'Sounds' },
          ...(devices.cameras.length > 1
            ? [
                { type: 'separator' as const },
                { type: 'label' as const, label: 'Camera' },
                ...devices.cameras.map((d, i): MenuItem => ({
                  id: `device:${d.deviceId}`,
                  type: 'radio',
                  group: 'device',
                  checked: (settings.cameraId ?? devices.cameras[0]?.deviceId) === d.deviceId,
                  label: deviceName(d, `Camera ${i + 1}`),
                  enabled: phase !== 'recording',
                })),
              ]
            : []),
        ],
      },
    ];
  }, [current, shutterLabel, live, phase, busy, effectsOpen, settings, items.length, devices.cameras, canEffect]);

  useMenuBar(menus, (id) => {
    if (id === 'take') void take();
    else if (id === 'effects') toggleEffects();
    else if (id === 'next-page') setPage((p) => (p + 1) % EFFECT_PAGES.length);
    else if (id === 'previous-page') setPage((p) => (p + EFFECT_PAGES.length - 1) % EFFECT_PAGES.length);
    else if (id === 'normal') pickEffect('normal');
    else if (id === 'camera') backToCamera();
    else if (id === 'previous') step(-1);
    else if (id === 'next') step(1);
    else if (id === 'mirror') update({ mirror: !settings.mirror });
    else if (id === 'countdown') update({ countdown: !settings.countdown });
    else if (id === 'flash') update({ flash: !settings.flash });
    else if (id === 'sound') update({ sound: !settings.sound });
    else if (id.startsWith('mode:')) update({ mode: id.slice(5) as CameraMode });
    else if (id.startsWith('device:')) update({ cameraId: id.slice(7) });
    else if (id.startsWith('item:') && current) itemAction(current, id.slice(5) as ItemAction);
  });

  useWindowTitle(phase === 'recording' && recordStart !== null ? `Recording ${formatElapsed(now - recordStart)}` : current ? current.name : null);

  // ---- moving a bending effect's middle ----
  const dragging = useRef(false);
  const centered = canEffect && CENTERED_EFFECTS.has(settings.effect) && !effectsOpen && !current;
  const moveCenter = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCenter({ x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) });
  };

  const error = glError ?? cam.error;
  const ratio = size ? size.width / size.height : 16 / 9;
  const recording = phase === 'recording';

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-white select-none">
      <WindowDragRegion className="flex h-10 shrink-0 items-center gap-2 pl-4">
        <span className="flex-1 truncate text-sm font-medium text-white/70">Camera</span>
        <WindowControls />
      </WindowDragRegion>

      {/* The stage: the live picture, the effects grid, or something taken. */}
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!!current}>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-2" style={{ containerType: 'size' }}>
            <div
              className={cn('relative overflow-hidden rounded-xl bg-black shadow-lg shadow-black/40', centered && 'cursor-crosshair')}
              style={{ width: `min(100cqw, calc(100cqh * ${ratio}))`, aspectRatio: ratio }}
              onPointerDown={(e) => {
                if (!centered || e.button !== 0) return;
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                moveCenter(e);
              }}
              onPointerMove={(e) => dragging.current && moveCenter(e)}
              onPointerUp={() => (dragging.current = false)}
              onDoubleClick={() => centered && setCenter({ x: 0.5, y: 0.5 })}
            >
              <video ref={videoRef} className="hidden" muted playsInline />
              <canvas ref={canvasRef} className={cn('size-full', (current || !live) && 'invisible')} aria-label={canEffect && effect.id !== 'normal' ? `The camera’s picture, ${effect.name}` : 'The camera’s picture'} role="img" />

              {!live && !current && (
                <div className="absolute inset-0 grid place-items-center p-8 text-center">
                  {error ? (
                    <div className="max-w-sm space-y-4">
                      <CameraIcon className="mx-auto size-10 text-white/40" aria-hidden />
                      <p className="text-base text-white/80">{error}</p>
                      {!glError && (
                        <button type="button" className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 outline-none" onClick={() => setRetry((n) => n + 1)}>
                          <RotateCcw className="size-4" aria-hidden /> Try Again
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="size-10 rounded-full border-2 border-white/20 border-t-white/70 motion-safe:animate-spin" role="status" aria-label="Starting the camera" />
                  )}
                </div>
              )}

              {effectsOpen && live && (
                <div className="absolute inset-0 grid grid-cols-3 grid-rows-3" role="radiogroup" aria-label={`Effects, page ${page + 1} of ${EFFECT_PAGES.length}`}>
                  {EFFECT_PAGES[page]!.map((e, i) => (
                    <button
                      key={`${page}-${i}`}
                      type="button"
                      role="radio"
                      aria-checked={e.id === settings.effect}
                      data-effect-cell
                      autoFocus={e.id === settings.effect || (i === 4 && !EFFECT_PAGES[page]!.some((x) => x.id === settings.effect))}
                      className={cn(
                        'group relative m-[3px] flex items-end justify-center rounded-md pb-2 outline-none',
                        'ring-inset hover:ring-2 hover:ring-white/50 focus-visible:ring-2 focus-visible:ring-white',
                        e.id === settings.effect && 'ring-2 ring-sky-400',
                      )}
                      onClick={() => pickEffect(e.id)}
                    >
                      <span className="rounded-full bg-black/55 px-2.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm sm:text-sm">{e.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {current && (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="absolute inset-0 grid place-items-center bg-black">
                      {current.kind === 'photo' ? (
                        <img key={current.path} src={din.files.pathUrl(current.path)} alt={current.name} className="size-full object-contain" draggable={false} />
                      ) : (
                        <video key={current.path} src={din.files.pathUrl(current.path)} className="size-full object-contain" controls autoPlay />
                      )}
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-56">
                    <ItemContextItems item={current} onAction={itemAction} />
                  </ContextMenuContent>
                </ContextMenu>
              )}

              {count !== null && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-live="assertive">
                  <span key={count} className="grid size-32 place-items-center rounded-full bg-black/40 text-7xl font-semibold tabular-nums text-white backdrop-blur-sm motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in">
                    {count}
                  </span>
                </div>
              )}
              {shot !== null && (
                <span className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-sm font-medium tabular-nums">
                  {shot} of 4
                </span>
              )}
              {recording && recordStart !== null && (
                <span className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1 text-sm font-medium tabular-nums">
                  <span className="size-2.5 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden />
                  {formatElapsed(now - recordStart)}
                </span>
              )}
              {centered && live && settings.effect !== 'normal' && phase === 'idle' && (
                <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1 text-xs text-white/80">Drag to move the effect</span>
              )}
            </div>
            {notice && (
              <button type="button" className="absolute top-2 left-1/2 max-w-[90%] -translate-x-1/2 rounded-lg bg-red-600/90 px-3 py-1.5 text-sm text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-white" onClick={() => setNotice(null)}>
                {notice}
              </button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem disabled={!live || (phase !== 'idle' && phase !== 'recording')} onSelect={() => void take()}>
            <CameraIcon /> {shutterLabel}
          </ContextMenuItem>
          <ContextMenuItem disabled={busy || !canEffect} onSelect={toggleEffects}>
            <Sparkles /> {effectsOpen ? 'Hide Effects' : 'Show Effects'}
          </ContextMenuItem>
          <ContextMenuItem disabled={!canEffect || settings.effect === 'normal'} onSelect={() => pickEffect('normal')}>
            No Effect
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuCheckboxItem checked={settings.mirror} onCheckedChange={(v) => update({ mirror: v === true })}>
            Mirror
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked={settings.countdown} onCheckedChange={(v) => update({ countdown: v === true })}>
            Count Down
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem checked={settings.flash} onCheckedChange={(v) => update({ flash: v === true })}>
            Flash the Screen
          </ContextMenuCheckboxItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* The controls. */}
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-1">
          {current ? (
            <button type="button" className="inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm text-white/85 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70" onClick={backToCamera}>
              <ChevronLeft className="size-4" aria-hidden /> Camera
            </button>
          ) : (
            <div role="radiogroup" aria-label="What to take" className="inline-flex items-center gap-0.5 rounded-full bg-white/10 p-1">
              {MODES.map((m) => {
                const Icon = m.icon;
                const on = settings.mode === m.value;
                return (
                  <Tooltip key={m.value}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={m.label}
                        disabled={busy}
                        className={cn('grid size-8 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-50', on ? 'bg-white text-neutral-900' : 'text-white/75 hover:text-white')}
                        onClick={() => update({ mode: m.value })}
                      >
                        <Icon className="size-4" aria-hidden />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{m.label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          )}
        </div>

        {/* The shutter. */}
        {current ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Back to the camera" className="grid size-14 place-items-center rounded-full bg-white/10 text-white outline-none ring-2 ring-white/30 hover:bg-white/20 focus-visible:ring-white" onClick={backToCamera}>
                <CameraIcon className="size-6" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Back to the camera</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={phase === 'countdown' ? 'Stop the countdown' : shutterLabel}
                disabled={!live || phase === 'shooting' || phase === 'saving'}
                className={cn(
                  'grid size-14 place-items-center rounded-full outline-none ring-4 ring-white/85 ring-offset-2 ring-offset-neutral-950 transition-transform focus-visible:ring-sky-400 active:scale-95 disabled:opacity-50',
                  'bg-red-600 hover:bg-red-500',
                )}
                onClick={(e) => void take({ countdown: e.shiftKey ? false : settings.countdown })}
              >
                {recording ? (
                  <Square className="size-5 fill-white text-white" aria-hidden />
                ) : settings.mode === 'video' ? (
                  <span className="size-5 rounded-full bg-white" aria-hidden />
                ) : settings.mode === 'four-up' ? (
                  <Grid2x2 className="size-6 text-white" aria-hidden />
                ) : (
                  <CameraIcon className="size-6 text-white" aria-hidden />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{phase === 'countdown' ? 'Stop the countdown' : `${shutterLabel} (Shift-click to skip the countdown)`}</TooltipContent>
          </Tooltip>
        )}

        <div className="flex min-w-0 items-center justify-end gap-1">
          {current ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className={ROUND} aria-label={current.kind === 'photo' ? 'Open in Preview' : 'Open'} onClick={() => itemAction(current, 'open')}>
                    <Play className="size-4" aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{current.kind === 'photo' ? 'Open in Preview' : 'Open'}</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={ROUND} aria-label="More">
                    <MoreHorizontal className="size-5" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-56">
                  <ItemDropdownItems item={current} onAction={itemAction} />
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              {effectsOpen && (
                <div className="flex items-center" aria-label="Effects pages">
                  <button type="button" className={cn(ROUND, 'size-8')} aria-label="Previous page of effects" onClick={() => setPage((p) => (p + EFFECT_PAGES.length - 1) % EFFECT_PAGES.length)}>
                    <ChevronLeft className="size-4" aria-hidden />
                  </button>
                  <div className="hidden items-center gap-1.5 px-1 sm:flex" aria-hidden>
                    {EFFECT_PAGES.map((_, i) => (
                      <span key={i} className={cn('size-1.5 rounded-full', i === page ? 'bg-white' : 'bg-white/30')} />
                    ))}
                  </div>
                  <button type="button" className={cn(ROUND, 'size-8')} aria-label="Next page of effects" onClick={() => setPage((p) => (p + 1) % EFFECT_PAGES.length)}>
                    <ChevronRight className="size-4" aria-hidden />
                  </button>
                </div>
              )}
              {canEffect && (
              <button
                type="button"
                aria-pressed={effectsOpen}
                disabled={busy || !live}
                className={cn(
                  'inline-flex h-10 items-center gap-1.5 rounded-full px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40',
                  effectsOpen ? 'bg-white text-neutral-900' : 'text-white/85 hover:bg-white/10',
                )}
                onClick={toggleEffects}
              >
                <Sparkles className="size-4" aria-hidden />
                <span className="hidden sm:inline">{effectsOpen || settings.effect === 'normal' ? 'Effects' : effect.name}</span>
              </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={ROUND} aria-label="Camera options">
                    <Settings2 className="size-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-64">
                  <DropdownMenuCheckboxItem checked={settings.mirror} onCheckedChange={(v) => update({ mirror: v === true })}>
                    Mirror
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={settings.countdown} onCheckedChange={(v) => update({ countdown: v === true })}>
                    Count down
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={settings.flash} onCheckedChange={(v) => update({ flash: v === true })}>
                    Flash the screen
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={settings.sound} onCheckedChange={(v) => update({ sound: v === true })}>
                    Sounds
                  </DropdownMenuCheckboxItem>
                  {devices.cameras.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Camera</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={settings.cameraId ?? devices.cameras[0]!.deviceId} onValueChange={(id) => update({ cameraId: id })}>
                        {devices.cameras.map((d, i) => (
                          <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} disabled={recording}>
                            <span className="truncate">{deviceName(d, `Camera ${i + 1}`)}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                  {settings.mode === 'video' && devices.mics.length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>Microphone</DropdownMenuLabel>
                      <DropdownMenuRadioGroup value={settings.micId ?? ''} onValueChange={(id) => update({ micId: id || null })}>
                        <DropdownMenuRadioItem value="" disabled={recording}>
                          System default
                        </DropdownMenuRadioItem>
                        {devices.mics.map((d, i) => (
                          <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} disabled={recording}>
                            <span className="truncate">{deviceName(d, `Microphone ${i + 1}`)}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      {/* What's been taken, oldest first. */}
      <div ref={strip} className="flex h-24 shrink-0 items-center gap-2 overflow-x-auto border-t border-white/10 bg-black/40 px-4" role="listbox" aria-label="Photos and videos" aria-orientation="horizontal">
        {library.loaded && items.length === 0 && <p className="w-full text-center text-sm text-white/50">Photos and videos you take appear here.</p>}
        {items.map((item) => (
          <ContextMenu key={item.path}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                role="option"
                aria-selected={item.path === selected}
                aria-label={item.name}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/uri-list', fileUrl(item.path));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className={cn(
                  'relative h-16 shrink-0 overflow-hidden rounded-md bg-white/5 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-white',
                  item.path === selected ? 'ring-2 ring-sky-400' : 'hover:ring-2 hover:ring-white/40',
                )}
                style={{ aspectRatio: ratio }}
                onClick={() => {
                  setEffectsOpen(false);
                  setSelected(item.path === selected ? null : item.path);
                }}
              >
                {item.kind === 'photo' ? (
                  <img src={din.files.pathUrl(item.path)} alt="" loading="lazy" decoding="async" className="size-full object-cover" draggable={false} />
                ) : (
                  <>
                    <video src={`${din.files.pathUrl(item.path)}#t=0.1`} preload="metadata" muted className="size-full object-cover" />
                    <span className="absolute right-1 bottom-1 grid size-5 place-items-center rounded-full bg-black/60" aria-hidden>
                      <Play className="size-3 fill-white" />
                    </span>
                  </>
                )}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ItemContextItems item={item} onAction={itemAction} />
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>

      {/* The flash: the whole window goes white, lighting the face. */}
      <div aria-hidden className={cn('pointer-events-none fixed inset-0 z-50 bg-white transition-opacity', flash ? 'opacity-100 duration-0' : 'opacity-0 duration-500 motion-reduce:duration-150')} />
    </div>
  );
}
