import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { portalContainer } from '@/lib/portalContainer';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { getFsBridge, cleanFsError, joinPath } from '@/lib/fs';
import {
  cleanScreenshotError,
  dataUrlToBlob,
  dataUrlToBytes,
  getScreenshotBridge,
  screenshotFilename,
  setScreenshotSessionActive,
  type Screenshot as Capture,
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

/** A rectangle in viewport (CSS pixel) coordinates. */
interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Ignore drags smaller than this on a side (a stray click, not a selection). */
const MIN_DRAG_PX = 4;

/**
 * The live capture session, while our window sits minimized out of the shot:
 * dragging the region on the desktop, then counting down the chosen delay.
 */
type Session =
  | { phase: 'select' }
  | { phase: 'countdown'; left: number; region: ViewportRect | null };

/**
 * Resolve once two animation frames have painted plus a vsync cushion, so the
 * compositor has presented the latest DOM state before capturePage snapshots
 * it (a hidden window or a dismissed overlay must reach the screen first).
 */
function paintSettled(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  });
}

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

/** The drag rectangle between two viewport points, clamped to the viewport. */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): ViewportRect {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(window.innerWidth, Math.max(a.x, b.x));
  const y1 = Math.min(window.innerHeight, Math.max(a.y, b.y));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Crop a full-desktop capture to the selected region. The selection is in
 * viewport CSS pixels while the capture is in device pixels; the shell
 * window fills the viewport, so the two relate by a plain per-axis scale.
 */
async function cropCapture(shot: Capture, region: ViewportRect): Promise<Capture> {
  const sx = shot.width / window.innerWidth;
  const sy = shot.height / window.innerHeight;
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const x = clamp(Math.round(region.x * sx), 0, shot.width - 1);
  const y = clamp(Math.round(region.y * sy), 0, shot.height - 1);
  const width = clamp(Math.round(region.width * sx), 1, shot.width - x);
  const height = clamp(Math.round(region.height * sy), 1, shot.height - y);
  if (x === 0 && y === 0 && width === shot.width && height === shot.height) return shot;

  const img = new Image();
  img.src = shot.dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return shot;
  // The image is loaded from a data: URL (same-origin), so the canvas isn't
  // tainted and toDataURL() works.
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/**
 * The capture overlay, over every monitor and portaled to <body> so it floats
 * above every desktop layer (dock included) while our window is minimized. The
 * 'select' phase dims the desktop and takes a drag rectangle (releasing a
 * sub-threshold drag just re-arms; Esc cancels). The 'countdown' phase is
 * pointer-transparent, so the user can keep arranging the desktop - hover
 * states, open menus - until the delayed shot fires. The overlay always
 * unmounts before capturePage runs, so it never appears in the shot.
 */
function CaptureOverlay({
  session,
  onSelect,
}: {
  session: Session;
  onSelect: (region: ViewportRect) => void;
}) {
  const [drag, setDrag] = useState<ViewportRect | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const { primary } = useMonitors();
  // Hints sit at the top middle of the primary monitor.
  const hintStyle = { left: primary.x + primary.width / 2, top: primary.y + 20 };

  if (session.phase === 'countdown') {
    return createPortal(
      <ScreenLayer aria-live="polite" className="pointer-events-none z-[10000]">
        {session.region && (
          <div
            aria-hidden
            className="absolute rounded-sm border-2 border-primary"
            style={{
              left: session.region.x,
              top: session.region.y,
              width: session.region.width,
              height: session.region.height,
            }}
          />
        )}
        <div
          style={hintStyle}
          className="absolute -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-xs text-foreground shadow-lg backdrop-blur"
        >
          Capturing in <span className="font-semibold tabular-nums">{session.left}</span>s
          <span className="text-muted-foreground"> &middot; Esc to cancel</span>
        </div>
      </ScreenLayer>,
      portalContainer(),
    );
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Portal events bubble through the REACT tree, not the DOM tree: without
    // this, the click reaches the Window section's raise-on-pointerdown
    // handler and un-minimizes the app window mid-selection (straight into
    // the shot).
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    origin.current = { x: e.clientX, y: e.clientY };
    setDrag(null);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!origin.current) return;
    e.stopPropagation();
    setDrag(rectFrom(origin.current, { x: e.clientX, y: e.clientY }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const o = origin.current;
    if (!o) return;
    e.stopPropagation();
    origin.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    const rect = rectFrom(o, { x: e.clientX, y: e.clientY });
    // A sub-threshold drag is a stray click: re-arm instead of capturing a
    // sliver. Esc is the way out.
    if (rect.width >= MIN_DRAG_PX && rect.height >= MIN_DRAG_PX) onSelect(rect);
    else setDrag(null);
  };

  const onPointerCancel = () => {
    origin.current = null;
    setDrag(null);
  };

  return createPortal(
    <ScreenLayer
      role="dialog"
      aria-modal="true"
      aria-label="Select an area to capture"
      className="z-[10000] cursor-crosshair touch-none select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Once a drag is live, the selection's oversized box-shadow dims
          everything BUT the rectangle, keeping the pick bright. */}
      {!drag && <div aria-hidden className="absolute inset-0 bg-black/25" />}
      {drag && (
        <div
          aria-hidden
          className="absolute border border-white/90 shadow-[0_0_0_100vmax_rgba(0,0,0,0.3)]"
          style={{ left: drag.x, top: drag.y, width: drag.width, height: drag.height }}
        >
          <div
            className={cn(
              'absolute right-0 rounded bg-black/75 px-1.5 py-0.5 text-[11px] leading-none text-white tabular-nums',
              drag.y + drag.height + 24 > window.innerHeight
                ? 'bottom-full mb-1'
                : 'top-full mt-1',
            )}
          >
            {Math.round(drag.width)} &times; {Math.round(drag.height)}
          </div>
        </div>
      )}
      {!drag && (
        <div
          style={hintStyle}
          className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-background/90 px-3 py-1 text-xs text-foreground shadow-lg backdrop-blur"
        >
          Drag to select an area<span className="text-muted-foreground"> &middot; Esc to cancel</span>
        </div>
      )}
    </ScreenLayer>,
    portalContainer(),
  );
}

/**
 * A minimal screenshot tool in the spirit of GNOME's: a compact launcher
 * (whole screen or a drag-selected area, with an optional delay), then a
 * clean preview where the shot can be copied, saved to ~/Pictures, or
 * downloaded.
 *
 * Selection happens BEFORE capture on the live desktop: the app minimizes
 * its own window, waits until it's verifiably hidden (not just until a
 * timer expires, which races the genie animation under load), then overlays
 * the desktop for the region drag. The delay counts down after the
 * selection, so menus and hover states can still be arranged before the
 * shot fires. Hotkeys launch sessions directly (see DesktopHotkeys): Print
 * Screen grabs the whole screen; Shift+Print Screen - or the dedicated
 * box-select key found on newer laptop keyboards - starts an area grab.
 *
 * Capture is backed by the Electron shell's screenshot bridge
 * (webContents.capturePage). Outside the shell (a plain browser) there is
 * no bridge, so the app shows a short fallback instead.
 */
export function Screenshot({ windowId, params }: AppComponentProps) {
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

  const captureRegion = useCallback(
    async (region: ViewportRect | null) => {
      const b = getScreenshotBridge();
      if (!b) return;
      // Every overlay must be gone from the page before the snapshot.
      setSession(null);
      await paintSettled();
      try {
        const shot = await b.capture();
        setImage(region ? await cropCapture(shot, region) : shot);
      } catch (e) {
        setError(cleanScreenshotError(e));
      } finally {
        activeRef.current = false;
        setScreenshotSessionActive(false);
        setBusy(false);
        focus(windowId); // restore + raise our window to show the result
      }
    },
    [focus, windowId],
  );

  const cancelSession = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setScreenshotSessionActive(false);
    setBusy(false);
    setSession(null);
    focus(windowId);
  }, [focus, windowId]);

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
      if (m === 'area') {
        setSession({ phase: 'select' });
      } else if (delay > 0) {
        setSession({ phase: 'countdown', left: delay, region: null });
      } else {
        await captureRegion(null);
      }
    },
    [delay, minimize, windowId, captureRegion],
  );

  const onRegionSelected = useCallback(
    (region: ViewportRect) => {
      if (delay > 0) setSession({ phase: 'countdown', left: delay, region });
      else void captureRegion(region);
    },
    [delay, captureRegion],
  );

  // Tick the countdown down once a second; on the final tick, fire the
  // capture. The state change happens in the timer callback (not
  // synchronously in the effect body) so it doesn't cascade renders.
  useEffect(() => {
    if (session?.phase !== 'countdown') return;
    const t = setTimeout(() => {
      if (session.left <= 1) void captureRegion(session.region);
      else setSession({ phase: 'countdown', left: session.left - 1, region: session.region });
    }, 1000);
    return () => clearTimeout(t);
  }, [session, captureRegion]);

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

  // Launch params (e.g. the desktop's Print Screen hotkey) start a session
  // directly. Single-instance reopens re-merge the params object on every
  // press, so consume each object once, by identity.
  const consumedParams = useRef<AppComponentProps['params']>(null);
  useEffect(() => {
    if (!params || consumedParams.current === params) return;
    consumedParams.current = params;
    const start = params.start;
    if (start !== 'area' && start !== 'screen') return;
    if (!getScreenshotBridge() || activeRef.current) return;
    setMode(start);
    void startSession(start);
  }, [params, startSession]);

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
      const dir = joinPath(await bridge.homedir(), 'Pictures');
      await bridge.mkdir(dir);
      const name = screenshotFilename();
      await bridge.writeFile(joinPath(dir, name), dataUrlToBytes(image.dataUrl));
      toast({ title: 'Screenshot saved', description: `~/Pictures/${name}` });
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
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': dataUrlToBlob(image.dataUrl) }),
      ]);
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
