import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Copy,
  Download,
  FolderOpen,
  Loader2,
  Mic,
  Monitor,
  MonitorOff,
  Play,
  Save,
  Square,
  SquareDashedMousePointer,
  Video,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { CaptureOverlay, type Session } from '@/components/desktop/CaptureOverlay';
import { appForFile } from '@/lib/fileTypes';
import { getFsBridge, cleanFsError, localFileUrl, parentPath } from '@/lib/fs';
import {
  cleanScreenshotError,
  copyScreenshot,
  cropCapture,
  getScreenshotBridge,
  paintSettled,
  saveScreenshot,
  screenshotFilename,
  setScreenshotSessionActive,
  type Screenshot as Capture,
  type ViewportRect,
} from '@/lib/screenshot';
import {
  formatRecordingTime,
  getScreenRecorderBridge,
  startRecording,
  stopRecording,
  useScreenRecorder,
  type FinishedRecording,
  type RecordingAudio,
} from '@/lib/screenRecorder';

/** What to make: a still, or a video of the screen. */
const KINDS = [
  { id: 'photo', name: 'Screenshot', icon: Camera },
  { id: 'video', name: 'Recording', icon: Video },
] as const;
type Kind = (typeof KINDS)[number]['id'];

/** Capture modes: the whole desktop, or a region dragged out on it first. */
const MODES = [
  { id: 'screen', name: 'Screen', icon: Monitor },
  { id: 'area', name: 'Area', icon: SquareDashedMousePointer },
] as const;
type Mode = (typeof MODES)[number]['id'];

/** The sound a recording takes. */
const SOUNDS = [
  { id: 'none', name: 'No sound', icon: VolumeX },
  { id: 'system', name: 'Computer', icon: Volume2 },
  { id: 'microphone', name: 'Mic', icon: Mic },
] as const satisfies readonly { id: RecordingAudio; name: string; icon: LucideIcon }[];

/** Seconds to wait between selection and capture, so hover states and menus can be arranged. */
const DELAYS = [0, 3, 5] as const;
type Delay = (typeof DELAYS)[number];

/**
 * Resolve once this app's own window has finished minimizing out of view.
 * Polling the window element's computed visibility is exact where a fixed
 * timer is not: the genie timeline only starts when React commits the
 * minimized state (which can lag under load), and hands visibility back when
 * the window is fully swallowed; with reduced motion the window is hidden
 * synchronously at commit. A generous deadline guards against hanging if the
 * window was closed mid-wait.
 */
async function awaitWindowHidden(root: HTMLElement | null): Promise<void> {
  const section = root?.closest('section');
  if (section) {
    const deadline = Date.now() + 3000;
    while (getComputedStyle(section).visibility !== 'hidden' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 32));
    }
  }
  await paintSettled();
}

