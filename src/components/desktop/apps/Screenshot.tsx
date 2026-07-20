import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Copy, Crop, Download, Loader2, MonitorOff, Save, X } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getFsBridge, cleanFsError, joinPath } from '@/lib/fs';
import { GENIE_DURATION_MS } from '@/lib/genie';
import {
  cleanScreenshotError,
  dataUrlToBlob,
  dataUrlToBytes,
  getScreenshotBridge,
  screenshotFilename,
  type Screenshot as Capture,
} from '@/lib/screenshot';

/** Seconds to wait before capturing, so the user can arrange the desktop. */
const DELAYS = [0, 3, 5] as const;
type Delay = (typeof DELAYS)[number];

/** A drag-selected region, as fractions (0..1) of the image's own size. */
interface Selection {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Ignore selections smaller than this fraction on a side (a stray click). */
const MIN_SELECTION = 0.01;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Resolve once the desktop has visually settled after this window minimizes:
 * the genie animation has fully swallowed the window into the dock and the
 * compositor has painted the result. Without waiting out the full genie
 * timeline, the capture catches the window mid-animation.
 */
function awaitHidden(): Promise<void> {
  const animMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : GENIE_DURATION_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
    }, animMs);
  });
}

/**
 * A minimal screenshot tool in the spirit of Budgie's: a compact launcher
 * with a delay picker and one capture button, then a clean preview where the
 * shot can be cropped (drag a region), copied, saved to ~/Pictures, or
 * downloaded.
 *
 * Capture is backed by the Electron shell's screenshot bridge
 * (webContents.capturePage). The tool minimizes its own window and waits out
 * the genie animation so it never appears in the shot. Outside the Electron
 * shell (a plain browser) there is no bridge, so the app shows a short
 * fallback instead.
 */
