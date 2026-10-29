import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/photo/styles';
import { css, swatchLabel, type Swatch, type Swatches } from './colors';

/** A swatch's little square: its color, None's red slash, a gradient's ramp. */
export function Chip({ sw, size = 14, stroke = false, className }: { sw: Swatch | null | undefined; size?: number; stroke?: boolean; className?: string }) {
  const style: React.CSSProperties = { width: size, height: size };
  if (!sw || sw.kind === 'none') {
    return (
      <span className={cn('relative inline-block shrink-0 border border-[#1a1a1a] bg-white', className)} style={style}>
        <svg viewBox="0 0 10 10" className="absolute inset-0 size-full" aria-hidden>
          <path d="M0 10 10 0" stroke="#e00" strokeWidth="1.4" />
        </svg>
      </span>
    );
  }
  if (sw.kind === 'gradient' && sw.gradient) {
    const stops = sw.gradient.stops.map((s) => `${css(s.rgb)} ${s.location}%`).join(', ');
    style.background = sw.gradient.type === 'Radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(to right, ${stops})`;
  } else style.background = css(sw.rgb);
  if (stroke) {
    return (
      <span className={cn('inline-block shrink-0 border border-[#1a1a1a]', className)} style={{ ...style, background: 'transparent', boxShadow: `inset 0 0 0 ${Math.max(2, size / 4)}px ${css(sw.rgb)}` }} />
    );
  }
  return <span className={cn('inline-block shrink-0 border border-[#1a1a1a]', className)} style={style} />;
}

/** A button showing a swatch; it opens the document's swatches to pick from. */
export function SwatchButton({
  value,
  swatches,
  onPick,
  label,
  stroke,
}: {
  value: string | null | undefined;
  swatches: Swatches;
  onPick: (self: string) => void;
  label: string;
  stroke?: boolean;
}) {
  const sw = value === undefined ? undefined : swatches.bySelf.get(value ?? 'Swatch/None');
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger aria-label={label} title={label} className={cn('flex h-[22px] items-center gap-0.5 rounded-[3px] px-1 hover:bg-[#4a4a4a]', FOCUS)}>
        {value === undefined ? <span className="size-[14px] border border-dashed border-[#8a8a8a]" /> : <Chip sw={sw} stroke={stroke} />}
        <svg viewBox="0 0 8 8" className="size-2 text-[#bdbdbd]" aria-hidden>
          <path d="M1 2.5h6L4 6Z" fill="currentColor" />
        </svg>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={4}
          align="start"
          onKeyDown={(e) => e.stopPropagation()}
          className="z-50 max-h-[60vh] w-[240px] overflow-y-auto rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 text-[#e0e0e0] shadow-xl shadow-black/40"
        >
          {swatches.list.map((s) => (
            <PopoverPrimitive.Close asChild key={s.self}>
              <button
                type="button"
                onClick={() => onPick(s.self)}
                className={cn('flex h-6 w-full items-center gap-2 rounded-[3px] px-1.5 text-left text-[11px] hover:bg-[#2d8ceb] hover:text-white', s.self === value && 'bg-[#4a4a4a]', FOCUS)}
              >
                <Chip sw={s} />
                <span className="min-w-0 flex-1 truncate">{swatchLabel(s)}</span>
              </button>
            </PopoverPrimitive.Close>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
