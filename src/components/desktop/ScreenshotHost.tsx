import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { CaptureOverlay } from '@/components/desktop/CaptureOverlay';
import { endFileDrag, startFileDrag } from '@/components/desktop/apps/files/dnd';
import { cleanFsError, getFsBridge } from '@/lib/fs';
import {
  cleanScreenshotError,
  copyScreenshot,
  cropCapture,
  getScreenshotBridge,
  isScreenshotSessionActive,
  onScreenshotRequest,
  paintSettled,
  playShutter,
  saveScreenshot,
  setScreenshotSessionActive,
  type Screenshot,
  type ScreenshotRequest,
  type ViewportRect,
} from '@/lib/screenshot';

/** How long the thumbnail stays up after a capture, unless hovered. */
const THUMBNAIL_MS = 5000;

/** The thumbnail's longest side may not exceed these, in CSS pixels. */
const THUMB_MAX_W = 224;
const THUMB_MAX_H = 160;

interface Thumbnail {
  /** Tells captures apart, so a timer from an older one can't dismiss a newer one. */
  id: number;
  shot: Screenshot;
  /** Where it was saved; null while saving, or when it couldn't be. */
  path: string | null;
}

/**
 * The Print Screen hotkeys, the way GNOME and macOS do them: no window and
 * no questions. Print Screen captures the whole desktop at once; Shift+Print
 * Screen (or the box-select key) puts up the area overlay first. Either way
 * the shutter sounds, the capture goes to the clipboard and to
 * ~/Pictures/Screenshots, and a thumbnail sits in the bottom-right corner
 * for a few seconds: click it to open the file, or drag it into Files.
 *
 * Requests come from DesktopHotkeys through requestScreenshot(). The
 * Screenshot app is still there for delayed shots and a preview.
 */
export function ScreenshotHost() {
  const { toast } = useToast();
  const { open } = useWindowActions();
  const [selecting, setSelecting] = useState(false);
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  const thumbnailRef = useRef<Thumbnail | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    thumbnailRef.current = thumbnail;
  }, [thumbnail]);

  const finish = useCallback(() => {
    setScreenshotSessionActive(false);
  }, []);

  const capture = useCallback(
    async (region: ViewportRect | null) => {
      const bridge = getScreenshotBridge();
      if (!bridge) return finish();
      let shot: Screenshot;
      try {
        shot = await bridge.capture();
        if (region) shot = await cropCapture(shot, region);
      } catch (e) {
        finish();
        toast({
          title: 'Could not take a screenshot',
          description: cleanScreenshotError(e),
          variant: 'destructive',
        });
        return;
      }
      finish();
      playShutter();
      flashScreen();

      const id = nextId.current++;
      setThumbnail({ id, shot, path: null });

      copyScreenshot(shot).catch((e: unknown) => {
        toast({
          title: 'Could not copy the screenshot',
          description: cleanScreenshotError(e),
          variant: 'destructive',
        });
      });
      const fs = getFsBridge();
      if (fs) {
        try {
          const path = await saveScreenshot(fs, shot);
          setThumbnail((t) => (t?.id === id ? { ...t, path } : t));
        } catch (e) {
          toast({
            title: 'Could not save the screenshot',
            description: cleanFsError(e),
            variant: 'destructive',
          });
        }
      }
    },
    [finish, toast],
  );

  useEffect(
    () =>
      onScreenshotRequest((request: ScreenshotRequest) => {
        if (isScreenshotSessionActive() || !getScreenshotBridge()) return;
        setScreenshotSessionActive(true);
        void (async () => {
          // The last capture's thumbnail mustn't end up in this one.
          if (thumbnailRef.current) {
            setThumbnail(null);
            await paintSettled();
          }
          if (request === 'area') setSelecting(true);
          else await capture(null);
        })();
      }),
    [capture],
  );

  const onSelect = useCallback(
    async (region: ViewportRect) => {
      setSelecting(false);
      await paintSettled();
      await capture(region);
    },
    [capture],
  );

  // Esc backs out of the area selection.
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setSelecting(false);
      finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, finish]);

  // Don't leave the desktop-wide flag set if the desktop goes away mid-session.
  useEffect(() => () => setScreenshotSessionActive(false), []);

  const dismiss = useCallback((id: number) => {
    setThumbnail((t) => (t?.id === id ? null : t));
  }, []);

  return (
    <>
      {selecting && <CaptureOverlay session={{ phase: 'select' }} onSelect={onSelect} />}
      {thumbnail && (
        <CaptureThumbnail
          key={thumbnail.id}
          thumbnail={thumbnail}
          onOpen={(path) => {
            dismiss(thumbnail.id);
            open('preview', { path });
          }}
          onDismiss={() => dismiss(thumbnail.id)}
        />
      )}
    </>
  );
}

/**
 * A brief white flash over the screen, the camera going off. The layer is
 * removed as soon as it has faded: left in place, even fully transparent,
 * it showed up whitened in the next capture.
 */
function flashScreen(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText =
    'position:fixed;inset:0;z-index:10001;pointer-events:none;background:#fff;opacity:0';
  portalContainer().appendChild(layer);
  layer
    .animate([{ opacity: 0.6 }, { opacity: 0 }], { duration: 300, easing: 'ease-out' })
    .finished.finally(() => layer.remove());
}

function CaptureThumbnail({
  thumbnail,
  onOpen,
  onDismiss,
}: {
  thumbnail: Thumbnail;
  onOpen: (path: string) => void;
  onDismiss: () => void;
}) {
  const { primary } = useMonitors();
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { shot, path } = thumbnail;

  // Hold still while the pointer is on it or it's being dragged; the
  // countdown starts over when it leaves.
  useEffect(() => {
    if (hovered || dragging) return;
    const t = setTimeout(onDismiss, THUMBNAIL_MS);
    return () => clearTimeout(t);
  }, [hovered, dragging, onDismiss]);

  const scale = Math.min(THUMB_MAX_W / shot.width, THUMB_MAX_H / shot.height, 1);
  const width = Math.max(48, Math.round(shot.width * scale));
  const height = Math.max(48, Math.round(shot.height * scale));
  const name = path ? path.slice(path.lastIndexOf('/') + 1) : null;

  return createPortal(
    <ScreenLayer className="pointer-events-none z-[10000]">
      <div
        className="absolute"
        style={{ left: primary.x, top: primary.y, width: primary.width, height: primary.height }}
      >
        <div
          className="group pointer-events-auto absolute right-6 bottom-6 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-8 motion-safe:duration-300"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <button
            type="button"
            disabled={!path}
            draggable={!!path}
            onClick={() => path && onOpen(path)}
            onDragStart={(e) => {
              if (!path || !name) return;
              setDragging(true);
              startFileDrag(e, { paths: [path], folders: new Set() }, name);
            }}
            onDragEnd={() => {
              endFileDrag();
              setDragging(false);
              setHovered(false);
            }}
            title={path ? 'Click to open, or drag into Files' : 'Saving…'}
            aria-label={name ? `Open ${name}` : 'Screenshot taken'}
            className="block overflow-hidden rounded-lg border border-white/70 bg-background shadow-xl ring-1 ring-black/20 transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress"
          >
            <img
              src={shot.dataUrl}
              alt=""
              draggable={false}
              style={{ width, height }}
              className="block object-cover"
            />
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="absolute -top-2 -left-2 grid size-6 place-items-center rounded-full border border-border bg-background text-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </ScreenLayer>,
    portalContainer(),
  );
}
