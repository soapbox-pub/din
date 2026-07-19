import { useCallback, useEffect, useState } from 'react';
import {
  Camera,
  Download,
  ImageIcon,
  Loader2,
  MonitorOff,
  Save,
  Trash2,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/useToast';
import { getFsBridge, cleanFsError, joinPath } from '@/lib/fs';
import {
  cleanScreenshotError,
  dataUrlToBytes,
  getScreenshotBridge,
  screenshotFilename,
  type Screenshot as Capture,
} from '@/lib/screenshot';

/** Seconds to wait before capturing, so the user can arrange the desktop. */
const DELAYS = [0, 3, 5] as const;
type Delay = (typeof DELAYS)[number];

/**
 * A minimal screenshot tool: capture the Din desktop as a PNG, preview it, and
 * save it to ~/Pictures or download it. Capture is backed by the Electron
 * shell's screenshot bridge (webContents.capturePage), so the whole desktop -
 * including Din's own windows - is in the shot; an optional delay lets the user
 * arrange things first. Outside the Electron shell (a plain browser) there is no
 * bridge, so the app shows a short fallback instead.
 */
export function Screenshot(_props: AppComponentProps) {
  const { toast } = useToast();
  const bridge = getScreenshotBridge();
  const fs = getFsBridge();

  const [image, setImage] = useState<Capture | null>(null);
  const [delay, setDelay] = useState<Delay>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCapture = useCallback(async () => {
    const b = getScreenshotBridge();
    if (!b) return;
    setError(null);
    setBusy(true);
    try {
      setImage(await b.capture());
    } catch (e) {
      setError(cleanScreenshotError(e));
    } finally {
      setBusy(false);
    }
  }, []);

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

  const save = useCallback(async () => {
    if (!image) return;
    const bridge = getFsBridge();
    if (!bridge) return;
    setSaving(true);
    try {
      const dir = joinPath(await bridge.homedir(), 'Pictures');
      await bridge.mkdir(dir);
      const name = screenshotFilename();
      await bridge.writeFile(joinPath(dir, name), await dataUrlToBytes(image.dataUrl));
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
            ? `Capturing in ${countdown}\u2026`
            : busy
              ? 'Capturing\u2026'
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
          <img
            src={image.dataUrl}
            alt={`Screenshot, ${image.width} by ${image.height} pixels`}
            width={image.width}
            height={image.height}
            className="mx-auto h-auto max-w-full rounded-lg border border-border shadow-lg"
          />
        ) : (
          <div className="grid h-full place-items-center">
            <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
              <ImageIcon
                className="mx-auto mb-3 size-8 text-muted-foreground"
                aria-hidden
              />
              <p className="text-sm text-muted-foreground">
                Capture your whole desktop as an image. Din's own window will
                appear in the shot &mdash; use a delay to arrange things first.
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
          {fs && (
            <Button variant="default" onClick={save} disabled={saving}>
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
        </div>
      )}
    </div>
  );
}