export function Screenshot({ windowId }: AppComponentProps) {
  const { toast } = useToast();
  const { minimize, focus } = useWindowActions();
  const bridge = getScreenshotBridge();
  const fs = getFsBridge();

  const [image, setImage] = useState<Capture | null>(null);
  const [delay, setDelay] = useState<Delay>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);

  const imgRef = useRef<HTMLImageElement>(null);
  const dragging = useRef(false);

  const runCapture = useCallback(async () => {
    const b = getScreenshotBridge();
    if (!b) return;
    setError(null);
    setSelection(null);
    setBusy(true);
    // Hide our own window so it isn't part of the capture, and wait for its
    // genie animation to finish so it isn't caught mid-flight either.
    minimize(windowId);
    try {
      await awaitHidden();
      setImage(await b.capture());
    } catch (e) {
      setError(cleanScreenshotError(e));
    } finally {
      focus(windowId); // restore + raise our window to show the result
      setBusy(false);
    }
  }, [windowId, minimize, focus]);

  const capture = useCallback(() => {
    if (delay <= 0) {
      void runCapture();
    } else {
      setCountdown(delay);
    }
  }, [delay, runCapture]);

  // Tick the countdown down once a second; on the final tick, fire the
  // capture. The state change happens in the timer callback (not synchronously
  // in the effect body) so it doesn't cascade renders.
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const t = setTimeout(() => {
      if (countdown <= 1) {
        setCountdown(null);
        void runCapture();
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [countdown, runCapture]);

  // --- Region selection (drag a rectangle over the preview) ----------------

  const pointFrac = useCallback((e: React.PointerEvent) => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / rect.width),
      y: clamp01((e.clientY - rect.top) / rect.height),
    };
  }, []);

  const onSelectDown = useCallback(
    (e: React.PointerEvent) => {
      if (!image || busy) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = true;
      const p = pointFrac(e);
      setSelection({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    },
    [image, busy, pointFrac],
  );

  const onSelectMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const p = pointFrac(e);
      setSelection((s) => (s ? { ...s, x1: p.x, y1: p.y } : s));
    },
    [pointFrac],
  );

  const onSelectUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    // Drop a too-small selection (treat it as a plain click).
    setSelection((s) =>
      s && Math.abs(s.x1 - s.x0) >= MIN_SELECTION && Math.abs(s.y1 - s.y0) >= MIN_SELECTION
        ? s
        : null,
    );
  }, []);

  const cropToSelection = useCallback(() => {
    const el = imgRef.current;
    if (!image || !selection || !el) return;
    const sx = Math.round(Math.min(selection.x0, selection.x1) * image.width);
    const sy = Math.round(Math.min(selection.y0, selection.y1) * image.height);
    const sw = Math.max(1, Math.round(Math.abs(selection.x1 - selection.x0) * image.width));
    const sh = Math.max(1, Math.round(Math.abs(selection.y1 - selection.y0) * image.height));

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The <img> is loaded from a data: URL (same-origin), so the canvas isn't
    // tainted and toDataURL() works.
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, sw, sh);
    setImage({ dataUrl: canvas.toDataURL('image/png'), width: sw, height: sh });
    setSelection(null);
  }, [image, selection]);

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

  const capturing = busy || countdown !== null;

  // --- Launcher (no capture yet) -------------------------------------------

  if (!image) {
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6">
        <div className="flex w-full max-w-xs flex-col items-center gap-6 text-center">
          <div className="grid size-16 place-items-center rounded-2xl bg-muted">
            {countdown !== null ? (
              <span
                aria-live="polite"
                className="text-3xl font-semibold tabular-nums text-foreground"
              >
                {countdown}
              </span>
            ) : (
              <Camera className="size-8 text-muted-foreground" aria-hidden />
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div
            className="flex items-center gap-1 rounded-lg bg-muted p-1"
            role="group"
            aria-label="Capture delay"
          >
            {DELAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDelay(d)}
                disabled={capturing}
                aria-pressed={delay === d}
                className={cn(
                  'rounded-md px-3 py-1 text-sm font-medium transition-colors',
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

          <Button size="lg" className="w-full" onClick={capture} disabled={capturing}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Camera className="size-4" aria-hidden />
            )}
            {countdown !== null
              ? `Capturing in ${countdown}…`
              : busy
                ? 'Capturing…'
                : 'Take Screenshot'}
          </Button>
        </div>
      </div>
    );
  }

  // --- Preview -------------------------------------------------------------

  const sel = selection && {
    left: `${Math.min(selection.x0, selection.x1) * 100}%`,
    top: `${Math.min(selection.y0, selection.y1) * 100}%`,
    width: `${Math.abs(selection.x1 - selection.x0) * 100}%`,
    height: `${Math.abs(selection.y1 - selection.y0) * 100}%`,
  };

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-4">
        <div
          className="relative inline-block cursor-crosshair touch-none select-none"
          onPointerDown={onSelectDown}
          onPointerMove={onSelectMove}
          onPointerUp={onSelectUp}
        >
          <img
            ref={imgRef}
            src={image.dataUrl}
            alt={`Screenshot, ${image.width} by ${image.height} pixels`}
            width={image.width}
            height={image.height}
            draggable={false}
            className="h-auto max-w-full rounded-lg border border-border shadow-lg"
          />
          {sel && (
            <div
              aria-hidden
              className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
              style={sel}
            />
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
        <span className="mr-auto text-xs text-muted-foreground">
          {image.width} &times; {image.height}
          {!selection && <span className="max-sm:hidden"> &middot; drag to crop</span>}
        </span>
        {selection ? (
          <>
            <Button size="sm" onClick={cropToSelection}>
              <Crop className="size-4" aria-hidden />
              Crop
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelection(null)}>
              <X className="size-4" aria-hidden />
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={copy}>
              <Copy className="size-4" aria-hidden />
              Copy
            </Button>
            {fs && (
              <Button size="sm" variant="ghost" onClick={save} disabled={saving}>
                {saving ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="size-4" aria-hidden />
                )}
                Save
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={download}>
              <Download className="size-4" aria-hidden />
              Download
            </Button>
            <Button size="sm" onClick={() => setImage(null)} disabled={capturing}>
              <Camera className="size-4" aria-hidden />
              New
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
