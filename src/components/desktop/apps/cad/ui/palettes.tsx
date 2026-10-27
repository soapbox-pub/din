import { useState } from 'react';
import { Check, Focus, Lightbulb, LightbulbOff, Lock, LockOpen, Plus, Printer, Snowflake, Sun, Trash2, X } from 'lucide-react';
import { DropdownMenu as Menu } from 'radix-ui';
import { colorName } from '../aci';
import {
  BYLAYER,
  ENTITY_NAMES,
  EXTRA_LINETYPES,
  LINEWEIGHTS,
  LW_BYBLOCK,
  LW_BYLAYER,
  LW_DEFAULT,
  defaultLayer,
  findLayer,
  type Drawing,
  type Entity,
  type EntityType,
  type Layer,
  type Vec,
} from '../model';
import { TAU, dist, ellipsePoints, entitySegs, len, plinePoints, polar, polygonArea, sweep, wrapAngle } from '../geom';
import { dimText } from '../dim';
import { findDimStyle } from '../model';
import { fmt, fmtAngle } from '../commands';
import { PATTERNS, patternLines } from '../hatch';
import { MenuContent, MenuItem } from './chrome';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './contextMenu';
import { ColorMenu, LwSample, Swatch } from './ribbon';
import { FIELD, FOCUS, lwName } from './style';
import { cn } from '@/lib/utils';

// ---- Properties -------------------------------------------------------------------------

interface PropsPaletteProps {
  drawing: Drawing;
  selection: Entity[];
  /** Replace entities (same ids) in one undo step. */
  update: (label: string, list: Entity[]) => void;
  current: { color: number; linetype: string; lineweight: number };
  setCurrent: (patch: Partial<{ color: number; linetype: string; lineweight: number; layer: string }>) => void;
  onClose: () => void;
  metric: boolean;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className={cn('flex h-6 w-full items-center gap-1.5 bg-[#2a3039] px-2 text-[11.5px] font-semibold text-[#dfe4ec]', FOCUS)}>
        <span className={cn('inline-block transition-transform motion-reduce:transition-none', open ? 'rotate-90' : '')}>▸</span>
        {title}
      </button>
      {open && <div className="divide-y divide-[#2b313a]">{children}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-[24px] grid-cols-[46%_54%] items-center text-[11.5px]">
      <span className="truncate px-2 text-[#b8c0cb]">{label}</span>
      <span className="min-w-0 border-l border-[#2b313a] pr-1 pl-1">{children}</span>
    </div>
  );
}

/** A text field that commits on Enter or blur. */
function Edit({ value, onCommit, readOnly, multiline }: { value: string; onCommit?: (v: string) => void; readOnly?: boolean; multiline?: boolean }) {
  if (readOnly || !onCommit) return <span className="block truncate px-1 text-[#8e98a6]">{value}</span>;
  const common = {
    defaultValue: value,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
        e.preventDefault();
        onCommit((e.target as HTMLInputElement).value);
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Escape') {
        (e.target as HTMLInputElement).value = value;
        (e.target as HTMLElement).blur();
      }
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.target.value !== value && onCommit(e.target.value),
    className: 'h-[21px] w-full rounded-[1px] border border-transparent bg-transparent px-1 text-[11.5px] text-[#eef2f7] outline-none hover:border-[#4f5865] focus:border-[#3fa9f5] focus:bg-[#262c34]',
  };
  // Keyed by value so an outside change replaces what's shown.
  return multiline ? <textarea key={value} rows={2} {...common} className={cn(common.className, 'h-auto resize-none py-0.5')} /> : <input key={value} {...common} />;
}

