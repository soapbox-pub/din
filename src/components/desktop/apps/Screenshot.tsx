import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  Copy,
  Crop,
  Download,
  ImageIcon,
  Loader2,
  MonitorOff,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getFsBridge, cleanFsError, joinPath } from '@/lib/fs';
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
 * Resolve after the browser has painted the next frame(s). Used to let the
 * compositor commit our window's hidden state before the shell is captured.
 */
function nextPaint(delayMs = 90): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(resolve, delayMs)),
    );
  });
}

/**
 * A minimal screenshot tool: capture the Din desktop as a PNG, preview it,
 * optionally crop to a drag-selected region, then copy it to the clipboard,
 * save it to ~/Pictures, or download it.
 *
 * Capture is backed by the Electron shell's screenshot bridge
 * (webContents.capturePage). The tool minimizes its own window for the capture
 * so it stays out of the shot; an optional delay lets the user arrange other
 * windows first. Outside the Electron shell (a plain browser) there is no
 * bridge, so the app shows a short fallback instead.
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
    // Hide our own window so it isn't part of the capture, then wait for the
    // compositor to paint the hidden state before snapping the shell.
    minimize(windowId);
    try {
      await nextPaint();
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
  const sel = selection && {
    left: `${Math.min(selection.x0, selection.x1) * 100}%`,
    top: `${Math.min(selection.y0, selection.y1) * 100}%`,
    width: `${Math.abs(selection.x1 - selection.x0) * 100}%`,
    height: `${Math.abs(selection.y1 - selection.y0) * 100}%`,
  };

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="mr-auto flex items-center gap-2 font-medium">
          <Camera className="size-5 text-muted-foreground" aria-hidden />
          <span>Screenshot</span>
        </div>

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
                'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
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

        <Button onClick={capture} disabled={capturing}>
          {capturing ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Camera className="size-4" aria-hidden />
          )}
          {countdown !== null
            ? `Capturing in ${countdown}…`
            : busy
              ? 'Capturing…'
              : image
                ? 'New screenshot'
                : 'Capture'}
        </Button>
      </div>

      {/* Preview / empty state */}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm space-y-2">
              <p className="text-sm font-medium text-destructive">Capture failed</p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        ) : image ? (
          <div className="flex flex-col items-center gap-2">
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
            <p className="text-xs text-muted-foreground">
              Drag on the image to select a region to crop.
            </p>
          </div>
        ) : (
          <div className="grid h-full place-items-center">
            <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
              <ImageIcon
                className="mx-auto mb-3 size-8 text-muted-foreground"
                aria-hidden
              />
              <p className="text-sm text-muted-foreground">
                Capture your whole desktop as an image, then crop, copy, or save
                it. The Screenshot window hides itself while capturing.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Action bar (only with a capture) */}
      {image && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <span className="mr-auto text-sm text-muted-foreground">
            {image.width} &times; {image.height}
          </span>
          {selection ? (
            <>
              <Button variant="secondary" onClick={cropToSelection}>
                <Crop className="size-4" aria-hidden />
                Crop to selection
              </Button>
              <Button variant="ghost" onClick={() => setSelection(null)}>
                <X className="size-4" aria-hidden />
                Clear
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={copy}>
                <Copy className="size-4" aria-hidden />
                Copy
              </Button>
              {fs && (
                <Button onClick={save} disabled={saving}>
                  {saving ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Save className="size-4" aria-hidden />
                  )}
                  Save to Pictures
                </Button>
              )}
              <Button variant="outline" onClick={download}>
                <Download className="size-4" aria-hidden />
                Download
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setImage(null);
                  setError(null);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
                Discard
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
