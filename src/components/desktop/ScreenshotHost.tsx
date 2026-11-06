import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FolderOpen, Layers, Paintbrush, Trash2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { portalContainer } from '@/lib/portalContainer';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { CaptureOverlay } from '@/components/desktop/CaptureOverlay';
import { endFileDrag, startFileDrag } from '@/components/desktop/apps/files/dnd';
import { cleanFsError, getFsBridge, parentPath } from '@/lib/fs';
import { invalidateListings } from '@/hooks/useFileSystem';
import {
  cleanScreenshotError,
  copyScreenshot,
  cropCapture,
  captureDesktop,
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
import { prefersReducedMotion } from '@/shared/reducedMotion';

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
 * Screen (or the box-select key) freezes the screen and puts up the area
 * overlay on it. Either way
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
  const queryClient = useQueryClient();
  /** The desktop as it was when an area shot was asked for, up while the area is dragged. */
  const [frozen, setFrozen] = useState<Screenshot | null>(null);
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  const thumbnailRef = useRef<Thumbnail | null>(null);
  const nextId = useRef(1);

  useEffect(() => {
    thumbnailRef.current = thumbnail;
  }, [thumbnail]);

  const finish = useCallback(() => {
    setScreenshotSessionActive(false);
  }, []);

  const copy = useCallback(
    (shot: Screenshot) => {
      copyScreenshot(shot).catch((e: unknown) => {
        toast({
          title: 'Could not copy the screenshot',
          description: cleanScreenshotError(e),
          variant: 'destructive',
        });
      });
    },
    [toast],
  );

  const failed = useCallback(
    (e: unknown) => {
      finish();
      toast({
        title: 'Could not take a screenshot',
        description: cleanScreenshotError(e),
        variant: 'destructive',
      });
    },
    [finish, toast],
  );

  const deliver = useCallback(
    async (shot: Screenshot) => {
      finish();
      playShutter();
      flashScreen();

      const id = nextId.current++;
      setThumbnail({ id, shot, path: null });

      copy(shot);
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
    [copy, finish, toast],
  );

  useEffect(
    () =>
      onScreenshotRequest((request: ScreenshotRequest) => {
        const bridge = getScreenshotBridge();
        if (isScreenshotSessionActive() || !bridge) return;
        setScreenshotSessionActive(true);
        void (async () => {
          // The last capture's thumbnail mustn't end up in this one.
          if (thumbnailRef.current) {
            setThumbnail(null);
            await paintSettled();
          }
          let shot: Screenshot;
          try {
            shot = await captureDesktop(bridge);
          } catch (e) {
            return failed(e);
          }
          // An area is dragged out on this capture, not the live desktop.
          if (request === 'area') setFrozen(shot);
          else await deliver(shot);
        })();
      }),
    [deliver, failed],
  );

  const onSelect = useCallback(
    async (region: ViewportRect) => {
      if (!frozen) return;
      setFrozen(null);
      let shot: Screenshot;
      try {
        shot = await cropCapture(frozen, region);
      } catch (e) {
        return failed(e);
      }
      await deliver(shot);
    },
    [frozen, deliver, failed],
  );

  // Esc backs out of the area selection.
  useEffect(() => {
    if (!frozen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setFrozen(null);
      finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen, finish]);

  // Don't leave the desktop-wide flag set if the desktop goes away mid-session.
  useEffect(() => () => setScreenshotSessionActive(false), []);

  const dismiss = useCallback((id: number) => {
    setThumbnail((t) => (t?.id === id ? null : t));
  }, []);

  return (
    <>
      {frozen && <CaptureOverlay session={{ phase: 'select', frozen }} onSelect={onSelect} />}
      {thumbnail && (
        <CaptureThumbnail
          key={thumbnail.id}
          thumbnail={thumbnail}
          onOpen={(path) => {
            dismiss(thumbnail.id);
            open('preview', { path });
          }}
          onOpenWith={(appId, params) => {
            dismiss(thumbnail.id);
            open(appId, params);
          }}
          onCopy={() => copy(thumbnail.shot)}
          onTrash={async (path) => {
            dismiss(thumbnail.id);
            try {
              await getFsBridge()!.trash(path);
              void invalidateListings(queryClient, path);
            } catch (e) {
              toast({
                title: 'Could not move the screenshot to the Trash',
                description: cleanFsError(e),
                variant: 'destructive',
              });
            }
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
  if (prefersReducedMotion()) return;
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
  onOpenWith,
  onCopy,
  onTrash,
  onDismiss,
}: {
  thumbnail: Thumbnail;
  onOpen: (path: string) => void;
  onOpenWith: (appId: string, params: { path: string; select?: string }) => void;
  onCopy: () => void;
  onTrash: (path: string) => void;
  onDismiss: () => void;
}) {
  const { primary } = useMonitors();
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { shot, path } = thumbnail;

  // Hold still while the pointer is on it, it's being dragged, or its menu
  // is open; the countdown starts over when it leaves.
  useEffect(() => {
    if (hovered || dragging || menuOpen) return;
    const t = setTimeout(onDismiss, THUMBNAIL_MS);
    return () => clearTimeout(t);
  }, [hovered, dragging, menuOpen, onDismiss]);

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
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger asChild>
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
                onDragEnd={(e) => {
                  endFileDrag(e);
                  setDragging(false);
                  setHovered(false);
                }}
                title={path ? 'Click to open, or drag into Files' : 'Saving…'}
                aria-label={name ? `Open ${name}` : 'Screenshot taken'}
                className="block rounded-2xl glass-surface p-1.5 shadow-lg outline-none transition-transform motion-safe:hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-progress"
              >
                <img
                  src={shot.dataUrl}
                  alt=""
                  draggable={false}
                  style={{ width, height }}
                  className="block rounded-xl object-cover"
                />
              </button>
              <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="absolute -top-2 -left-2 grid size-7 place-items-center rounded-full glass-surface text-popover-foreground opacity-0 shadow-md outline-none transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <X className="size-4" strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          </ContextMenuTrigger>
          {/* Above the thumbnail's layer (z-[10000]). The file items wait for the save. */}
          <ContextMenuContent className="z-[10001] w-52">
            <ContextMenuItem disabled={!path} onSelect={() => path && onOpen(path)}>
              Open
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!path}
              onSelect={() => path && name && onOpenWith('file-browser', { path: parentPath(path), select: name })}
            >
              <FolderOpen />
              Show in Files
            </ContextMenuItem>
            <ContextMenuItem onSelect={onCopy}>
              <Copy />
              Copy Image
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!path} onSelect={() => path && onOpenWith('paint', { path })}>
              <Paintbrush />
              Edit in Paint
            </ContextMenuItem>
            <ContextMenuItem disabled={!path} onSelect={() => path && onOpenWith('photo-editor', { path })}>
              <Layers />
              Edit in Photo Editor
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" disabled={!path} onSelect={() => path && onTrash(path)}>
              <Trash2 />
              Move to Trash
            </ContextMenuItem>
            <ContextMenuItem onSelect={onDismiss}>
              <X />
              Dismiss
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </ScreenLayer>,
    portalContainer(),
  );
}
