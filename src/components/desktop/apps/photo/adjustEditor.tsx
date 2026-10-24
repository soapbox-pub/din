import { useLayoutEffect, useRef, useState } from 'react';
import type { AdjustmentLayer, CurvesAdjustmentChannel, LevelsAdjustmentChannel } from 'ag-psd';
import { colorToRgb, curveLut } from './adjust';
import { Checkbox, NumberField, Select, SliderRow } from './chrome';
import { ColorWell } from './color';
import { hexToRgb, rgbToHex } from './paint';

/**
 * The controls for one adjustment, shared by the Properties panel (for
 * adjustment layers) and Image > Adjustments dialogs.
 */

const HUE_TRACK = 'linear-gradient(to right, #00ffff, #0000ff, #ff00ff, #ff0000, #ffff00, #00ff00, #00ffff)';
const SAT_TRACK = 'linear-gradient(to right, #808080, #ff0000)';
const LIGHT_TRACK = 'linear-gradient(to right, #000, #808080, #fff)';

type Channel = 'rgb' | 'red' | 'green' | 'blue';
const CHANNELS = [
  ['rgb', 'RGB'],
  ['red', 'Red'],
  ['green', 'Green'],
  ['blue', 'Blue'],
] as const;

const LEVEL_DEFAULT: LevelsAdjustmentChannel = { shadowInput: 0, highlightInput: 255, shadowOutput: 0, highlightOutput: 255, midtoneInput: 1 };

function Histogram({ data, className }: { data: number[] | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c || !ref.current) return;
    const { width: w, height: h } = ref.current;
    c.clearRect(0, 0, w, h);
    if (!data) return;
    // Square root keeps a spike from flattening the rest.
    const max = Math.sqrt(Math.max(1, ...data));
    c.fillStyle = '#8a8a8a';
    for (let i = 0; i < 256; i++) {
      const v = (Math.sqrt(data[i]) / max) * h;
      c.fillRect((i / 256) * w, h - v, Math.ceil(w / 256), v);
    }
  }, [data]);
  return <canvas ref={ref} width={256} height={100} className={className} aria-hidden />;
}

function LevelsEditor({ adj, onChange, histogram }: { adj: Extract<AdjustmentLayer, { type: 'levels' }>; onChange: (a: AdjustmentLayer) => void; histogram: number[] | null }) {
  const [channel, setChannel] = useState<Channel>('rgb');
  const ch = adj[channel] ?? LEVEL_DEFAULT;
  const set = (p: Partial<LevelsAdjustmentChannel>) => onChange({ ...adj, [channel]: { ...ch, ...p } });
  return (
    <div className="space-y-3">
      <Select label="Channel" value={channel} onChange={setChannel} options={CHANNELS} className="w-28" />
      <div className="rounded-[3px] border border-[#1f1f1f] bg-[#2a2a2a] p-1">
        <Histogram data={histogram} className="block h-20 w-full" />
        <div className="relative mt-1 h-2 bg-gradient-to-r from-black to-white" />
      </div>
      <div className="flex items-center justify-between gap-1">
        <NumberField title="Shadows input" value={ch.shadowInput} min={0} max={ch.highlightInput - 2} onChange={(v) => set({ shadowInput: v })} width="w-12" />
        <NumberField title="Midtones (gamma)" value={ch.midtoneInput} min={0.01} max={9.99} step={0.01} decimals={2} onChange={(v) => set({ midtoneInput: v })} width="w-14" />
        <NumberField title="Highlights input" value={ch.highlightInput} min={ch.shadowInput + 2} max={255} onChange={(v) => set({ highlightInput: v })} width="w-12" />
      </div>
      <SliderRow label="Shadows" value={ch.shadowInput} min={0} max={253} onChange={(v) => set({ shadowInput: Math.min(v, ch.highlightInput - 2) })} />
      <SliderRow label="Midtones" value={ch.midtoneInput} min={0.1} max={9.99} step={0.01} decimals={2} onChange={(v) => set({ midtoneInput: v })} />
      <SliderRow label="Highlights" value={ch.highlightInput} min={2} max={255} onChange={(v) => set({ highlightInput: Math.max(v, ch.shadowInput + 2) })} />
      <div className="text-xs text-[#bdbdbd]">Output Levels</div>
      <div className="h-2 bg-gradient-to-r from-black to-white" />
      <div className="flex items-center justify-between">
        <NumberField title="Output shadows" value={ch.shadowOutput} min={0} max={255} onChange={(v) => set({ shadowOutput: v })} width="w-12" />
        <NumberField title="Output highlights" value={ch.highlightOutput} min={0} max={255} onChange={(v) => set({ highlightOutput: v })} width="w-12" />
      </div>
    </div>
  );
}

