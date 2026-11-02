import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { Music } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDocumentVisible } from '@/sdk/react';
import { useCover } from './useCover';
import { readFrame, visualizationById } from '../visualizations';

export function IconButton({
  label,
  className,
  children,
  ...rest
}: { label: string; children: ReactNode } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('mp-icon-btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A themed range input whose filled part follows its value. */
export function Range({
  value,
  min,
  max,
  step,
  onValue,
  label,
  vertical,
  className,
  style,
  thumb,
  ...rest
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValue: (value: number) => void;
  label: string;
  vertical?: boolean;
  thumb?: 'always';
} & Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'min' | 'max' | 'step'>) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      aria-label={label}
      title={label}
      min={min}
      max={max}
      step={step ?? 'any'}
      value={value}
      data-thumb={thumb}
      onChange={(e) => onValue(Number(e.target.value))}
      className={cn('mp-range', vertical && 'mp-vrange', className)}
      style={{ ...style, '--mp-fill': `${fill}%` } as CSSProperties}
      {...rest}
    />
  );
}

export function Cover({ location, className, iconClassName }: { location: string | null | undefined; className?: string; iconClassName?: string }) {
  const url = useCover(location);
  return (
    <div
      className={cn(
        'relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-[linear-gradient(135deg,color-mix(in_oklab,var(--mp-tint)_30%,var(--card)),color-mix(in_oklab,var(--mp-tint)_12%,var(--background)))] text-[var(--mp-ink-faint)]',
        className,
      )}
    >
      {url ? (
        <img src={url} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <Music className={cn('size-1/2', iconClassName)} strokeWidth={1.5} aria-hidden />
      )}
    </div>
  );
}

/**
 * A canvas running a visualization at the display's frame rate, sized to
 * its box, and idle while the window is hidden.
 */
export function VisCanvas({ vis, className, pixelScale = 1 }: { vis: string; className?: string; pixelScale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const visible = useDocumentVisible();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !visible) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const v = visualizationById(vis);
    const mem: Record<string, unknown> = {};
    const start = performance.now();
    let raf = 0;
    const resize = () => {
      const scale = (window.devicePixelRatio || 1) * pixelScale;
      const w = Math.max(1, Math.round(canvas.clientWidth * scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };
    let tintAt = 0;
    const loop = () => {
      resize();
      // The skin's tint, for visualizations drawn in it (checked now and then: it's a style lookup).
      if (performance.now() - tintAt > 1000) {
        tintAt = performance.now();
        const tint = getComputedStyle(canvas).getPropertyValue('--mp-tint').trim();
        if (tint) mem.tint = tint;
      }
      v.draw(ctx, canvas.width, canvas.height, readFrame((performance.now() - start) / 1000), mem);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [vis, visible, pixelScale]);
  return <canvas ref={ref} aria-hidden className={cn('block size-full', className)} />;
}

/** Text that slides back and forth when it doesn't fit. */
export function Marquee({ text, className }: { text: string; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const measure = () => setShift(Math.max(0, i.scrollWidth - o.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div ref={outer} className={cn('min-w-0 overflow-hidden whitespace-nowrap', className)} title={text}>
      <span
        ref={inner}
        className="mp-marquee inline-block"
        data-overflow={shift > 0}
        style={{ '--mp-marquee-shift': `-${shift}px` } as CSSProperties}
      >
        {text}
      </span>
    </div>
  );
}

/** Star rating, as WMP's library shows it. */
export function Stars({ value, onChange, size = 12 }: { value: number; onChange?: (rating: number) => void; size?: number }) {
  return (
    <span className="inline-flex" role={onChange ? 'radiogroup' : 'img'} aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role={onChange ? 'radio' : undefined}
          aria-checked={onChange ? value === n : undefined}
          aria-label={onChange ? `${n} star${n === 1 ? '' : 's'}` : undefined}
          tabIndex={onChange ? 0 : -1}
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(value === n ? 0 : n);
          }}
          className="px-px leading-none disabled:cursor-default"
          style={{ fontSize: size, color: n <= value ? 'hsl(45 100% 60%)' : 'var(--mp-ink-faint)', opacity: n <= value ? 1 : 0.5 }}
        >
          ★
        </button>
      ))}
    </span>
  );
}