function Pick({ value, options, onPick }: { value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onPick(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      className="h-[21px] w-full cursor-pointer rounded-[1px] border border-transparent bg-transparent px-0.5 text-[11.5px] text-[#eef2f7] outline-none hover:border-[#4f5865] focus:border-[#3fa9f5] [&>option]:bg-[#2f3640]"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

const num = (s: string) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};
const deg = (rad: number) => fmtAngle(rad);
const rad = (s: string) => {
  const v = num(s);
  return v === null ? null : (v * Math.PI) / 180;
};

function common<T>(list: Entity[], get: (e: Entity) => T): T | undefined {
  if (!list.length) return undefined;
  const v = get(list[0]);
  return list.every((e) => get(e) === v) ? v : undefined;
}

export function PropertiesPalette({ drawing: d, selection, update, current, setCurrent, onClose, metric }: PropsPaletteProps) {
  const [filter, setFilter] = useState<EntityType | 'all'>('all');
  const types = [...new Set(selection.map((e) => e.type))];
  const list = filter === 'all' || !types.includes(filter) ? selection : selection.filter((e) => e.type === filter);
  const one = list.length === 1 ? list[0] : null;
  // Edits apply to every selected object of the kind shown, so their shapes are checked by the caller.
  const set = (label: string, fn: (e: Entity) => object) => update(label, list.map((e) => fn(e) as Entity));
  const layerColor = findLayer(d, common(list, (e) => e.layer) ?? d.header.clayer)?.color;

  const general = list.length ? (
    <Section title="General">
      <Row label="Color">
        <ColorPick value={common(list, (e) => e.color)} layerColor={layerColor} onPick={(c) => set('Color', (e) => ({ ...e, color: c }))} />
      </Row>
      <Row label="Layer">
        <Pick value={common(list, (e) => e.layer) ?? ''} options={[...(common(list, (e) => e.layer) === undefined ? [['', '*VARIES*'] as [string, string]] : []), ...d.layers.map((l) => [l.name, l.name] as [string, string])]} onPick={(v) => v && set('Layer', (e) => ({ ...e, layer: v }))} />
      </Row>
      <Row label="Linetype">
        <Pick value={common(list, (e) => e.linetype) ?? ''} options={[...(common(list, (e) => e.linetype) === undefined ? [['', '*VARIES*'] as [string, string]] : []), ...d.linetypes.map((l) => [l.name, l.name] as [string, string])]} onPick={(v) => v && set('Linetype', (e) => ({ ...e, linetype: v }))} />
      </Row>
      <Row label="Linetype scale">
        <Edit value={common(list, (e) => e.ltscale)?.toString() ?? '*VARIES*'} onCommit={(s) => num(s) && set('Linetype Scale', (e) => ({ ...e, ltscale: num(s)! }))} />
      </Row>
      <Row label="Lineweight">
        <Pick value={String(common(list, (e) => e.lineweight) ?? '')} options={[...(common(list, (e) => e.lineweight) === undefined ? [['', '*VARIES*'] as [string, string]] : []), ...[LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT, ...LINEWEIGHTS].map((w) => [String(w), lwName(w)] as [string, string])]} onPick={(v) => v && set('Lineweight', (e) => ({ ...e, lineweight: parseInt(v, 10) }))} />
      </Row>
    </Section>
  ) : (
    <Section title="General">
      <Row label="Color">
        <ColorPick value={current.color} layerColor={findLayer(d, d.header.clayer)?.color} onPick={(c) => setCurrent({ color: c })} />
      </Row>
      <Row label="Layer">
        <Pick value={d.header.clayer} options={d.layers.map((l) => [l.name, l.name])} onPick={(v) => setCurrent({ layer: v })} />
      </Row>
      <Row label="Linetype">
        <Pick value={current.linetype} options={d.linetypes.map((l) => [l.name, l.name])} onPick={(v) => setCurrent({ linetype: v })} />
      </Row>
      <Row label="Lineweight">
        <Pick value={String(current.lineweight)} options={[LW_BYLAYER, LW_BYBLOCK, LW_DEFAULT, ...LINEWEIGHTS].map((w) => [String(w), lwName(w)])} onPick={(v) => setCurrent({ lineweight: parseInt(v, 10) })} />
      </Row>
    </Section>
  );

  const P = (label: string, value: number, apply?: (v: number) => (e: Entity) => object, angle = false) => (
    <Row label={label}>
      <Edit value={angle ? deg(value) : fmt(value)} readOnly={!apply} onCommit={apply ? (s) => {
        const v = angle ? rad(s) : num(s);
        if (v !== null) set(label, apply(v));
      } : undefined} />
    </Row>
  );

  let geometry: React.ReactNode = null;
  if (one) {
    const e = one;
    switch (e.type) {
      case 'line': {
        const L = dist(e.a, e.b);
        geometry = (
          <Section title="Geometry">
            {P('Start X', e.a.x, (v) => (x) => ({ ...x, a: { ...e.a, x: v } }))}
            {P('Start Y', e.a.y, (v) => (x) => ({ ...x, a: { ...e.a, y: v } }))}
            {P('End X', e.b.x, (v) => (x) => ({ ...x, b: { ...e.b, x: v } }))}
            {P('End Y', e.b.y, (v) => (x) => ({ ...x, b: { ...e.b, y: v } }))}
            {P('Delta X', e.b.x - e.a.x)}
            {P('Delta Y', e.b.y - e.a.y)}
            {P('Length', L, (v) => (x) => (L > 0 ? { ...x, b: { x: e.a.x + ((e.b.x - e.a.x) * v) / L, y: e.a.y + ((e.b.y - e.a.y) * v) / L } } : x))}
            {P('Angle', Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x), (v) => (x) => ({ ...x, b: polar(e.a, L, v) }), true)}
          </Section>
        );
        break;
      }
      case 'circle':
        geometry = (
          <Section title="Geometry">
            {P('Center X', e.c.x, (v) => (x) => ({ ...x, c: { ...e.c, x: v } }))}
            {P('Center Y', e.c.y, (v) => (x) => ({ ...x, c: { ...e.c, y: v } }))}
            {P('Radius', e.r, (v) => (x) => (v > 0 ? { ...x, r: v } : x))}
            {P('Diameter', e.r * 2, (v) => (x) => (v > 0 ? { ...x, r: v / 2 } : x))}
            {P('Circumference', TAU * e.r, (v) => (x) => (v > 0 ? { ...x, r: v / TAU } : x))}
            {P('Area', Math.PI * e.r * e.r, (v) => (x) => (v > 0 ? { ...x, r: Math.sqrt(v / Math.PI) } : x))}
          </Section>
        );
        break;
      case 'arc':
        geometry = (
          <Section title="Geometry">
            {P('Center X', e.c.x, (v) => (x) => ({ ...x, c: { ...e.c, x: v } }))}
            {P('Center Y', e.c.y, (v) => (x) => ({ ...x, c: { ...e.c, y: v } }))}
            {P('Radius', e.r, (v) => (x) => (v > 0 ? { ...x, r: v } : x))}
            {P('Start angle', e.start, (v) => (x) => ({ ...x, start: wrapAngle(v) }), true)}
            {P('End angle', e.end, (v) => (x) => ({ ...x, end: wrapAngle(v) }), true)}
            {P('Total angle', sweep(e.start, e.end), undefined, true)}
            {P('Arc length', e.r * sweep(e.start, e.end))}
          </Section>
        );
        break;
      case 'ellipse':
        geometry = (
          <Section title="Geometry">
            {P('Center X', e.c.x, (v) => (x) => ({ ...x, c: { ...e.c, x: v } }))}
            {P('Center Y', e.c.y, (v) => (x) => ({ ...x, c: { ...e.c, y: v } }))}
            {P('Major radius', len(e.major))}
            {P('Minor radius', len(e.major) * e.ratio)}
            {P('Radius ratio', e.ratio, (v) => (x) => (v > 0 && v <= 1 ? { ...x, ratio: v } : x))}
          </Section>
        );
        break;
      case 'pline':
        geometry = <PlineGeometry e={e} set={set} />;
        break;
      case 'point':
        geometry = (
          <Section title="Geometry">
            {P('Position X', e.p.x, (v) => (x) => ({ ...x, p: { ...e.p, x: v } }))}
            {P('Position Y', e.p.y, (v) => (x) => ({ ...x, p: { ...e.p, y: v } }))}
          </Section>
        );
        break;
      case 'text':
      case 'attdef':
        geometry = (
          <Section title="Text">
            {e.type === 'attdef' && (
              <>
                <Row label="Tag">
                  <Edit value={e.tag} onCommit={(s) => s && set('Tag', (x) => ({ ...x, tag: s.toUpperCase() }))} />
                </Row>
                <Row label="Prompt">
                  <Edit value={e.prompt} onCommit={(s) => set('Prompt', (x) => ({ ...x, prompt: s }))} />
                </Row>
              </>
            )}
            <Row label={e.type === 'attdef' ? 'Value' : 'Contents'}>
              <Edit value={e.text} onCommit={(s) => set('Contents', (x) => ({ ...x, text: s }))} />
            </Row>
            <Row label="Style">
              <Pick value={e.style} options={d.textStyles.map((s) => [s.name, s.name])} onPick={(v) => set('Style', (x) => ({ ...x, style: v }))} />
            </Row>
            <Row label="Justify">
              <Pick
                value={`${e.halign},${e.valign}`}
                options={[
                  ['0,0', 'Left'],
                  ['1,0', 'Center'],
                  ['2,0', 'Right'],
                  ['4,0', 'Middle'],
                  ['0,3', 'Top left'],
                  ['1,3', 'Top center'],
                  ['2,3', 'Top right'],
                  ['0,2', 'Middle left'],
                  ['1,2', 'Middle center'],
                  ['2,2', 'Middle right'],
                  ['0,1', 'Bottom left'],
                  ['1,1', 'Bottom center'],
                  ['2,1', 'Bottom right'],
                ]}
                onPick={(v) => {
                  const [hA, vA] = v.split(',').map(Number);
                  set('Justify', (x) => ({ ...x, halign: hA, valign: vA, a: hA === 0 && vA === 0 ? (x as typeof e).p : (x as typeof e).a.x === 0 && (x as typeof e).a.y === 0 ? (x as typeof e).p : (x as typeof e).a }) as Entity);
                }}
              />
            </Row>
            {P('Height', e.h, (v) => (x) => (v > 0 ? { ...x, h: v } : x))}
            {P('Rotation', e.rot, (v) => (x) => ({ ...x, rot: v }), true)}
            {P('Width factor', e.wf, (v) => (x) => (v > 0 ? { ...x, wf: v } : x))}
            {P('Position X', e.halign || e.valign ? e.a.x : e.p.x, (v) => (x) => (e.halign || e.valign ? { ...x, a: { ...e.a, x: v } } : { ...x, p: { ...e.p, x: v }, a: { ...e.a, x: v } }))}
            {P('Position Y', e.halign || e.valign ? e.a.y : e.p.y, (v) => (x) => (e.halign || e.valign ? { ...x, a: { ...e.a, y: v } } : { ...x, p: { ...e.p, y: v }, a: { ...e.a, y: v } }))}
          </Section>
        );
        break;
      case 'mtext':
        geometry = (
          <Section title="Text">
            <Row label="Contents">
              <Edit multiline value={e.text.replace(/\\P/g, '\n')} onCommit={(s) => set('Contents', (x) => ({ ...x, text: s.replace(/\r?\n/g, '\\P') }))} />
            </Row>
            <Row label="Style">
              <Pick value={e.style} options={d.textStyles.map((s) => [s.name, s.name])} onPick={(v) => set('Style', (x) => ({ ...x, style: v }))} />
            </Row>
            <Row label="Justify">
              <Pick value={String(e.attach)} options={['Top left', 'Top center', 'Top right', 'Middle left', 'Middle center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'].map((l, i) => [String(i + 1), l])} onPick={(v) => set('Justify', (x) => ({ ...x, attach: parseInt(v, 10) }))} />
            </Row>
            {P('Text height', e.h, (v) => (x) => (v > 0 ? { ...x, h: v } : x))}
            {P('Rotation', e.rot, (v) => (x) => ({ ...x, rot: v }), true)}
            {P('Defined width', e.width, (v) => (x) => (v >= 0 ? { ...x, width: v } : x))}
            {P('Line space factor', e.spacing, (v) => (x) => (v > 0 ? { ...x, spacing: v } : x))}
            {P('Position X', e.p.x, (v) => (x) => ({ ...x, p: { ...e.p, x: v } }))}
            {P('Position Y', e.p.y, (v) => (x) => ({ ...x, p: { ...e.p, y: v } }))}
          </Section>
        );
        break;
      case 'insert':
        geometry = (
          <>
            <Section title="Geometry">
              <Row label="Name">
                <Edit value={e.block} readOnly />
              </Row>
              {P('Position X', e.p.x, (v) => (x) => ({ ...x, p: { ...e.p, x: v } }))}
              {P('Position Y', e.p.y, (v) => (x) => ({ ...x, p: { ...e.p, y: v } }))}
              {P('Scale X', e.sx, (v) => (x) => (v !== 0 ? { ...x, sx: v } : x))}
              {P('Scale Y', e.sy, (v) => (x) => (v !== 0 ? { ...x, sy: v } : x))}
              {P('Rotation', e.rot, (v) => (x) => ({ ...x, rot: v }), true)}
            </Section>
            {e.attribs.length > 0 && (
              <Section title="Attributes">
                {e.attribs.map((a, i) => (
                  <Row key={i} label={a.tag}>
                    <Edit value={a.text} onCommit={(s) => set('Attribute', (x) => (x.type === 'insert' ? { ...x, attribs: x.attribs.map((y, j) => (j === i ? { ...y, text: s } : y)) } : x))} />
                  </Row>
                ))}
              </Section>
            )}
          </>
        );
        break;
      case 'dim':
        geometry = (
          <Section title="Dimension">
            <Row label="Dim style">
              <Pick value={e.style} options={d.dimStyles.map((s) => [s.name, s.name])} onPick={(v) => set('Dim Style', (x) => ({ ...x, style: v, block: undefined }))} />
            </Row>
            <Row label="Measurement">
              <Edit value={dimText({ ...e, override: '' }, findDimStyle(d, e.style)).replace(/%%[dD]/g, '°').replace(/%%[cC]/g, 'Ø')} readOnly />
            </Row>
            <Row label="Text override">
              <Edit value={e.override} onCommit={(s) => set('Text Override', (x) => ({ ...x, override: s, block: undefined }))} />
            </Row>
          </Section>
        );
        break;
      case 'hatch':
        geometry = (
          <Section title="Pattern">
            <Row label="Pattern name">
              <Pick
                value={e.solid ? 'SOLID' : e.pattern}
                options={[['SOLID', 'SOLID'], ...(!PATTERNS[e.pattern] && !e.solid ? [[e.pattern, e.pattern] as [string, string]] : []), ...Object.keys(PATTERNS).map((k) => [k, k] as [string, string])]}
                onPick={(v) => set('Hatch Pattern', (x) => (x.type === 'hatch' ? { ...x, pattern: v, solid: v === 'SOLID', lines: v === 'SOLID' ? [] : patternLines(v, x.angle, x.scale, metric) } : x))}
              />
            </Row>
            {P('Angle', e.angle, (v) => (x) => (x.type === 'hatch' && PATTERNS[x.pattern] ? { ...x, angle: v, lines: patternLines(x.pattern, v, x.scale, metric) } : x), true)}
            {P('Scale', e.scale, (v) => (x) => (x.type === 'hatch' && v > 0 && PATTERNS[x.pattern] ? { ...x, scale: v, lines: patternLines(x.pattern, x.angle, v, metric) } : x))}
            {P('Area', hatchArea(e))}
          </Section>
        );
        break;
      case 'leader':
        geometry = (
          <Section title="Misc">
            <Row label="Arrowhead">
              <Pick value={e.arrow ? '1' : '0'} options={[['1', 'Yes'], ['0', 'No']]} onPick={(v) => set('Arrowhead', (x) => ({ ...x, arrow: v === '1' }))} />
            </Row>
            <Row label="Dim style">
              <Pick value={e.style} options={d.dimStyles.map((s) => [s.name, s.name])} onPick={(v) => set('Dim Style', (x) => ({ ...x, style: v }))} />
            </Row>
          </Section>
        );
        break;
      default:
        break;
    }
  }

  return (
    <aside aria-label="Properties" className="flex w-[260px] shrink-0 flex-col border-l border-[#15191e] bg-[#333a45] text-[#e3e8ef]">
      <div className="flex h-7 shrink-0 items-center justify-between bg-[#272d36] pr-1 pl-2.5 text-[12px] font-semibold tracking-wide uppercase">
        Properties
        <button type="button" aria-label="Close Properties" onClick={onClose} className={cn('grid size-5 place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-white/10', FOCUS)}>
          <X className="size-3.5" />
        </button>
      </div>
      <div className="shrink-0 p-1.5">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as EntityType | 'all')}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Selection"
          className={cn(FIELD, 'w-full cursor-pointer [&>option]:bg-[#2f3640]')}
        >
          {selection.length === 0 && <option value="all">No selection</option>}
          {selection.length > 0 && <option value="all">{types.length === 1 ? `${ENTITY_NAMES[types[0]]} (${selection.length})` : `All (${selection.length})`}</option>}
          {types.length > 1 &&
            types.map((t) => (
              <option key={t} value={t}>
                {ENTITY_NAMES[t]} ({selection.filter((e) => e.type === t).length})
              </option>
            ))}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {general}
        {geometry}
        {!list.length && (
          <Section title="Drawing">
            <Row label="Units">
              <Edit value={['Unitless', 'Inches', 'Feet', 'Miles', 'Millimeters', 'Centimeters', 'Meters', 'Kilometers'][d.header.insunits] ?? String(d.header.insunits)} readOnly />
            </Row>
            <Row label="Objects">
              <Edit value={String(d.entities.length)} readOnly />
            </Row>
            <Row label="Layers">
              <Edit value={String(d.layers.length)} readOnly />
            </Row>
            <Row label="Blocks">
              <Edit value={String(Object.keys(d.blocks).filter((k) => !k.startsWith('*')).length)} readOnly />
            </Row>
          </Section>
        )}
      </div>
    </aside>
  );
}