const CURVE_DEFAULT: CurvesAdjustmentChannel = [
  { input: 0, output: 0 },
  { input: 255, output: 255 },
];

function CurvesEditor({ adj, onChange, histogram }: { adj: Extract<AdjustmentLayer, { type: 'curves' }>; onChange: (a: AdjustmentLayer) => void; histogram: number[] | null }) {
  const [channel, setChannel] = useState<Channel>('rgb');
  const points = adj[channel] ?? CURVE_DEFAULT;
  const ref = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const set = (p: CurvesAdjustmentChannel) => onChange({ ...adj, [channel]: [...p].sort((a, b) => a.input - b.input) });
  const S = 256;

  useLayoutEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, S, S);
    c.fillStyle = '#2a2a2a';
    c.fillRect(0, 0, S, S);
    if (histogram) {
      const max = Math.sqrt(Math.max(1, ...histogram));
      c.fillStyle = '#444';
      for (let i = 0; i < 256; i++) {
        const v = (Math.sqrt(histogram[i]) / max) * S;
        c.fillRect(i, S - v, 1, v);
      }
    }
    c.strokeStyle = '#4a4a4a';
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo((i * S) / 4 + 0.5, 0);
      c.lineTo((i * S) / 4 + 0.5, S);
      c.moveTo(0, (i * S) / 4 + 0.5);
      c.lineTo(S, (i * S) / 4 + 0.5);
      c.stroke();
    }
    c.strokeStyle = '#5a5a5a';
    c.beginPath();
    c.moveTo(0, S);
    c.lineTo(S, 0);
    c.stroke();
    const lut = curveLut(points);
    c.strokeStyle = channel === 'rgb' ? '#e6e6e6' : channel === 'red' ? '#ff5555' : channel === 'green' ? '#55dd55' : '#5599ff';
    c.lineWidth = 1.5;
    c.beginPath();
    for (let x = 0; x < 256; x++) {
      const y = S - lut[x];
      if (x === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
    for (const p of points) {
      c.fillStyle = '#e6e6e6';
      c.fillRect(p.input - 3, S - p.output - 3, 6, 6);
    }
  }, [points, histogram, channel]);

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      input: Math.round(Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255))),
      output: Math.round(Math.max(0, Math.min(255, (1 - (e.clientY - r.top) / r.height) * 255))),
      outside: e.clientX < r.left - 16 || e.clientX > r.right + 16 || e.clientY < r.top - 16 || e.clientY > r.bottom + 16,
    };
  };

  return (
    <div className="space-y-3">
      <Select label="Channel" value={channel} onChange={setChannel} options={CHANNELS} className="w-28" />
      <canvas
        ref={ref}
        width={S}
        height={S}
        className="aspect-square w-full cursor-crosshair touch-none rounded-[3px] border border-[#1f1f1f]"
        aria-label="Curve: click to add a point, drag points to bend it, drag one off the graph to remove it"
        onPointerDown={(e) => {
          const p = at(e);
          let i = points.findIndex((q) => Math.abs(q.input - p.input) < 8 && Math.abs(q.output - p.output) < 12);
          if (i === -1) {
            const next = [...points, { input: p.input, output: p.output }].sort((a, b) => a.input - b.input);
            i = next.findIndex((q) => q.input === p.input && q.output === p.output);
            set(next);
          }
          setDrag(i);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const p = at(e);
          const next = [...points];
          if (p.outside && next.length > 2) {
            next.splice(drag, 1);
            setDrag(null);
            set(next);
            return;
          }
          const lo = drag > 0 ? next[drag - 1].input + 1 : 0;
          const hi = drag < next.length - 1 ? next[drag + 1].input - 1 : 255;
          next[drag] = { input: Math.max(lo, Math.min(hi, p.input)), output: p.output };
          onChange({ ...adj, [channel]: next });
        }}
        onPointerUp={() => setDrag(null)}
      />
      <p className="text-[11px] text-[#9a9a9a]">Click to add a point; drag a point off the graph to remove it.</p>
    </div>
  );
}

