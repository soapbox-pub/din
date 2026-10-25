import { useState } from 'react';
import { Link2, Unlink2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Checkbox, Dialog, IconButton, Select } from '../photo/chrome';
import { ColorPicker } from '../photo/color';
import { INPUT } from '../photo/styles';
import { cmykToRgb, fromHex, hex, rgbToCmyk } from './colors';
import { LengthField, NumField } from './fields';
import { PRESETS, type NewDocSettings } from './newdoc';
import type { FrameOptions } from './ops';
import { UNIT_NAMES, type Unit } from './units';

/** Page Layout's dialogs, after InDesign's. */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-xs text-[#cfcfcf]">{label}</span>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-2 rounded-md border border-[#4a4a4a] p-3">
      <legend className="px-1 text-xs font-semibold text-[#e0e0e0]">{title}</legend>
      {children}
    </fieldset>
  );
}

/** Four sides with InDesign's chain: linked, one value sets all. */
function Sides({
  labels,
  values,
  unit,
  onChange,
}: {
  labels: [string, string, string, string];
  values: [number, number, number, number];
  unit: Unit;
  onChange: (v: [number, number, number, number]) => void;
}) {
  const [linked, setLinked] = useState(values.every((v) => v === values[0]));
  const set = (i: number, v: number) => onChange(linked ? [v, v, v, v] : (values.map((x, j) => (j === i ? v : x)) as [number, number, number, number]));
  return (
    <div className="flex items-center gap-2">
      <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2">
        {labels.map((l, i) => (
          <LengthField key={l} label={`${l}:`} value={values[i]} unit={unit} min={0} onChange={(v) => set(i, v)} width="w-[78px]" />
        ))}
      </div>
      <IconButton label={linked ? 'Make all settings the same: on' : 'Make all settings the same: off'} pressed={linked} onClick={() => setLinked(!linked)}>
        {linked ? <Link2 className="size-4" /> : <Unlink2 className="size-4" />}
      </IconButton>
    </div>
  );
}

