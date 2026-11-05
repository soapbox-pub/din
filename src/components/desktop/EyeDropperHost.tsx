import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { portalContainer } from '@/lib/portalContainer';
import { useMonitors } from '@/contexts/MonitorsContext';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { getScreenshotBridge, isScreenshotSessionActive, type Screenshot } from '@/lib/screenshot';
import { getEyeDropperBridge, hexColor, type EyeDropperRequest } from '@/lib/eyeDropper';

/** Screen pixels across the magnifier, an odd number so one is in the middle. */
const LOUPE_PIXELS = 11;
/** CSS pixels each of them is drawn at. */
const LOUPE_ZOOM = 10;
const LOUPE_SIZE = LOUPE_PIXELS * LOUPE_ZOOM;

interface Session {
  request: EyeDropperRequest;
  shot: Screenshot;
  /** The capture, decoded, to read pixels from. */
  pixels: HTMLCanvasElement;
}

/**
 * Desktop-lifetime host for web pages' EyeDropper (electron/eyedropper.mts):
 * a page's `new EyeDropper().open()` freezes the screen, as an area
 * screenshot does, and a magnifier follows the pointer over it. A click picks
 * the pixel in its middle; Esc or a right-click cancels. The arrow keys move
 * it a pixel at a time (ten with Shift), and Enter picks.
 *
 * Chromium's own eyedropper can't capture the screen under din-shell, so it
 * left pages with no cursor and nothing to pick; this replaces it.
 *
 * Renders nothing outside the Electron shell.
 */
export function EyeDropperHost() {
  const [session, setSession] = useState<Session | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const bridge = getEyeDropperBridge();
    if (!bridge) return;
    const offPick = bridge.onPick((request) => {
      const screenshot = getScreenshotBridge();
      // A screenshot's area overlay is up, or another pick: not now.
      if (busy.current || isScreenshotSessionActive() || !screenshot) {
        bridge.choose({ requestId: request.requestId, color: null, unavailable: !screenshot });
        return;
      }
      busy.current = true;
      void (async () => {
        try {
          const shot = await screenshot.capture();
          const pixels = await decode(shot);
          if (!busy.current) return;
          setSession({ request, shot, pixels });
        } catch (e) {
          console.error('eyedropper: could not capture the screen', e);
          busy.current = false;
          bridge.choose({ requestId: request.requestId, color: null, unavailable: true });
        }
      })();
    });
    const offCancel = bridge.onCancel((requestId) => {
      setSession((s) => {
        if (s?.request.requestId !== requestId) return s;
        busy.current = false;
        return null;
      });
    });
    return () => {
      offPick();
      offCancel();
    };
  }, []);

  const answer = useCallback((color: string | null) => {
    setSession((s) => {
      if (s) getEyeDropperBridge()?.choose({ requestId: s.request.requestId, color });
      busy.current = false;
      return null;
    });
  }, []);

  if (!session) return null;
  return <EyeDropperOverlay key={session.request.requestId} session={session} onAnswer={answer} />;
}