function ColorInput({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-[#cfcfcf]">
      {label}
      <ColorWell label={label || 'Color'} value={value} onChange={onChange} />
    </div>
  );
}

const rgbHex = (c: Parameters<typeof colorToRgb>[0], fb: [number, number, number]) => {
  const [r, g, b] = colorToRgb(c, fb);
  return rgbToHex(r, g, b);
};
const asRgb = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return { r, g, b };
};

export function AdjustmentEditor({
  adj,
  onChange,
  histogram,
}: {
  adj: AdjustmentLayer;
  onChange: (a: AdjustmentLayer) => void;
  histogram: number[] | null;
}) {
  switch (adj.type) {
    case 'brightness/contrast':
      return (
        <div className="space-y-3">
          <SliderRow label="Brightness" value={adj.brightness ?? 0} min={-150} max={150} onChange={(v) => onChange({ ...adj, brightness: v })} />
          <SliderRow label="Contrast" value={adj.contrast ?? 0} min={-50} max={100} onChange={(v) => onChange({ ...adj, contrast: v })} />
        </div>
      );
    case 'levels':
      return <LevelsEditor adj={adj} onChange={onChange} histogram={histogram} />;
    case 'curves':
      return <CurvesEditor adj={adj} onChange={onChange} histogram={histogram} />;
    case 'exposure':
      return (
        <div className="space-y-3">
          <SliderRow label="Exposure" value={adj.exposure ?? 0} min={-20} max={20} step={0.01} decimals={2} onChange={(v) => onChange({ ...adj, exposure: v })} />
          <SliderRow label="Offset" value={adj.offset ?? 0} min={-0.5} max={0.5} step={0.0001} decimals={4} onChange={(v) => onChange({ ...adj, offset: v })} />
          <SliderRow label="Gamma Correction" value={adj.gamma ?? 1} min={0.01} max={9.99} step={0.01} decimals={2} onChange={(v) => onChange({ ...adj, gamma: v })} />
        </div>
      );
    case 'vibrance':
      return (
        <div className="space-y-3">
          <SliderRow label="Vibrance" value={adj.vibrance ?? 0} min={-100} max={100} onChange={(v) => onChange({ ...adj, vibrance: v })} track={SAT_TRACK} />
          <SliderRow label="Saturation" value={adj.saturation ?? 0} min={-100} max={100} onChange={(v) => onChange({ ...adj, saturation: v })} track={SAT_TRACK} />
        </div>
      );
    case 'hue/saturation': {
      const m = adj.master ?? { a: 0, b: 0, c: 0, d: 0, hue: 0, saturation: 0, lightness: 0 };
      const set = (p: Partial<typeof m>) => onChange({ ...adj, master: { ...m, ...p } });
      return (
        <div className="space-y-3">
          <SliderRow label="Hue" value={m.hue} min={-180} max={180} onChange={(v) => set({ hue: v })} track={HUE_TRACK} />
          <SliderRow label="Saturation" value={m.saturation} min={-100} max={100} onChange={(v) => set({ saturation: v })} track={SAT_TRACK} />
          <SliderRow label="Lightness" value={m.lightness} min={-100} max={100} onChange={(v) => set({ lightness: v })} track={LIGHT_TRACK} />
        </div>
      );
    }
    case 'color balance': {
      return <ColorBalanceEditor adj={adj} onChange={onChange} />;
    }
    case 'black & white': {
      const keys = [
        ['reds', 'Reds', 40],
        ['yellows', 'Yellows', 60],
        ['greens', 'Greens', 40],
        ['cyans', 'Cyans', 60],
        ['blues', 'Blues', 20],
        ['magentas', 'Magentas', 80],
      ] as const;
      return (
        <div className="space-y-3">
          {keys.map(([k, label, d]) => (
            <SliderRow key={k} label={label} value={adj[k] ?? d} min={-200} max={300} unit="%" onChange={(v) => onChange({ ...adj, [k]: v })} />
          ))}
          <div className="flex items-center justify-between">
            <Checkbox checked={!!adj.useTint} onChange={(v) => onChange({ ...adj, useTint: v })}>
              Tint
            </Checkbox>
            {adj.useTint && <ColorInput label="" value={rgbHex(adj.tintColor, [225, 211, 179])} onChange={(h) => onChange({ ...adj, tintColor: asRgb(h) })} />}
          </div>
        </div>
      );
    }
    case 'photo filter':
      return (
        <div className="space-y-3">
          <ColorInput label="Color" value={rgbHex(adj.color, [236, 138, 0])} onChange={(h) => onChange({ ...adj, color: asRgb(h) })} />
          <SliderRow label="Density" value={adj.density ?? 25} min={1} max={100} unit="%" onChange={(v) => onChange({ ...adj, density: v })} />
          <Checkbox checked={adj.preserveLuminosity ?? true} onChange={(v) => onChange({ ...adj, preserveLuminosity: v })}>
            Preserve Luminosity
          </Checkbox>
        </div>
      );
    case 'posterize':
      return <SliderRow label="Levels" value={adj.levels ?? 4} min={2} max={255} onChange={(v) => onChange({ ...adj, levels: v })} />;
    case 'threshold':
      return (
        <div className="space-y-3">
          <div className="rounded-[3px] border border-[#1f1f1f] bg-[#2a2a2a] p-1">
            <Histogram data={histogram} className="block h-20 w-full" />
          </div>
          <SliderRow label="Threshold Level" value={adj.level ?? 128} min={1} max={255} onChange={(v) => onChange({ ...adj, level: v })} />
        </div>
      );
    case 'gradient map': {
      const stops = adj.colorStops ?? [];
      const first = stops[0];
      const last = stops[stops.length - 1];
      const setStop = (i: 0 | 1, hex: string) => {
        const next = [
          { color: i === 0 ? asRgb(hex) : (first?.color ?? { r: 0, g: 0, b: 0 }), location: 0, midpoint: 50 },
          { color: i === 1 ? asRgb(hex) : (last?.color ?? { r: 255, g: 255, b: 255 }), location: 4096, midpoint: 50 },
        ];
        onChange({ ...adj, colorStops: next });
      };
      return (
        <div className="space-y-3">
          <ColorInput label="Shadows" value={rgbHex(first?.color, [0, 0, 0])} onChange={(h) => setStop(0, h)} />
          <ColorInput label="Highlights" value={rgbHex(last?.color, [255, 255, 255])} onChange={(h) => setStop(1, h)} />
          <Checkbox checked={!!adj.reverse} onChange={(v) => onChange({ ...adj, reverse: v })}>
            Reverse
          </Checkbox>
        </div>
      );
    }
    case 'invert':
      return <p className="text-xs text-[#9a9a9a]">Invert has no settings.</p>;
    default:
      return <p className="text-xs text-[#9a9a9a]">This adjustment is kept in the file, but Photo Editor can’t show or edit it.</p>;
  }
}