export function NewDocDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (s: NewDocSettings) => void }) {
  const [preset, setPreset] = useState('Letter');
  const [s, setS] = useState<NewDocSettings>({
    width: 612,
    height: 792,
    pages: 1,
    facing: true,
    startPage: 1,
    columns: 1,
    gutter: 12,
    margins: { top: 36, bottom: 36, inside: 36, outside: 36 },
    bleed: { top: 0, bottom: 0, inside: 0, outside: 0 },
    unit: 'in',
    primaryTextFrame: false,
  });
  const portrait = s.height >= s.width;
  const u = s.unit;
  return (
    <Dialog title="New Document" onCancel={onCancel} onOk={() => onCreate(s)} okLabel="Create" className="w-[560px]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Preset">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              role="radio"
              aria-checked={preset === p.name}
              onClick={() => {
                setPreset(p.name);
                setS((x) => ({ ...x, width: portrait ? p.w : p.h, height: portrait ? p.h : p.w, unit: p.unit, margins: p.unit === 'mm' ? { top: 36, bottom: 36, inside: 36, outside: 36 } : x.margins }));
              }}
              className={cn('flex h-16 w-[78px] flex-col items-center justify-center gap-1 rounded-md border text-[11px]', preset === p.name ? 'border-[#2d8ceb] bg-[#2d8ceb]/15 text-white' : 'border-[#555] text-[#cfcfcf] hover:border-[#777]')}
            >
              <span className="border border-current" style={{ width: (p.w / p.h) * 26, height: 26 }} />
              {p.name}
            </button>
          ))}
        </div>
        <Group title="Page">
          <Row label="Width:">
            <LengthField value={s.width} unit={u} min={1} max={15552} onChange={(v) => setS({ ...s, width: v })} width="w-[90px]" />
            <span className="text-xs text-[#9a9a9a]">Height:</span>
            <LengthField value={s.height} unit={u} min={1} max={15552} onChange={(v) => setS({ ...s, height: v })} width="w-[90px]" />
          </Row>
          <Row label="Units:">
            <Select<Unit> label="Units" value={u} onChange={(v) => setS({ ...s, unit: v })} options={(Object.keys(UNIT_NAMES) as Unit[]).map((k) => [k, UNIT_NAMES[k]] as const)} className="w-36" />
            <span className="text-xs text-[#9a9a9a]">Orientation:</span>
            <IconButton label="Portrait" pressed={portrait} onClick={() => !portrait && setS({ ...s, width: s.height, height: s.width })}>
              <span className="h-4 w-3 border border-current" />
            </IconButton>
            <IconButton label="Landscape" pressed={!portrait} onClick={() => portrait && setS({ ...s, width: s.height, height: s.width })}>
              <span className="h-3 w-4 border border-current" />
            </IconButton>
          </Row>
          <Row label="Pages:">
            <NumField value={s.pages} decimals={0} min={1} max={9999} onChange={(v) => setS({ ...s, pages: Math.round(v) })} width="w-[60px]" />
            <Checkbox checked={s.facing} onChange={(v) => setS({ ...s, facing: v })}>
              Facing Pages
            </Checkbox>
          </Row>
          <Row label="Start #:">
            <NumField value={s.startPage} decimals={0} min={1} max={99999} onChange={(v) => setS({ ...s, startPage: Math.round(v) })} width="w-[60px]" />
            <Checkbox checked={s.primaryTextFrame} onChange={(v) => setS({ ...s, primaryTextFrame: v })}>
              Primary Text Frame
            </Checkbox>
          </Row>
        </Group>
        <Group title="Columns">
          <Row label="Number:">
            <NumField value={s.columns} decimals={0} min={1} max={216} onChange={(v) => setS({ ...s, columns: Math.round(v) })} width="w-[60px]" />
            <span className="text-xs text-[#9a9a9a]">Gutter:</span>
            <LengthField value={s.gutter} unit={u} min={0} onChange={(v) => setS({ ...s, gutter: v })} width="w-[90px]" />
          </Row>
        </Group>
        <Group title="Margins">
          <Sides
            labels={['Top', 'Bottom', s.facing ? 'Inside' : 'Left', s.facing ? 'Outside' : 'Right']}
            values={[s.margins.top, s.margins.bottom, s.margins.inside, s.margins.outside]}
            unit={u}
            onChange={([top, bottom, inside, outside]) => setS({ ...s, margins: { top, bottom, inside, outside } })}
          />
        </Group>
        <Group title="Bleed">
          <Sides
            labels={['Top', 'Bottom', s.facing ? 'Inside' : 'Left', s.facing ? 'Outside' : 'Right']}
            values={[s.bleed.top, s.bleed.bottom, s.bleed.inside, s.bleed.outside]}
            unit={u}
            onChange={([top, bottom, inside, outside]) => setS({ ...s, bleed: { top, bottom, inside, outside } })}
          />
        </Group>
      </div>
    </Dialog>
  );
}

const VJ: readonly (readonly [string, string])[] = [
  ['TopAlign', 'Top'],
  ['CenterAlign', 'Center'],
  ['BottomAlign', 'Bottom'],
  ['JustifyAlign', 'Justify'],
];
const FB: readonly (readonly [string, string])[] = [
  ['AscentOffset', 'Ascent'],
  ['CapHeight', 'Cap Height'],
  ['LeadingOffset', 'Leading'],
  ['XHeight', 'x Height'],
  ['EmBoxHeight', 'Em Box Height'],
  ['FixedHeight', 'Fixed'],
];