function hatchArea(e: Extract<Entity, { type: 'hatch' }>): number {
  let a = 0;
  for (const l of e.loops) {
    const pts: Vec[] = l.kind === 'poly' ? plinePoints(l.pts, true, 64) : l.edges.flatMap((ed) => (ed.t === 'line' ? [ed.a] : ed.t === 'arc' ? Array.from({ length: 33 }, (_, i) => polar(ed.c, ed.r, ed.start + (sweep(ed.start, ed.end) * i) / 32)) : ed.t === 'ellipse' ? ellipsePoints(ed.c, ed.major, ed.ratio, ed.start, ed.end, 48) : ed.ctrl));
    a += polygonArea(pts) * (l.flags & 16 || a === 0 ? 1 : -1);
  }
  return Math.abs(a);
}

function PlineGeometry({ e, set }: { e: Extract<Entity, { type: 'pline' }>; set: (label: string, fn: (e: Entity) => object) => void }) {
  const [i, setI] = useState(0);
  const vi = Math.min(i, e.pts.length - 1);
  const v = e.pts[vi];
  const length = entitySegs(e).reduce((s, x) => s + (x.k === 'line' ? dist(x.a, x.b) : x.r * sweep(x.a0, x.a1)), 0);
  const upd = (patch: Partial<typeof v>) => (x: Entity) => (x.type === 'pline' ? { ...x, pts: x.pts.map((p, j) => (j === vi ? { ...p, ...patch } : p)) } : x);
  return (
    <Section title="Geometry">
      <Row label="Current vertex">
        <span className="flex items-center gap-1">
          <button type="button" aria-label="Previous vertex" onClick={() => setI(Math.max(0, vi - 1))} className="grid size-5 place-items-center rounded-[2px] hover:bg-white/10">‹</button>
          <span className="tabular-nums">{vi + 1}</span>
          <button type="button" aria-label="Next vertex" onClick={() => setI(Math.min(e.pts.length - 1, vi + 1))} className="grid size-5 place-items-center rounded-[2px] hover:bg-white/10">›</button>
        </span>
      </Row>
      <Row label="Vertex X">
        <Edit value={fmt(v.x)} onCommit={(s) => num(s) !== null && set('Vertex', upd({ x: num(s)! }))} />
      </Row>
      <Row label="Vertex Y">
        <Edit value={fmt(v.y)} onCommit={(s) => num(s) !== null && set('Vertex', upd({ y: num(s)! }))} />
      </Row>
      <Row label="Global width">
        <Edit value={fmt(e.width)} onCommit={(s) => num(s) !== null && num(s)! >= 0 && set('Width', (x) => ({ ...x, width: num(s)! }))} />
      </Row>
      <Row label="Closed">
        <Pick value={e.closed ? '1' : '0'} options={[['1', 'Yes'], ['0', 'No']]} onPick={(val) => set('Closed', (x) => ({ ...x, closed: val === '1' }))} />
      </Row>
      <Row label="Length">
        <Edit value={fmt(length)} readOnly />
      </Row>
      <Row label="Area">
        <Edit value={fmt(Math.abs(polygonArea(plinePoints(e.pts, true, 64))))} readOnly />
      </Row>
    </Section>
  );
}