function ColorBalanceEditor({ adj, onChange }: { adj: Extract<AdjustmentLayer, { type: 'color balance' }>; onChange: (a: AdjustmentLayer) => void }) {
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const v = adj[tone] ?? { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 };
  const set = (p: Partial<typeof v>) => onChange({ ...adj, [tone]: { ...v, ...p } });
  return (
    <div className="space-y-3">
      <Select
        label="Tone"
        value={tone}
        onChange={setTone}
        options={[
          ['shadows', 'Shadows'],
          ['midtones', 'Midtones'],
          ['highlights', 'Highlights'],
        ]}
        className="w-32"
      />
      <SliderRow label="Cyan ↔ Red" value={v.cyanRed} min={-100} max={100} onChange={(x) => set({ cyanRed: x })} track="linear-gradient(to right,#00ffff,#ff0000)" />
      <SliderRow label="Magenta ↔ Green" value={v.magentaGreen} min={-100} max={100} onChange={(x) => set({ magentaGreen: x })} track="linear-gradient(to right,#ff00ff,#00ff00)" />
      <SliderRow label="Yellow ↔ Blue" value={v.yellowBlue} min={-100} max={100} onChange={(x) => set({ yellowBlue: x })} track="linear-gradient(to right,#ffff00,#0000ff)" />
      <Checkbox checked={adj.preserveLuminosity ?? true} onChange={(x) => onChange({ ...adj, preserveLuminosity: x })}>
        Preserve Luminosity
      </Checkbox>
    </div>
  );
}