export function TextFrameOptionsDialog({ initial, unit, onCancel, onOk, onPreview }: { initial: FrameOptions; unit: Unit; onCancel: () => void; onOk: (o: FrameOptions) => void; onPreview: (o: FrameOptions | null) => void }) {
  const [o, setO] = useState(initial);
  const [preview, setPreview] = useState(false);
  const set = (n: FrameOptions) => {
    setO(n);
    if (preview) onPreview(n);
  };
  return (
    <Dialog
      title="Text Frame Options"
      onCancel={() => {
        onPreview(null);
        onCancel();
      }}
      onOk={() => onOk(o)}
      className="w-[460px]"
      extra={
        <Checkbox
          checked={preview}
          onChange={(v) => {
            setPreview(v);
            onPreview(v ? o : null);
          }}
        >
          Preview
        </Checkbox>
      }
    >
      <div className="space-y-3">
        <Group title="Columns">
          <Row label="Number:">
            <NumField value={o.columns} decimals={0} min={1} max={40} onChange={(v) => set({ ...o, columns: Math.round(v) })} width="w-[60px]" />
          </Row>
          <Row label="Gutter:">
            <LengthField value={o.gutter} unit={unit} min={0} onChange={(v) => set({ ...o, gutter: v })} width="w-[90px]" />
          </Row>
        </Group>
        <Group title="Inset Spacing">
          <Sides labels={['Top', 'Bottom', 'Left', 'Right']} values={[o.inset[0], o.inset[2], o.inset[1], o.inset[3]]} unit={unit} onChange={([t, b, l, r]) => set({ ...o, inset: [t, l, b, r] })} />
        </Group>
        <Group title="Vertical Justification">
          <Row label="Align:">
            <Select label="Vertical justification" value={o.vj} onChange={(v) => set({ ...o, vj: v })} options={VJ} className="w-32" />
          </Row>
        </Group>
        <Group title="First Baseline">
          <Row label="Offset:">
            <Select label="First baseline offset" value={o.firstBaseline} onChange={(v) => set({ ...o, firstBaseline: v })} options={FB} className="w-32" />
            <span className="text-xs text-[#9a9a9a]">Min:</span>
            <LengthField value={o.minFirstBaseline} unit={unit} min={0} onChange={(v) => set({ ...o, minFirstBaseline: v })} />
          </Row>
        </Group>
        <Checkbox checked={o.ignoreWrap} onChange={(v) => set({ ...o, ignoreWrap: v })}>
          Ignore Text Wrap
        </Checkbox>
      </div>
    </Dialog>
  );
}

export function InsertPagesDialog({ count, masters, onCancel, onOk }: { count: number; masters: { self: string; name: string }[]; onCancel: () => void; onOk: (n: number, where: 'after' | 'before' | 'start' | 'end', at: number, master: string | null) => void }) {
  const [n, setN] = useState(1);
  const [where, setWhere] = useState<'after' | 'before' | 'start' | 'end'>('after');
  const [at, setAt] = useState(count);
  const [master, setMaster] = useState(masters[0]?.self ?? 'none');
  return (
    <Dialog title="Insert Pages" onCancel={onCancel} onOk={() => onOk(n, where, at, master === 'none' ? null : master)}>
      <div className="space-y-2">
        <Row label="Pages:">
          <NumField value={n} decimals={0} min={1} max={9999} onChange={(v) => setN(Math.round(v))} width="w-[60px]" />
        </Row>
        <Row label="Insert:">
          <Select<'after' | 'before' | 'start' | 'end'>
            label="Insert where"
            value={where}
            onChange={setWhere}
            options={[
              ['after', 'After Page'],
              ['before', 'Before Page'],
              ['start', 'At Start of Document'],
              ['end', 'At End of Document'],
            ]}
            className="w-40"
          />
          {(where === 'after' || where === 'before') && <NumField value={at} decimals={0} min={1} max={count} onChange={(v) => setAt(Math.round(v))} width="w-[52px]" />}
        </Row>
        <Row label="Master:">
          <Select label="Master" value={master} onChange={setMaster} options={[['none', '[None]'] as const, ...masters.map((m) => [m.self, m.name] as const)]} className="w-40" />
        </Row>
      </div>
    </Dialog>
  );
}