async function decode(shot: Screenshot): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = shot.dataUrl;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = shot.width;
  canvas.height = shot.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas');
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function EyeDropperOverlay({ session, onAnswer }: { session: Session; onAnswer: (color: string | null) => void }) {
  const { primary } = useMonitors();
  const layerRef = useRef<HTMLDivElement>(null);
  const loupeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const swatchRef = useRef<HTMLSpanElement>(null);
  /** The pixel of the capture in the middle of the magnifier, once the pointer has moved. */
  const at = useRef<{ x: number; y: number } | null>(null);
  const color = useRef<string | null>(null);
  const [shown, setShown] = useState(false);
  const frame = useRef(0);

  const { shot, pixels } = session;
  // The capture is of the shell window, which fills the viewport.
  const sx = shot.width / window.innerWidth;
  const sy = shot.height / window.innerHeight;

  const draw = useCallback(() => {
    frame.current = 0;
    const p = at.current;
    const loupe = loupeRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!p || !loupe || !canvas || !ctx) return;
    loupe.style.transform = `translate(${p.x / sx - LOUPE_SIZE / 2}px, ${p.y / sy - LOUPE_SIZE / 2}px)`;

    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(LOUPE_SIZE * dpr);
    if (canvas.width !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const half = (LOUPE_PIXELS - 1) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(pixels, p.x - half, p.y - half, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, size, size);

    // The grid between the pixels, and a ring round the middle one.
    const cell = size / LOUPE_PIXELS;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < LOUPE_PIXELS; i++) {
      const o = Math.round(i * cell) + 0.5;
      ctx.moveTo(o, 0);
      ctx.lineTo(o, size);
      ctx.moveTo(0, o);
      ctx.lineTo(size, o);
    }
    ctx.stroke();
    const c = Math.round(half * cell);
    const w = Math.round(cell);
    ctx.lineWidth = Math.max(2, Math.round(dpr * 1.5));
    ctx.strokeStyle = '#000';
    ctx.strokeRect(c - ctx.lineWidth / 2, c - ctx.lineWidth / 2, w + ctx.lineWidth, w + ctx.lineWidth);
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(c + 0.5, c + 0.5, w - 1, w - 1);

    const read = pixels.getContext('2d', { willReadFrequently: true });
    if (!read) return;
    const [r, g, b] = read.getImageData(p.x, p.y, 1, 1).data;
    const hex = hexColor(r, g, b);
    color.current = hex;
    if (labelRef.current) labelRef.current.textContent = hex.toUpperCase();
    if (swatchRef.current) swatchRef.current.style.background = hex;
  }, [pixels, sx, sy]);

  const moveTo = useCallback(
    (x: number, y: number) => {
      at.current = {
        x: Math.max(0, Math.min(shot.width - 1, Math.floor(x))),
        y: Math.max(0, Math.min(shot.height - 1, Math.floor(y))),
      };
      setShown(true);
      if (!frame.current) frame.current = requestAnimationFrame(draw);
    },
    [draw, shot.width, shot.height],
  );

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Drawn straight away once shown, not a frame late.
  useEffect(() => {
    if (shown) draw();
  }, [shown, draw]);

  // Keys come here, not to the page underneath.
  useEffect(() => {
    layerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 1;
      const p = at.current ?? {
        x: (primary.x + primary.width / 2) * sx,
        y: (primary.y + primary.height / 2) * sy,
      };
      const moves: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      if (e.key === 'Escape') onAnswer(null);
      else if ((e.key === 'Enter' || e.key === ' ') && at.current) onAnswer(color.current);
      else if (moves[e.key]) moveTo(p.x + moves[e.key][0], p.y + moves[e.key][1]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [moveTo, onAnswer, primary, sx, sy]);

  const host = (() => {
    try {
      return new URL(session.request.origin).host || session.request.origin;
    } catch {
      return session.request.origin;
    }
  })();

  return createPortal(
    <ScreenLayer
      ref={layerRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Pick a color for ${host}`}
      className={`z-[10000] touch-none select-none outline-none ${shown ? 'cursor-none' : 'cursor-crosshair'}`}
      onPointerDown={(e) => {
        // Not through to the window underneath, by way of React's tree.
        e.stopPropagation();
        e.preventDefault();
        if (e.button === 2) return onAnswer(null);
        if (e.button !== 0) return;
        moveTo(e.clientX * sx, e.clientY * sy);
        draw();
        onAnswer(color.current);
      }}
      onPointerMove={(e) => {
        e.stopPropagation();
        moveTo(e.clientX * sx, e.clientY * sy);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* The frozen screen, as CaptureOverlay lays it: the capture fills the viewport. */}
      <img
        src={shot.dataUrl}
        alt=""
        draggable={false}
        className="pointer-events-none absolute top-0 left-0 max-w-none"
        style={{ width: window.innerWidth, height: window.innerHeight }}
      />
      <div
        ref={loupeRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0"
        style={{ width: LOUPE_SIZE, height: LOUPE_SIZE, visibility: shown ? 'visible' : 'hidden' }}
      >
        <canvas
          ref={canvasRef}
          className="block size-full rounded-full shadow-[0_2px_12px_rgba(0,0,0,0.35)] ring-2 ring-white outline outline-1 outline-black/40"
        />
        <div className="absolute top-full left-1/2 mt-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-black/80 py-1 pr-2.5 pl-1.5 font-mono text-xs leading-none text-white shadow-lg">
          <span ref={swatchRef} className="size-3 rounded-full ring-1 ring-white/70" />
          <span ref={labelRef} />
        </div>
      </div>
      <div
        role="status"
        style={{ left: primary.x + primary.width / 2, top: primary.y + 20 }}
        className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap glass-surface rounded-full px-3 py-1 text-xs text-foreground"
      >
        Click to pick a color for {host}
        <span className="text-muted-foreground"> &middot; Esc to cancel</span>
      </div>
    </ScreenLayer>,
    portalContainer(),
  );
}
