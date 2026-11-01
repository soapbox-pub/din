import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Compositor } from '../engine/compositor';
import { bubbleRect, CANVAS, MAX_BUBBLE, MIN_BUBBLE, type Bubble, type Layout } from '../engine/layout';

/**
 * The picture, as large as the window allows, with the camera bubble to drag
 * (and to resize, by its corner or the scroll wheel) when it's shown.
 */
export function Stage({
  compositor,
  layout,
  movable,
  onBubble,
  recording,
  countdown,
  onCancelCountdown,
  children,
}: {
  compositor: Compositor;
  layout: Layout;
  /** Whether the camera is a bubble on the screen right now. */
  movable: boolean;
  onBubble: (bubble: Bubble) => void;
  recording: boolean;
  countdown: number | null;
  onCancelCountdown: () => void;
  /** Shown over the picture: what's missing, or why. */
  children?: ReactNode;
}) {
  const area = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const canvas = CANVAS[layout.aspect];

  useLayoutEffect(() => (host.current ? compositor.mount(host.current) : undefined), [compositor]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      const pad = 24;
      const w = Math.max(0, el.clientWidth - pad * 2);
      const h = Math.max(0, el.clientHeight - pad * 2);
      const scale = Math.min(w / canvas.width, h / canvas.height);
      setBox({ width: Math.floor(canvas.width * scale), height: Math.floor(canvas.height * scale) });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [canvas.width, canvas.height]);

  const bubble = layout.bubbles[layout.aspect];
  const rect = bubbleRect(bubble, canvas);
  const scale = box.width / canvas.width || 0;

  // Dragging the bubble: from where it was grabbed, in canvas pixels.
  const drag = useRef<{ x: number; y: number; bubble: Bubble; resize: boolean } | null>(null);
  const begin = (e: React.PointerEvent, resize: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, bubble, resize };
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !scale) return;
    const dx = (e.clientX - d.x) / scale;
    const dy = (e.clientY - d.y) / scale;
    if (d.resize) {
      const short = Math.min(canvas.width, canvas.height);
      const grow = Math.max(dx, dy) / short;
      onBubble({ ...d.bubble, size: Math.min(MAX_BUBBLE, Math.max(MIN_BUBBLE, d.bubble.size + grow)) });
    } else {
      onBubble({ ...d.bubble, cx: d.bubble.cx + dx / canvas.width, cy: d.bubble.cy + dy / canvas.height });
    }
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.resize) return;
    // Settle where it was left: inside the picture, as it's drawn.
    const r = bubbleRect(bubble, canvas);
    onBubble({ ...bubble, cx: (r.x + r.width / 2) / canvas.width, cy: (r.y + r.height / 2) / canvas.height });
  };
  const nudge = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      onBubble({ ...bubble, cx: bubble.cx + m[0], cy: bubble.cy + m[1] });
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      const size = bubble.size + (e.key === '-' ? -0.02 : 0.02);
      onBubble({ ...bubble, size: Math.min(MAX_BUBBLE, Math.max(MIN_BUBBLE, size)) });
    }
  };

  // Scrolling over the bubble resizes it (a non-passive listener, to keep the page still).
  const bubbleEl = useRef<HTMLDivElement>(null);
  const latest = useRef({ bubble, onBubble });
  useLayoutEffect(() => {
    latest.current = { bubble, onBubble };
  });
  useEffect(() => {
    const el = bubbleEl.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { bubble: b, onBubble: set } = latest.current;
      set({ ...b, size: Math.min(MAX_BUBBLE, Math.max(MIN_BUBBLE, b.size - e.deltaY * 0.0008)) });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [movable]);

  return (
    <div ref={area} className="relative grid min-h-0 flex-1 place-items-center overflow-hidden">
      <div
        className={cn(
          'relative overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10 transition-shadow duration-300',
          recording && 'ring-2 ring-red-500/80 shadow-red-500/20',
        )}
        style={{ width: box.width, height: box.height }}
      >
        <div ref={host} className="absolute inset-0" />
        {movable && scale > 0 && countdown === null && (
          <div
            ref={bubbleEl}
            role="slider"
            tabIndex={0}
            aria-label="Camera bubble: arrow keys move it, plus and minus resize it"
            aria-valuemin={Math.round(MIN_BUBBLE * 100)}
            aria-valuemax={Math.round(MAX_BUBBLE * 100)}
            aria-valuenow={Math.round(bubble.size * 100)}
            onPointerDown={(e) => begin(e, false)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={nudge}
            className={cn(
              'group absolute cursor-grab outline-none active:cursor-grabbing',
              layout.shape === 'circle' ? 'rounded-full' : 'rounded-[18%]',
              'hover:ring-2 hover:ring-white/60 focus-visible:ring-2 focus-visible:ring-ring',
            )}
            style={{ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale }}
          >
            <span
              aria-hidden
              onPointerDown={(e) => begin(e, true)}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              className="absolute right-[6%] bottom-[6%] size-4 cursor-nwse-resize rounded-full border-2 border-white bg-black/50 opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          </div>
        )}
        {children && <div className="absolute inset-0 grid place-items-center p-6">{children}</div>}
        {countdown !== null && (
          <button
            type="button"
            onClick={onCancelCountdown}
            aria-label={`Starting in ${countdown}. Click to cancel.`}
            className="absolute inset-0 grid cursor-pointer place-items-center bg-black/45 backdrop-blur-[2px] outline-none"
          >
            <span key={countdown} className="text-[min(30vh,180px)] leading-none font-semibold text-white tabular-nums drop-shadow-lg motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:fade-in-0 motion-safe:duration-300">
              {countdown}
            </span>
            <span className="absolute bottom-6 text-sm text-white/70">Click or press Esc to cancel</span>
          </button>
        )}
      </div>
    </div>
  );
}