function ColorPick({ value, layerColor, onPick }: { value: number | undefined; layerColor?: number; onPick: (c: number) => void }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" className="flex h-[21px] w-full items-center gap-1.5 rounded-[1px] border border-transparent px-1 text-left text-[11.5px] hover:border-[#4f5865]">
          {value === undefined ? (
            <span className="text-[#8e98a6]">*VARIES*</span>
          ) : (
            <>
              <Swatch color={value} layerColor={layerColor} />
              {colorName(value)}
            </>
          )}
        </button>
      </Menu.Trigger>
      <MenuContent>
        <ColorMenu onPick={onPick} layerColor={layerColor} />
      </MenuContent>
    </Menu.Root>
  );
}

// ---- Layer Properties Manager --------------------------------------------------------------

/** Which layers were on before the Layer Properties Manager isolated one, for Unisolate. */
export type LayerIsolation = { layer: string; on: Record<string, boolean> } | null;

interface LayerManagerProps {
  drawing: Drawing;
  commit: (label: string, d: Drawing) => void;
  onClose: () => void;
  inUse: (name: string) => boolean;
  /** Where the user dragged the panel to, relative to the drawing area; null for the default corner. */
  pos: Vec | null;
  onMove: (p: Vec) => void;
  isolation: LayerIsolation;
  setIsolation: (iso: LayerIsolation) => void;
}

