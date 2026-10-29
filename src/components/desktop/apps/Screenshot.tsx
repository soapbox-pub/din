import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Copy,
  Download,
  Loader2,
  Monitor,
  MonitorOff,
  Save,
  SquareDashedMousePointer,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { CaptureOverlay, type Session } from '@/components/desktop/CaptureOverlay';
import { getFsBridge, cleanFsError } from '@/lib/fs';
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

/** Capture modes: the whole desktop, or a region dragged out on it first. */
const MODES = [
  { id: 'screen', name: 'Screen', icon: Monitor },
  { id: 'area', name: 'Area', icon: SquareDashedMousePointer },
] as const;
type Mode = (typeof MODES)[number]['id'];

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

/**
 * A minimal screenshot tool in the spirit of GNOME's: a compact launcher
 * (whole screen or a drag-selected area, with an optional delay), then a
 * clean preview where the shot can be copied, saved to
 * ~/Pictures/Screenshots, or downloaded. The Print Screen hotkeys don't come
 * here; they capture straight away (see ScreenshotHost).
 *
 * The app minimizes its own window and waits until it's verifiably hidden
 * (not just until a timer expires, which races the genie animation under
 * load). The delay counts down next, so menus and hover states can still be
 * arranged; then the desktop is captured. In area mode that capture goes up
 * frozen over the screen and the region is dragged out on it, so nothing
 * underneath moves or reacts to the drag.
 *
 * Capture is backed by the Electron shell's screenshot bridge
 * (webContents.capturePage). Outside the shell (a plain browser) there is
 * no bridge, so the app shows a short fallback instead.
 */
export function Screenshot({ windowId }: AppComponentProps) {
  const { toast } = useToast();
  const { minimize, focus } = useWindowActions();
  const bridge = getScreenshotBridge();
  const fs = getFsBridge();

  const [image, setImage] = useState<Capture | null>(null);
  const [mode, setMode] = useState<Mode>('area');
  const [delay, setDelay] = useState<Delay>(0);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  // Mirror of "a capture session is running" for re-entrancy guards; state
  // alone can't cover the gaps between the session's async steps.
  const activeRef = useRef(false);

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
      if (delay > 0) setSession({ phase: 'countdown', left: delay });
      else await shoot(m === 'area');
    },
    [delay, minimize, windowId, shoot],
  );

  const onRegionSelected = useCallback(
    async (region: ViewportRect) => {
      if (session?.phase !== 'select') return;
      const shot = session.frozen;
      setSession(null);
      try {
        setImage(await cropCapture(shot, region));
      } catch (e) {
        setError(cleanScreenshotError(e));
      }
      endSession();
    },
    [session, endSession],
  );

  // Tick the countdown down once a second; on the final tick, fire the
  // capture. The state change happens in the timer callback (not
  // synchronously in the effect body) so it doesn't cascade renders.
  useEffect(() => {
    if (session?.phase !== 'countdown') return;
    const t = setTimeout(() => {
      if (session.left <= 1) void shoot(mode === 'area');
      else setSession({ phase: 'countdown', left: session.left - 1 });
    }, 1000);
    return () => clearTimeout(t);
  }, [session, mode, shoot]);

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

  return (
    <>
      {image ? (
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
        <div ref={rootRef} className="grid h-full w-full place-items-center bg-background p-4">
          <div className="flex w-full max-w-72 flex-col items-stretch gap-3">
            <div
              className="flex gap-1 rounded-lg bg-muted p-1"
              role="group"
              aria-label="Capture mode"
            >
              {MODES.map(({ id, name, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMode(id)}
                  disabled={busy}
                  aria-pressed={mode === id}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:opacity-50',
                    mode === id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {name}
                </button>
              ))}
            </div>

            <div
              className="flex gap-1 rounded-lg bg-muted p-1"
              role="group"
              aria-label="Capture delay"
            >
              {DELAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDelay(d)}
                  disabled={busy}
                  aria-pressed={delay === d}
                  className={cn(
                    'flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:opacity-50',
                    delay === d
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {d === 0 ? 'No delay' : `${d}s`}
                </button>
              ))}
            </div>

            {error && (
              <p role="alert" className="text-center text-xs text-destructive">
                {error}
              </p>
            )}

            <Button
              className="w-full"
              onClick={() => void startSession(mode)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Camera className="size-4" aria-hidden />
              )}
              Take Screenshot
            </Button>

            <p className="text-center text-xs leading-snug text-muted-foreground">
              Print Screen grabs the screen &middot; Shift+Print Screen grabs an
              area
            </p>
          </div>
        </div>
      )}

      {session && <CaptureOverlay session={session} onSelect={onRegionSelected} />}
    </>
  );
}
