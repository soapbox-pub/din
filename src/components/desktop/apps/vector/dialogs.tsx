import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button, Checkbox, Dialog, NumberField, Select } from '@/shared/photo/chrome';
import { INPUT } from '@/shared/photo/styles';
import { LengthField } from './bars';
import { UNIT_PT, type Units } from './model';
import type { TransformDialog } from './menus';

const UNIT_OPTIONS: [Units, string][] = [
  ['pt', 'Points'],
  ['pc', 'Picas'],
  ['in', 'Inches'],
  ['mm', 'Millimeters'],
  ['cm', 'Centimeters'],
  ['px', 'Pixels'],
];

interface Preset {
  name: string;
  w: number;
  h: number;
  units: Units;
  mode: 'rgb' | 'cmyk';
}

const PRESETS: { group: string; items: Preset[] }[] = [
  {
    group: 'Print',
    items: [
      { name: 'Letter', w: 612, h: 792, units: 'pt', mode: 'cmyk' },
      { name: 'Legal', w: 612, h: 1008, units: 'pt', mode: 'cmyk' },
      { name: 'Tabloid', w: 792, h: 1224, units: 'pt', mode: 'cmyk' },
      { name: 'A4', w: 595.28, h: 841.89, units: 'mm', mode: 'cmyk' },
      { name: 'A3', w: 841.89, h: 1190.55, units: 'mm', mode: 'cmyk' },
      { name: 'A5', w: 419.53, h: 595.28, units: 'mm', mode: 'cmyk' },
    ],
  },
  {
    group: 'Web',
    items: [
      { name: 'Web-Large 1920 × 1080', w: 1920, h: 1080, units: 'px', mode: 'rgb' },
      { name: 'Web 1366 × 768', w: 1366, h: 768, units: 'px', mode: 'rgb' },
      { name: 'Common 1280 × 800', w: 1280, h: 800, units: 'px', mode: 'rgb' },
    ],
  },
  {
    group: 'Mobile',
    items: [
      { name: 'iPhone 15', w: 393, h: 852, units: 'px', mode: 'rgb' },
      { name: 'Android 360 × 800', w: 360, h: 800, units: 'px', mode: 'rgb' },
      { name: 'iPad 820 × 1180', w: 820, h: 1180, units: 'px', mode: 'rgb' },
    ],
  },
  {
    group: 'Art & Illustration',
    items: [
      { name: 'Postcard', w: 288, h: 560, units: 'pt', mode: 'cmyk' },
      { name: '1000 × 1000 px', w: 1000, h: 1000, units: 'px', mode: 'rgb' },
    ],
  },
];

export interface NewDocSpec {
  name: string;
  w: number;
  h: number;
  units: Units;
  mode: 'rgb' | 'cmyk';
  artboards: number;
}