export function LayerManager({ drawing: d, commit, onClose, inUse, pos, onMove, isolation, setIsolation }: LayerManagerProps) {
  const [sel, setSel] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Undo, or turning layers back on by hand, ends the isolation.
  const isolated = isolation && d.layers.some((l) => l.name === isolation.layer && l.on) && d.layers.every((l) => l.name === isolation.layer || !l.on) ? isolation : null;
  const isolate = (name: string) => {
    commit('Isolate Layer', {
      ...d,
      header: { ...d.header, clayer: name },
      layers: d.layers.map((l) => (l.name === name ? { ...l, on: true, frozen: false } : { ...l, on: false })),
    });
    // Isolating another layer while one is isolated keeps the original states to go back to.
    setIsolation({ layer: name, on: isolated?.on ?? Object.fromEntries(d.layers.map((l) => [l.name, l.on])) });
    setMsg(null);
  };
  const unisolate = () => {
    if (!isolated) return;
    commit('Unisolate Layer', { ...d, layers: d.layers.map((l) => ({ ...l, on: isolated.on[l.name] ?? true })) });
    setIsolation(null);
  };
  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const panel = e.currentTarget.parentElement!;
    const area = panel.offsetParent as HTMLElement | null;
    if (!area) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const x0 = e.clientX - panel.offsetLeft;
    const y0 = e.clientY - panel.offsetTop;
    const move = (ev: PointerEvent) => {
      // Keep the title bar inside the drawing area so the panel can always be dragged back.
      const x = Math.min(Math.max(ev.clientX - x0, 0), Math.max(0, area.clientWidth - panel.offsetWidth));
      const y = Math.min(Math.max(ev.clientY - y0, 0), Math.max(0, area.clientHeight - handle.offsetHeight));
      onMove({ x, y });
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const setLayer = (name: string, patch: Partial<Layer>, label = 'Layer Properties') => {
    let header = d.header;
    if (patch.name && d.header.clayer === name) header = { ...header, clayer: patch.name };
    const rename = (l: string) => (patch.name && l === name ? patch.name : l);
    if (patch.name && isolated) setIsolation({ layer: rename(isolated.layer), on: Object.fromEntries(Object.entries(isolated.on).map(([k, v]) => [rename(k), v])) });
    commit(label, {
      ...d,
      header,
      layers: d.layers.map((l) => (l.name === name ? { ...l, ...patch } : l)),
      ...(patch.name ? { entities: d.entities.map((e) => (e.layer === name ? { ...e, layer: rename(e.layer) } : e)) } : {}),
    });
  };
  const create = () => {
    let n = 1;
    while (findLayer(d, `Layer${n}`)) n++;
    const name = `Layer${n}`;
    commit('New Layer', { ...d, layers: [...d.layers, defaultLayer(name)] });
    setSel(name);
    setRenaming(name);
  };
  const remove = () => {
    if (!sel) return;
    if (sel === '0' || sel.toUpperCase() === 'DEFPOINTS') return setMsg('Layer 0 and Defpoints can’t be deleted.');
    if (sel === d.header.clayer) return setMsg('The current layer can’t be deleted.');
    if (inUse(sel)) return setMsg(`“${sel}” has objects on it, so it can’t be deleted.`);
    commit('Delete Layer', { ...d, layers: d.layers.filter((l) => l.name !== sel) });
    setSel(null);
  };
  const current = () => {
    if (!sel) return;
    commit('Set Current Layer', { ...d, header: { ...d.header, clayer: sel } });
  };
  const loadLinetype = (name: string) => {
    if (d.linetypes.some((l) => l.name.toUpperCase() === name.toUpperCase())) return d;
    const lt = EXTRA_LINETYPES.find((l) => l.name === name);
    if (!lt) return d;
    const k = d.header.measurement ? 25.4 : 1;
    return { ...d, linetypes: [...d.linetypes, { ...lt, pattern: lt.pattern.map((x) => x * k) }] };
  };
  const ICON_BTN = cn('grid size-6 place-items-center rounded-[2px] hover:bg-white/10', FOCUS);
  return (
    <section
      aria-label="Layer Properties Manager"
      style={pos ? { left: pos.x, top: pos.y, maxHeight: `calc(100% - ${pos.y + 8}px)` } : undefined}
      className="absolute top-2 left-2 z-30 flex max-h-[calc(100%-16px)] w-[min(760px,calc(100%-16px))] flex-col overflow-hidden rounded-[4px] border border-[#15191e] bg-[#333a45] text-[#e3e8ef] shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      <div onPointerDown={startDrag} className="flex h-7 shrink-0 cursor-move items-center justify-between bg-[#272d36] pr-1 pl-2.5 text-[12px] font-semibold tracking-wide uppercase select-none">
        Layer Properties Manager
        <button type="button" aria-label="Close Layer Properties Manager" onClick={onClose} className={cn('grid size-5 place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-white/10', FOCUS)}>
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-[#262c34] px-2 py-1 text-[11.5px]">
        <button type="button" onClick={create} className={ICON_BTN} title="New Layer (Alt+N)" aria-label="New Layer">
          <Plus className="size-4 text-[#6fdc8c]" />
        </button>
        <button type="button" onClick={remove} className={ICON_BTN} title="Delete Layer" aria-label="Delete Layer" disabled={!sel}>
          <Trash2 className="size-4 text-[#ff6b6b]" />
        </button>
        <button type="button" onClick={current} className={ICON_BTN} title="Set Current" aria-label="Set Current" disabled={!sel}>
          <Check className="size-4 text-[#6fdc8c]" />
        </button>
        <button
          type="button"
          onClick={() => (isolated ? unisolate() : sel && isolate(sel))}
          disabled={!isolated && !sel}
          className={cn('flex h-6 items-center gap-1.5 rounded-[2px] px-1.5 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-transparent', FOCUS)}
          title={isolated ? `Unisolate “${isolated.layer}”: turn the other layers back on` : 'Isolate: show only the selected layer'}
        >
          <Focus className={cn('size-4', isolated ? 'text-[#f5c542]' : 'text-[#7cc4ff]')} />
          {isolated ? 'Unisolate' : 'Isolate'}
        </button>
        <span className="ml-3 text-[#a9b2bf]">Current layer: {d.header.clayer}</span>
        {msg && <span role="status" className="ml-auto text-[#ffb4a6]">{msg}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 bg-[#2a3039] text-left text-[#b8c0cb]">
            <tr>
              {['S…', 'Name', 'Isolate', 'On', 'Freeze', 'Lock', 'Plot', 'Color', 'Linetype', 'Lineweight', 'Description'].map((h) => (
                <th key={h} className="h-6 border-r border-[#20252c] px-2 font-normal whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.layers.map((l) => {
              const isSel = sel === l.name;
              const cell = 'h-[25px] border-r border-[#2b313a] px-2';
              const tog = (v: boolean, a: React.ReactNode, b: React.ReactNode, label: string, fn: () => void) => (
                <button
                  type="button"
                  aria-label={label}
                  title={label}
                  onClick={(e) => {
                    e.stopPropagation();
                    fn();
                  }}
                  className={cn('grid size-5 place-items-center rounded-[2px] hover:bg-white/10', FOCUS)}
                >
                  {v ? a : b}
                </button>
              );
              const toggleIsolate = () => (isolated?.layer === l.name ? unisolate() : isolate(l.name));
              const toggleOn = () => setLayer(l.name, { on: !l.on });
              const toggleFrozen = () => (l.name === d.header.clayer ? setMsg('The current layer can’t be frozen.') : setLayer(l.name, { frozen: !l.frozen }));
              const toggleLocked = () => setLayer(l.name, { locked: !l.locked });
              const togglePlot = () => setLayer(l.name, { plot: !l.plot });
              return (
                <ContextMenu key={l.name}>
                  <ContextMenuTrigger asChild disabled={renaming === l.name}>
                    <tr onClick={() => setSel(l.name)} onContextMenu={() => renaming !== l.name && setSel(l.name)} onDoubleClick={() => commit('Set Current Layer', { ...d, header: { ...d.header, clayer: l.name } })} className={cn('cursor-default', isSel ? 'bg-[#0b6aa8]/60' : 'odd:bg-[#353c48] hover:bg-[#3d4552]')}>
                      <td className={cell}>{l.name === d.header.clayer && <Check className="size-3.5 text-[#6fdc8c]" />}</td>
                      <td className={cn(cell, 'min-w-32')}>
                        {renaming === l.name ? (
                          <input
                            autoFocus
                            defaultValue={l.name}
                            aria-label="Layer name"
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                              if (e.key === 'Escape') setRenaming(null);
                            }}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              setRenaming(null);
                              if (!v || v === l.name) return;
                              if (l.name === '0') return setMsg('Layer 0 can’t be renamed.');
                              if (/[<>/\\":;?*|,=`]/.test(v)) return setMsg('That name has characters layers can’t use.');
                              if (findLayer(d, v)) return setMsg(`There’s already a layer called “${v}”.`);
                              setLayer(l.name, { name: v }, 'Rename Layer');
                              setSel(v);
                            }}
                            className={cn(FIELD, 'h-5 w-full')}
                          />
                        ) : (
                          <span onDoubleClick={(e) => (e.stopPropagation(), setRenaming(l.name))}>{l.name}</span>
                        )}
                      </td>
                      <td className={cell}>{tog(isolated?.layer !== l.name, <Focus className="size-3.5 text-[#6c7480]" />, <Focus className="size-3.5 text-[#f5c542]" />, isolated?.layer === l.name ? 'Unisolate' : `Isolate ${l.name}`, toggleIsolate)}</td>
                      <td className={cell}>{tog(l.on, <Lightbulb className="size-3.5 text-[#f5c542]" />, <LightbulbOff className="size-3.5 text-[#6c7480]" />, l.on ? 'Turn off' : 'Turn on', toggleOn)}</td>
                      <td className={cell}>{tog(!l.frozen, <Sun className="size-3.5 text-[#f5c542]" />, <Snowflake className="size-3.5 text-[#7cc4ff]" />, l.frozen ? 'Thaw' : 'Freeze', toggleFrozen)}</td>
                      <td className={cell}>{tog(!l.locked, <LockOpen className="size-3.5" />, <Lock className="size-3.5 text-[#f5c542]" />, l.locked ? 'Unlock' : 'Lock', toggleLocked)}</td>
                      <td className={cell}>{tog(l.plot, <Printer className="size-3.5" />, <Printer className="size-3.5 text-[#ff6b6b] opacity-60" />, l.plot ? 'Don’t plot' : 'Plot', togglePlot)}</td>
                      <td className={cell}>
                        <Menu.Root modal={false}>
                          <Menu.Trigger asChild>
                            <button type="button" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 rounded-[2px] px-1 hover:bg-white/10">
                              <Swatch color={l.color} />
                              {colorName(l.color === BYLAYER ? 7 : l.color)}
                            </button>
                          </Menu.Trigger>
                          <MenuContent>
                            <ColorMenu onPick={(c) => setLayer(l.name, { color: c === BYLAYER || c === 0 ? 7 : c })} />
                          </MenuContent>
                        </Menu.Root>
                      </td>
                      <td className={cell}>
                        <Menu.Root modal={false}>
                          <Menu.Trigger asChild>
                            <button type="button" onClick={(e) => e.stopPropagation()} className="rounded-[2px] px-1 hover:bg-white/10">
                              {l.linetype}
                            </button>
                          </Menu.Trigger>
                          <MenuContent>
                            {d.linetypes
                              .filter((t) => !/^by(layer|block)$/i.test(t.name))
                              .map((t) => (
                                <MenuItem key={t.name} onSelect={() => setLayer(l.name, { linetype: t.name })} checked={t.name === l.linetype}>
                                  {t.name}
                                </MenuItem>
                              ))}
                            {EXTRA_LINETYPES.filter((t) => !d.linetypes.some((x) => x.name.toUpperCase() === t.name.toUpperCase())).map((t) => (
                              <MenuItem
                                key={t.name}
                                onSelect={() => {
                                  const dd = loadLinetype(t.name);
                                  commit('Load Linetype', { ...dd, layers: dd.layers.map((x) => (x.name === l.name ? { ...x, linetype: t.name } : x)) });
                                }}
                              >
                                {t.name} <span className="text-[#8e98a6]">(load)</span>
                              </MenuItem>
                            ))}
                          </MenuContent>
                        </Menu.Root>
                      </td>
                      <td className={cell}>
                        <Menu.Root modal={false}>
                          <Menu.Trigger asChild>
                            <button type="button" onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 rounded-[2px] px-1 hover:bg-white/10">
                              <LwSample lw={l.lineweight} />
                              {lwName(l.lineweight)}
                            </button>
                          </Menu.Trigger>
                          <MenuContent>
                            {[LW_DEFAULT, ...LINEWEIGHTS].map((w) => (
                              <MenuItem key={w} onSelect={() => setLayer(l.name, { lineweight: w })} checked={w === l.lineweight}>
                                <span className="inline-flex items-center gap-3">
                                  <LwSample lw={w} />
                                  {lwName(w)}
                                </span>
                              </MenuItem>
                            ))}
                          </MenuContent>
                        </Menu.Root>
                      </td>
                      <td className={cn(cell, 'min-w-24 text-[#a9b2bf]')}>{l.description ?? ''}</td>
                    </tr>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem icon={<Check className="text-[#6fdc8c]" />} disabled={l.name === d.header.clayer} onSelect={current}>
                      Set Current
                    </ContextMenuItem>
                    <ContextMenuItem icon={<Plus className="text-[#6fdc8c]" />} onSelect={create}>
                      New Layer
                    </ContextMenuItem>
                    <ContextMenuItem disabled={l.name === '0'} onSelect={() => setRenaming(l.name)}>
                      Rename Layer
                    </ContextMenuItem>
                    <ContextMenuItem icon={<Trash2 />} destructive onSelect={remove}>
                      Delete Layer
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem icon={<Focus className={isolated?.layer === l.name ? 'text-[#f5c542]' : 'text-[#7cc4ff]'} />} onSelect={toggleIsolate}>
                      {isolated?.layer === l.name ? 'Unisolate' : 'Isolate'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem icon={l.on ? <LightbulbOff /> : <Lightbulb />} onSelect={toggleOn}>
                      {l.on ? 'Turn Off' : 'Turn On'}
                    </ContextMenuItem>
                    <ContextMenuItem icon={l.frozen ? <Sun /> : <Snowflake />} onSelect={toggleFrozen}>
                      {l.frozen ? 'Thaw' : 'Freeze'}
                    </ContextMenuItem>
                    <ContextMenuItem icon={l.locked ? <LockOpen /> : <Lock />} onSelect={toggleLocked}>
                      {l.locked ? 'Unlock' : 'Lock'}
                    </ContextMenuItem>
                    <ContextMenuItem icon={<Printer />} onSelect={togglePlot}>
                      {l.plot ? 'Don’t Plot' : 'Plot'}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-[#262c34] px-2 py-1 text-[11px] text-[#a9b2bf]">
        All: {d.layers.length} layers displayed of {d.layers.length} total layers · Double-click a layer to make it current, its name to rename it. Drag the title bar to move this panel.
      </div>
    </section>
  );
}

