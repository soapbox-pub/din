import { memo, useLayoutEffect, useRef, useState } from 'react';
import type { AdjustmentLayer, BlendMode } from 'ag-psd';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  CircleSlash2,
  Contrast,
  CornerLeftDown,
  Eye,
  EyeOff,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Lock,
  Move,
  RectangleHorizontal,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Trash2,
  Type,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ADJUSTMENT_NAMES, MENU_ADJUSTMENTS } from './adjust';
import { AdjustmentEditor } from './adjustEditor';
import { IconButton, NumberField, Select } from './chrome';
import { ColorPicker } from './color';
import { FOCUS, INPUT, SWATCHES } from './styles';
import { findLayer, findPlace, walkTopDown, type Doc, type Layer } from './model';
import { BLEND_GROUPS, blendLabel } from './render';

// ---- Frame -----------------------------------------------------------------------

export function Panel({
  title,
  open,
  onToggle,
  children,
  grow,
  actions,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  grow?: boolean;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn('flex flex-col border-b border-[#232323]', grow && open ? 'min-h-56 flex-1' : 'shrink-0')} aria-label={title}>
      <div className="flex h-7 shrink-0 items-center gap-1 bg-[#2f2f2f] pr-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn('flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left text-[11px] font-semibold text-[#e0e0e0]', FOCUS)}
        >
          {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
          {title}
        </button>
        {open && actions}
      </div>
      {open && <div className={cn('min-h-0 bg-[#383838]', grow ? 'flex flex-1 flex-col' : '')}>{children}</div>}
    </section>
  );
}

// ---- Thumbnails ----------------------------------------------------------------------

/** A layer (or mask) shrunk into the document's shape, on a checkerboard. */
const Thumb = memo(function Thumb({
  canvas,
  left,
  top,
  docW,
  docH,
  mask,
  defaultColor = 0,
}: {
  canvas: HTMLCanvasElement | null;
  left: number;
  top: number;
  docW: number;
  docH: number;
  mask?: boolean;
  defaultColor?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const S = 32;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dpr = 2;
    el.width = S * dpr;
    el.height = S * dpr;
    const c = el.getContext('2d')!;
    const k = Math.min(S / docW, S / docH) * dpr;
    const w = docW * k;
    const h = docH * k;
    const ox = (S * dpr - w) / 2;
    const oy = (S * dpr - h) / 2;
    c.clearRect(0, 0, el.width, el.height);
    if (mask) {
      c.fillStyle = `rgb(${defaultColor},${defaultColor},${defaultColor})`;
      c.fillRect(ox, oy, w, h);
    } else {
      for (let y = 0; y < h; y += 6) {
        for (let x = 0; x < w; x += 6) {
          c.fillStyle = ((x + y) / 6) % 2 ? '#ffffff' : '#cccccc';
          c.fillRect(ox + x, oy + y, Math.min(6, w - x), Math.min(6, h - y));
        }
      }
    }
    if (canvas) {
      c.save();
      c.beginPath();
      c.rect(ox, oy, w, h);
      c.clip();
      c.imageSmoothingQuality = 'high';
      c.drawImage(canvas, ox + left * k, oy + top * k, canvas.width * k, canvas.height * k);
      c.restore();
    }
  }, [canvas, left, top, docW, docH, mask, defaultColor]);
  return <canvas ref={ref} className="size-8 shrink-0" aria-hidden />;
});

// ---- Layers ----------------------------------------------------------------------------

export interface LayersPanelProps {
  doc: Doc;
  activeId: number | null;
  selectedIds: Set<number>;
  editMask: boolean;
  onSelect: (id: number, how: { shift: boolean; ctrl: boolean }) => void;
  onSelectMask: (id: number) => void;
  onToggleVisible: (id: number, solo: boolean) => void;
  onToggleOpen: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onSetProps: (props: Partial<Layer>, label: string, coalesce?: string) => void;
  onNewLayer: () => void;
  onNewGroup: () => void;
  onDelete: () => void;
  onAddMask: () => void;
  onToggleMask: (id: number) => void;
  onAdjustment: (type: AdjustmentLayer['type']) => void;
  onLayerStyle: () => void;
  onDrop: (id: number, parentId: number | null, index: number) => void;
  onLoadSelection: (id: number) => void;
  onToggleClipping: (id: number) => void;
}

const KIND_ICON = {
  text: Type,
  smart: RectangleHorizontal,
  shape: SquareDashed,
} as const;