export function NewDocDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (s: NewDocSpec) => void }) {
  const [tab, setTab] = useState(1);
  const [spec, setSpec] = useState<NewDocSpec>({ name: 'Untitled-1', w: 1920, h: 1080, units: 'px', mode: 'rgb', artboards: 1 });
  const [preset, setPreset] = useState('Web-Large 1920 × 1080');
  const pick = (p: Preset) => {
    setPreset(p.name);
    setSpec((s) => ({ ...s, w: p.w, h: p.h, units: p.units, mode: p.mode }));
  };
  const portrait = spec.h >= spec.w;
  return (
    <Dialog title="New Document" onCancel={onCancel} onOk={() => onCreate(spec)} okLabel="Create" className="w-[760px]">
      <div className="flex min-h-[340px] gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex gap-4 border-b border-[#2a2a2a] text-xs" role="tablist">
            {PRESETS.map((g, i) => (
              <button
                key={g.group}
                type="button"
                role="tab"
                aria-selected={tab === i}
                onClick={() => setTab(i)}
                className={cn('-mb-px border-b-2 pb-1.5 font-medium', tab === i ? 'border-[#2d8ceb] text-white' : 'border-transparent text-[#bdbdbd] hover:text-white')}
              >
                {g.group.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS[tab].items.map((p) => {
              const k = 64 / Math.max(p.w, p.h);
              return (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => pick(p)}
                  onDoubleClick={() => onCreate({ ...spec, w: p.w, h: p.h, units: p.units, mode: p.mode })}
                  className={cn('flex flex-col items-center gap-2 rounded-md border p-3 text-center', preset === p.name ? 'border-[#2d8ceb] bg-[#2d8ceb]/10' : 'border-[#4a4a4a] hover:border-[#6a6a6a]')}
                >
                  <span className="grid h-16 place-items-center">
                    <span className="block border border-[#9a9a9a] bg-[#4a4a4a]" style={{ width: p.w * k, height: p.h * k }} />
                  </span>
                  <span className="text-xs text-[#e6e6e6]">{p.name}</span>
                  <span className="text-[10px] text-[#9a9a9a]">
                    {fmt(p.w / UNIT_PT[p.units])} × {fmt(p.h / UNIT_PT[p.units])} {p.units}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="w-60 shrink-0 space-y-3 border-l border-[#2a2a2a] pl-4 text-xs">
          <div className="text-[11px] font-semibold tracking-wide text-[#bdbdbd]">PRESET DETAILS</div>
          <input aria-label="Document name" value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={cn(INPUT, 'w-full')} />
          <div className="grid grid-cols-2 gap-2">
            <LengthField label="Width" value={spec.w} units={spec.units} onChange={(w) => setSpec({ ...spec, w: Math.max(1, w) })} width="w-20" />
            <Select label="Units" value={spec.units} onChange={(units) => setSpec({ ...spec, units })} options={UNIT_OPTIONS} />
            <LengthField label="Height" value={spec.h} units={spec.units} onChange={(h) => setSpec({ ...spec, h: Math.max(1, h) })} width="w-20" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[#bdbdbd]">Orientation</span>
            <Button className={cn('min-w-0 px-2', portrait && 'border-[#2d8ceb]')} onClick={() => portrait || setSpec({ ...spec, w: spec.h, h: spec.w })}>
              Portrait
            </Button>
            <Button className={cn('min-w-0 px-2', !portrait && 'border-[#2d8ceb]')} onClick={() => !portrait || setSpec({ ...spec, w: spec.h, h: spec.w })}>
              Landscape
            </Button>
          </div>
          <NumberField label="Artboards" value={spec.artboards} min={1} max={100} width="w-12" onChange={(artboards) => setSpec({ ...spec, artboards: Math.round(artboards) })} />
          <div className="flex items-center gap-2">
            <span className="text-[#bdbdbd]">Color Mode</span>
            <Select
              label="Color Mode"
              value={spec.mode}
              onChange={(mode) => setSpec({ ...spec, mode })}
              options={[
                ['rgb', 'RGB Color'],
                ['cmyk', 'CMYK Color'],
              ]}
            />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

const fmt = (v: number) => String(Math.round(v * 100) / 100);

export interface TransformSpec {
  kind: TransformDialog;
  dx: number;
  dy: number;
  angle: number;
  axis: 'horizontal' | 'vertical' | 'angle';
  uniform: boolean;
  sx: number;
  sy: number;
  strokes: boolean;
}

export function TransformDialogView({
  kind,
  units,
  initial,
  onPreview,
  onCancel,
  onOk,
}: {
  kind: TransformDialog;
  units: Units;
  initial: TransformSpec;
  onPreview: (s: TransformSpec | null) => void;
  onCancel: () => void;
  onOk: (s: TransformSpec, copy: boolean) => void;
}) {
  const [s, setS] = useState<TransformSpec>({ ...initial, kind });
  const [preview, setPreview] = useState(false);
  const update = (patch: Partial<TransformSpec>) => {
    const n = { ...s, ...patch };
    setS(n);
    if (preview) onPreview(n);
  };
  const title = { move: 'Move', rotate: 'Rotate', reflect: 'Reflect', scale: 'Scale', shear: 'Shear' }[kind];
  return (
    <Dialog
      title={title}
      onCancel={() => {
        onPreview(null);
        onCancel();
      }}
      onOk={() => onOk(s, false)}
      extra={
        <div className="flex items-center gap-3">
          <Checkbox
            checked={preview}
            onChange={(v) => {
              setPreview(v);
              onPreview(v ? s : null);
            }}
          >
            Preview
          </Checkbox>
          <Button onClick={() => onOk(s, true)}>Copy</Button>
        </div>
      }
      className="w-[400px]"
    >
      <div className="flex flex-col items-start gap-3 text-xs">
        {kind === 'move' && (
          <>
            <LengthField label="Horizontal:" value={s.dx} units={units} onChange={(dx) => update({ dx })} width="w-24" />
            <LengthField label="Vertical:" value={s.dy} units={units} onChange={(dy) => update({ dy })} width="w-24" />
            <div className="text-[#9a9a9a]">
              Distance: {fmt(Math.hypot(s.dx, s.dy) / UNIT_PT[units])} {units} · Angle: {fmt((Math.atan2(-s.dy, s.dx) * 180) / Math.PI)}°
            </div>
          </>
        )}
        {kind === 'rotate' && <NumberField label="Angle:" value={s.angle} min={-360} max={360} decimals={2} unit="°" width="w-20" onChange={(angle) => update({ angle })} />}
        {kind === 'reflect' && (
          <div className="space-y-2">
            {(['horizontal', 'vertical', 'angle'] as const).map((a) => (
              <label key={a} className="flex items-center gap-2 text-[#d6d6d6]">
                <input type="radio" name="axis" checked={s.axis === a} onChange={() => update({ axis: a })} className="accent-[#2d8ceb]" />
                {a === 'horizontal' ? 'Horizontal' : a === 'vertical' ? 'Vertical' : 'Angle:'}
                {a === 'angle' && <NumberField value={s.angle} min={-360} max={360} decimals={1} unit="°" width="w-16" onChange={(angle) => update({ angle, axis: 'angle' })} />}
              </label>
            ))}
          </div>
        )}
        {kind === 'scale' && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[#d6d6d6]">
              <input type="radio" name="scale" checked={s.uniform} onChange={() => update({ uniform: true })} className="accent-[#2d8ceb]" />
              Uniform:
              <NumberField value={s.sx} min={-10000} max={10000} decimals={1} unit="%" width="w-16" onChange={(v) => update({ sx: v, sy: v, uniform: true })} />
            </label>
            <label className="flex items-center gap-2 text-[#d6d6d6]">
              <input type="radio" name="scale" checked={!s.uniform} onChange={() => update({ uniform: false })} className="accent-[#2d8ceb]" />
              Non-Uniform
            </label>
            <div className="flex gap-3 pl-6">
              <NumberField label="Horizontal:" value={s.sx} min={-10000} max={10000} decimals={1} unit="%" width="w-16" onChange={(sx) => update({ sx, uniform: false })} />
              <NumberField label="Vertical:" value={s.sy} min={-10000} max={10000} decimals={1} unit="%" width="w-16" onChange={(sy) => update({ sy, uniform: false })} />
            </div>
            <Checkbox checked={s.strokes} onChange={(strokes) => update({ strokes })}>
              Scale Strokes &amp; Effects
            </Checkbox>
          </div>
        )}
        {kind === 'shear' && (
          <div className="space-y-2">
            <NumberField label="Shear Angle:" value={s.angle} min={-89} max={89} decimals={1} unit="°" width="w-16" onChange={(angle) => update({ angle })} />
            {(['horizontal', 'vertical'] as const).map((a) => (
              <label key={a} className="flex items-center gap-2 text-[#d6d6d6]">
                <input type="radio" name="shear-axis" checked={s.axis === a} onChange={() => update({ axis: a })} className="accent-[#2d8ceb]" />
                {a === 'horizontal' ? 'Horizontal' : 'Vertical'}
              </label>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function NumberDialog({ title, label, value, unit, units, onCancel, onOk, extra }: { title: string; label: string; value: number; unit?: string; units?: Units; onCancel: () => void; onOk: (v: number) => void; extra?: React.ReactNode }) {
  const [v, setV] = useState(value);
  return (
    <Dialog title={title} onCancel={onCancel} onOk={() => onOk(v)}>
      <div className="flex flex-col items-start gap-3 text-xs">
        {units ? <LengthField label={label} value={v} units={units} onChange={setV} width="w-24" /> : <NumberField label={label} value={v} onChange={setV} unit={unit} decimals={1} width="w-20" min={-100000} max={100000} />}
        {extra}
      </div>
    </Dialog>
  );
}

export interface ShapeSpec {
  w: number;
  h: number;
  radius: number;
  sides: number;
  points: number;
  r1: number;
  r2: number;
}

export function ShapeDialog({ kind, units, initial, onCancel, onOk }: { kind: string; units: Units; initial: ShapeSpec; onCancel: () => void; onOk: (s: ShapeSpec) => void }) {
  const [s, setS] = useState(initial);
  const [linked, setLinked] = useState(false);
  const title = kind === 'rectangle' ? 'Rectangle' : kind === 'rounded-rectangle' ? 'Rounded Rectangle' : kind === 'ellipse' ? 'Ellipse' : kind === 'polygon' ? 'Polygon' : 'Star';
  return (
    <Dialog title={title} onCancel={onCancel} onOk={() => onOk(s)}>
      <div className="flex flex-col items-start gap-3 text-xs">
        {(kind === 'rectangle' || kind === 'rounded-rectangle' || kind === 'ellipse') && (
          <>
            <LengthField label="Width:" value={s.w} units={units} onChange={(w) => setS({ ...s, w, h: linked ? w : s.h })} width="w-24" />
            <LengthField label="Height:" value={s.h} units={units} onChange={(h) => setS({ ...s, h, w: linked ? h : s.w })} width="w-24" />
            <Checkbox checked={linked} onChange={setLinked}>
              Constrain Proportions
            </Checkbox>
          </>
        )}
        {kind === 'rounded-rectangle' && <LengthField label="Corner Radius:" value={s.radius} units={units} onChange={(radius) => setS({ ...s, radius })} width="w-24" />}
        {kind === 'polygon' && (
          <>
            <LengthField label="Radius:" value={s.r1} units={units} onChange={(r1) => setS({ ...s, r1 })} width="w-24" />
            <NumberField label="Sides:" value={s.sides} min={3} max={1000} width="w-16" onChange={(sides) => setS({ ...s, sides: Math.round(sides) })} />
          </>
        )}
        {kind === 'star' && (
          <>
            <LengthField label="Radius 1:" value={s.r1} units={units} onChange={(r1) => setS({ ...s, r1 })} width="w-24" />
            <LengthField label="Radius 2:" value={s.r2} units={units} onChange={(r2) => setS({ ...s, r2 })} width="w-24" />
            <NumberField label="Points:" value={s.points} min={3} max={1000} width="w-16" onChange={(points) => setS({ ...s, points: Math.round(points) })} />
          </>
        )}
      </div>
    </Dialog>
  );
}

export function ExportDialog({ artboards, onCancel, onOk }: { artboards: string[]; onCancel: () => void; onOk: (o: { format: 'png' | 'jpg' | 'svg' | 'pdf'; artboard: number | null; scale: number }) => void }) {
  const [format, setFormat] = useState<'png' | 'jpg' | 'svg' | 'pdf'>('png');
  const [artboard, setArtboard] = useState<string>('0');
  const [ppi, setPpi] = useState(144);
  return (
    <Dialog title="Export As" onCancel={onCancel} onOk={() => onOk({ format, artboard: artboard === 'all' ? null : Number(artboard), scale: ppi / 72 })} okLabel="Export…">
      <div className="flex flex-col items-start gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-20 text-[#bdbdbd]">Format:</span>
          <Select
            label="Format"
            value={format}
            onChange={setFormat}
            options={[
              ['png', 'PNG (png)'],
              ['jpg', 'JPEG (jpg)'],
              ['svg', 'SVG (svg)'],
              ['pdf', 'Adobe PDF (pdf)'],
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 text-[#bdbdbd]">Artboard:</span>
          <Select label="Artboard" value={artboard} onChange={setArtboard} options={[...artboards.map((n, i) => [String(i), `${i + 1}: ${n}`] as [string, string]), ...(format === 'svg' ? ([['all', 'All Artwork']] as [string, string][]) : [])]} />
        </div>
        {(format === 'png' || format === 'jpg') && (
          <div className="flex items-center gap-2">
            <span className="w-20 text-[#bdbdbd]">Resolution:</span>
            <Select
              label="Resolution"
              value={String(ppi)}
              onChange={(v) => setPpi(Number(v))}
              options={[
                ['72', 'Screen (72 ppi)'],
                ['144', 'Medium (144 ppi)'],
                ['300', 'High (300 ppi)'],
              ]}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function DocumentSetupDialog({ units, onCancel, onOk }: { units: Units; onCancel: () => void; onOk: (u: Units) => void }) {
  const [u, setU] = useState(units);
  return (
    <Dialog title="Document Setup" onCancel={onCancel} onOk={() => onOk(u)}>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[#bdbdbd]">Units:</span>
        <Select label="Units" value={u} onChange={setU} options={UNIT_OPTIONS} />
      </div>
    </Dialog>
  );
}

export function AverageDialog({ onCancel, onOk }: { onCancel: () => void; onOk: (a: 'h' | 'v' | 'both') => void }) {
  const [a, setA] = useState<'h' | 'v' | 'both'>('both');
  return (
    <Dialog title="Average" onCancel={onCancel} onOk={() => onOk(a)}>
      <div className="space-y-2 text-xs text-[#d6d6d6]">
        {(
          [
            ['h', 'Horizontal'],
            ['v', 'Vertical'],
            ['both', 'Both'],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="flex items-center gap-2">
            <input type="radio" name="avg" checked={a === k} onChange={() => setA(k)} className="accent-[#2d8ceb]" />
            {l}
          </label>
        ))}
      </div>
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V', 'Selection'],
  ['A', 'Direct Selection'],
  ['P', 'Pen'],
  ['+ / −', 'Add / Delete Anchor Point'],
  ['Shift+C', 'Anchor Point'],
  ['T', 'Type'],
  ['\\', 'Line Segment'],
  ['M / L', 'Rectangle / Ellipse'],
  ['B / N', 'Paintbrush / Pencil'],
  ['C', 'Scissors'],
  ['R / O', 'Rotate / Reflect'],
  ['S', 'Scale'],
  ['E', 'Free Transform'],
  ['G', 'Gradient'],
  ['I', 'Eyedropper'],
  ['Shift+O', 'Artboard'],
  ['H / Space', 'Hand'],
  ['Z', 'Zoom'],
  ['X / Shift+X', 'Fill or stroke in front / Swap'],
  ['D', 'Default fill and stroke'],
  ['< > /', 'Color / Gradient / None'],
  ['Ctrl+G / Shift+Ctrl+G', 'Group / Ungroup'],
  ['Ctrl+] / Ctrl+[', 'Bring Forward / Send Backward'],
  ['Ctrl+7 / Ctrl+8', 'Clipping Mask / Compound Path'],
  ['Ctrl+D', 'Transform Again'],
  ['Ctrl+F / Ctrl+B', 'Paste in Front / Back'],
  ['Ctrl+Y', 'Outline'],
  ['Ctrl+0 / Ctrl+1', 'Fit Artboard / Actual Size'],
  ['Alt+drag', 'Duplicate while moving'],
  ['Shift+drag', 'Constrain'],
  ['Tab', 'Hide panels'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard Shortcuts" onCancel={onClose} className="w-[460px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-mono text-[#e6e6e6]">{k}</dt>
            <dd className="text-[#bdbdbd]">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
