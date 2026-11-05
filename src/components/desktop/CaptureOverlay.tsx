import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { portalContainer } from '@/lib/portalContainer';
import { useMonitors } from '@/contexts/MonitorsContext';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import type { Screenshot, ViewportRect } from '@/lib/screenshot';

/** Ignore drags smaller than this on a side (a stray click, not a selection). */
const MIN_DRAG_PX = 4;

/**
 * The capture session: (in the Screenshot app, while its window sits
 * minimized out of the shot) counting down the chosen delay, then dragging
 * the region out on a frozen capture of the desktop.
 */
export type Session =
  | { phase: 'select'; frozen: Screenshot }
  | { phase: 'countdown'; left: number; recording?: boolean };

/** The drag rectangle between two viewport points, clamped to the viewport. */
function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): ViewportRect {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(window.innerWidth, Math.max(a.x, b.x));
  const y1 = Math.min(window.innerHeight, Math.max(a.y, b.y));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The capture overlay, over every monitor and portaled to <body> so it floats
 * above every desktop layer (dock included), shared by the Screenshot app
 * (while its window is minimized) and the Print Screen hotkeys. The
 * 'select' phase covers the desktop with a capture already taken, so the
 * screen holds still and the drag can't reach (and close) the menu or
 * popup being captured, the way GNOME and Pop!_OS do it; the region is cut
 * from that capture (releasing a sub-threshold drag just re-arms; Esc
 * cancels). The 'countdown' phase is pointer-transparent, so the user can
 * keep arranging the desktop - hover states, open menus - until it freezes.
 * The overlay is never up while capturePage runs, so it isn't in the shot.
 */
export function CaptureOverlay({
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

  // The selection takes the keyboard, so Esc reaches the desktop. Started
  // from the box-select key, which the Electron host hears itself, focus was
  // still in the app on top (a guest webview, or a native window's host,
  // which forwards keys to the app): Esc went there until a click on the
  // overlay moved it. Whatever had it gets it back afterwards.
  const layerRef = useRef<HTMLDivElement>(null);
  const selecting = session.phase === 'select';
  useEffect(() => {
    if (!selecting) return;
    const returnFocus = document.activeElement;
    const layer = layerRef.current;
    layer?.focus({ preventScroll: true });
    return () => {
      // Unless something else has taken it since (a click on a thumbnail).
      const active = document.activeElement;
      if (active && active !== document.body && active !== layer) return;
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, [selecting]);

  if (session.phase === 'countdown') {
    return createPortal(
      <ScreenLayer aria-live="polite" className="pointer-events-none z-[10000]">
        <div
          style={hintStyle}
          className="absolute -translate-x-1/2 rounded-full border border-border bg-background/90 px-3 py-1 text-xs text-foreground shadow-lg backdrop-blur"
        >
          {session.recording ? 'Recording' : 'Capturing'} in <span className="font-semibold tabular-nums">{session.left}</span>s
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
      ref={layerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Select an area to capture"
      className="z-[10000] cursor-crosshair touch-none select-none outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The capture fills the viewport, which is what the shell window captured. */}
      <img
        src={session.frozen.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-0 left-0 max-w-none"
        style={{ width: window.innerWidth, height: window.innerHeight }}
      />
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