interface DropTarget {
  rowId: number;
  edge: 'above' | 'below' | 'into';
  parentId: number | null;
  index: number;
}

export function LayersPanel(p: LayersPanelProps) {
  const { doc, activeId } = p;
  const active = activeId !== null ? findLayer(doc.layers, activeId) : null;
  const rows = visibleRows(doc.layers);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [adjMenu, setAdjMenu] = useState(false);
  const dragId = useRef<number | null>(null);

  const targetFor = (l: Layer, e: React.DragEvent): DropTarget | null => {
    const place = findPlace(doc.layers, l.id);
    if (!place) return null;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    const parentId = place.parent?.id ?? null;
    if (l.kind === 'group' && f > 0.3 && f < 0.7) return { rowId: l.id, edge: 'into', parentId: l.id, index: l.children.length };
    if (f < 0.5) return { rowId: l.id, edge: 'above', parentId, index: place.index + 1 };
    if (l.kind === 'group' && l.open) return { rowId: l.id, edge: 'into', parentId: l.id, index: l.children.length };
    return { rowId: l.id, edge: 'below', parentId, index: place.index };
  };

  const locked = active?.locked ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-[#2a2a2a] p-2">
        <div className="flex items-center gap-2">
          <Select<BlendMode>
            label="Blend mode"
            value={active?.blendMode ?? 'normal'}
            disabled={!active}
            onChange={(m) => p.onSetProps({ blendMode: m }, 'Blending Change')}
            options={[
              ...(active?.kind === 'group' ? ([['pass through', 'Pass Through']] as const) : []),
              ...BLEND_GROUPS.flatMap((g, i) => [...(i ? [null] : []), ...g.map((m) => [m, blendLabel(m)] as const)]),
            ]}
            className="min-w-0 flex-1"
          />
          <NumberField
            label="Opacity:"
            value={Math.round((active?.opacity ?? 1) * 100)}
            min={0}
            max={100}
            unit="%"
            width="w-14"
            disabled={!active}
            onChange={(v) => p.onSetProps({ opacity: v / 100 }, 'Opacity Change', `opacity:${activeId}`)}
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-1 text-xs text-[#bdbdbd]">Lock:</span>
          <IconButton label="Lock transparent pixels" pressed={!!active?.lockAlpha} disabled={!active || active.kind !== 'pixel'} onClick={() => p.onSetProps({ lockAlpha: !active!.lockAlpha }, 'Lock Change')}>
            <SquareDashed className="size-3.5" />
          </IconButton>
          <IconButton label="Lock all" pressed={locked} disabled={!active} onClick={() => p.onSetProps({ locked: !locked }, 'Lock Change')}>
            <Lock className="size-3.5" />
          </IconButton>
          <span className="flex-1" />
          <NumberField
            label="Fill:"
            value={Math.round((active?.fill ?? 1) * 100)}
            min={0}
            max={100}
            unit="%"
            width="w-14"
            disabled={!active || active.kind === 'group' || active.kind === 'adjustment'}
            onChange={(v) => p.onSetProps({ fill: v / 100 }, 'Fill Opacity Change', `fill:${activeId}`)}
          />
        </div>
      </div>

      <div
        role="listbox"
        aria-label="Layers"
        aria-multiselectable
        className="min-h-0 flex-1 overflow-y-auto"
        onDragOver={(e) => {
          if (dragId.current !== null && e.target === e.currentTarget) {
            e.preventDefault();
            setDrop(null);
          }
        }}
        onDrop={(e) => {
          // Dropped below every row: the bottom of the stack.
          if (e.target === e.currentTarget && dragId.current !== null) p.onDrop(dragId.current, null, 0);
          dragId.current = null;
        }}
      >
        {rows.map(({ layer: l, depth }) => {
          const selected = p.selectedIds.has(l.id);
          const isActive = l.id === activeId;
          const Icon = l.kind === 'text' || l.kind === 'smart' || l.kind === 'shape' ? KIND_ICON[l.kind] : null;
          const hasFx = !!l.effects && !l.effects.disabled && Object.keys(l.effects).some((k) => k !== 'scale' && k !== 'disabled');
          return (
            <div
              key={l.id}
              role="option"
              aria-selected={selected}
              draggable={renaming !== l.id}
              onDragStart={(e) => {
                dragId.current = l.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', l.name);
              }}
              onDragOver={(e) => {
                if (dragId.current === null) return;
                e.preventDefault();
                setDrop(targetFor(l, e));
              }}
              onDragLeave={() => setDrop((d) => (d?.rowId === l.id ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                const t = targetFor(l, e);
                if (t && dragId.current !== null && dragId.current !== l.id) p.onDrop(dragId.current, t.parentId, t.index);
                dragId.current = null;
                setDrop(null);
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDrop(null);
              }}
              onPointerDown={(e) => {
                if (e.button !== 0 || renaming === l.id) return;
                p.onSelect(l.id, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
              }}
              onDoubleClick={() => setRenaming(l.id)}
              className={cn(
                'group relative flex h-10 cursor-default items-center gap-1 border-b border-[#2c2c2c] pr-2 text-xs select-none',
                selected ? 'bg-[#4f4f4f] text-white' : 'text-[#d6d6d6] hover:bg-[#424242]',
                drop?.rowId === l.id && drop.edge === 'into' && 'outline outline-2 -outline-offset-2 outline-[#2d8ceb]',
              )}
            >
              {drop?.rowId === l.id && drop.edge !== 'into' && (
                <span className={cn('pointer-events-none absolute inset-x-0 h-0.5 bg-[#2d8ceb]', drop.edge === 'above' ? 'top-0' : 'bottom-0')} />
              )}
              <button
                type="button"
                aria-label={l.hidden ? `Show ${l.name}` : `Hide ${l.name}`}
                title="Show/hide (Alt+click: show only this layer)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => p.onToggleVisible(l.id, e.altKey)}
                className={cn('grid h-full w-7 shrink-0 place-items-center border-r border-[#2c2c2c] text-[#cfcfcf]', FOCUS)}
              >
                {l.hidden ? <EyeOff className="size-3.5 opacity-40" /> : <Eye className="size-3.5" />}
              </button>
              <span style={{ width: depth * 14 }} className="shrink-0" />
              {l.clipping && <CornerLeftDown className="size-3 shrink-0 text-[#bdbdbd]" aria-label="Clipped to the layer below" />}
              {l.kind === 'group' ? (
                <button
                  type="button"
                  aria-label={l.open ? 'Collapse group' : 'Expand group'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => p.onToggleOpen(l.id)}
                  className={cn('flex shrink-0 items-center gap-0.5 rounded-[2px] px-0.5 text-[#cfcfcf]', FOCUS)}
                >
                  {l.open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  {l.open ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
                </button>
              ) : l.kind === 'adjustment' ? (
                <span className="grid size-8 shrink-0 place-items-center rounded-[2px] bg-[#2a2a2a] text-[#cfcfcf]" title={ADJUSTMENT_NAMES[l.adjustment?.type ?? ''] ?? 'Adjustment'}>
                  <SlidersHorizontal className="size-4" />
                </span>
              ) : (
                <span
                  className={cn('relative shrink-0 rounded-[2px] p-px', isActive && !p.editMask ? 'ring-1 ring-[#e6e6e6]' : '')}
                  title="Ctrl+click: select this layer's pixels"
                  onPointerDown={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      e.stopPropagation();
                      p.onLoadSelection(l.id);
                    } else if (p.editMask && isActive) {
                      e.stopPropagation();
                      p.onSelect(l.id, { shift: false, ctrl: false });
                    }
                  }}
                >
                  <Thumb canvas={l.canvas} left={l.left} top={l.top} docW={doc.width} docH={doc.height} />
                  {Icon && (
                    <span className="absolute right-0 bottom-0 grid size-3.5 place-items-center rounded-tl-[3px] bg-[#232323] text-[#e6e6e6]">
                      <Icon className="size-2.5" />
                    </span>
                  )}
                </span>
              )}
              {l.mask && (
                <span
                  className={cn('relative shrink-0 rounded-[2px] p-px', isActive && p.editMask && 'ring-1 ring-[#e6e6e6]')}
                  title="Layer mask (Shift+click to turn it off)"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey) p.onToggleMask(l.id);
                    else p.onSelectMask(l.id);
                  }}
                >
                  <Thumb canvas={l.mask.canvas} left={l.mask.left} top={l.mask.top} docW={doc.width} docH={doc.height} mask defaultColor={l.mask.defaultColor} />
                  {l.mask.disabled && <span className="absolute inset-0 grid place-items-center text-lg font-bold text-red-500">✕</span>}
                </span>
              )}
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  aria-label="Layer name"
                  onPointerDown={(e) => e.stopPropagation()}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== l.name) p.onRename(l.id, name);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                  className={cn(INPUT, 'ml-1 min-w-0 flex-1')}
                />
              ) : (
                <span className={cn('ml-1 min-w-0 flex-1 truncate', l.name === 'Background' && 'italic')}>{l.name}</span>
              )}
              {hasFx && <span className="shrink-0 text-[10px] font-semibold text-[#bdbdbd] italic">fx</span>}
              {l.locked && <Lock className="size-3 shrink-0 text-[#bdbdbd]" aria-label="Locked" />}
              {!l.locked && l.lockAlpha && <SquareDashed className="size-3 shrink-0 text-[#bdbdbd]" aria-label="Transparency locked" />}
            </div>
          );
        })}
      </div>

      <div className="relative flex shrink-0 items-center justify-end gap-0.5 border-t border-[#2a2a2a] px-1 py-0.5">
        <IconButton label="Create clipping mask (Alt+Ctrl+G)" disabled={!active} pressed={!!active?.clipping} onClick={() => activeId !== null && p.onToggleClipping(activeId)}>
          <CornerLeftDown className="size-3.5" />
        </IconButton>
        <IconButton label="Add a layer style" disabled={!active || active.kind === 'adjustment'} onClick={p.onLayerStyle}>
          <Sparkles className="size-3.5" />
        </IconButton>
        <IconButton label="Add layer mask" disabled={!active || !!active.mask} onClick={p.onAddMask}>
          <CircleSlash2 className="size-3.5" />
        </IconButton>
        <IconButton label="Create new fill or adjustment layer" pressed={adjMenu} onClick={() => setAdjMenu((v) => !v)}>
          <Contrast className="size-3.5" />
        </IconButton>
        <IconButton label="Create a new group (Ctrl+G groups selected layers)" onClick={p.onNewGroup}>
          <FolderPlus className="size-3.5" />
        </IconButton>
        <IconButton label="Create a new layer (Shift+Ctrl+N)" onClick={p.onNewLayer}>
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton label="Delete layer" disabled={!active || walkTopDown(doc.layers).length <= 1} onClick={p.onDelete}>
          <Trash2 className="size-3.5" />
        </IconButton>
        {adjMenu && (
          <div
            role="menu"
            className="absolute right-8 bottom-full z-30 mb-1 w-48 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 text-xs shadow-xl shadow-black/40"
            onKeyDown={(e) => e.key === 'Escape' && setAdjMenu(false)}
          >
            {MENU_ADJUSTMENTS.map((t) => (
              <button
                key={t}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAdjMenu(false);
                  p.onAdjustment(t);
                }}
                className={cn('flex h-6 w-full items-center rounded-[3px] px-2 text-left text-[#e0e0e0] hover:bg-[#2d8ceb] hover:text-white', FOCUS)}
              >
                {ADJUSTMENT_NAMES[t]}…
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function visibleRows(layers: Layer[], depth = 0, out: { layer: Layer; depth: number }[] = []) {
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    out.push({ layer: l, depth });
    if (l.kind === 'group' && l.open) visibleRows(l.children, depth + 1, out);
  }
  return out;
}

// ---- History -------------------------------------------------------------------------

export function HistoryPanel({ labels, index, onJump }: { labels: string[]; index: number; onJump: (i: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, labels.length]);
  return (
    <div ref={listRef} className="max-h-40 min-h-16 overflow-y-auto py-0.5" role="list" aria-label="History states">
      {labels.map((label, i) => (
        <button
          key={i}
          type="button"
          role="listitem"
          aria-current={i === index ? 'step' : undefined}
          onClick={() => onJump(i)}
          className={cn(
            'flex h-6 w-full items-center gap-2 px-3 text-left text-xs',
            i === index ? 'bg-[#4f4f4f] text-white' : i > index ? 'text-[#7d7d7d] hover:bg-[#424242]' : 'text-[#d6d6d6] hover:bg-[#424242]',
            FOCUS,
          )}
        >
          <span className="w-3 text-center text-[10px] text-[#9a9a9a]">{i === 0 ? '◆' : '›'}</span>
          {label}
        </button>
      ))}
    </div>
  );
}

// ---- Color -----------------------------------------------------------------------------

export function ColorPanel({
  fg,
  bg,
  editing,
  onEditing,
  onChange,
}: {
  fg: string;
  bg: string;
  editing: 'fg' | 'bg';
  onEditing: (w: 'fg' | 'bg') => void;
  onChange: (which: 'fg' | 'bg', hex: string) => void;
}) {
  return (
    <div className="flex gap-3 p-2">
      <div className="relative h-11 w-11 shrink-0">
        <button
          type="button"
          aria-label={`Background color ${bg}`}
          aria-pressed={editing === 'bg'}
          onClick={() => onEditing('bg')}
          className={cn('absolute right-0 bottom-0 size-7 border border-[#111]', editing === 'bg' && 'ring-2 ring-[#2d8ceb]', FOCUS)}
          style={{ background: bg }}
        />
        <button
          type="button"
          aria-label={`Foreground color ${fg}`}
          aria-pressed={editing === 'fg'}
          onClick={() => onEditing('fg')}
          className={cn('absolute top-0 left-0 size-7 border border-[#111]', editing === 'fg' && 'ring-2 ring-[#2d8ceb]', FOCUS)}
          style={{ background: fg }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <ColorPicker value={editing === 'fg' ? fg : bg} onChange={(hex) => onChange(editing, hex)} />
      </div>
    </div>
  );
}

export function SwatchesPanel({ onPick }: { onPick: (hex: string, bg: boolean) => void }) {
  return (
    <div className="grid grid-cols-16 gap-px p-2" role="list" aria-label="Swatches">
      {SWATCHES.map((s) => (
        <button
          key={s}
          type="button"
          role="listitem"
          aria-label={`Swatch ${s} (Ctrl+click for background)`}
          title={`${s} — click: foreground, Ctrl+click: background`}
          onClick={(e) => onPick(s, e.ctrlKey || e.metaKey)}
          className={cn('aspect-square w-full border border-black/40 hover:scale-125 motion-reduce:hover:scale-100', FOCUS)}
          style={{ background: s }}
        />
      ))}
    </div>
  );
}

// ---- Properties ----------------------------------------------------------------------------

export function PropertiesPanel({
  doc,
  layer,
  histogram,
  onAdjust,
  onMove,
  onMaskProps,
}: {
  doc: Doc;
  layer: Layer | null;
  histogram: number[] | null;
  onAdjust: (adj: AdjustmentLayer) => void;
  onMove: (x: number, y: number) => void;
  onMaskProps: (disabled: boolean) => void;
}) {
  if (!layer) {
    return (
      <div className="space-y-1 p-3 text-xs text-[#bdbdbd]">
        <div>
          Document: {doc.width} × {doc.height} px
        </div>
      </div>
    );
  }
  if (layer.kind === 'adjustment' && layer.adjustment) {
    return (
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#e0e0e0]">
          <SlidersHorizontal className="size-3.5" />
          {ADJUSTMENT_NAMES[layer.adjustment.type] ?? 'Adjustment'}
        </div>
        <AdjustmentEditor adj={layer.adjustment} onChange={onAdjust} histogram={histogram} />
      </div>
    );
  }
  return (
    <div className="space-y-2 p-3 text-xs text-[#d6d6d6]">
      <div className="flex items-center gap-2 font-semibold">
        <Move className="size-3.5" />
        {layer.kind === 'group' ? 'Group' : layer.kind === 'text' ? 'Type Layer' : layer.kind === 'smart' ? 'Smart Object' : layer.kind === 'shape' ? 'Shape Layer' : 'Pixel Layer'}
      </div>
      {layer.canvas && (
        <div className="grid grid-cols-2 gap-2">
          <span className="text-[#9a9a9a]">
            W: {layer.canvas.width} px
          </span>
          <span className="text-[#9a9a9a]">
            H: {layer.canvas.height} px
          </span>
          <NumberField label="X" value={layer.left} unit="px" onChange={(x) => onMove(x, layer.top)} />
          <NumberField label="Y" value={layer.top} unit="px" onChange={(y) => onMove(layer.left, y)} />
        </div>
      )}
      {layer.mask && (
        <button type="button" onClick={() => onMaskProps(!layer.mask!.disabled)} className={cn('flex items-center gap-1.5 text-[#cfcfcf] hover:text-white', FOCUS)}>
          <ArrowLeftRight className="size-3.5" />
          {layer.mask.disabled ? 'Enable layer mask' : 'Disable layer mask'}
        </button>
      )}
      {(layer.kind === 'smart' || layer.kind === 'shape') && (
        <p className="text-[#9a9a9a]">Shown as Photoshop drew it. Painting on it turns it into a pixel layer.</p>
      )}
    </div>
  );
}
