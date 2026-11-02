import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useDocumentVisible } from '@/sdk/react';
import { spriteStyle, useSkin } from './hooks';
import { FONT, SPRITES, type SpriteDef, type SpriteName } from '@/shared/skins/winamp/sprites';
import { readFrame } from '../visualizations';
import { player } from '../engine';

export function Sprite({
  name,
  def,
  x,
  y,
  style,
  className,
  children,
  ...rest
}: {
  name?: SpriteName;
  def?: SpriteDef;
  x: number;
  y: number;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
} & Omit<React.ComponentProps<'div'>, 'style'>) {
  const skin = useSkin();
  const d = def ?? SPRITES[name!];
  return (
    <div className={className} style={{ position: 'absolute', left: x, top: y, ...spriteStyle(skin, d), ...style }} {...rest}>
      {children}
    </div>
  );
}

/** A sprite button: shows its pressed sprite while held. */
export function SpriteButton({
  up,
  down,
  x,
  y,
  label,
  onClick,
  width,
  height,
}: {
  up: SpriteName | null;
  down: SpriteName | null;
  x: number;
  y: number;
  label: string;
  onClick: () => void;
  width?: number;
  height?: number;
}) {
  const skin = useSkin();
  const [pressed, setPressed] = useState(false);
  const def = pressed && down ? SPRITES[down] : up ? SPRITES[up] : null;
  const w = width ?? (up ? SPRITES[up][3] : 0);
  const h = height ?? (up ? SPRITES[up][4] : 0);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressed(true);
      }}
      onPointerUp={(e) => {
        const inside = e.currentTarget.contains(document.elementFromPoint(e.clientX, e.clientY));
        if (pressed && inside) onClick();
        setPressed(false);
      }}
      onPointerCancel={() => setPressed(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="absolute cursor-default p-0 outline-none focus-visible:outline-1 focus-visible:outline-dotted focus-visible:outline-white"
      style={{ left: x, top: y, width: w, height: h, ...(def ? spriteStyle(skin, def) : {}), ...(def ? {} : { background: 'transparent' }) }}
    />
  );
}

/** Text drawn with the skin's TEXT.BMP font. */
export function SkinText({ text, x = 0, y = 0, style }: { text: string; x?: number; y?: number; style?: CSSProperties }) {
  const skin = useSkin();
  const sheet = skin.sheets.text;
  return (
    <div aria-hidden style={{ position: 'absolute', left: x, top: y, height: 6, display: 'flex', ...style }}>
      {[...text.toLowerCase()].map((ch, i) => {
        const [row, col] = FONT[ch] ?? FONT[' '];
        return (
          <span
            key={i}
            style={{
              width: 5,
              height: 6,
              flex: 'none',
              backgroundImage: sheet ? `url("${sheet.url}")` : undefined,
              backgroundPosition: `-${col * 5}px -${row * 6}px`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Winamp's little visualizer: the spectrum analyzer (bars with peaks) or
 * the oscilloscope, in the skin's viscolor.txt colors, drawn at its native
 * pixel size and scaled up crisp.
 */
export function WinampVis({ x, y, width, height, mode, onClick }: { x: number; y: number; width: number; height: number; mode: number; onClick: () => void }) {
  const skin = useSkin();
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = useDocumentVisible();
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !visible) return;
    const colors = skin.visColors;
    const peaks = new Float32Array(width);
    const peakVel = new Float32Array(width);
    let raf = 0;
    const bars = Math.floor(width / 4);
    const draw = () => {
      ctx.fillStyle = colors[0];
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = colors[1];
      for (let yy = 1; yy < height; yy += 2) for (let xx = 1; xx < width; xx += 2) ctx.fillRect(xx, yy, 1, 1);
      const playing = player.getState().status === 'playing';
      if (mode !== 0 && playing) {
        const { freq, wave } = readFrame(0);
        if (mode === 1) {
          for (let b = 0; b < bars; b++) {
            // Log-spaced bins, as Winamp's analyzer leans on the bass.
            const lo = Math.floor(Math.pow(freq.length * 0.7, b / bars));
            const hi = Math.max(lo + 1, Math.floor(Math.pow(freq.length * 0.7, (b + 1) / bars)));
            let v = 0;
            for (let i = lo; i < hi; i++) v = Math.max(v, freq[i]);
            const h = Math.round((v / 255) * height);
            for (let row = 0; row < h; row++) {
              const yy = height - 1 - row;
              ctx.fillStyle = colors[2 + Math.min(15, Math.round((yy / (height - 1)) * 15))];
              ctx.fillRect(b * 4, yy, 3, 1);
            }
            if (h >= peaks[b]) {
              peaks[b] = h;
              peakVel[b] = 0;
            } else {
              peakVel[b] += 0.02;
              peaks[b] = Math.max(0, peaks[b] - peakVel[b]);
            }
            if (peaks[b] > 0.5) {
              ctx.fillStyle = colors[23];
              ctx.fillRect(b * 4, height - 1 - Math.round(peaks[b]), 3, 1);
            }
          }
        } else {
          let last = -1;
          for (let xx = 0; xx < width; xx++) {
            const s = wave[Math.floor((xx / width) * wave.length)];
            const yy = Math.max(0, Math.min(height - 1, Math.round(((s - 128) / 128) * (height / 2) + height / 2)));
            const amp = Math.abs(yy - height / 2) / (height / 2);
            ctx.fillStyle = colors[18 + Math.min(4, Math.floor(amp * 5))];
            const from = last === -1 ? yy : last;
            const top = Math.min(from, yy);
            ctx.fillRect(xx, top, 1, Math.abs(from - yy) + 1);
            last = yy;
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [skin, mode, width, height, visible]);
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      aria-label="Visualization (click to change)"
      style={{ position: 'absolute', left: x, top: y, width, height, imageRendering: 'pixelated' }}
    />
  );
}
