import { memo, useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, FilePlus, FileImage, Link2Off, Lock, LockOpen, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton, Select, SliderRow } from '../photo/chrome';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuTrigger } from '../photo/contextMenu';
import { FOCUS, INPUT } from '../photo/styles';
import { cmykToRgb, css, hex, rgbToCmyk, swatchLabel, type Swatch, type Swatches } from './colors';
import type { ObjectInfo, TypeInfo } from './control';
import { ComboField, LengthField, NumField } from './fields';
import type { LayerInfo, Page, Spread } from './model';
import type { StyleInfo } from './styles';
import { Chip } from './swatch';
import type { Attrs } from './text';
import type { Unit } from './units';

/**
 * The panels docked on the right, as InDesign has them: Pages (masters and
 * spreads), Layers, Links, Stroke, Swatches, Color, Character, Paragraph,
 * Paragraph and Character Styles, Text Wrap.
 */

const ROW = 'flex h-7 items-center gap-1.5 px-2 text-[11px] text-[#e0e0e0]';
const EMPTY = 'p-3 text-[11px] text-[#9a9a9a]';

// ---- Pages -------------------------------------------------------------------------------

const NONE = new Set<string>();

export type ThumbDraw = (spread: Spread, canvas: HTMLCanvasElement, w: number, h: number) => void;