export function MarginsDialog({
  initial,
  unit,
  onCancel,
  onOk,
}: {
  initial: { top: number; bottom: number; left: number; right: number; columns: number; gutter: number };
  unit: Unit;
  onCancel: () => void;
  onOk: (m: { top: number; bottom: number; left: number; right: number; columns: number; gutter: number }) => void;
}) {
  const [m, setM] = useState(initial);
  return (
    <Dialog title="Margins and Columns" onCancel={onCancel} onOk={() => onOk(m)} className="w-[440px]">
      <div className="space-y-3">
        <Group title="Margins">
          <Sides labels={['Top', 'Bottom', 'Inside', 'Outside']} values={[m.top, m.bottom, m.left, m.right]} unit={unit} onChange={([top, bottom, left, right]) => setM({ ...m, top, bottom, left, right })} />
        </Group>
        <Group title="Columns">
          <Row label="Number:">
            <NumField value={m.columns} decimals={0} min={1} max={216} onChange={(v) => setM({ ...m, columns: Math.round(v) })} width="w-[60px]" />
            <span className="text-xs text-[#9a9a9a]">Gutter:</span>
            <LengthField value={m.gutter} unit={unit} min={0} onChange={(v) => setM({ ...m, gutter: v })} />
          </Row>
        </Group>
        <p className="text-xs text-[#a0a0a0]">Applies to the selected pages in the Pages panel (or the current page).</p>
      </div>
    </Dialog>
  );
}

export function CornerDialog({ initial, unit, onCancel, onOk }: { initial: { option: string; radius: number }; unit: Unit; onCancel: () => void; onOk: (option: string, radius: number) => void }) {
  const [option, setOption] = useState(initial.option);
  const [radius, setRadius] = useState(initial.radius);
  return (
    <Dialog title="Corner Options" onCancel={onCancel} onOk={() => onOk(option, radius)}>
      <div className="space-y-2">
        <Row label="Shape:">
          <Select
            label="Corner shape"
            value={option}
            onChange={setOption}
            options={[
              ['None', 'None'],
              ['RoundedCorner', 'Rounded'],
              ['InverseRoundedCorner', 'Inverse Rounded'],
              ['BevelCorner', 'Bevel'],
              ['InsetCorner', 'Inset'],
            ]}
            className="w-40"
          />
        </Row>
        <Row label="Size:">
          <LengthField value={radius} unit={unit} min={0} onChange={setRadius} width="w-[90px]" />
        </Row>
      </div>
    </Dialog>
  );
}

