import { useRef, useState } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalSpaceAround,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus,
  Lock,
  SquareDashed,
  SquareSplitHorizontal,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, IconButton, NumberField, Select } from '../photo/chrome';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../photo/contextMenu';
import { FOCUS, INPUT } from '../photo/styles';
import { LengthField, PaintChip } from './bars';
import { BLEND_OPTIONS, STROKE_WEIGHTS } from './units';
import { hexColor, toHex, toRgb, type Color } from './pdf/color';
import { colorAt, cssPaint, CMYK_SWATCHES, gradientAngle, GRADIENT_SWATCHES, rgbToCmyk, RGB_SWATCHES, setGradientAngle } from './paint';
import { itemLabel, type Artboard, type Blend, type Doc, type GradStop, type Gradient, type Item, type Layer, type Paint, type Rect, type Stroke, type TextItem, type Units } from './model';
import type { AlignHow, DistributeHow } from './ops';

const FONT_FAMILIES = ['Arial', 'Helvetica', 'Myriad Pro', 'Minion Pro', 'Times New Roman', 'Courier New', 'Calibri', 'Cambria', 'Inter', 'Georgia', 'Verdana'];
const FONT_STYLES = ['Regular', 'Italic', 'Bold', 'Bold Italic', 'Light', 'Semibold', 'Black'];
const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 21, 24, 36, 48, 60, 72];

