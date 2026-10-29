import { useLayoutEffect, useRef, useState } from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { hsvToRgb, rgbToHsv } from './adjust';
import { NumberField } from './chrome';
import { FOCUS, INPUT } from './styles';
import { hexToRgb, rgbToHex } from './paint';

/** Photoshop's color picker in small: a saturation/brightness square, a hue strip, and the numbers. */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [r, g, b] = hexToRgb(value);
  const [h0, s, v] = rgbToHsv(r, g, b);
  // Grays have no hue; remember the last one so the square doesn't jump to red.
  const [hue, setHue] = useState(h0);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    if (s > 0 && v > 0) setHue(h0);
  }
  const squareRef = useRef<HTMLCanvasElement>(null);
  const [hex, setHex] = useState<string | null>(null);

  useLayoutEffect(() => {
    const c = squareRef.current?.getContext('2d');
    if (!c) return;
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    c.fillStyle = `rgb(${hr},${hg},${hb})`;
    c.fillRect(0, 0, 128, 128);
    const white = c.createLinearGradient(0, 0, 128, 0);
    white.addColorStop(0, '#fff');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = white;
    c.fillRect(0, 0, 128, 128);
    const black = c.createLinearGradient(0, 0, 0, 128);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, '#000');
    c.fillStyle = black;
    c.fillRect(0, 0, 128, 128);
  }, [hue]);

  const pick = (e: React.PointerEvent, el: HTMLElement, fn: (x: number, y: number) => void) => {
    const r = el.getBoundingClientRect();
    fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  const setSV = (x: number, y: number) => {
    const [nr, ng, nb] = hsvToRgb(hue, x, 1 - y);
    onChange(rgbToHex(nr, ng, nb));
  };
  const setH = (_x: number, y: number) => {
    const nh = (1 - y) * 360;
    setHue(nh);
    const [nr, ng, nb] = hsvToRgb(nh, s, v);
    onChange(rgbToHex(nr, ng, nb));
  };
  const drag = (fn: (x: number, y: number) => void) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      pick(e, e.currentTarget, fn);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (e.buttons & 1) pick(e, e.currentTarget, fn);
    },
  });

  return (
    <div className="flex gap-2">
      <div className="relative aspect-square min-w-0 flex-1 touch-none" {...drag(setSV)}>
        <canvas ref={squareRef} width={128} height={128} className="block size-full cursor-crosshair rounded-[2px]" aria-label="Saturation and brightness" />
        <span
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#000]"
          style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
        />
      </div>
      <div
        className="relative w-3 shrink-0 cursor-ns-resize touch-none rounded-[2px]"
        style={{ background: 'linear-gradient(to top, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        aria-label="Hue"
        {...drag(setH)}
      >
        <span className="pointer-events-none absolute -inset-x-0.5 h-1 -translate-y-1/2 rounded-sm border border-white shadow-[0_0_0_1px_#000]" style={{ top: `${(1 - hue / 360) * 100}%` }} />
      </div>
      <div className="flex w-[76px] shrink-0 flex-col gap-1">
        <NumberField label="H" value={Math.round(hue)} min={0} max={360} unit="°" width="w-12" onChange={(x) => setH(0, 1 - x / 360)} />
        <NumberField label="S" value={Math.round(s * 100)} min={0} max={100} unit="%" width="w-12" onChange={(x) => onChange(rgbToHex(...hsvToRgb(hue, x / 100, v)))} />
        <NumberField label="B" value={Math.round(v * 100)} min={0} max={100} unit="%" width="w-12" onChange={(x) => onChange(rgbToHex(...hsvToRgb(hue, s, x / 100)))} />
        <NumberField label="R" value={r} min={0} max={255} width="w-12" onChange={(x) => onChange(rgbToHex(x, g, b))} />
        <NumberField label="G" value={g} min={0} max={255} width="w-12" onChange={(x) => onChange(rgbToHex(r, x, b))} />
        <NumberField label="B" value={b} min={0} max={255} width="w-12" onChange={(x) => onChange(rgbToHex(r, g, x))} />
        <label className="flex items-center gap-1 text-xs text-[#bdbdbd]">
          #
          <input
            aria-label="Hex color"
            value={hex ?? value.slice(1)}
            onFocus={() => setHex(value.slice(1))}
            onChange={(e) => setHex(e.target.value)}
            onBlur={() => {
              if (hex && /^[0-9a-f]{6}$/i.test(hex)) onChange(`#${hex.toLowerCase()}`);
              else if (hex && /^[0-9a-f]{3}$/i.test(hex)) onChange(`#${hex.replace(/./g, (c) => c + c).toLowerCase()}`);
              setHex(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={cn(INPUT, 'w-[64px] font-mono')}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}

/** A color swatch that opens the picker in a popover. */
export function ColorWell({ value, onChange, label, className }: { value: string; onChange: (hex: string) => void; label: string; className?: string }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        aria-label={label}
        title={label}
        className={cn('h-6 w-10 shrink-0 rounded-[3px] border border-[#1f1f1f] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]', FOCUS, className)}
        style={{ background: value }}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          sideOffset={4}
          onKeyDown={(e) => e.stopPropagation()}
          className="z-50 w-[300px] rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-3 text-[#e0e0e0] shadow-xl shadow-black/40"
        >
          <ColorPicker value={value} onChange={onChange} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
