import { useEffect, useState } from 'react';
import type { AdjustmentLayer, LayerEffectsInfo } from 'ag-psd';
import { cn } from '@/lib/utils';
import { ADJUSTMENT_NAMES, colorToRgb, FILTER_NAMES, type FilterSpec } from './adjust';
import { AdjustmentEditor } from './adjustEditor';
import { Checkbox, Dialog, NumberField, Select, SliderRow } from './chrome';
import { FOCUS, INPUT } from './styles';
import { ColorWell } from './color';
import { hexToRgb, rgbToHex } from './paint';

/** Live preview: dialogs report what they'd do as it changes, and the editor shows it. */
function usePreview<T>(value: T, preview: boolean, onPreview: (v: T | null) => void) {
  useEffect(() => {
    const t = setTimeout(() => onPreview(preview ? value : null), 60);
    return () => clearTimeout(t);
  }, [value, preview, onPreview]);
}

// ---- New ------------------------------------------------------------------------

const PRESETS = [
  ['custom', 'Custom'],
  ['1920x1080', 'HD 1920 × 1080'],
  ['3840x2160', '4K UHD 3840 × 2160'],
  ['1080x1080', 'Square 1080 × 1080'],
  ['1080x1920', 'Story 1080 × 1920'],
  ['1200x628', 'Web banner 1200 × 628'],
  ['2480x3508', 'A4 at 300 ppi 2480 × 3508'],
  ['2550x3300', 'US Letter at 300 ppi 2550 × 3300'],
  ['800x600', '800 × 600'],
  ['512x512', 'Icon 512 × 512'],
] as const;

export type BackgroundChoice = 'white' | 'black' | 'background' | 'transparent';