export function SwatchDialog({
  title,
  initial,
  onCancel,
  onOk,
}: {
  title: string;
  initial: { name: string; space: 'CMYK' | 'RGB'; values: number[] };
  onCancel: () => void;
  onOk: (name: string, space: 'CMYK' | 'RGB', values: number[]) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [nameEdited, setNameEdited] = useState(false);
  const [space, setSpace] = useState(initial.space);
  const [values, setValues] = useState(initial.values);
  const rgb = space === 'CMYK' ? cmykToRgb(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0) : ([values[0] ?? 0, values[1] ?? 0, values[2] ?? 0] as [number, number, number]);
  const autoName = space === 'CMYK' ? `C=${Math.round(values[0])} M=${Math.round(values[1])} Y=${Math.round(values[2])} K=${Math.round(values[3])}` : `R=${Math.round(values[0])} G=${Math.round(values[1])} B=${Math.round(values[2])}`;
  return (
    <Dialog title={title} onCancel={onCancel} onOk={() => onOk(nameEdited ? name : autoName, space, values)} className="w-[420px]">
      <div className="space-y-3">
        <Row label="Swatch Name:">
          <input
            value={nameEdited ? name : autoName}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(INPUT, 'flex-1')}
            aria-label="Swatch name"
          />
        </Row>
        <Row label="Color Mode:">
          <Select<'CMYK' | 'RGB'>
            label="Color mode"
            value={space}
            onChange={(v) => {
              setSpace(v);
              setValues(v === 'CMYK' ? rgbToCmyk(...rgb) : [...rgb]);
            }}
            options={[
              ['CMYK', 'CMYK'],
              ['RGB', 'RGB'],
            ]}
            className="w-28"
          />
        </Row>
        <ColorPicker
          value={hex(rgb)}
          onChange={(h) => {
            const c = fromHex(h);
            setValues(space === 'CMYK' ? rgbToCmyk(...c) : [...c]);
          }}
        />
        <div className="grid grid-cols-4 gap-2">
          {(space === 'CMYK' ? ['C', 'M', 'Y', 'K'] : ['R', 'G', 'B']).map((ch, i) => (
            <NumField key={ch} label={ch} value={Math.round(values[i] ?? 0)} decimals={0} min={0} max={space === 'CMYK' ? 100 : 255} onChange={(v) => setValues(values.map((x, j) => (j === i ? v : x)))} width="w-[44px]" />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

export function DocumentSetupDialog({ initial, unit, onCancel, onOk }: { initial: { width: number; height: number; facing: boolean }; unit: Unit; onCancel: () => void; onOk: (w: number, h: number) => void }) {
  const [w, setW] = useState(initial.width);
  const [h, setH] = useState(initial.height);
  return (
    <Dialog title="Document Setup" onCancel={onCancel} onOk={() => onOk(w, h)}>
      <div className="space-y-2">
        <Row label="Width:">
          <LengthField value={w} unit={unit} min={1} onChange={setW} width="w-[90px]" />
        </Row>
        <Row label="Height:">
          <LengthField value={h} unit={unit} min={1} onChange={setH} width="w-[90px]" />
        </Row>
        <p className="text-xs text-[#a0a0a0]">{initial.facing ? 'Facing pages. ' : ''}Page items keep their place from the top left of each page.</p>
      </div>
    </Dialog>
  );
}

const SHORTCUTS: [string, string][] = [
  ['V / A', 'Selection / Direct Selection'],
  ['T', 'Type tool (double-click a text frame to type in it)'],
  ['F / M / L / \\', 'Rectangle Frame / Rectangle / Ellipse / Line'],
  ['P / N', 'Pen / Pencil'],
  ['E / R / S / O', 'Free Transform / Rotate / Scale / Shear'],
  ['G / I / H / Z', 'Gradient Swatch / Eyedropper / Hand / Zoom'],
  ['Space / Ctrl+Space', 'Hand / Zoom while held'],
  ['X / Shift+X / D / /', 'Fill or stroke / swap / defaults / none'],
  ['W', 'Normal and Preview'],
  ['Ctrl+D', 'Place (into the selected frame, or with a loaded cursor)'],
  ['Alt+Shift+Ctrl+E / C', 'Fit content proportionally / Fill frame proportionally'],
  ['Ctrl+G / Shift+Ctrl+G', 'Group / Ungroup'],
  ['Ctrl+] / Ctrl+[', 'Forward / Backward (Shift: front / back)'],
  ['Arrows (Shift)', 'Nudge (×10)'],
  ['Alt+drag', 'Duplicate'],
  ['Ctrl+B', 'Text Frame Options'],
  ['Shift+Ctrl+> / <', 'Larger / smaller type'],
  ['Shift+Ctrl+L C R J F', 'Align left, center, right, justify, justify all'],
  ['Ctrl+0 / Alt+Ctrl+0 / Ctrl+1', 'Fit page / Fit spread / Actual size'],
  ['Ctrl+; / Ctrl+H / Alt+Ctrl+Y', 'Guides / Frame edges / Text threads'],
  ['F5 F6 F7 F10 F11 F12', 'Swatches, Color, Layers, Stroke, Paragraph Styles, Pages'],
  ['Ctrl+T / Alt+Ctrl+T', 'Character / Paragraph'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard Shortcuts" onCancel={onClose} className="w-[520px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
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

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="About Page Layout" onCancel={onClose}>
      <div className="space-y-2 text-sm text-[#e0e0e0]">
        <p>Page Layout opens InDesign documents (.indd, .indt) and InDesign Markup (.idml), and saves IDML, which InDesign opens.</p>
        <p className="text-xs text-[#a0a0a0]">INDD files are read with indd-utils. Fonts that aren’t on this computer are shown with similar free fonts; the document keeps its own font names.</p>
      </div>
    </Dialog>
  );
}

export function SaveNoteDialog({ name, onCancel, onOk }: { name: string; onCancel: () => void; onOk: () => void }) {
  return (
    <Dialog title="Save As IDML" onCancel={onCancel} onOk={onOk} okLabel="Save As…">
      <p className="text-sm text-[#e6e6e6]">“{name}” is an InDesign document. Page Layout can’t write that format, so it saves InDesign Markup (.idml) instead.</p>
      <p className="mt-1 text-xs text-[#a0a0a0]">InDesign opens IDML files, and saving one from there makes an .indd again. The original file isn’t changed.</p>
    </Dialog>
  );
}

export { Button };