const SpreadThumb = memo(function SpreadThumb({ spread, draw, version, selected, current, onPage, onGo, prefixes, order, onPageMenu, menu }: {
  spread: Spread;
  prefixes: Map<string, string>;
  /** Position in the panel: thumbnails are drawn one after another, not all at once. */
  order: number;
  draw: ThumbDraw;
  version: unknown;
  selected: Set<string>;
  current: string | null;
  onPage: (p: Page, e: React.MouseEvent) => void;
  onGo: (p: Page) => void;
  onPageMenu?: (p: Page) => void;
  /** A page's right-click menu items. */
  menu: (p: Page) => React.ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const H = 64;
  const b = spread.bounds;
  const k = Math.min(H / (b.h || 1), 150 / (b.w || 1));
  const W = Math.max(12, b.w * k);
  const h = Math.max(12, b.h * k);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Thumbnails wait for a quiet moment.
    const id = setTimeout(() => draw(spread, el, W, h), 150 + order * 30);
    return () => clearTimeout(id);
  }, [spread, draw, version, W, h, order]);
  return (
    <div className="flex flex-col items-center gap-0.5 py-1">
      <div className="relative" style={{ width: W, height: h }}>
        <canvas ref={ref} className="absolute inset-0 size-full" aria-hidden />
        {spread.pages.map((p) => {
          const x = (p.bounds.x - b.x) * k;
          const w = p.bounds.w * k;
          const sel = selected.has(p.self);
          return (
            <ContextMenu key={p.self}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  title={spread.isMaster ? `${spread.prefix}-${spread.name}` : `Page ${p.name}`}
                  aria-label={spread.isMaster ? `${spread.prefix}-${spread.name}` : `Page ${p.name}`}
                  aria-current={current === p.self ? 'page' : undefined}
                  onClick={(e) => onPage(p, e)}
                  onDoubleClick={() => onGo(p)}
                  onContextMenu={() => onPageMenu?.(p)}
                  className={cn('absolute top-0 h-full border', sel ? 'border-[#2d8ceb] bg-[#2d8ceb]/20' : 'border-[#1a1a1a]', FOCUS)}
                  style={{ left: x, width: w }}
                >
                  {!spread.isMaster && p.master && <span className="absolute top-0.5 left-1 text-[9px] font-semibold text-[#555]">{prefixes.get(p.master) ?? ''}</span>}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>{menu(p)}</ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
      <span className="text-[10px] text-[#cfcfcf] tabular-nums">{spread.isMaster ? `${spread.prefix}-${spread.name}` : spread.pages.map((p) => p.name).join('–')}</span>
    </div>
  );
});

export function PagesPanel({
  masters,
  spreads,
  pageCount,
  current,
  selected,
  onSelect,
  onGo,
  onGoMaster,
  onInsert,
  onDelete,
  onApplyMaster,
  draw,
  version,
}: {
  masters: Spread[];
  spreads: Spread[];
  pageCount: number;
  current: string | null;
  selected: Set<string>;
  onSelect: (pages: Set<string>) => void;
  onGo: (p: Page) => void;
  onGoMaster: (s: Spread) => void;
  onInsert: () => void;
  onDelete: () => void;
  onApplyMaster: (master: string | null) => void;
  draw: ThumbDraw;
  version: unknown;
}) {
  const prefixes = new Map(masters.map((m) => [m.self, m.prefix]));
  const pages = spreads.flatMap((s) => s.pages);
  const click = (p: Page, e: React.MouseEvent) => {
    if (e.shiftKey && selected.size) {
      const last = pages.findIndex((q) => selected.has(q.self));
      const at = pages.findIndex((q) => q.self === p.self);
      onSelect(new Set(pages.slice(Math.min(last, at), Math.max(last, at) + 1).map((q) => q.self)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected);
      if (n.has(p.self)) n.delete(p.self);
      else n.add(p.self);
      onSelect(n);
    } else onSelect(new Set([p.self]));
  };
  const pageMenu = (p: Page) => (
    <>
      <ContextMenuItem onSelect={() => onGo(p)}>Go to Page</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem shortcut="Shift+Ctrl+P" onSelect={onInsert}>
        Add Page
      </ContextMenuItem>
      <ContextMenuSub label="Apply Master" disabled={!masters.length}>
        <ContextMenuItem onSelect={() => onApplyMaster(null)}>[None]</ContextMenuItem>
        {masters.map((m) => (
          <ContextMenuItem key={m.self} onSelect={() => onApplyMaster(m.self)}>
            {m.prefix}-{m.name}
          </ContextMenuItem>
        ))}
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem destructive disabled={pageCount < 2} onSelect={onDelete}>
        {selected.size > 1 ? 'Delete Pages' : 'Delete Page'}
      </ContextMenuItem>
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="max-h-[96px] shrink-0 overflow-y-auto border-b border-[#2a2a2a] bg-[#3f3f3f]">
        <div className="px-2 pt-1 text-[10px] text-[#a0a0a0]">[None]</div>
        <div className="flex flex-wrap justify-center gap-2 px-1">
          {masters.map((m, i) => (
            <SpreadThumb key={m.self} order={i} prefixes={prefixes} spread={m} draw={draw} version={version} selected={NONE} current={null} onPage={() => {}} onGo={() => onGoMaster(m)} menu={() => <ContextMenuItem onSelect={() => onGoMaster(m)}>Go to Master</ContextMenuItem>} />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[#383838]">
        <div className="flex flex-col items-center">
          {spreads.map((s, i) => (
            <SpreadThumb key={s.self} order={masters.length + i} prefixes={prefixes} spread={s} draw={draw} version={version} selected={selected} current={current} onPage={click} onGo={onGo} onPageMenu={(p) => !selected.has(p.self) && onSelect(new Set([p.self]))} menu={pageMenu} />
          ))}
        </div>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-[#2a2a2a] bg-[#323232] px-2">
        <span className="min-w-0 flex-1 truncate text-[10px] text-[#bdbdbd]">
          {pageCount} {pageCount === 1 ? 'Page' : 'Pages'} in {spreads.length} {spreads.length === 1 ? 'Spread' : 'Spreads'}
        </span>
        <Select<string>
          label="Apply master to selected pages"
          value=""
          onChange={(v) => onApplyMaster(v === 'none' ? null : v)}
          options={[['', 'Apply Master…'], ['none', '[None]'], ...masters.map((m) => [m.self, `${m.prefix}-${m.name}`] as const)]}
          className="h-5 w-24 text-[10px]"
        />
        <IconButton label="Create new page" onClick={onInsert} className="size-6">
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton label="Delete selected pages" onClick={onDelete} disabled={pageCount < 2} className="size-6">
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Layers -------------------------------------------------------------------------------

export function LayersPanel({
  layers,
  active,
  withSelection,
  onActive,
  onToggle,
  onRename,
  onNew,
  onDelete,
  onMoveSelection,
}: {
  layers: LayerInfo[];
  active: string | null;
  withSelection: Set<string>;
  onActive: (self: string) => void;
  onToggle: (self: string, what: 'Visible' | 'Locked') => void;
  onRename: (self: string, name: string) => void;
  onNew: () => void;
  onDelete: (self: string) => void;
  onMoveSelection: (self: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Rename puts focus in the name field; the closing menu mustn't take it back.
  const keepFocus = useRef(false);
  return (
    <div className="flex flex-col">
      <ul className="max-h-[30vh] overflow-y-auto" aria-label="Layers">
        {layers.map((l) => (
          <ContextMenu key={l.self}>
            <ContextMenuTrigger asChild disabled={editing === l.self}>
              <li className={cn(ROW, 'border-b border-[#2f2f2f]', active === l.self && 'bg-[#4b4b4b]')} onContextMenu={() => editing !== l.self && onActive(l.self)}>
                <button type="button" aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`} onClick={() => onToggle(l.self, 'Visible')} className={cn('grid size-5 place-items-center text-[#cfcfcf]', FOCUS)}>
                  {l.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 opacity-40" />}
                </button>
                <button type="button" aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`} onClick={() => onToggle(l.self, 'Locked')} className={cn('grid size-5 place-items-center text-[#cfcfcf]', FOCUS)}>
                  {l.locked ? <Lock className="size-3" /> : <LockOpen className="size-3 opacity-25" />}
                </button>
                <span className="h-3.5 w-1 shrink-0" style={{ background: l.color }} />
                {editing === l.self ? (
                  <input
                    autoFocus
                    defaultValue={l.name}
                    aria-label="Layer name"
                    onBlur={(e) => {
                      setEditing(null);
                      if (e.target.value.trim() && e.target.value !== l.name) onRename(l.self, e.target.value.trim());
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className={cn(INPUT, 'h-5 min-w-0 flex-1')}
                  />
                ) : (
                  <button type="button" onClick={() => onActive(l.self)} onDoubleClick={() => setEditing(l.self)} className={cn('min-w-0 flex-1 truncate text-left', FOCUS)}>
                    {l.name}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={withSelection.has(l.self) ? `Selection is on ${l.name}` : `Move selection to ${l.name}`}
                  title="Click to move the selection to this layer"
                  onClick={() => onMoveSelection(l.self)}
                  className={cn('grid size-4 place-items-center', FOCUS)}
                >
                  <span className={cn('size-2', withSelection.has(l.self) ? '' : 'border border-[#6a6a6a]')} style={withSelection.has(l.self) ? { background: l.color } : undefined} />
                </button>
              </li>
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
                  setEditing(l.self);
                }}
              >
                Rename Layer
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onToggle(l.self, 'Visible')}>{l.visible ? 'Hide Layer' : 'Show Layer'}</ContextMenuItem>
              <ContextMenuItem onSelect={() => onToggle(l.self, 'Locked')}>{l.locked ? 'Unlock Layer' : 'Lock Layer'}</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!withSelection.size || (withSelection.size === 1 && withSelection.has(l.self))} onSelect={() => onMoveSelection(l.self)}>
                Move Selection Here
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={onNew}>New Layer</ContextMenuItem>
              <ContextMenuItem destructive disabled={layers.length < 2} onSelect={() => onDelete(l.self)}>
                Delete Layer
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </ul>
      <div className="flex h-7 items-center justify-end gap-1 border-t border-[#2a2a2a] bg-[#323232] px-2">
        <span className="min-w-0 flex-1 text-[10px] text-[#bdbdbd]">
          {layers.length} {layers.length === 1 ? 'Layer' : 'Layers'}
        </span>
        <IconButton label="Create new layer" onClick={onNew} className="size-6">
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton label="Delete selected layer" onClick={() => active && onDelete(active)} disabled={layers.length < 2 || !active} className="size-6">
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Links -----------------------------------------------------------------------------------

export interface LinkRow {
  self: string;
  name: string;
  page: string;
  status: 'ok' | 'missing' | 'embedded' | 'preview' | 'loading';
}

export function LinksPanel({ links, selected, onSelect, onRelink }: { links: LinkRow[]; selected: string | null; onSelect: (self: string) => void; onRelink: (self: string) => void }) {
  if (!links.length) return <p className={EMPTY}>No placed graphics.</p>;
  return (
    <div className="flex flex-col">
      <div className="flex h-6 items-center gap-2 border-b border-[#2a2a2a] bg-[#333] px-2 text-[10px] text-[#a0a0a0]">
        <span className="flex-1">Name</span>
        <span className="w-8 text-center">Status</span>
        <span className="w-8 text-right">Page</span>
      </div>
      <ul className="max-h-[26vh] overflow-y-auto">
        {links.map((l) => (
          <li key={l.self}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => onSelect(l.self)}
                  onDoubleClick={() => onRelink(l.self)}
                  title={l.status === 'missing' ? 'Missing: double-click to relink' : l.status === 'preview' ? 'The file isn’t here; showing InDesign’s preview. Double-click to relink.' : l.name}
                  className={cn(ROW, 'w-full text-left', selected === l.self && 'bg-[#4b4b4b]', FOCUS)}
                >
                  <FileImage className="size-3.5 shrink-0 text-[#a0a0a0]" />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="grid w-8 place-items-center">
                    {l.status === 'missing' && <TriangleAlert className="size-3.5 text-[#ff6b6b]" />}
                    {l.status === 'preview' && <Link2Off className="size-3.5 text-[#f0b429]" />}
                    {l.status === 'embedded' && <span className="text-[9px] text-[#bdbdbd]">EMB</span>}
                  </span>
                  <span className="w-8 text-right text-[#bdbdbd] tabular-nums">{l.page}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onSelect(l.self)}>Go to Link</ContextMenuItem>
                <ContextMenuItem onSelect={() => onRelink(l.self)}>Relink…</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </li>
        ))}
      </ul>
      <div className="flex h-7 items-center justify-end gap-1 border-t border-[#2a2a2a] bg-[#323232] px-2">
        <span className="min-w-0 flex-1 text-[10px] text-[#bdbdbd]">
          {links.length} {links.length === 1 ? 'Link' : 'Links'}
          {links.some((l) => l.status === 'missing' || l.status === 'preview') ? ` · ${links.filter((l) => l.status === 'missing' || l.status === 'preview').length} missing` : ''}
        </span>
        <button type="button" disabled={!selected} onClick={() => selected && onRelink(selected)} className={cn('h-5 rounded-[3px] px-2 text-[10px] text-[#e0e0e0] hover:bg-[#4a4a4a] disabled:opacity-40', FOCUS)}>
          Relink…
        </button>
      </div>
    </div>
  );
}

// ---- Stroke -----------------------------------------------------------------------------------

export function StrokePanel({ obj, item, onAttrs }: { obj: ObjectInfo | null; item: { cap: string; join: string; strokeAlign: string } | null; onAttrs: (a: Attrs) => void }) {
  if (!obj || !item) return <p className={EMPTY}>Select a frame, shape or line.</p>;
  const btn = (on: boolean, label: string, onClick: () => void, glyph: React.ReactNode) => (
    <IconButton label={label} pressed={on} onClick={onClick} className="size-6">
      {glyph}
    </IconButton>
  );
  return (
    <div className="space-y-2 p-3">
      <NumField label="Weight:" value={obj.weight} suffix="pt" min={0} max={1000} step={0.25} decimals={3} options={[0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 8, 10]} onChange={(v) => onAttrs({ StrokeWeight: v })} width="w-[70px]" />
      <div className="flex items-center gap-1 text-[11px] text-[#bdbdbd]">
        <span className="w-12">Cap:</span>
        {btn(item.cap === 'ButtEndCap', 'Butt cap', () => onAttrs({ EndCap: 'ButtEndCap' }), <span className="h-1 w-3 bg-current" />)}
        {btn(item.cap === 'RoundEndCap', 'Round cap', () => onAttrs({ EndCap: 'RoundEndCap' }), <span className="h-1.5 w-3.5 rounded-full bg-current" />)}
        {btn(item.cap === 'ProjectingEndCap', 'Projecting cap', () => onAttrs({ EndCap: 'ProjectingEndCap' }), <span className="h-1.5 w-4 bg-current" />)}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-[#bdbdbd]">
        <span className="w-12">Join:</span>
        {btn(item.join === 'MiterEndJoin', 'Miter join', () => onAttrs({ EndJoin: 'MiterEndJoin' }), <span className="size-3 border-t-2 border-r-2 border-current" />)}
        {btn(item.join === 'RoundEndJoin', 'Round join', () => onAttrs({ EndJoin: 'RoundEndJoin' }), <span className="size-3 rounded-tr-md border-t-2 border-r-2 border-current" />)}
        {btn(item.join === 'BevelEndJoin', 'Bevel join', () => onAttrs({ EndJoin: 'BevelEndJoin' }), <span className="size-3 rounded-tr-[3px] border-t-2 border-r-2 border-current" />)}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-[#bdbdbd]">
        <span className="w-12">Align:</span>
        {btn(item.strokeAlign === 'CenterAlignment', 'Align stroke to center', () => onAttrs({ StrokeAlignment: 'CenterAlignment' }), <span className="size-3 border-2 border-current opacity-80" />)}
        {btn(item.strokeAlign === 'InsideAlignment', 'Align stroke to inside', () => onAttrs({ StrokeAlignment: 'InsideAlignment' }), <span className="size-3 border-2 border-current shadow-[inset_0_0_0_1px_#888]" />)}
        {btn(item.strokeAlign === 'OutsideAlignment', 'Align stroke to outside', () => onAttrs({ StrokeAlignment: 'OutsideAlignment' }), <span className="size-3 border-2 border-current shadow-[0_0_0_1px_#888]" />)}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-[#bdbdbd]">
        <span className="w-12">Type:</span>
        <Select
          label="Stroke type"
          value={obj.strokeType ?? 'StrokeStyle/$ID/Solid'}
          onChange={(v) => onAttrs({ StrokeType: v })}
          options={[
            ['StrokeStyle/$ID/Solid', 'Solid'],
            ['StrokeStyle/$ID/Dashed', 'Dashed'],
            ['StrokeStyle/$ID/Canned Dashed 3x2', 'Dashed (3 and 2)'],
            ['StrokeStyle/$ID/Canned Dashed 4x4', 'Dashed (4 and 4)'],
            ['StrokeStyle/$ID/Canned Dotted', 'Dotted'],
          ]}
          className="h-[22px] w-[130px] text-[11px]"
        />
      </div>
    </div>
  );
}

// ---- Swatches --------------------------------------------------------------------------------------

export function SwatchesPanel({
  swatches,
  fill,
  stroke,
  active,
  onActive,
  onApply,
  onNew,
  onDelete,
  onEdit,
  tint,
  onTint,
}: {
  swatches: Swatches;
  fill: string | null | undefined;
  stroke: string | null | undefined;
  active: 'fill' | 'stroke';
  onActive: (a: 'fill' | 'stroke') => void;
  onApply: (self: string) => void;
  onNew: () => void;
  onDelete: (self: string) => void;
  onEdit: (self: string) => void;
  tint: number | null;
  onTint: (v: number) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const current = active === 'fill' ? fill : stroke;
  return (
    <div className="flex flex-col">
      <div className="flex h-8 items-center gap-2 border-b border-[#2a2a2a] px-2">
        <button type="button" aria-label="Fill" aria-pressed={active === 'fill'} title="Fill" onClick={() => onActive('fill')} className={cn('rounded-[2px] p-0.5', active === 'fill' && 'ring-1 ring-[#2d8ceb]', FOCUS)}>
          <Chip sw={swatches.bySelf.get(fill ?? 'Swatch/None')} />
        </button>
        <button type="button" aria-label="Stroke" aria-pressed={active === 'stroke'} title="Stroke" onClick={() => onActive('stroke')} className={cn('rounded-[2px] p-0.5', active === 'stroke' && 'ring-1 ring-[#2d8ceb]', FOCUS)}>
          <Chip sw={swatches.bySelf.get(stroke ?? 'Swatch/None')} stroke />
        </button>
        <span className="flex-1" />
        <NumField label="Tint:" value={tint} suffix="%" decimals={0} min={0} max={100} onChange={onTint} width="w-[64px]" options={[100, 90, 75, 50, 25, 10]} />
      </div>
      <ul className="max-h-[28vh] overflow-y-auto" aria-label="Swatches">
        {swatches.list.map((s: Swatch) => (
          <li key={s.self}>
            <button
              type="button"
              onClick={() => {
                setPicked(s.self);
                onApply(s.self);
              }}
              onDoubleClick={() => s.kind === 'color' && s.editable && onEdit(s.self)}
              className={cn(ROW, 'h-6 w-full text-left', (picked === s.self || current === s.self) && 'bg-[#4b4b4b]', FOCUS)}
            >
              <Chip sw={s} />
              <span className="min-w-0 flex-1 truncate">{swatchLabel(s)}</span>
              {s.model === 'Spot' && <span className="text-[9px] text-[#9a9a9a]">◐</span>}
              {s.kind === 'color' && <span className="text-[9px] text-[#9a9a9a]">{s.space === 'RGB' ? 'RGB' : s.space === 'LAB' ? 'Lab' : 'CMYK'}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex h-7 items-center justify-end gap-1 border-t border-[#2a2a2a] bg-[#323232] px-2">
        <IconButton label="New swatch from the current color" onClick={onNew} className="size-6">
          <Plus className="size-3.5" />
        </IconButton>
        <IconButton
          label="Delete swatch"
          disabled={!picked || !swatches.bySelf.get(picked)?.editable || ['Color/Paper', 'Color/Black', 'Swatch/None', 'Color/Registration'].includes(picked)}
          onClick={() => picked && onDelete(picked)}
          className="size-6"
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Color -------------------------------------------------------------------------------------------

export function ColorPanel({ swatch, onColor, label }: { swatch: Swatch | null | undefined; onColor: (space: 'CMYK' | 'RGB', values: number[]) => void; label: string }) {
  const [space, setSpace] = useState<'CMYK' | 'RGB' | null>(null);
  if (!swatch || swatch.kind === 'none' || swatch.kind === 'gradient') {
    return <p className={EMPTY}>{swatch?.kind === 'gradient' ? 'A gradient is applied.' : `${label}: None. Pick a swatch, or set a color here once one is applied.`}</p>;
  }
  const sp = space ?? (swatch.space === 'RGB' ? 'RGB' : 'CMYK');
  const cmyk = swatch.space === 'CMYK' && swatch.values.length === 4 ? (swatch.values as [number, number, number, number]) : rgbToCmyk(...swatch.rgb);
  const rgb = swatch.rgb;
  return (
    <div className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <span className="h-6 w-10 border border-[#1a1a1a]" style={{ background: css(swatch.rgb) }} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[#cfcfcf]">{swatchLabel(swatch)}</span>
        <Select<'CMYK' | 'RGB'> label="Color mode" value={sp} onChange={setSpace} options={[['CMYK', 'CMYK'], ['RGB', 'RGB']]} className="h-5 w-16 text-[10px]" />
      </div>
      {sp === 'CMYK'
        ? (['C', 'M', 'Y', 'K'] as const).map((ch, i) => {
            const ends = [cmykToRgb(...(cmyk.map((v, j) => (j === i ? 0 : v)) as [number, number, number, number])), cmykToRgb(...(cmyk.map((v, j) => (j === i ? 100 : v)) as [number, number, number, number]))];
            return (
              <SliderRow
                key={ch}
                label={ch}
                value={Math.round(cmyk[i])}
                min={0}
                max={100}
                unit="%"
                track={`linear-gradient(to right, ${css(ends[0])}, ${css(ends[1])})`}
                onChange={(v) => onColor('CMYK', cmyk.map((x, j) => (j === i ? v : x)))}
              />
            );
          })
        : (['R', 'G', 'B'] as const).map((ch, i) => (
            <SliderRow
              key={ch}
              label={ch}
              value={Math.round(rgb[i])}
              min={0}
              max={255}
              track={`linear-gradient(to right, ${hex(rgb.map((x, j) => (j === i ? 0 : x)) as [number, number, number])}, ${hex(rgb.map((x, j) => (j === i ? 255 : x)) as [number, number, number])})`}
              onChange={(v) => onColor('RGB', rgb.map((x, j) => (j === i ? v : x)))}
            />
          ))}
    </div>
  );
}

// ---- Character and Paragraph ---------------------------------------------------------------------------

export function CharacterPanel({ type, onChar }: { type: TypeInfo | null; onChar: (a: Attrs) => void }) {
  if (!type) return <p className={EMPTY}>Select text, or a text frame, to format its characters.</p>;
  const c = type.char;
  return (
    <div className="space-y-1.5 p-3">
      <ComboField label="Font family" value={c.font} options={type.fonts} onChange={(v) => onChar({ AppliedFont: v })} width="w-full" />
      <ComboField label="Font style" value={c.fontStyle} options={type.styles} onChange={(v) => onChar({ FontStyle: v })} width="w-full" />
      <div className="grid grid-cols-2 gap-1.5">
        <NumField label="Size" value={c.size} suffix="pt" min={0.1} max={1296} onChange={(v) => onChar({ PointSize: v })} options={[6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72]} />
        <NumField label="Lead" value={c.leading ?? Math.round(c.size * c.autoLeading) / 100} suffix="pt" min={0} max={5000} onChange={(v) => onChar({ Leading: v })} onAuto={() => onChar({ Leading: 'Auto' })} options={['Auto']} />
        <NumField label="Track" value={c.tracking} decimals={0} min={-1000} max={10000} step={10} onChange={(v) => onChar({ Tracking: v })} />
        <NumField label="Shift" value={c.baselineShift} suffix="pt" min={-5000} max={5000} onChange={(v) => onChar({ BaselineShift: v })} />
        <NumField label="V scale" value={c.vscale} suffix="%" decimals={1} min={1} max={1000} onChange={(v) => onChar({ VerticalScale: v })} />
        <NumField label="H scale" value={c.hscale} suffix="%" decimals={1} min={1} max={1000} onChange={(v) => onChar({ HorizontalScale: v })} />
        <NumField label="Skew" value={c.skew} suffix="°" decimals={1} min={-85} max={85} onChange={(v) => onChar({ Skew: v })} />
      </div>
    </div>
  );
}

export function ParagraphPanel({ type, unit, onPara }: { type: TypeInfo | null; unit: Unit; onPara: (a: Attrs) => void }) {
  if (!type) return <p className={EMPTY}>Select text, or a text frame, to format its paragraphs.</p>;
  const p = type.para;
  const opts: readonly (readonly [string, string])[] = [
    ['LeftAlign', 'Align left'],
    ['CenterAlign', 'Align center'],
    ['RightAlign', 'Align right'],
    ['LeftJustified', 'Justify, last line left'],
    ['CenterJustified', 'Justify, last line centered'],
    ['RightJustified', 'Justify, last line right'],
    ['FullyJustified', 'Justify all lines'],
    ['ToBindingSide', 'Towards spine'],
    ['AwayFromBindingSide', 'Away from spine'],
  ];
  return (
    <div className="space-y-1.5 p-3">
      <Select label="Alignment" value={p.justification} onChange={(v) => onPara({ Justification: v })} options={opts} className="h-[22px] w-full text-[11px]" />
      <div className="grid grid-cols-2 gap-1.5">
        <LengthField label="Left" value={p.leftIndent} unit={unit} onChange={(v) => onPara({ LeftIndent: v })} />
        <LengthField label="Right" value={p.rightIndent} unit={unit} onChange={(v) => onPara({ RightIndent: v })} />
        <LengthField label="First" value={p.firstIndent} unit={unit} onChange={(v) => onPara({ FirstLineIndent: v })} />
        <LengthField label="Last" value={p.lastIndent} unit={unit} onChange={(v) => onPara({ LastLineIndent: v })} />
        <LengthField label="Before" value={p.spaceBefore} unit={unit} min={0} onChange={(v) => onPara({ SpaceBefore: v })} />
        <LengthField label="After" value={p.spaceAfter} unit={unit} min={0} onChange={(v) => onPara({ SpaceAfter: v })} />
        <NumField label="Drop lines" value={p.dropLines} decimals={0} min={0} max={25} onChange={(v) => onPara({ DropCapLines: Math.round(v) })} width="w-[44px]" />
        <NumField label="Drop chars" value={p.dropChars} decimals={0} min={0} max={150} onChange={(v) => onPara({ DropCapCharacters: Math.round(v) })} width="w-[44px]" />
      </div>
    </div>
  );
}

export function StylesPanel({ styles, current, onApply, onNew, kind }: { styles: StyleInfo[]; current: string | null; onApply: (self: string) => void; onNew: () => void; kind: 'paragraph' | 'character' }) {
  return (
    <div className="flex flex-col">
      <ul className="max-h-[26vh] overflow-y-auto" aria-label={kind === 'paragraph' ? 'Paragraph styles' : 'Character styles'}>
        {styles.map((s) => (
          <li key={s.self}>
            <button type="button" onClick={() => onApply(s.self)} className={cn(ROW, 'h-6 w-full text-left', current === s.self && 'bg-[#2d8ceb] text-white', FOCUS)}>
              {s.group && <span className="text-[#9a9a9a]">{s.group}:</span>}
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex h-7 items-center justify-end gap-1 border-t border-[#2a2a2a] bg-[#323232] px-2">
        <span className="min-w-0 flex-1 truncate text-[10px] text-[#bdbdbd]">{styles.find((s) => s.self === current)?.name ?? ''}</span>
        <IconButton label={`Create new ${kind} style from the selection`} onClick={onNew} className="size-6">
          <Plus className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// ---- Text wrap ----------------------------------------------------------------------------------------

const WRAPS: [string, string, string][] = [
  ['None', 'No text wrap', 'M3 5h14M3 9h14M3 13h14M7 7h6v8H7z'],
  ['BoundingBoxTextWrap', 'Wrap around bounding box', 'M3 5h3M14 5h3M3 9h3M14 9h3M3 13h3M14 13h3M7 4h6v10H7z'],
  ['Contour', 'Wrap around object shape', 'M3 5h3M14 5h3M3 9h2M15 9h2M3 13h3M14 13h3M10 4a3.5 5 0 1 1 0 10a3.5 5 0 1 1 0-10z'],
  ['JumpObjectTextWrap', 'Jump object', 'M3 3h14M3 17h14M7 6h6v8H7z'],
  ['NextColumnTextWrap', 'Jump to next column', 'M3 3h14M7 6h6v8H7zM10 16l2 2-2 2'],
];

export function WrapPanel({ wrap, unit, onWrap }: { wrap: { mode: string; offsets: [number, number, number, number] } | null | undefined; unit: Unit; onWrap: (mode: string, offsets: [number, number, number, number]) => void }) {
  if (wrap === undefined) return <p className={EMPTY}>Select a frame or shape.</p>;
  const mode = wrap?.mode ?? 'None';
  const off = wrap?.offsets ?? [0, 0, 0, 0];
  return (
    <div className="space-y-2 p-3">
      <div className="flex gap-0.5">
        {WRAPS.map(([m, label, d]) => (
          <IconButton key={m} label={label} pressed={mode === m} onClick={() => onWrap(m, off)} className="size-7">
            <svg viewBox="0 0 20 20" className="size-4" aria-hidden>
              <path d={d} stroke="currentColor" strokeWidth="1.3" fill="none" />
            </svg>
          </IconButton>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {(['Top', 'Left', 'Bottom', 'Right'] as const).map((k, i) => (
          <LengthField key={k} label={`${k}:`} value={off[i]} unit={unit} onChange={(v) => onWrap(mode === 'None' ? 'BoundingBoxTextWrap' : mode, off.map((x, j) => (j === i ? v : x)) as [number, number, number, number])} />
        ))}
      </div>
    </div>
  );
}