export function NewDocDialog({
  onCancel,
  onCreate,
  initial,
}: {
  onCancel: () => void;
  onCreate: (w: number, h: number, bg: BackgroundChoice, name: string) => void;
  initial: { w: number; h: number };
}) {
  const [name, setName] = useState('Untitled-1');
  const [w, setW] = useState(initial.w);
  const [h, setH] = useState(initial.h);
  const [bg, setBg] = useState<BackgroundChoice>('white');
  const preset = PRESETS.find(([k]) => k === `${w}x${h}`)?.[0] ?? 'custom';
  return (
    <Dialog title="New Document" onCancel={onCancel} onOk={() => onCreate(w, h, bg, name)} okLabel="Create">
      <div className="space-y-3 text-xs">
        <label className="flex items-center gap-2">
          <span className="w-24 text-[#bdbdbd]">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key !== 'Enter' && e.key !== 'Escape' && e.stopPropagation()}
            className={cn(INPUT, 'flex-1')}
            data-autofocus
          />
        </label>
        <div className="flex items-center gap-2">
          <span className="w-24 text-[#bdbdbd]">Preset</span>
          <Select
            label="Preset"
            value={preset}
            onChange={(v) => {
              if (v === 'custom') return;
              const [pw, ph] = v.split('x').map(Number);
              setW(pw);
              setH(ph);
            }}
            options={PRESETS}
            className="flex-1"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-[#bdbdbd]">Width</span>
          <NumberField value={w} min={1} max={16384} unit="px" width="w-24" onChange={setW} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-[#bdbdbd]">Height</span>
          <NumberField value={h} min={1} max={16384} unit="px" width="w-24" onChange={setH} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-24 text-[#bdbdbd]">Background</span>
          <Select
            label="Background contents"
            value={bg}
            onChange={setBg}
            options={[
              ['white', 'White'],
              ['black', 'Black'],
              ['background', 'Background Color'],
              ['transparent', 'Transparent'],
            ]}
            className="flex-1"
          />
        </div>
      </div>
    </Dialog>
  );
}

// ---- Image and canvas size ----------------------------------------------------------

export function ImageSizeDialog({ w0, h0, onCancel, onOk }: { w0: number; h0: number; onCancel: () => void; onOk: (w: number, h: number, smooth: boolean) => void }) {
  const [w, setW] = useState(w0);
  const [h, setH] = useState(h0);
  const [link, setLink] = useState(true);
  const [smooth, setSmooth] = useState(true);
  const [pct, setPct] = useState(false);
  const setWidth = (v: number) => {
    const nw = Math.max(1, Math.round(pct ? (v / 100) * w0 : v));
    setW(nw);
    if (link) setH(Math.max(1, Math.round((nw / w0) * h0)));
  };
  const setHeight = (v: number) => {
    const nh = Math.max(1, Math.round(pct ? (v / 100) * h0 : v));
    setH(nh);
    if (link) setW(Math.max(1, Math.round((nh / h0) * w0)));
  };
  return (
    <Dialog title="Image Size" onCancel={onCancel} onOk={() => onOk(w, h, smooth)}>
      <div className="space-y-3 text-xs">
        <p className="text-[#bdbdbd]">
          Was {w0} × {h0} px; now {w} × {h} px ({((w * h * 4) / 1048576).toFixed(1)} MB per layer)
        </p>
        <div className="flex items-center gap-2">
          <span className="w-16 text-[#bdbdbd]">Width</span>
          <NumberField value={pct ? Math.round((w / w0) * 1000) / 10 : w} decimals={pct ? 1 : 0} min={pct ? 0.1 : 1} max={pct ? 1000 : 16384} unit={pct ? '%' : 'px'} width="w-24" onChange={setWidth} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 text-[#bdbdbd]">Height</span>
          <NumberField value={pct ? Math.round((h / h0) * 1000) / 10 : h} decimals={pct ? 1 : 0} min={pct ? 0.1 : 1} max={pct ? 1000 : 16384} unit={pct ? '%' : 'px'} width="w-24" onChange={setHeight} />
          <Select
            label="Units"
            value={pct ? 'pct' : 'px'}
            onChange={(v) => setPct(v === 'pct')}
            options={[
              ['px', 'Pixels'],
              ['pct', 'Percent'],
            ]}
          />
        </div>
        <Checkbox checked={link} onChange={setLink}>
          Constrain proportions
        </Checkbox>
        <div className="flex items-center gap-2">
          <span className="text-[#bdbdbd]">Resample:</span>
          <Select
            label="Resample"
            value={smooth ? 'smooth' : 'nearest'}
            onChange={(v) => setSmooth(v === 'smooth')}
            options={[
              ['smooth', 'Automatic (smooth)'],
              ['nearest', 'Nearest Neighbor (hard edges)'],
            ]}
          />
        </div>
      </div>
    </Dialog>
  );
}

export function CanvasSizeDialog({
  w0,
  h0,
  onCancel,
  onOk,
}: {
  w0: number;
  h0: number;
  onCancel: () => void;
  onOk: (w: number, h: number, anchor: [number, number], fill: 'background' | 'white' | 'black' | 'transparent') => void;
}) {
  const [w, setW] = useState(w0);
  const [h, setH] = useState(h0);
  const [relative, setRelative] = useState(false);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  const [fill, setFill] = useState<'background' | 'white' | 'black' | 'transparent'>('background');
  return (
    <Dialog title="Canvas Size" onCancel={onCancel} onOk={() => onOk(w, h, anchor, fill)}>
      <div className="space-y-3 text-xs">
        <p className="text-[#bdbdbd]">
          Current size: {w0} × {h0} px
        </p>
        <div className="flex items-center gap-2">
          <span className="w-16 text-[#bdbdbd]">Width</span>
          <NumberField value={relative ? w - w0 : w} min={relative ? 1 - w0 : 1} max={16384} unit="px" width="w-24" onChange={(v) => setW(Math.max(1, relative ? w0 + v : v))} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-16 text-[#bdbdbd]">Height</span>
          <NumberField value={relative ? h - h0 : h} min={relative ? 1 - h0 : 1} max={16384} unit="px" width="w-24" onChange={(v) => setH(Math.max(1, relative ? h0 + v : v))} />
        </div>
        <Checkbox checked={relative} onChange={setRelative}>
          Relative
        </Checkbox>
        <div className="flex items-center gap-3">
          <span className="w-16 text-[#bdbdbd]">Anchor</span>
          <div className="grid grid-cols-3 gap-0.5" role="radiogroup" aria-label="Anchor">
            {[0, 0.5, 1].flatMap((ay) =>
              [0, 0.5, 1].map((ax) => {
                const on = anchor[0] === ax && anchor[1] === ay;
                return (
                  <button
                    key={`${ax}-${ay}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`Anchor ${['left', 'center', 'right'][ax * 2]} ${['top', 'middle', 'bottom'][ay * 2]}`}
                    onClick={() => setAnchor([ax, ay])}
                    className={cn('size-6 rounded-[2px] border border-[#1f1f1f]', on ? 'bg-[#e6e6e6]' : 'bg-[#2a2a2a] hover:bg-[#4a4a4a]', FOCUS)}
                  />
                );
              }),
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[#bdbdbd]">Canvas extension color:</span>
          <Select
            label="Canvas extension color"
            value={fill}
            onChange={setFill}
            options={[
              ['background', 'Background'],
              ['white', 'White'],
              ['black', 'Black'],
              ['transparent', 'Transparent'],
            ]}
          />
        </div>
      </div>
    </Dialog>
  );
}

// ---- Adjustments and filters ---------------------------------------------------------

export function AdjustmentDialog({
  initial,
  histogram,
  onCancel,
  onOk,
  onPreview,
}: {
  initial: AdjustmentLayer;
  histogram: number[] | null;
  onCancel: () => void;
  onOk: (adj: AdjustmentLayer) => void;
  onPreview: (adj: AdjustmentLayer | null) => void;
}) {
  const [adj, setAdj] = useState(initial);
  const [preview, setPreview] = useState(true);
  usePreview(adj, preview, onPreview);
  return (
    <Dialog
      title={ADJUSTMENT_NAMES[adj.type] ?? 'Adjustment'}
      onCancel={onCancel}
      onOk={() => onOk(adj)}
      extra={
        <Checkbox checked={preview} onChange={setPreview}>
          Preview
        </Checkbox>
      }
    >
      <AdjustmentEditor adj={adj} onChange={setAdj} histogram={histogram} />
    </Dialog>
  );
}

export function FilterDialog({
  initial,
  onCancel,
  onOk,
  onPreview,
}: {
  initial: FilterSpec;
  onCancel: () => void;
  onOk: (f: FilterSpec) => void;
  onPreview: (f: FilterSpec | null) => void;
}) {
  const [f, setF] = useState(initial);
  const [preview, setPreview] = useState(true);
  usePreview(f, preview, onPreview);
  return (
    <Dialog
      title={FILTER_NAMES[f.type]}
      onCancel={onCancel}
      onOk={() => onOk(f)}
      extra={
        <Checkbox checked={preview} onChange={setPreview}>
          Preview
        </Checkbox>
      }
    >
      <div className="space-y-3">
        {f.type === 'gaussian' && <SliderRow label="Radius" value={f.radius} min={0.1} max={250} step={0.1} decimals={1} unit="px" onChange={(v) => setF({ ...f, radius: v })} />}
        {f.type === 'unsharp' && (
          <>
            <SliderRow label="Amount" value={f.amount} min={1} max={500} unit="%" onChange={(v) => setF({ ...f, amount: v })} />
            <SliderRow label="Radius" value={f.radius} min={0.1} max={100} step={0.1} decimals={1} unit="px" onChange={(v) => setF({ ...f, radius: v })} />
            <SliderRow label="Threshold" value={f.threshold} min={0} max={255} onChange={(v) => setF({ ...f, threshold: v })} />
          </>
        )}
        {f.type === 'noise' && (
          <>
            <SliderRow label="Amount" value={f.amount} min={0.1} max={400} step={0.1} decimals={1} unit="%" onChange={(v) => setF({ ...f, amount: v })} />
            <Checkbox checked={f.mono} onChange={(v) => setF({ ...f, mono: v })}>
              Monochromatic
            </Checkbox>
          </>
        )}
        {f.type === 'mosaic' && <SliderRow label="Cell Size" value={f.size} min={2} max={200} unit="px" onChange={(v) => setF({ ...f, size: v })} />}
        {f.type === 'motion' && (
          <>
            <SliderRow label="Angle" value={f.angle} min={-90} max={90} unit="°" onChange={(v) => setF({ ...f, angle: v })} />
            <SliderRow label="Distance" value={f.distance} min={1} max={500} unit="px" onChange={(v) => setF({ ...f, distance: v })} />
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---- Fill ------------------------------------------------------------------------------

export type FillContents = 'fg' | 'bg' | 'black' | 'white' | 'gray' | 'color';

export function FillDialog({ onCancel, onOk, fg }: { onCancel: () => void; onOk: (contents: FillContents, color: string, opacity: number) => void; fg: string }) {
  const [contents, setContents] = useState<FillContents>('fg');
  const [color, setColor] = useState(fg);
  const [opacity, setOpacity] = useState(100);
  return (
    <Dialog title="Fill" onCancel={onCancel} onOk={() => onOk(contents, color, opacity / 100)}>
      <div className="space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-20 text-[#bdbdbd]">Contents</span>
          <Select
            label="Contents"
            value={contents}
            onChange={setContents}
            options={[
              ['fg', 'Foreground Color'],
              ['bg', 'Background Color'],
              ['color', 'Color…'],
              ['black', 'Black'],
              ['gray', '50% Gray'],
              ['white', 'White'],
            ]}
            className="flex-1"
          />
          {contents === 'color' && <ColorWell label="Fill color" value={color} onChange={setColor} />}
        </div>
        <SliderRow label="Opacity" value={opacity} min={1} max={100} unit="%" onChange={setOpacity} />
      </div>
    </Dialog>
  );
}

// ---- Selection ---------------------------------------------------------------------------

export function RadiusDialog({ title, label, onCancel, onOk }: { title: string; label: string; onCancel: () => void; onOk: (r: number) => void }) {
  const [r, setR] = useState(5);
  return (
    <Dialog title={title} onCancel={onCancel} onOk={() => onOk(r)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[#bdbdbd]">{label}</span>
        <NumberField value={r} min={1} max={500} unit="px" width="w-20" onChange={setR} />
      </div>
    </Dialog>
  );
}

// ---- Layer style ---------------------------------------------------------------------------

const toHex = (c: Parameters<typeof colorToRgb>[0], fb: [number, number, number]) => {
  const [r, g, b] = colorToRgb(c, fb);
  return rgbToHex(r, g, b);
};
const fromHex = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return { r, g, b };
};
const units = (value: number) => ({ units: 'Pixels' as const, value });

type StyleTab = 'dropShadow' | 'outerGlow' | 'stroke' | 'solidFill';
const STYLE_TABS: [StyleTab, string][] = [
  ['dropShadow', 'Drop Shadow'],
  ['outerGlow', 'Outer Glow'],
  ['stroke', 'Stroke'],
  ['solidFill', 'Color Overlay'],
];

/**
 * Layer > Layer Style: the effects Photo Editor draws. Others in the file
 * (bevels, inner shadows, gradient overlays...) are kept as they are.
 */
export function LayerStyleDialog({
  initial,
  onCancel,
  onOk,
  onPreview,
}: {
  initial: LayerEffectsInfo | null;
  onCancel: () => void;
  onOk: (fx: LayerEffectsInfo) => void;
  onPreview: (fx: LayerEffectsInfo | null) => void;
}) {
  const [fx, setFx] = useState<LayerEffectsInfo>(() => initial ?? {});
  const [tab, setTab] = useState<StyleTab>('dropShadow');
  usePreview(fx, true, onPreview);

  const shadow = fx.dropShadow?.[0];
  const glow = fx.outerGlow;
  const stroke = fx.stroke?.[0];
  const overlay = fx.solidFill?.[0];
  const on = (t: StyleTab) =>
    t === 'dropShadow' ? !!shadow && shadow.enabled !== false : t === 'outerGlow' ? !!glow && glow.enabled !== false : t === 'stroke' ? !!stroke && stroke.enabled !== false : !!overlay && overlay.enabled !== false;

  const toggle = (t: StyleTab, v: boolean) => {
    if (t === 'dropShadow') {
      const s = shadow ?? { color: { r: 0, g: 0, b: 0 }, opacity: 0.75, angle: 120, distance: units(5), size: units(5), blendMode: 'multiply' as const, useGlobalLight: true, choke: units(0) };
      setFx({ ...fx, dropShadow: [{ ...s, enabled: v, present: true, showInDialog: true }, ...(fx.dropShadow?.slice(1) ?? [])] });
    } else if (t === 'outerGlow') {
      const g = glow ?? { color: { r: 255, g: 255, b: 190 }, opacity: 0.75, size: units(5), blendMode: 'screen' as const, choke: units(0), range: 0.5 };
      setFx({ ...fx, outerGlow: { ...g, enabled: v, present: true, showInDialog: true } });
    } else if (t === 'stroke') {
      const s = stroke ?? { color: { r: 0, g: 0, b: 0 }, opacity: 1, size: units(3), position: 'outside' as const, fillType: 'color' as const, blendMode: 'normal' as const };
      setFx({ ...fx, stroke: [{ ...s, enabled: v, present: true, showInDialog: true }, ...(fx.stroke?.slice(1) ?? [])] });
    } else {
      const o = overlay ?? { color: { r: 255, g: 0, b: 0 }, opacity: 1, blendMode: 'normal' as const };
      setFx({ ...fx, solidFill: [{ ...o, enabled: v, present: true, showInDialog: true }, ...(fx.solidFill?.slice(1) ?? [])] });
    }
  };

  return (
    <Dialog title="Layer Style" onCancel={onCancel} onOk={() => onOk(fx)} className="w-[560px]">
      <div className="flex gap-4">
        <div className="w-40 shrink-0 space-y-0.5" role="tablist" aria-label="Styles">
          {STYLE_TABS.map(([t, label]) => (
            <div key={t} className={cn('flex h-7 items-center gap-2 rounded-[3px] px-2', tab === t ? 'bg-[#4f4f4f]' : 'hover:bg-[#424242]')}>
              <input type="checkbox" aria-label={`Use ${label}`} checked={on(t)} onChange={(e) => toggle(t, e.target.checked)} className="size-3.5 accent-[#2d8ceb]" />
              <button type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('flex-1 text-left text-xs', FOCUS)}>
                {label}
              </button>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          {!on(tab) && (
            <p className="text-xs text-[#9a9a9a]">Tick {STYLE_TABS.find(([t]) => t === tab)![1]} to add it.</p>
          )}
          {tab === 'dropShadow' && shadow && on(tab) && (
            <>
              <div className="flex items-center justify-between text-xs">
                Color
                <ColorWell label="Shadow color" value={toHex(shadow.color, [0, 0, 0])} onChange={(h) => setFx({ ...fx, dropShadow: [{ ...shadow, color: fromHex(h) }] })} />
              </div>
              <SliderRow label="Opacity" value={Math.round((shadow.opacity ?? 0.75) * 100)} min={0} max={100} unit="%" onChange={(v) => setFx({ ...fx, dropShadow: [{ ...shadow, opacity: v / 100 }] })} />
              <SliderRow label="Angle" value={shadow.angle ?? 120} min={-180} max={180} unit="°" onChange={(v) => setFx({ ...fx, dropShadow: [{ ...shadow, angle: v }] })} />
              <SliderRow label="Distance" value={shadow.distance?.value ?? 5} min={0} max={300} unit="px" onChange={(v) => setFx({ ...fx, dropShadow: [{ ...shadow, distance: units(v) }] })} />
              <SliderRow label="Size" value={shadow.size?.value ?? 5} min={0} max={250} unit="px" onChange={(v) => setFx({ ...fx, dropShadow: [{ ...shadow, size: units(v) }] })} />
            </>
          )}
          {tab === 'outerGlow' && glow && on(tab) && (
            <>
              <div className="flex items-center justify-between text-xs">
                Color
                <ColorWell label="Glow color" value={toHex(glow.color, [255, 255, 190])} onChange={(h) => setFx({ ...fx, outerGlow: { ...glow, color: fromHex(h) } })} />
              </div>
              <SliderRow label="Opacity" value={Math.round((glow.opacity ?? 0.75) * 100)} min={0} max={100} unit="%" onChange={(v) => setFx({ ...fx, outerGlow: { ...glow, opacity: v / 100 } })} />
              <SliderRow label="Size" value={glow.size?.value ?? 5} min={0} max={250} unit="px" onChange={(v) => setFx({ ...fx, outerGlow: { ...glow, size: units(v) } })} />
            </>
          )}
          {tab === 'stroke' && stroke && on(tab) && (
            <>
              <SliderRow label="Size" value={stroke.size?.value ?? 3} min={1} max={100} unit="px" onChange={(v) => setFx({ ...fx, stroke: [{ ...stroke, size: units(v) }] })} />
              <div className="flex items-center justify-between text-xs">
                Position
                <Select
                  label="Position"
                  value={stroke.position ?? 'outside'}
                  onChange={(v) => setFx({ ...fx, stroke: [{ ...stroke, position: v }] })}
                  options={[
                    ['outside', 'Outside'],
                    ['inside', 'Inside'],
                    ['center', 'Center'],
                  ]}
                />
              </div>
              <SliderRow label="Opacity" value={Math.round((stroke.opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => setFx({ ...fx, stroke: [{ ...stroke, opacity: v / 100 }] })} />
              <div className="flex items-center justify-between text-xs">
                Color
                <ColorWell label="Stroke color" value={toHex(stroke.color, [0, 0, 0])} onChange={(h) => setFx({ ...fx, stroke: [{ ...stroke, color: fromHex(h) }] })} />
              </div>
            </>
          )}
          {tab === 'solidFill' && overlay && on(tab) && (
            <>
              <div className="flex items-center justify-between text-xs">
                Color
                <ColorWell label="Overlay color" value={toHex(overlay.color, [255, 0, 0])} onChange={(h) => setFx({ ...fx, solidFill: [{ ...overlay, color: fromHex(h) }] })} />
              </div>
              <SliderRow label="Opacity" value={Math.round((overlay.opacity ?? 1) * 100)} min={0} max={100} unit="%" onChange={(v) => setFx({ ...fx, solidFill: [{ ...overlay, opacity: v / 100 }] })} />
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ---- Questions -------------------------------------------------------------------------------

export function ConfirmDialog({
  title,
  message,
  okLabel,
  onCancel,
  onOk,
}: {
  title: string;
  message: string;
  okLabel: string;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Dialog title={title} onCancel={onCancel} onOk={onOk} okLabel={okLabel}>
      <p className="text-xs leading-relaxed text-[#d6d6d6]">{message}</p>
    </Dialog>
  );
}
