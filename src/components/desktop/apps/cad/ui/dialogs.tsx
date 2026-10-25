import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { DEFAULT_DIMSTYLE, type Block, type DimStyle, type Drawing, type TextStyle } from '../model';
import { boxValid, emptyBox } from '../geom';
import { entityGeom, primBox } from '../prims';
import { DARK, drawPrims, type View } from '../render';
import { OSNAP, OSNAP_NAMES } from '../snap';
import { Check2, Dialog, Field } from './chrome';
import { FIELD } from './style';

// ---- Units ------------------------------------------------------------------------------------

const LUNITS = ['', 'Scientific', 'Decimal', 'Engineering', 'Architectural', 'Fractional'];
const INSUNITS = ['Unitless', 'Inches', 'Feet', 'Miles', 'Millimeters', 'Centimeters', 'Meters', 'Kilometers', 'Microinches', 'Mils', 'Yards', 'Angstroms', 'Nanometers', 'Microns', 'Decimeters'];
const AUNITS = ['Decimal Degrees', 'Deg/Min/Sec', 'Grads', 'Radians', 'Surveyor’s Units'];

export function UnitsDialog({ drawing, onCancel, onOk }: { drawing: Drawing; onCancel: () => void; onOk: (h: Drawing['header']) => void }) {
  const [h, setH] = useState(drawing.header);
  const sel = (value: number, opts: string[], fn: (v: number) => void, from = 0, label = '') => (
    <select aria-label={label} value={value} onChange={(e) => fn(parseInt(e.target.value, 10))} onKeyDown={(e) => e.stopPropagation()} className={cn(FIELD, 'w-48 [&>option]:bg-[#2f3640]')}>
      {opts.map((o, i) => (i < from ? null : <option key={o} value={i}>{o}</option>))}
    </select>
  );
  const sample = (1.5).toFixed(h.luprec);
  return (
    <Dialog title="Drawing Units" onCancel={onCancel} onOk={() => onOk(h)} width={460}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <fieldset className="space-y-1">
          <legend className="mb-1 text-[12px] font-semibold text-[#dfe4ec]">Length</legend>
          <Field label="Type">{sel(h.lunits, LUNITS, (v) => setH({ ...h, lunits: v }), 1, 'Length type')}</Field>
          <Field label="Precision">{sel(h.luprec, ['0', '0.0', '0.00', '0.000', '0.0000', '0.00000', '0.000000', '0.0000000', '0.00000000'], (v) => setH({ ...h, luprec: v }), 0, 'Length precision')}</Field>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-[12px] font-semibold text-[#dfe4ec]">Angle</legend>
          <Field label="Type">{sel(h.aunits, AUNITS, (v) => setH({ ...h, aunits: v }), 0, 'Angle type')}</Field>
          <Field label="Precision">{sel(h.auprec, ['0', '0.0', '0.00', '0.000', '0.0000'], (v) => setH({ ...h, auprec: v }), 0, 'Angle precision')}</Field>
          <Check2 checked={h.angdir} onChange={(v) => setH({ ...h, angdir: v })}>
            Clockwise
          </Check2>
        </fieldset>
      </div>
      <fieldset className="mt-3 space-y-1">
        <legend className="mb-1 text-[12px] font-semibold text-[#dfe4ec]">Insertion scale</legend>
        <Field label="Units to scale inserted content">{sel(h.insunits, INSUNITS, (v) => setH({ ...h, insunits: v }), 0, 'Insertion units')}</Field>
      </fieldset>
      <p className="mt-3 text-[12px] text-[#a9b2bf]">Sample output: {sample},2.0039,0</p>
    </Dialog>
  );
}

// ---- Drafting settings ------------------------------------------------------------------------

export interface DraftSettings {
  osmode: number;
  osnap: boolean;
  grid: boolean;
  snap: boolean;
  snapUnit: number;
  gridUnit: number;
  polar: boolean;
  polarAngle: number;
  ortho: boolean;
  dyn: boolean;
}

export function DraftingDialog({ s, onCancel, onOk }: { s: DraftSettings; onCancel: () => void; onOk: (s: DraftSettings) => void }) {
  const [v, setV] = useState(s);
  const [tab, setTab] = useState<'snap' | 'polar' | 'osnap'>('osnap');
  const numField = (value: number, fn: (n: number) => void, label: string) => (
    <input
      aria-label={label}
      defaultValue={value}
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const n = parseFloat(e.target.value);
        if (n > 0) fn(n);
      }}
      className={cn(FIELD, 'w-28')}
    />
  );
  return (
    <Dialog title="Drafting Settings" onCancel={onCancel} onOk={() => onOk(v)} width={480}>
      <div role="tablist" className="mb-3 flex gap-1 border-b border-[#4a5260]">
        {(
          [
            ['snap', 'Snap and Grid'],
            ['polar', 'Polar Tracking'],
            ['osnap', 'Object Snap'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('-mb-px rounded-t-[3px] border px-3 py-1 text-[12px]', tab === id ? 'border-[#4a5260] border-b-[#333a45] bg-[#333a45]' : 'border-transparent text-[#a9b2bf] hover:text-white')}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'snap' && (
        <div className="space-y-2">
          <Check2 checked={v.snap} onChange={(x) => setV({ ...v, snap: x })}>
            Snap On (F9)
          </Check2>
          <Field label="Snap spacing">{numField(v.snapUnit, (n) => setV({ ...v, snapUnit: n }), 'Snap spacing')}</Field>
          <Check2 checked={v.grid} onChange={(x) => setV({ ...v, grid: x })}>
            Grid On (F7)
          </Check2>
          <Field label="Grid spacing">{numField(v.gridUnit, (n) => setV({ ...v, gridUnit: n }), 'Grid spacing')}</Field>
        </div>
      )}
      {tab === 'polar' && (
        <div className="space-y-2">
          <Check2 checked={v.polar} onChange={(x) => setV({ ...v, polar: x, ortho: x ? false : v.ortho })}>
            Polar Tracking On (F10)
          </Check2>
          <Field label="Increment angle">
            <select aria-label="Increment angle" value={v.polarAngle} onChange={(e) => setV({ ...v, polarAngle: parseFloat(e.target.value) })} onKeyDown={(e) => e.stopPropagation()} className={cn(FIELD, 'w-28 [&>option]:bg-[#2f3640]')}>
              {[90, 45, 30, 22.5, 18, 15, 10, 5].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Check2 checked={v.ortho} onChange={(x) => setV({ ...v, ortho: x, polar: x ? false : v.polar })}>
            Ortho Mode (F8)
          </Check2>
          <Check2 checked={v.dyn} onChange={(x) => setV({ ...v, dyn: x })}>
            Dynamic Input (F12)
          </Check2>
        </div>
      )}
      {tab === 'osnap' && (
        <div>
          <Check2 checked={v.osnap} onChange={(x) => setV({ ...v, osnap: x })}>
            Object Snap On (F3)
          </Check2>
          <div className="mt-2 grid grid-cols-2 gap-x-6">
            {OSNAP_NAMES.map(([k, label]) => (
              <Check2 key={k} checked={(v.osmode & OSNAP[k]) !== 0} onChange={(x) => setV({ ...v, osmode: x ? v.osmode | OSNAP[k] : v.osmode & ~OSNAP[k] })}>
                {label}
              </Check2>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="text-[12px] text-[#7fc8ff] hover:underline" onClick={() => setV({ ...v, osmode: Object.values(OSNAP).reduce((a, b) => a | b, 0) })}>
              Select All
            </button>
            <button type="button" className="text-[12px] text-[#7fc8ff] hover:underline" onClick={() => setV({ ...v, osmode: 0 })}>
              Clear All
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---- Insert -------------------------------------------------------------------------------------

export function BlockThumb({ block, drawing, size = 88 }: { block: Block; drawing: Drawing; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#212830';
    ctx.fillRect(0, 0, c.width, c.height);
    const geoms = block.entities.map((e) => entityGeom(e, drawing));
    const box = emptyBox();
    for (const g of geoms) for (const p of g.prims) primBox(p, box);
    if (!boxValid(box)) return;
    const w = Math.max(box.max.x - box.min.x, 1e-9);
    const h = Math.max(box.max.y - box.min.y, 1e-9);
    const v: View = { cx: (box.min.x + box.max.x) / 2, cy: (box.min.y + box.max.y) / 2, scale: (size * 0.84) / Math.max(w, h) };
    drawPrims(ctx, geoms.flatMap((g) => g.prims), v, { w: size, h: size, dpr }, { lineweights: false, theme: DARK });
  }, [block, drawing, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} className="rounded-[2px] border border-[#4a5260]" aria-hidden />;
}

export function InsertDialog({ drawing, onCancel, onOk }: { drawing: Drawing; onCancel: () => void; onOk: (r: { name: string; scale: number; rotation: number }) => void }) {
  const blocks = Object.values(drawing.blocks).filter((b) => !b.name.startsWith('*'));
  const [name, setName] = useState(blocks[0]?.name ?? '');
  const [scale, setScale] = useState(1);
  const [rot, setRot] = useState(0);
  const ok = () => name && onOk({ name, scale, rotation: (rot * Math.PI) / 180 });
  return (
    <Dialog title="Insert" onCancel={onCancel} onOk={blocks.length ? ok : undefined} okLabel="Insert" width={560}>
      {blocks.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-[#a9b2bf]">This drawing has no blocks yet. Use Create Block (B) to make one from objects in the drawing.</p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-[#a9b2bf]">Current Drawing Blocks</p>
          <div className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2 overflow-y-auto">
            {blocks.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => setName(b.name)}
                onDoubleClick={() => onOk({ name: b.name, scale, rotation: (rot * Math.PI) / 180 })}
                aria-pressed={name === b.name}
                className={cn('flex flex-col items-center gap-1 rounded-[3px] border p-1.5 text-[11.5px]', name === b.name ? 'border-[#3fa9f5] bg-[#0b6aa8]/30' : 'border-transparent hover:bg-white/5')}
              >
                <BlockThumb block={b} drawing={drawing} />
                <span className="w-full truncate text-center">{b.name}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex gap-6">
            <Field label="Scale">
              <input aria-label="Scale" defaultValue={scale} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => parseFloat(e.target.value) > 0 && setScale(parseFloat(e.target.value))} className={cn(FIELD, 'w-20')} />
            </Field>
            <Field label="Rotation">
              <input aria-label="Rotation" defaultValue={rot} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => Number.isFinite(parseFloat(e.target.value)) && setRot(parseFloat(e.target.value))} className={cn(FIELD, 'w-20')} />
            </Field>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ---- Text styles --------------------------------------------------------------------------------

const FONTS = ['txt', 'simplex.shx', 'romans.shx', 'isocp.shx', 'arial.ttf', 'times.ttf', 'cour.ttf', 'calibri.ttf'];

export function TextStyleDialog({ drawing, onCancel, onOk }: { drawing: Drawing; onCancel: () => void; onOk: (styles: TextStyle[], current: string) => void }) {
  const [styles, setStyles] = useState(drawing.textStyles);
  const [cur, setCur] = useState(drawing.header.textstyle);
  const [sel, setSel] = useState(drawing.header.textstyle);
  const s = styles.find((x) => x.name === sel) ?? styles[0];
  const patch = (p: Partial<TextStyle>) => setStyles(styles.map((x) => (x.name === s.name ? { ...x, ...p } : x)));
  return (
    <Dialog title="Text Style" onCancel={onCancel} onOk={() => onOk(styles, cur)} width={560}>
      <div className="flex gap-4">
        <div className="w-44 shrink-0">
          <p className="mb-1 text-[12px] text-[#a9b2bf]">Styles</p>
          <ul className="h-44 overflow-y-auto rounded-[2px] border border-[#4a5260] bg-[#262c34]">
            {styles.map((x) => (
              <li key={x.name}>
                <button type="button" onClick={() => setSel(x.name)} className={cn('w-full px-2 py-1 text-left text-[12px]', x.name === sel ? 'bg-[#0b6aa8] text-white' : 'hover:bg-white/5')}>
                  {x.name === cur ? '▸ ' : ''}
                  {x.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="text-[12px] text-[#7fc8ff] hover:underline"
              onClick={() => {
                let n = 1;
                while (styles.some((x) => x.name === `Style${n}`)) n++;
                setStyles([...styles, { ...s, name: `Style${n}` }]);
                setSel(`Style${n}`);
              }}
            >
              New…
            </button>
            <button type="button" className="text-[12px] text-[#7fc8ff] hover:underline" onClick={() => setCur(sel)}>
              Set Current
            </button>
          </div>
        </div>
        {s && (
          <div className="flex-1 space-y-1">
            <Field label="Name">
              <input key={s.name} aria-label="Style name" defaultValue={s.name} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== s.name && !styles.some((x) => x.name === v)) {
                  patch({ name: v });
                  if (cur === s.name) setCur(v);
                  setSel(v);
                }
              }} className={cn(FIELD, 'w-48')} />
            </Field>
            <Field label="Font">
              <select aria-label="Font" value={s.font} onChange={(e) => patch({ font: e.target.value })} onKeyDown={(e) => e.stopPropagation()} className={cn(FIELD, 'w-48 [&>option]:bg-[#2f3640]')}>
                {[...new Set([s.font, ...FONTS])].map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Field>
            <Field label="Height (0 asks)">
              <input key={`h${s.name}`} aria-label="Height" defaultValue={s.height} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => parseFloat(e.target.value) >= 0 && patch({ height: parseFloat(e.target.value) })} className={cn(FIELD, 'w-48')} />
            </Field>
            <Field label="Width factor">
              <input key={`w${s.name}`} aria-label="Width factor" defaultValue={s.width} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => parseFloat(e.target.value) > 0 && patch({ width: parseFloat(e.target.value) })} className={cn(FIELD, 'w-48')} />
            </Field>
            <Field label="Oblique angle">
              <input key={`o${s.name}`} aria-label="Oblique angle" defaultValue={(s.oblique * 180) / Math.PI} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => Number.isFinite(parseFloat(e.target.value)) && patch({ oblique: (parseFloat(e.target.value) * Math.PI) / 180 })} className={cn(FIELD, 'w-48')} />
            </Field>
            <p className="pt-2 text-[11.5px] text-[#8e98a6]">SHX fonts are shown with a similar outline font.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- Dimension styles --------------------------------------------------------------------------

export function DimStyleDialog({ drawing, onCancel, onOk }: { drawing: Drawing; onCancel: () => void; onOk: (styles: DimStyle[], current: string) => void }) {
  const [styles, setStyles] = useState(drawing.dimStyles);
  const [cur, setCur] = useState(drawing.header.dimstyle);
  const [sel, setSel] = useState(drawing.header.dimstyle);
  const s = styles.find((x) => x.name === sel) ?? styles[0];
  const patch = (p: Partial<DimStyle>) => setStyles(styles.map((x) => (x.name === s.name ? { ...x, ...p } : x)));
  const num = (key: keyof DimStyle, label: string) => (
    <Field label={label}>
      <input
        key={`${s.name}${key}`}
        aria-label={label}
        defaultValue={String(s[key])}
        onKeyDown={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= 0) patch({ [key]: v } as Partial<DimStyle>);
        }}
        className={cn(FIELD, 'w-28')}
      />
    </Field>
  );
  return (
    <Dialog title="Dimension Style Manager" onCancel={onCancel} onOk={() => onOk(styles, cur)} width={620}>
      <div className="flex gap-4">
        <div className="w-44 shrink-0">
          <p className="mb-1 text-[12px] text-[#a9b2bf]">Styles</p>
          <ul className="h-64 overflow-y-auto rounded-[2px] border border-[#4a5260] bg-[#262c34]">
            {styles.map((x) => (
              <li key={x.name}>
                <button type="button" onClick={() => setSel(x.name)} className={cn('w-full px-2 py-1 text-left text-[12px]', x.name === sel ? 'bg-[#0b6aa8] text-white' : 'hover:bg-white/5')}>
                  {x.name === cur ? '▸ ' : ''}
                  {x.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="text-[12px] text-[#7fc8ff] hover:underline"
              onClick={() => {
                let n = 1;
                while (styles.some((x) => x.name === `Copy of ${s.name}${n > 1 ? ` ${n}` : ''}`)) n++;
                const name = `Copy of ${s.name}${n > 1 ? ` ${n}` : ''}`;
                setStyles([...styles, { ...(s ?? DEFAULT_DIMSTYLE), name }]);
                setSel(name);
              }}
            >
              New…
            </button>
            <button type="button" className="text-[12px] text-[#7fc8ff] hover:underline" onClick={() => setCur(sel)}>
              Set Current
            </button>
          </div>
        </div>
        {s && (
          <div className="grid flex-1 grid-cols-2 gap-x-5">
            <div>
              <p className="mb-1 text-[12px] font-semibold">Lines and arrows</p>
              {num('dimasz', 'Arrow size')}
              {num('dimexe', 'Extend beyond dim lines')}
              {num('dimexo', 'Offset from origin')}
              {num('dimcen', 'Center mark')}
              {num('dimtsz', 'Tick size (0 = arrows)')}
              <p className="mt-2 mb-1 text-[12px] font-semibold">Fit</p>
              {num('dimscale', 'Overall scale')}
            </div>
            <div>
              <p className="mb-1 text-[12px] font-semibold">Text</p>
              {num('dimtxt', 'Text height')}
              {num('dimgap', 'Offset from dim line')}
              <Field label="Vertical">
                <select aria-label="Text vertical position" value={s.dimtad} onChange={(e) => patch({ dimtad: parseInt(e.target.value, 10) })} onKeyDown={(e) => e.stopPropagation()} className={cn(FIELD, 'w-28 [&>option]:bg-[#2f3640]')}>
                  <option value={0}>Centered</option>
                  <option value={1}>Above</option>
                </select>
              </Field>
              <Check2 checked={s.dimtih} onChange={(v) => patch({ dimtih: v, dimtoh: v })}>
                Horizontal text
              </Check2>
              <p className="mt-2 mb-1 text-[12px] font-semibold">Primary units</p>
              {num('dimdec', 'Precision')}
              {num('dimlfac', 'Scale factor')}
              <Field label="Suffix">
                <input key={`${s.name}post`} aria-label="Suffix" defaultValue={s.dimpost} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => patch({ dimpost: e.target.value })} className={cn(FIELD, 'w-28')} />
              </Field>
              <Check2 checked={(s.dimzin & 8) !== 0} onChange={(v) => patch({ dimzin: v ? s.dimzin | 8 : s.dimzin & ~8 })}>
                Suppress trailing zeros
              </Check2>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