// ---- Color --------------------------------------------------------------------------------

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function Slider({ label, value, max, onChange, track, unit }: { label: string; value: number; max: number; onChange: (v: number) => void; track: string; unit?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 text-xs text-[#cfcfcf]">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max}
        step={max > 100 ? 1 : 0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn('h-3 min-w-0 flex-1 cursor-pointer appearance-none rounded-[2px] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:bg-white', FOCUS)}
        style={{ background: track }}
      />
      <NumberField value={Math.round(value * 10) / 10} min={0} max={max} onChange={onChange} unit={unit} width="w-12" decimals={max > 100 ? 0 : 1} />
    </div>
  );
}

/** Illustrator's Color panel: sliders in the color's own mode, hex, and a spectrum. */
export function ColorEditor({ color, onChange, mode }: { color: Color; onChange: (c: Color) => void; mode: 'rgb' | 'cmyk' }) {
  const [hexText, setHexText] = useState<string | null>(null);
  const space = color.space;
  const c = color.c;
  const set = (i: number, v: number) => onChange({ space, c: c.map((x, j) => (j === i ? v : x)) });
  const [r, g, b] = toRgb(color);
  const css = (rr: number, gg: number, bb: number) => `rgb(${Math.round(rr * 255)},${Math.round(gg * 255)},${Math.round(bb * 255)})`;
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center justify-between">
        <span className="h-7 w-10 rounded-[2px] border border-[#111]" style={{ background: toHex(color) }} aria-hidden />
        <Select
          label="Color mode"
          value={space}
          onChange={(v) => {
            if (v === space) return;
            if (v === 'rgb') onChange({ space: 'rgb', c: [r, g, b] });
            else if (v === 'gray') onChange({ space: 'gray', c: [clamp01(0.3 * r + 0.59 * g + 0.11 * b)] });
            else {
              const k = 1 - Math.max(r, g, b);
              const d = 1 - k || 1;
              onChange({ space: 'cmyk', c: [(1 - r - k) / d, (1 - g - k) / d, (1 - b - k) / d, k] });
            }
          }}
          options={[
            ['gray', 'Grayscale'],
            ['rgb', 'RGB'],
            ['cmyk', 'CMYK'],
          ]}
        />
      </div>
      {space === 'rgb' &&
        (['R', 'G', 'B'] as const).map((l, i) => (
          <Slider
            key={l}
            label={l}
            value={Math.round(c[i] * 255)}
            max={255}
            onChange={(v) => set(i, v / 255)}
            track={`linear-gradient(to right, ${css(i === 0 ? 0 : r, i === 1 ? 0 : g, i === 2 ? 0 : b)}, ${css(i === 0 ? 1 : r, i === 1 ? 1 : g, i === 2 ? 1 : b)})`}
          />
        ))}
      {space === 'cmyk' &&
        (['C', 'M', 'Y', 'K'] as const).map((l, i) => (
          <Slider
            key={l}
            label={l}
            value={Math.round(c[i] * 1000) / 10}
            max={100}
            unit="%"
            onChange={(v) => set(i, v / 100)}
            track={`linear-gradient(to right, #fff, ${['#00aeef', '#ec008c', '#fff200', '#000'][i]})`}
          />
        ))}
      {space === 'gray' && <Slider label="K" value={Math.round((1 - c[0]) * 1000) / 10} max={100} unit="%" onChange={(v) => set(0, 1 - v / 100)} track="linear-gradient(to right, #fff, #000)" />}
      <label className="flex items-center gap-1.5 text-xs text-[#bdbdbd]">
        #
        <input
          aria-label="Hex color"
          value={hexText ?? toHex(color).slice(1)}
          onFocus={() => setHexText(toHex(color).slice(1))}
          onChange={(e) => setHexText(e.target.value)}
          onBlur={() => {
            if (hexText && /^[0-9a-f]{6}$/i.test(hexText)) {
              const h = hexColor(`#${hexText}`);
              onChange(mode === 'cmyk' && space === 'cmyk' ? rgbToCmyk(h) : h);
            }
            setHexText(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className={cn(INPUT, 'w-20 font-mono')}
          spellCheck={false}
        />
      </label>
      <div
        className="h-6 cursor-crosshair rounded-[2px] border border-[#111]"
        style={{ background: 'linear-gradient(to bottom, rgba(255,255,255,1), rgba(255,255,255,0) 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,1)), linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
        role="slider"
        aria-label="Color spectrum"
        aria-valuenow={0}
        tabIndex={-1}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const pick = (ev: { clientX: number; clientY: number }) => {
            const rect = el.getBoundingClientRect();
            const x = clamp01((ev.clientX - rect.left) / rect.width);
            const y = clamp01((ev.clientY - rect.top) / rect.height);
            const hue = x * 6;
            const k = Math.floor(hue) % 6;
            const f = hue - Math.floor(hue);
            const base = [
              [1, f, 0],
              [1 - f, 1, 0],
              [0, 1, f],
              [0, 1 - f, 1],
              [f, 0, 1],
              [1, 0, 1 - f],
            ][k];
            const mix = y < 0.5 ? base.map((v) => v + (1 - v) * (1 - y * 2)) : base.map((v) => v * (1 - (y - 0.5) * 2));
            const col: Color = { space: 'rgb', c: mix };
            onChange(space === 'cmyk' ? rgbToCmyk(col) : space === 'gray' ? { space: 'gray', c: [0.3 * mix[0] + 0.59 * mix[1] + 0.11 * mix[2]] } : col);
          };
          pick(e);
          const move = (ev: PointerEvent) => pick(ev);
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
      />
    </div>
  );
}

// ---- Panels ---------------------------------------------------------------------------------

export function PaintEditor({
  paint,
  onChange,
  mode,
  bounds,
}: {
  paint: Paint;
  onChange: (p: Paint) => void;
  mode: 'rgb' | 'cmyk';
  bounds: Rect | null;
}) {
  if (paint.type === 'gradient') return <GradientEditor gradient={paint.gradient} onChange={(g) => onChange({ type: 'gradient', gradient: g })} mode={mode} />;
  const color: Color = paint.type === 'color' ? paint.color : mode === 'cmyk' ? { space: 'cmyk', c: [0, 0, 0, 0] } : { space: 'rgb', c: [1, 1, 1] };
  void bounds;
  return <ColorEditor color={color} mode={mode} onChange={(c) => onChange({ type: 'color', color: c })} />;
}

export function SwatchesPanel({ mode, onPick, recent, used }: { mode: 'rgb' | 'cmyk'; onPick: (p: Paint, gradient?: (typeof GRADIENT_SWATCHES)[number]) => void; recent: Paint[]; used: { name: string; paint: Paint }[] }) {
  const list = mode === 'cmyk' ? CMYK_SWATCHES : RGB_SWATCHES;
  return (
    <div className="space-y-2 p-2">
      {used.length > 0 && (
        <div className="flex flex-wrap gap-0.5 border-b border-[#2a2a2a] pb-2" aria-label="Colors in this document">
          {used.map((s, i) => (
            <button key={i} type="button" title={s.name} aria-label={s.name} onClick={() => onPick(s.paint)} className={cn('size-5 border border-[#111]', FOCUS)}>
              <PaintChip paint={s.paint} className="size-full" />
            </button>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="flex flex-wrap gap-0.5" aria-label="Recently used colors">
          {recent.map((p, i) => (
            <button key={i} type="button" title="Recent color" aria-label="Recent color" onClick={() => onPick(p)} className={cn('size-5 border border-[#111]', FOCUS)}>
              <PaintChip paint={p} className="size-full" />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-0.5">
        {list.map((s) => (
          <button key={s.name} type="button" title={s.name} aria-label={s.name} onClick={() => onPick(s.paint)} className={cn('size-5 border border-[#111]', FOCUS)}>
            <PaintChip paint={s.paint} className="size-full" />
          </button>
        ))}
        {GRADIENT_SWATCHES.map((g) => (
          <button key={g.name} type="button" title={g.name} aria-label={g.name} onClick={() => onPick({ type: 'none' }, g)} className={cn('size-5 border border-[#111]', FOCUS)}>
            <span className="block size-full" style={{ background: cssPaint({ type: 'gradient', gradient: { type: g.type, stops: g.stops, matrix: [1, 0, 0, 1, 0, 0] } }) }} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function StrokePanel({ stroke, onChange }: { stroke: Stroke; onChange: (s: Partial<Stroke>) => void }) {
  const dashed = stroke.dash.length > 0;
  const [dash, setDash] = useState<number[]>(stroke.dash.length ? stroke.dash : [12, 0, 0, 0, 0, 0]);
  const btn = (pressed: boolean) => cn('h-6 rounded-[3px] border border-[#1f1f1f] px-2 text-[11px]', pressed ? 'bg-[#1f1f1f] text-white' : 'bg-[#3a3a3a] text-[#cfcfcf] hover:bg-[#4a4a4a]', FOCUS);
  return (
    <div className="space-y-2.5 p-3 text-xs">
      <div className="flex items-center gap-2">
        <NumberField label="Weight:" value={stroke.width} onChange={(width) => onChange({ width })} min={0} max={1000} decimals={2} unit="pt" width="w-16" />
        <Select label="Stroke weights" value="" className="w-6 px-0" onChange={(v) => v && onChange({ width: Number(v) })} options={[['', ''], ...STROKE_WEIGHTS.map((w) => [String(w), `${w} pt`] as [string, string])]} />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-10 text-[#bdbdbd]">Cap:</span>
        {(['Butt', 'Round', 'Projecting'] as const).map((n, i) => (
          <button key={n} type="button" aria-pressed={stroke.cap === i} title={`${n} Cap`} onClick={() => onChange({ cap: i as 0 | 1 | 2 })} className={btn(stroke.cap === i)}>
            {n}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-10 text-[#bdbdbd]">Corner:</span>
        {(['Miter', 'Round', 'Bevel'] as const).map((n, i) => (
          <button key={n} type="button" aria-pressed={stroke.join === i} title={`${n} Join`} onClick={() => onChange({ join: i as 0 | 1 | 2 })} className={btn(stroke.join === i)}>
            {n}
          </button>
        ))}
      </div>
      <NumberField label="Limit:" value={stroke.miter} onChange={(miter) => onChange({ miter })} min={1} max={500} width="w-12" />
      <label className="flex items-center gap-1.5 text-[#d6d6d6]">
        <input type="checkbox" checked={dashed} onChange={(e) => onChange({ dash: e.target.checked ? dash.filter((d, i) => d > 0 || i === 0).slice(0, 6) : [] })} onKeyDown={(e) => e.stopPropagation()} className="accent-[#2d8ceb]" />
        Dashed Line
      </label>
      {dashed && (
        <div className="grid grid-cols-6 gap-1">
          {dash.map((v, i) => (
            <label key={i} className="flex flex-col items-center gap-0.5 text-[10px] text-[#9a9a9a]">
              <NumberField
                value={v}
                min={0}
                max={1000}
                width="w-10"
                onChange={(x) => {
                  const next = dash.map((d, j) => (j === i ? x : d));
                  setDash(next);
                  let end = next.length;
                  while (end > 1 && !next[end - 1]) end--;
                  const used = next.slice(0, end);
                  onChange({ dash: used.length === 1 ? [used[0], used[0]] : used });
                }}
              />
              {i % 2 ? 'gap' : 'dash'}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function GradientEditor({ gradient, onChange, mode }: { gradient: Gradient; onChange: (g: Gradient) => void; mode: 'rgb' | 'cmyk' }) {
  const [active, setActive] = useState(0);
  const stops = gradient.stops;
  const sel = Math.min(active, stops.length - 1);
  const setStops = (s: GradStop[]) => onChange({ ...gradient, stops: s });
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="flex items-center gap-2">
        <Select
          label="Type"
          value={gradient.type}
          onChange={(type) => onChange({ ...gradient, type, focal: undefined })}
          options={[
            ['linear', 'Linear'],
            ['radial', 'Radial'],
          ]}
        />
        {gradient.type === 'linear' && <NumberField label="Angle:" value={gradientAngle(gradient)} min={-180} max={180} decimals={1} unit="°" width="w-14" onChange={(a) => onChange(setGradientAngle(gradient, a))} />}
        <IconButton label="Reverse Gradient" onClick={() => setStops(stops.map((s) => ({ ...s, t: 1 - s.t })))}>
          ⇄
        </IconButton>
      </div>
      <div
        className="relative h-5 rounded-[2px] border border-[#111]"
        style={{ background: cssPaint({ type: 'gradient', gradient: { ...gradient, type: 'linear' } }) }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const r = e.currentTarget.getBoundingClientRect();
          const t = clamp01((e.clientX - r.left) / r.width);
          const next = [...stops, { t, color: colorAt(stops, t), opacity: 1 }];
          setStops(next);
          setActive(next.length - 1);
        }}
        title="Click to add a color stop"
      >
        {stops.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Color stop ${i + 1}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              setActive(i);
              const bar = e.currentTarget.parentElement!;
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              const startY = e.clientY;
              const move = (ev: PointerEvent) => {
                const r = bar.getBoundingClientRect();
                // Dragging a stop off the bar removes it, as in Illustrator.
                if (Math.abs(ev.clientY - startY) > 40 && stops.length > 2) return;
                const t = clamp01((ev.clientX - r.left) / r.width);
                onChange({ ...gradient, stops: stops.map((x, j) => (j === i ? { ...x, t } : x)) });
              };
              const up = (ev: PointerEvent) => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                if (Math.abs(ev.clientY - startY) > 40 && stops.length > 2) setStops(stops.filter((_, j) => j !== i));
              };
              el.addEventListener('pointermove', move);
              el.addEventListener('pointerup', up);
            }}
            className={cn('absolute top-full mt-0.5 h-3 w-2.5 -translate-x-1/2 border border-[#111]', i === sel && 'ring-1 ring-white', FOCUS)}
            style={{ left: `${s.t * 100}%`, background: toHex(s.color) }}
          />
        ))}
      </div>
      <div className="h-2" />
      {stops[sel] && (
        <>
          <div className="flex items-center gap-2">
            <NumberField label="Location:" value={Math.round(stops[sel].t * 1000) / 10} min={0} max={100} decimals={1} unit="%" width="w-14" onChange={(v) => setStops(stops.map((s, j) => (j === sel ? { ...s, t: v / 100 } : s)))} />
            <NumberField label="Opacity:" value={Math.round(stops[sel].opacity * 100)} min={0} max={100} unit="%" width="w-14" onChange={(v) => setStops(stops.map((s, j) => (j === sel ? { ...s, opacity: v / 100 } : s)))} />
            {stops.length > 2 && (
              <IconButton label="Delete Stop" onClick={() => setStops(stops.filter((_, j) => j !== sel))}>
                <Trash2 className="size-3.5" />
              </IconButton>
            )}
          </div>
          <ColorEditor color={stops[sel].color} mode={mode} onChange={(c) => setStops(stops.map((s, j) => (j === sel ? { ...s, color: c } : s)))} />
        </>
      )}
    </div>
  );
}

export function TransparencyPanel({ opacity, blend, onOpacity, onBlend }: { opacity: number; blend: Blend; onOpacity: (v: number) => void; onBlend: (b: Blend) => void }) {
  return (
    <div className="flex items-center gap-2 p-3 text-xs">
      <Select label="Blending Mode" value={blend} onChange={onBlend} options={BLEND_OPTIONS} className="w-28" />
      <NumberField label="Opacity:" value={Math.round(opacity * 100)} onChange={(v) => onOpacity(v / 100)} min={0} max={100} unit="%" width="w-14" />
    </div>
  );
}

export interface TypeStyle {
  family: string;
  style: string;
  size: number;
  leading: number;
  tracking: number;
  hscale: number;
  rise: number;
  align: TextItem['align'];
}

export function CharacterPanel({ value, onChange }: { value: TypeStyle; onChange: (p: Partial<TypeStyle>) => void }) {
  const families = FONT_FAMILIES.includes(value.family) ? FONT_FAMILIES : [value.family, ...FONT_FAMILIES];
  const styles = FONT_STYLES.includes(value.style) ? FONT_STYLES : [value.style, ...FONT_STYLES];
  return (
    <div className="space-y-2 p-3 text-xs">
      <Select label="Font family" value={value.family} onChange={(family) => onChange({ family })} options={families.map((f) => [f, f] as [string, string])} className="w-full" />
      <Select label="Font style" value={value.style} onChange={(style) => onChange({ style })} options={styles.map((f) => [f, f] as [string, string])} className="w-full" />
      <div className="grid grid-cols-2 gap-2">
        <span className="flex items-center gap-1">
          <NumberField label="Size" title="Font Size" value={value.size} onChange={(size) => onChange({ size: Math.max(0.1, size) })} min={0.1} max={1296} decimals={1} unit="pt" width="w-14" />
          <Select label="Font sizes" value="" className="w-6 px-0" onChange={(v) => v && onChange({ size: Number(v) })} options={[['', ''], ...FONT_SIZES.map((s) => [String(s), `${s} pt`] as [string, string])]} />
        </span>
        <NumberField label="Lead" title="Leading (0 is Auto)" value={value.leading} onChange={(leading) => onChange({ leading: Math.max(0, leading) })} min={0} max={5000} decimals={1} unit="pt" width="w-14" />
        <NumberField label="VA" title="Tracking" value={value.tracking} onChange={(tracking) => onChange({ tracking })} min={-1000} max={10000} width="w-14" />
        <NumberField label="Scale" title="Horizontal Scale" value={Math.round(value.hscale * 100)} onChange={(v) => onChange({ hscale: Math.max(0.01, v / 100) })} min={1} max={10000} unit="%" width="w-14" />
        <NumberField label="Shift" title="Baseline Shift" value={value.rise} onChange={(rise) => onChange({ rise })} min={-1000} max={1000} decimals={1} unit="pt" width="w-14" />
      </div>
    </div>
  );
}

export function ParagraphPanel({ align, onAlign }: { align: TextItem['align']; onAlign: (a: TextItem['align']) => void }) {
  const opts: [TextItem['align'], string, React.ReactNode][] = [
    ['left', 'Align left', <TextAlignStart key="l" className="size-4" />],
    ['center', 'Align center', <TextAlignCenter key="c" className="size-4" />],
    ['right', 'Align right', <TextAlignEnd key="r" className="size-4" />],
    ['justify', 'Justify with last line aligned left', <TextAlignJustify key="j" className="size-4" />],
  ];
  return (
    <div className="flex gap-1 p-3">
      {opts.map(([a, label, icon]) => (
        <IconButton key={a} label={label} pressed={align === a} onClick={() => onAlign(a)}>
          {icon}
        </IconButton>
      ))}
    </div>
  );
}

export function AlignPanel({ onAlign, onDistribute, alignTo, onAlignTo, count }: { onAlign: (h: AlignHow) => void; onDistribute: (h: DistributeHow) => void; alignTo: 'selection' | 'artboard'; onAlignTo: (v: 'selection' | 'artboard') => void; count: number }) {
  const aligns: [AlignHow, string, React.ReactNode][] = [
    ['left', 'Horizontal Align Left', <AlignStartVertical key="1" className="size-4" />],
    ['hcenter', 'Horizontal Align Center', <AlignCenterVertical key="2" className="size-4" />],
    ['right', 'Horizontal Align Right', <AlignEndVertical key="3" className="size-4" />],
    ['top', 'Vertical Align Top', <AlignStartHorizontal key="4" className="size-4" />],
    ['vcenter', 'Vertical Align Center', <AlignCenterHorizontal key="5" className="size-4" />],
    ['bottom', 'Vertical Align Bottom', <AlignEndHorizontal key="6" className="size-4" />],
  ];
  const dists: [DistributeHow, string, React.ReactNode][] = [
    ['hcenter', 'Horizontal Distribute Center', <AlignHorizontalDistributeCenter key="1" className="size-4" />],
    ['vcenter', 'Vertical Distribute Center', <AlignVerticalDistributeCenter key="2" className="size-4" />],
    ['hspace', 'Horizontal Distribute Space', <AlignHorizontalSpaceAround key="3" className="size-4" />],
    ['vspace', 'Vertical Distribute Space', <AlignVerticalSpaceAround key="4" className="size-4" />],
  ];
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="text-[#bdbdbd]">Align Objects:</div>
      <div className="flex gap-0.5">
        {aligns.map(([h, label, icon]) => (
          <IconButton key={h} label={label} disabled={!count} onClick={() => onAlign(h)}>
            {icon}
          </IconButton>
        ))}
      </div>
      <div className="text-[#bdbdbd]">Distribute Objects:</div>
      <div className="flex gap-0.5">
        {dists.map(([h, label, icon]) => (
          <IconButton key={h} label={label} disabled={count < 3} onClick={() => onDistribute(h)}>
            {icon}
          </IconButton>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[#bdbdbd]">Align To:</span>
        <Select
          label="Align To"
          value={alignTo}
          onChange={onAlignTo}
          options={[
            ['selection', 'Align to Selection'],
            ['artboard', 'Align to Artboard'],
          ]}
        />
      </div>
    </div>
  );
}

export function ArtboardsPanel({ artboards, active, onActivate, onRename, onAdd, onDelete }: { artboards: Artboard[]; active: number; onActivate: (i: number) => void; onRename: (i: number, name: string) => void; onAdd: () => void; onDelete: (i: number) => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const keepFocus = useRef(false);
  return (
    <div className="flex flex-col">
      <ul className="max-h-48 overflow-y-auto py-1" role="listbox" aria-label="Artboards">
        {artboards.map((a, i) => (
          <ContextMenu key={a.id}>
            <ContextMenuTrigger asChild disabled={editing === i}>
              <li
                role="option"
                aria-selected={i === active}
                onClick={() => onActivate(i)}
                onDoubleClick={() => setEditing(i)}
                className={cn('flex h-7 cursor-default items-center gap-2 px-3 text-xs', i === active ? 'bg-[#4b4b4b] text-white' : 'text-[#d6d6d6] hover:bg-[#424242]')}
              >
                <span className="w-4 text-right text-[#9a9a9a] tabular-nums">{i + 1}</span>
                {editing === i ? (
                  <input
                    autoFocus
                    defaultValue={a.name}
                    aria-label="Artboard name"
                    onBlur={(e) => {
                      onRename(i, e.target.value || a.name);
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className={cn(INPUT, 'h-5 flex-1')}
                  />
                ) : (
                  <span className="flex-1 truncate">{a.name}</span>
                )}
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent
              onCloseAutoFocus={(e) => {
                if (keepFocus.current) e.preventDefault();
                keepFocus.current = false;
              }}
            >
              <ContextMenuItem onSelect={() => onActivate(i)}>Go to Artboard</ContextMenuItem>
              <ContextMenuItem
                onSelect={() => {
                  keepFocus.current = true;
                  setEditing(i);
                }}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={onAdd}>New Artboard</ContextMenuItem>
              <ContextMenuItem destructive disabled={artboards.length < 2} onSelect={() => onDelete(i)}>
                Delete Artboard
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </ul>
      <div className="flex justify-end gap-0.5 border-t border-[#2a2a2a] px-1 py-0.5">
        <IconButton label="New Artboard" onClick={onAdd}>
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton label="Delete Artboard" disabled={artboards.length < 2} onClick={() => onDelete(active)}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

export function PathfinderPanel({ onMode, count }: { onMode: (m: 'unite' | 'minus-front' | 'intersect' | 'exclude' | 'divide') => void; count: number }) {
  const modes: ['unite' | 'minus-front' | 'intersect' | 'exclude', string, React.ReactNode][] = [
    ['unite', 'Unite', <SquaresUnite key="u" className="size-4" />],
    ['minus-front', 'Minus Front', <SquaresSubtract key="m" className="size-4" />],
    ['intersect', 'Intersect', <SquaresIntersect key="i" className="size-4" />],
    ['exclude', 'Exclude', <SquaresExclude key="e" className="size-4" />],
  ];
  return (
    <div className="space-y-2 p-3 text-xs">
      <div className="text-[#bdbdbd]">Shape Modes:</div>
      <div className="flex gap-0.5">
        {modes.map(([m, label, icon]) => (
          <IconButton key={m} label={label} disabled={count < 2} onClick={() => onMode(m)}>
            {icon}
          </IconButton>
        ))}
      </div>
      <div className="text-[#bdbdbd]">Pathfinders:</div>
      <IconButton label="Divide" disabled={count < 2} onClick={() => onMode('divide')}>
        <SquareSplitHorizontal className="size-4" />
      </IconButton>
    </div>
  );
}

// ---- Layers ---------------------------------------------------------------------------------

export interface LayersProps {
  doc: Doc;
  selected: Set<number>;
  activeLayer: number;
  onActivateLayer: (id: number) => void;
  onSelectItem: (id: number, add: boolean) => void;
  onSelectLayer: (id: number) => void;
  onLayerProps: (id: number, patch: Partial<Pick<Layer, 'hidden' | 'locked' | 'name'>>) => void;
  onItemProps: (id: number, patch: Partial<Pick<Item, 'hidden' | 'locked' | 'name'>>) => void;
  onNewLayer: () => void;
  onDelete: () => void;
  onMoveLayer: (id: number, toIndex: number) => void;
  onMoveSelectionTo: (layerId: number) => void;
  onClip: () => void;
}

function Row({
  depth,
  color,
  name,
  hidden,
  locked,
  selected,
  current,
  open,
  hasKids,
  onToggleOpen,
  onToggleHidden,
  onToggleLocked,
  onClick,
  onRename,
  draggable,
  onDragStart,
  onDrop,
  onContextMenu,
  menu,
}: {
  depth: number;
  color: string;
  name: string;
  hidden: boolean;
  locked: boolean;
  selected: boolean;
  current?: boolean;
  open?: boolean;
  hasKids: boolean;
  onToggleOpen?: () => void;
  onToggleHidden: () => void;
  onToggleLocked: () => void;
  onClick: (e: React.MouseEvent) => void;
  onRename: (n: string) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onContextMenu: () => void;
  /** The right-click menu's items after Rename. */
  menu: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  // Rename puts focus in the name field; the closing menu mustn't take it back.
  const keepFocus = useRef(false);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={editing}>
        <div
          className={cn('flex h-7 items-center border-b border-[#2c2c2c] text-xs select-none', current ? 'bg-[#4b4b4b]' : 'hover:bg-[#424242]')}
          draggable={draggable}
          onDragStart={onDragStart}
          onDragOver={(e) => onDrop && e.preventDefault()}
          onDrop={onDrop}
          onContextMenu={() => !editing && onContextMenu()}
        >
          <button type="button" aria-label={hidden ? 'Show' : 'Hide'} title="Toggles Visibility" onClick={onToggleHidden} className={cn('grid h-full w-7 shrink-0 place-items-center border-r border-[#2c2c2c] text-[#cfcfcf]', FOCUS)}>
            {hidden ? <EyeOff className="size-3.5 opacity-30" /> : <Eye className="size-3.5" />}
          </button>
          <button type="button" aria-label={locked ? 'Unlock' : 'Lock'} title="Toggles Lock" onClick={onToggleLocked} className={cn('grid h-full w-6 shrink-0 place-items-center border-r border-[#2c2c2c] text-[#cfcfcf]', FOCUS)}>
            {locked ? <Lock className="size-3" /> : null}
          </button>
          <span className="h-full w-1 shrink-0" style={{ background: depth === 0 ? color : 'transparent' }} />
          <span style={{ width: depth * 12 }} className="shrink-0" />
          <button type="button" aria-label={open ? 'Collapse' : 'Expand'} onClick={onToggleOpen} className={cn('grid size-5 shrink-0 place-items-center text-[#bdbdbd]', !hasKids && 'invisible', FOCUS)}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
          {editing ? (
            <input
              autoFocus
              defaultValue={name}
              aria-label="Name"
              onBlur={(e) => {
                onRename(e.target.value);
                setEditing(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(false);
              }}
              className={cn(INPUT, 'h-5 min-w-0 flex-1')}
            />
          ) : (
            <span className={cn('min-w-0 flex-1 cursor-default truncate pl-1', hidden ? 'text-[#8a8a8a]' : 'text-[#e0e0e0]')} onClick={onClick} onDoubleClick={() => setEditing(true)}>
              {name}
            </span>
          )}
          <button type="button" aria-label={`Select ${name}`} title="Click to target, drag to move appearance" onClick={onClick} className={cn('grid h-full w-7 shrink-0 place-items-center', FOCUS)}>
            <span className={cn('block size-2.5 rounded-full border border-[#bdbdbd]', selected && 'border-0')} style={selected ? { background: color, boxShadow: `0 0 0 2px ${color}55` } : undefined} />
          </button>
          <span className={cn('mr-1 size-2 shrink-0', selected ? '' : 'invisible')} style={{ background: color }} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) e.preventDefault();
          keepFocus.current = false;
        }}
      >
        <ContextMenuItem
          onSelect={() => {
            keepFocus.current = true;
            setEditing(true);
          }}
        >
          Rename
        </ContextMenuItem>
        {menu}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function LayersPanel(p: LayersProps) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const containsSel = (it: Item): boolean => p.selected.has(it.id) || (it.type === 'group' && it.children.some(containsSel));
  const itemRows = (items: Item[], depth: number, color: string): React.ReactNode[] =>
    [...items].reverse().flatMap((it) => {
      const kids = it.type === 'group' ? it.children : [];
      const isOpen = open.has(it.id);
      return [
        <Row
          key={it.id}
          depth={depth}
          color={color}
          name={itemLabel(it)}
          hidden={!!it.hidden}
          locked={!!it.locked}
          selected={containsSel(it)}
          open={isOpen}
          hasKids={kids.length > 0}
          onToggleOpen={() => toggle(it.id)}
          onToggleHidden={() => p.onItemProps(it.id, { hidden: !it.hidden })}
          onToggleLocked={() => p.onItemProps(it.id, { locked: !it.locked })}
          onClick={(e) => p.onSelectItem(it.id, e.shiftKey || e.ctrlKey || e.metaKey)}
          onRename={(name) => p.onItemProps(it.id, { name })}
          onContextMenu={() => !p.selected.has(it.id) && p.onSelectItem(it.id, false)}
          menu={
            <>
              <ContextMenuItem onSelect={() => p.onItemProps(it.id, { hidden: !it.hidden })}>{it.hidden ? 'Show' : 'Hide'}</ContextMenuItem>
              <ContextMenuItem onSelect={() => p.onItemProps(it.id, { locked: !it.locked })}>{it.locked ? 'Unlock' : 'Lock'}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={p.onClip}>Make/Release Clipping Mask</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem destructive onSelect={p.onDelete}>
                Delete Selection
              </ContextMenuItem>
            </>
          }
        />,
        ...(isOpen ? itemRows(kids, depth + 1, color) : []),
      ];
    });
  const layers = [...p.doc.layers].reverse();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" role="tree" aria-label="Layers">
        {layers.map((l) => {
          const isOpen = open.has(l.id);
          return (
            <div key={l.id}>
              <Row
                depth={0}
                color={l.color}
                name={l.name}
                hidden={l.hidden}
                locked={l.locked}
                selected={l.children.some(containsSel)}
                current={l.id === p.activeLayer}
                open={isOpen}
                hasKids={l.children.length > 0}
                onToggleOpen={() => toggle(l.id)}
                onToggleHidden={() => p.onLayerProps(l.id, { hidden: !l.hidden })}
                onToggleLocked={() => p.onLayerProps(l.id, { locked: !l.locked })}
                onClick={(e) => {
                  p.onActivateLayer(l.id);
                  if ((e.target as HTMLElement).closest('button')) p.onSelectLayer(l.id);
                }}
                onRename={(name) => p.onLayerProps(l.id, { name: name || l.name })}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-din-layer', String(l.id));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDrop={(e) => {
                  const id = Number(e.dataTransfer.getData('application/x-din-layer'));
                  if (id && id !== l.id) p.onMoveLayer(id, p.doc.layers.findIndex((x) => x.id === l.id));
                  else if (!id) p.onMoveSelectionTo(l.id);
                }}
                onContextMenu={() => p.onActivateLayer(l.id)}
                menu={
                  <>
                    <ContextMenuItem onSelect={() => p.onLayerProps(l.id, { hidden: !l.hidden })}>{l.hidden ? 'Show Layer' : 'Hide Layer'}</ContextMenuItem>
                    <ContextMenuItem onSelect={() => p.onLayerProps(l.id, { locked: !l.locked })}>{l.locked ? 'Unlock Layer' : 'Lock Layer'}</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem disabled={l.hidden || l.locked} onSelect={() => p.onSelectLayer(l.id)}>
                      Select All on Layer
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!p.selected.size} onSelect={() => p.onMoveSelectionTo(l.id)}>
                      Move Selection Here
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={p.onClip}>Make/Release Clipping Mask</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={p.onNewLayer}>Create New Layer</ContextMenuItem>
                    {p.selected.size ? (
                      <ContextMenuItem destructive onSelect={p.onDelete}>
                        Delete Selection
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem destructive disabled={p.doc.layers.length < 2} onSelect={p.onDelete}>
                        Delete Layer
                      </ContextMenuItem>
                    )}
                  </>
                }
              />
              {isOpen && itemRows(l.children, 1, l.color)}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-0.5 border-t border-[#2a2a2a] px-2 py-0.5">
        <span className="flex-1 text-[11px] text-[#bdbdbd]">
          {p.doc.layers.length} Layer{p.doc.layers.length === 1 ? '' : 's'}
        </span>
        <IconButton label="Make/Release Clipping Mask" onClick={p.onClip}>
          <SquareDashed className="size-3.5" />
        </IconButton>
        <IconButton label="Create New Layer" onClick={p.onNewLayer}>
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton label="Delete Selection" onClick={p.onDelete}>
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Properties ---------------------------------------------------------------------------------

export function PropertiesPanel({
  kind,
  bounds,
  units,
  onBounds,
  rotation,
  onRotate,
  fill,
  stroke,
  opacity,
  onEditFill,
  onEditStroke,
  onStrokeWidth,
  onOpacity,
  artboard,
  onArtboard,
  onUnits,
  quick,
}: {
  kind: string | null;
  bounds: Rect | null;
  units: Units;
  onBounds: (b: Partial<Rect>) => void;
  rotation: number;
  onRotate: (deg: number) => void;
  fill: Paint;
  stroke: Stroke;
  opacity: number;
  onEditFill: () => void;
  onEditStroke: () => void;
  onStrokeWidth: (w: number) => void;
  onOpacity: (v: number) => void;
  artboard: Artboard | null;
  onArtboard: (b: Partial<Artboard>) => void;
  onUnits: (u: Units) => void;
  quick: { label: string; run: () => void }[];
}) {
  const section = 'border-b border-[#2a2a2a] px-3 py-2.5 space-y-2';
  const head = 'text-[11px] font-semibold text-[#e6e6e6]';
  if (!kind) {
    return (
      <div className="text-xs">
        <div className={section}>
          <div className={head}>Document</div>
          {artboard && (
            <div className="grid grid-cols-2 gap-2">
              <LengthField label="W:" value={artboard.w} units={units} onChange={(w) => onArtboard({ w: Math.max(1, w) })} />
              <LengthField label="H:" value={artboard.h} units={units} onChange={(h) => onArtboard({ h: Math.max(1, h) })} />
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[#bdbdbd]">Units:</span>
            <Select
              label="Units"
              value={units}
              onChange={onUnits}
              options={[
                ['pt', 'Points'],
                ['pc', 'Picas'],
                ['in', 'Inches'],
                ['mm', 'Millimeters'],
                ['cm', 'Centimeters'],
                ['px', 'Pixels'],
              ]}
            />
          </div>
        </div>
        <div className={section}>
          <div className={head}>Quick Actions</div>
          <div className="flex flex-wrap gap-1.5">
            {quick.map((q) => (
              <Button key={q.label} onClick={q.run} className="min-w-0 px-3">
                {q.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="text-xs">
      <div className="border-b border-[#2a2a2a] px-3 py-2 text-[11px] font-semibold text-[#e6e6e6]">{kind}</div>
      {bounds && (
        <div className={section}>
          <div className={head}>Transform</div>
          <div className="grid grid-cols-2 gap-2">
            <LengthField label="X:" value={bounds.x} units={units} onChange={(x) => onBounds({ x })} />
            <LengthField label="Y:" value={bounds.y} units={units} onChange={(y) => onBounds({ y })} />
            <LengthField label="W:" value={bounds.w} units={units} onChange={(w) => onBounds({ w })} />
            <LengthField label="H:" value={bounds.h} units={units} onChange={(h) => onBounds({ h })} />
          </div>
          <NumberField label="Rotate:" title="Rotate (applied when you press Enter)" value={rotation} min={-360} max={360} decimals={1} unit="°" width="w-14" onChange={onRotate} />
        </div>
      )}
      <div className={section}>
        <div className={head}>Appearance</div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-[#bdbdbd]">Fill</span>
          <button type="button" aria-label="Fill" title="Fill" onClick={onEditFill} className={cn('size-5 border border-[#111]', FOCUS)}>
            <PaintChip paint={fill} className="size-full" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-[#bdbdbd]">Stroke</span>
          <button type="button" aria-label="Stroke" title="Stroke" onClick={onEditStroke} className={cn('size-5 border border-[#111]', FOCUS)}>
            <PaintChip paint={stroke.paint} stroke className="size-full" />
          </button>
          <NumberField value={stroke.width} onChange={onStrokeWidth} min={0} max={1000} decimals={2} unit="pt" width="w-16" title="Stroke Weight" />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-[#bdbdbd]">Opacity</span>
          <NumberField value={Math.round(opacity * 100)} onChange={(v) => onOpacity(v / 100)} min={0} max={100} unit="%" width="w-14" />
        </div>
      </div>
      {quick.length > 0 && (
        <div className={section}>
          <div className={head}>Quick Actions</div>
          <div className="flex flex-wrap gap-1.5">
            {quick.map((q) => (
              <Button key={q.label} onClick={q.run} className="min-w-0 px-3">
                {q.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