/** A row of mutually exclusive choices. */
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly { id: T; name: string; icon?: LucideIcon; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label={label}>
      {options.map(({ id, name, icon: Icon, disabled: off, title }) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          disabled={disabled || off}
          aria-pressed={value === id}
          title={title}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:opacity-50',
            value === id
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
          <span className="truncate">{name}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * A minimal screenshot and screen recording tool in the spirit of GNOME's: a
 * compact launcher (a screenshot or a recording; the whole screen or a
 * drag-selected area; an optional delay; for a recording, its sound), then a
 * clean preview of the shot or the video. Shots can be copied, saved to
 * ~/Pictures/Screenshots, or downloaded; recordings are saved to
 * ~/Videos/Screen Recordings as they're made. The Print Screen hotkeys don't
 * come here; they capture straight away (see ScreenshotHost).
 *
 * The app minimizes its own window and waits until it's verifiably hidden
 * (not just until a timer expires, which races the genie animation under
 * load). For a screenshot the delay counts down next, so menus and hover
 * states can still be arranged; then the desktop is captured. In area mode
 * that capture goes up frozen over the screen and the region is dragged out
 * on it, so nothing underneath moves or reacts to the drag. A recording's
 * area is picked the same way, before the delay counts down to it.
 *
 * A recording runs on after this window closes: it's main's
 * (electron/screen-recorder.mts), and the menu bar's red button stops it.
 *
 * Capture is backed by the Electron shell's screenshot bridge
 * (webContents.capturePage). Outside the shell (a plain browser) there is
 * no bridge, so the app shows a short fallback instead.
 */
export function Screenshot({ windowId }: AppComponentProps) {
  const { toast } = useToast();
  const { minimize, focus, open } = useWindowActions();
  const bridge = getScreenshotBridge();
  const fs = getFsBridge();
  const recorder = useScreenRecorder();

  const [image, setImage] = useState<Capture | null>(null);
  const [video, setVideo] = useState<FinishedRecording | null>(null);
  const [kind, setKind] = useState<Kind>('photo');
  const [mode, setMode] = useState<Mode>('area');
  const [delay, setDelay] = useState<Delay>(0);
  const [audio, setAudio] = useState<RecordingAudio>('none');
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const rootRef = useRef<HTMLDivElement>(null);
  // Mirror of "a capture session is running" for re-entrancy guards; state
  // alone can't cover the gaps between the session's async steps.
  const activeRef = useRef(false);
  // The area a recording waits to start on through the countdown.
  const recordRegion = useRef<ViewportRect | undefined>(undefined);
  // The file of the recording this window started, to show when it ends.
  const ownRecording = useRef<string | null>(null);
  const recording = kind === 'video' && recorder.available;

  const endSession = useCallback(() => {
    activeRef.current = false;
    setScreenshotSessionActive(false);
    setBusy(false);
    setSession(null);
    focus(windowId); // restore + raise our window to show the result
  }, [focus, windowId]);

  // Snapshot the desktop. In area mode the snapshot then goes up, frozen,
  // for the region to be dragged out on it.
  const shoot = useCallback(
    async (area: boolean) => {
      const b = getScreenshotBridge();
      if (!b) return endSession();
      // The countdown must be gone from the page before the snapshot.
      setSession(null);
      await paintSettled();
      try {
        const shot = await b.capture();
        if (area) {
          setSession({ phase: 'select', frozen: shot });
          return;
        }
        setImage(shot);
      } catch (e) {
        setError(cleanScreenshotError(e));
      }
      endSession();
    },
    [endSession],
  );

  // Start the recording, leaving our window down out of the video. It shows
  // again when the recording ends (see the onFinished effect).
  const record = useCallback(
    async (region: ViewportRect | undefined) => {
      setSession(null);
      await paintSettled();
      try {
        const status = await startRecording({ region, audio });
        ownRecording.current = status.recording?.path ?? null;
        activeRef.current = false;
        setScreenshotSessionActive(false);
        setBusy(false);
      } catch (e) {
        setError(cleanScreenshotError(e));
        endSession();
      }
    },
    [audio, endSession],
  );

  const cancelSession = useCallback(() => {
    if (activeRef.current) endSession();
  }, [endSession]);

  const startSession = useCallback(
    async (m: Mode) => {
      if (activeRef.current || !getScreenshotBridge()) return;
      activeRef.current = true;
      setScreenshotSessionActive(true);
      setBusy(true);
      setError(null);
      // Hide our own window so it's neither in the shot nor in the way of
      // the area selection, and wait until it's actually gone.
      minimize(windowId);
      await awaitWindowHidden(rootRef.current);
      if (recording) {
        recordRegion.current = undefined;
        // A recording's area is picked first; the delay is before the video starts.
        if (m === 'area') await shoot(true);
        else if (delay > 0) setSession({ phase: 'countdown', left: delay, recording: true });
        else await record(undefined);
        return;
      }
      if (delay > 0) setSession({ phase: 'countdown', left: delay });
      else await shoot(m === 'area');
    },
    [delay, minimize, windowId, shoot, recording, record],
  );

  const onRegionSelected = useCallback(
    async (region: ViewportRect) => {
      if (session?.phase !== 'select') return;
      if (recording) {
        recordRegion.current = region;
        if (delay > 0) setSession({ phase: 'countdown', left: delay, recording: true });
        else await record(region);
        return;
      }
      const shot = session.frozen;
      setSession(null);
      try {
        setImage(await cropCapture(shot, region));
      } catch (e) {
        setError(cleanScreenshotError(e));
      }
      endSession();
    },
    [session, endSession, recording, delay, record],
  );

  // Tick the countdown down once a second; on the final tick, fire the
  // capture. The state change happens in the timer callback (not
  // synchronously in the effect body) so it doesn't cascade renders.
  useEffect(() => {
    if (session?.phase !== 'countdown') return;
    const t = setTimeout(() => {
      if (session.left > 1) setSession({ ...session, left: session.left - 1 });
      else if (session.recording) void record(recordRegion.current);
      else void shoot(mode === 'area');
    }, 1000);
    return () => clearTimeout(t);
  }, [session, mode, shoot, record]);

  // Esc backs out of a session at any point.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancelSession();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, cancelSession]);

  // If the window dies mid-session, don't leave the desktop-wide flag set
  // (it guards the Print Screen hotkey against re-entry).
  useEffect(
    () => () => {
      if (activeRef.current) setScreenshotSessionActive(false);
    },
    [],
  );

  // Our recording ended (from here, the menu bar, or on its own): show it.
  useEffect(() => {
    const b = getScreenRecorderBridge();
    if (!b) return;
    return b.onFinished((finished) => {
      if (!ownRecording.current || finished.path !== ownRecording.current) return;
      ownRecording.current = null;
      setImage(null);
      setVideo(finished);
      focus(windowId);
    });
  }, [focus, windowId]);

  // The running time, while a recording is.
  useEffect(() => {
    if (!recorder.recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recorder.recording]);

  // --- Output --------------------------------------------------------------

  const save = useCallback(async () => {
    if (!image) return;
    const bridge = getFsBridge();
    if (!bridge) return;
    setSaving(true);
    try {
      const path = await saveScreenshot(bridge, image);
      toast({
        title: 'Screenshot saved',
        description: `~/Pictures/Screenshots/${path.slice(path.lastIndexOf('/') + 1)}`,
      });
    } catch (e) {
      toast({
        title: 'Could not save screenshot',
        description: cleanFsError(e),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }, [image, toast]);

  const copy = useCallback(async () => {
    if (!image) return;
    try {
      await copyScreenshot(image);
      toast({ title: 'Copied to clipboard' });
    } catch (e) {
      toast({
        title: 'Could not copy',
        description: cleanScreenshotError(e),
        variant: 'destructive',
      });
    }
  }, [image, toast]);

  const download = useCallback(() => {
    if (!image) return;
    const a = document.createElement('a');
    a.href = image.dataUrl;
    a.download = screenshotFilename();
    a.click();
  }, [image]);

  if (!bridge) {
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6 text-center">
        <div className="max-w-xs space-y-3">
          <MonitorOff className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Screenshots are only available inside the Din desktop. Open this app
            from the desktop to capture your screen.
          </p>
        </div>
      </div>
    );
  }

  const videoName = video?.path ? video.path.slice(video.path.lastIndexOf('/') + 1) : null;

  return (
    <>
      {recorder.recording && !busy ? (
        // --- Recording -----------------------------------------------------
        <div ref={rootRef} className="grid h-full w-full place-items-center bg-background p-4">
          <div className="flex w-full max-w-72 flex-col items-center gap-3 text-center">
            <span className="relative grid size-10 place-items-center" aria-hidden>
              <span className="absolute size-10 rounded-full bg-destructive/20 motion-safe:animate-ping" />
              <span className="size-4 rounded-full bg-destructive" />
            </span>
            <p className="text-sm font-medium">
              Recording{' '}
              <span className="tabular-nums">
                {formatRecordingTime(now - recorder.recording.startedAt)}
              </span>
            </p>
            <Button variant="destructive" className="w-full" onClick={() => void stopRecording()}>
              <Square className="fill-current" aria-hidden />
              Stop Recording
            </Button>
            <p className="text-xs leading-snug text-muted-foreground">
              You can also stop it from the red button in the menu bar.
            </p>
          </div>
        </div>
      ) : video?.path ? (
        // --- Recording preview -----------------------------------------------
        <div ref={rootRef} className="flex h-full w-full flex-col bg-background text-foreground">
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
            <video
              src={localFileUrl(video.path)}
              controls
              className="max-h-full max-w-full rounded-md border border-border bg-black shadow-md"
            />
          </div>

          <div className="flex items-center gap-1 border-t border-border px-3 py-2">
            <span className="mr-auto min-w-0 truncate px-1 text-xs text-muted-foreground" title={videoName ?? undefined}>
              {formatRecordingTime(video.durationMs)} &middot; {videoName}
            </span>
            <Button size="sm" variant="ghost" onClick={() => open(appForFile(videoName ?? ''), { path: video.path! })}>
              <Play aria-hidden />
              Open
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => open('file-browser', { path: parentPath(video.path!), select: videoName })}
            >
              <FolderOpen aria-hidden />
              Show in Files
            </Button>
            <Button size="sm" onClick={() => setVideo(null)}>
              <Video aria-hidden />
              New
            </Button>
          </div>
        </div>
      ) : image ? (
        // --- Preview -------------------------------------------------------
        <div ref={rootRef} className="flex h-full w-full flex-col bg-background text-foreground">
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-3">
            <img
              src={image.dataUrl}
              alt={`Screenshot, ${image.width} by ${image.height} pixels`}
              width={image.width}
              height={image.height}
              className="h-auto max-w-full rounded-md border border-border shadow-md"
            />
          </div>

          <div className="flex items-center gap-1 border-t border-border px-3 py-2">
            <span className="mr-auto px-1 text-xs text-muted-foreground tabular-nums">
              {image.width} &times; {image.height}
            </span>
            <Button size="sm" variant="ghost" onClick={copy}>
              <Copy aria-hidden />
              Copy
            </Button>
            {fs && (
              <Button size="sm" variant="ghost" onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Save aria-hidden />
                )}
                Save
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={download}>
              <Download aria-hidden />
              Download
            </Button>
            <Button size="sm" onClick={() => setImage(null)}>
              <Camera aria-hidden />
              New
            </Button>
          </div>
        </div>
      ) : (
        // --- Launcher ------------------------------------------------------
        <div ref={rootRef} className="grid h-full w-full place-items-center overflow-auto bg-background p-4">
          <div className="flex w-full max-w-80 flex-col items-stretch gap-3">
            <Segmented
              label="Capture"
              options={KINDS.map((k) =>
                k.id === 'video' && !recorder.available
                  ? { ...k, disabled: true, title: 'Screen recording needs DinOS' }
                  : k,
              )}
              value={recording ? 'video' : 'photo'}
              onChange={setKind}
              disabled={busy}
            />
            <Segmented label="Capture mode" options={MODES} value={mode} onChange={setMode} disabled={busy} />
            {recording && (
              <Segmented label="Sound" options={SOUNDS} value={audio} onChange={setAudio} disabled={busy} />
            )}
            <Segmented
              label="Capture delay"
              options={DELAYS.map((d) => ({ id: d, name: d === 0 ? 'No delay' : `${d}s` }))}
              value={delay}
              onChange={setDelay}
              disabled={busy}
            />

            {error && (
              <p role="alert" className="text-center text-xs text-destructive">
                {error}
              </p>
            )}

            <Button
              className="w-full"
              variant={recording ? 'destructive' : 'default'}
              onClick={() => void startSession(mode)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : recording ? (
                <Video className="size-4" aria-hidden />
              ) : (
                <Camera className="size-4" aria-hidden />
              )}
              {recording ? 'Start Recording' : 'Take Screenshot'}
            </Button>

            <p className="text-center text-xs leading-snug text-muted-foreground">
              {recording
                ? 'Recordings are saved in Videos › Screen Recordings'
                : 'Print Screen grabs the screen · Shift+Print Screen grabs an area'}
            </p>
          </div>
        </div>
      )}

      {session && <CaptureOverlay session={session} onSelect={onRegionSelected} />}
    </>
  );
}
