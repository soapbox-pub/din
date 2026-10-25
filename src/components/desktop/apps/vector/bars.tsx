import { useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NumberField, Select } from '../photo/chrome';
import { FOCUS } from '../photo/styles';
import { cssPaint } from './paint';
import { SwapIcon } from './icons';
import type { Paint, Units } from './model';
import { UNIT_PT } from './model';
import { STROKE_WEIGHTS, unitLabel } from './units';
import { TOOL_GROUPS, toolInfo, type ToolId } from './tools';

// ---- Swatches of paint ----------------------------------------------------------------------

/** A paint as a swatch: none is white with Illustrator's red slash. */
export function PaintChip({ paint, className, stroke }: { paint: Paint; className?: string; stroke?: boolean }) {
  if (paint.type === 'none') {
    return (
      <span className={cn('relative block overflow-hidden bg-white', className)}>
        <span className="absolute top-1/2 left-1/2 h-[2px] w-[150%] -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-[#e0261c]" />
      </span>
    );
  }
  if (stroke) {
    return (
      <span className={cn('relative block', className)} style={{ background: cssPaint(paint) }}>
        <span className="absolute inset-[30%] bg-[#323232] shadow-[0_0_0_1px_#1a1a1a]" />
      </span>
    );
  }
  return <span className={cn('block', className)} style={{ background: cssPaint(paint) }} />;
}

// ---- Toolbar --------------------------------------------------------------------------------

export function Toolbar({
  tool,
  choice,
  onTool,
  fill,
  stroke,
  focus,
  onFocus,
  onSwap,
  onDefault,
  onApply,
}: {
  tool: ToolId;
  choice: Record<number, ToolId>;
  onTool: (t: ToolId) => void;
  fill: Paint;
  stroke: Paint;
  focus: 'fill' | 'stroke';
  onFocus: (f: 'fill' | 'stroke') => void;
  onSwap: () => void;
  onDefault: () => void;
  onApply: (kind: 'color' | 'gradient' | 'none') => void;
}) {
  const [flyout, setFlyout] = useState<number | null>(null);
  return (
    <div className="relative flex w-11 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-[#232323] bg-[#323232] py-1.5" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOL_GROUPS.map((group, gi) => {
        const shown = group.find((t) => t.id === choice[gi]) ?? group[0];
        const active = group.some((t) => t.id === tool);
        const current = active ? toolInfo(tool) : shown;
        const Icon = current.icon;
        const label = `${current.name}${current.key ? ` (${current.key})` : ''}`;
        return (
          <div key={gi} className="relative">
            <button
              type="button"
              aria-label={label}
              title={label}
              aria-pressed={active}
              onClick={() => onTool(current.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (group.length > 1) setFlyout(flyout === gi ? null : gi);
              }}
              onPointerDown={(e) => {
                if (group.length < 2 || e.button !== 0) return;
                const t = setTimeout(() => setFlyout(gi), 450);
                const clear = () => {
                  clearTimeout(t);
                  window.removeEventListener('pointerup', clear);
                };
                window.addEventListener('pointerup', clear);
              }}
              className={cn('relative grid size-8 place-items-center rounded-[3px] text-[#d6d6d6]', active ? 'bg-[#1f1f1f] text-white' : 'hover:bg-[#4a4a4a]', FOCUS)}
            >
              <Icon className="size-[18px]" />
              {group.length > 1 && (
                <svg className="absolute right-0.5 bottom-0.5 size-1.5 text-[#9a9a9a]" viewBox="0 0 4 4" aria-hidden>
                  <path d="M4 0V4H0Z" fill="currentColor" />
                </svg>
              )}
            </button>
            {flyout === gi && (
              <div role="menu" className="absolute top-0 left-full z-40 ml-1 w-60 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 shadow-xl shadow-black/40" onPointerLeave={() => setFlyout(null)}>
                {group.map((t) => {
                  const TIcon = t.icon;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={t.id === current.id}
                      onClick={() => {
                        onTool(t.id);
                        setFlyout(null);
                      }}
                      className={cn('flex h-7 w-full items-center gap-2 rounded-[3px] px-2 text-left text-xs text-[#e0e0e0] hover:bg-[#2d8ceb] hover:text-white', FOCUS)}
                    >
                      <TIcon className="size-4" />
                      <span className="flex-1">{t.name}</span>
                      <span className="text-[#a0a0a0]">{t.key}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Fill and stroke, as Illustrator's toolbar has them. */}
      <div className="mt-2 flex flex-col items-center gap-1.5">
        <div className="relative size-10">
          <button
            type="button"
            aria-label="Stroke (X)"
            title="Stroke (X)"
            onClick={() => onFocus('stroke')}
            className={cn('absolute right-0 bottom-0 size-6 border border-[#111]', focus === 'stroke' ? 'z-10' : 'z-0', FOCUS)}
          >
            <PaintChip paint={stroke} stroke className="size-full" />
          </button>
          <button
            type="button"
            aria-label="Fill (X)"
            title="Fill (X)"
            onClick={() => onFocus('fill')}
            className={cn('absolute top-0 left-0 size-6 border border-[#111]', focus === 'fill' ? 'z-10' : 'z-0', FOCUS)}
          >
            <PaintChip paint={fill} className="size-full" />
          </button>
          <button type="button" aria-label="Swap Fill and Stroke (Shift+X)" title="Swap Fill and Stroke (Shift+X)" onClick={onSwap} className={cn('absolute -top-0.5 right-0 grid size-3.5 place-items-center text-[#cfcfcf] hover:text-white', FOCUS)}>
            <SwapIcon className="size-3" />
          </button>
          <button type="button" aria-label="Default Fill and Stroke (D)" title="Default Fill and Stroke (D)" onClick={onDefault} className={cn('absolute bottom-0 left-0 grid size-3.5 place-items-center', FOCUS)}>
            <span className="relative block size-3">
              <span className="absolute right-0 bottom-0 size-2 border-[1.5px] border-black bg-transparent" />
              <span className="absolute top-0 left-0 size-2 border border-[#666] bg-white" />
            </span>
          </button>
        </div>
        <div className="flex gap-0.5">
          <button type="button" aria-label="Color (<)" title="Color (<)" onClick={() => onApply('color')} className={cn('size-3.5 border border-[#111] bg-[#e6e6e6]', FOCUS)} />
          <button type="button" aria-label="Gradient (>)" title="Gradient (>)" onClick={() => onApply('gradient')} className={cn('size-3.5 border border-[#111] bg-gradient-to-r from-white to-black', FOCUS)} />
          <button type="button" aria-label="None (/)" title="None (/)" onClick={() => onApply('none')} className={cn('size-3.5 border border-[#111]', FOCUS)}>
            <PaintChip paint={{ type: 'none' }} className="size-full" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Control bar ------------------------------------------------------------------------------

/** A number field for lengths in the document's units (values in points). */
export function LengthField({ label, value, onChange, units, width = 'w-[72px]', title }: { label: string; value: number; onChange: (pt: number) => void; units: Units; width?: string; title?: string }) {
  const k = UNIT_PT[units];
  return (
    <NumberField
      label={label}
      title={title}
      value={value / k}
      decimals={units === 'in' ? 3 : units === 'px' || units === 'pt' ? 2 : 2}
      step={units === 'in' ? 0.01 : 1}
      unit={unitLabel(units)}
      width={width}
      onChange={(v) => onChange(v * k)}
    />
  );
}

export interface ControlProps {
  kind: string | null;
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  opacity: number;
  bounds: { x: number; y: number; w: number; h: number } | null;
  units: Units;
  linked: boolean;
  onLinked: (v: boolean) => void;
  onStrokeWidth: (w: number) => void;
  onOpacity: (o: number) => void;
  onBounds: (b: { x?: number; y?: number; w?: number; h?: number }) => void;
  onEditFill: () => void;
  onEditStroke: () => void;
  /** Tool-specific controls (the Type tool's font fields and so on). */
  extra?: React.ReactNode;
}

export function ControlBar(p: ControlProps) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-[#232323] bg-[#323232] px-2 text-xs text-[#d6d6d6]">
      <span className="w-24 shrink-0 truncate font-medium text-[#e6e6e6]">{p.kind ?? 'No Selection'}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-[#bdbdbd]">Fill</span>
        <button type="button" aria-label="Fill color" title="Fill" onClick={p.onEditFill} className={cn('size-5 border border-[#111]', FOCUS)}>
          <PaintChip paint={p.fill} className="size-full" />
        </button>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="text-[#bdbdbd]">Stroke</span>
        <button type="button" aria-label="Stroke color" title="Stroke" onClick={p.onEditStroke} className={cn('size-5 border border-[#111]', FOCUS)}>
          <PaintChip paint={p.stroke} stroke className="size-full" />
        </button>
        <NumberField value={p.strokeWidth} onChange={p.onStrokeWidth} min={0} max={1000} step={1} decimals={2} unit="pt" width="w-16" title="Stroke Weight" />
        <Select
          label="Stroke weights"
          value=""
          className="w-6 px-0"
          onChange={(v) => v && p.onStrokeWidth(Number(v))}
          options={[['', ''], ...STROKE_WEIGHTS.map((w) => [String(w), `${w} pt`] as [string, string])]}
        />
      </span>
      <span className="flex items-center gap-1.5">
        <NumberField label="Opacity:" value={Math.round(p.opacity * 100)} onChange={(v) => p.onOpacity(v / 100)} min={0} max={100} unit="%" width="w-14" />
      </span>
      {p.extra}
      {p.bounds && (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <LengthField label="X:" value={p.bounds.x} units={p.units} onChange={(x) => p.onBounds({ x })} />
          <LengthField label="Y:" value={p.bounds.y} units={p.units} onChange={(y) => p.onBounds({ y })} />
          <LengthField label="W:" value={p.bounds.w} units={p.units} onChange={(w) => p.onBounds({ w })} />
          <button
            type="button"
            aria-label={p.linked ? 'Unlink width and height' : 'Constrain width and height proportions'}
            title="Constrain Width and Height Proportions"
            aria-pressed={p.linked}
            onClick={() => p.onLinked(!p.linked)}
            className={cn('grid size-6 place-items-center rounded-[3px] hover:bg-[#4a4a4a]', p.linked && 'text-white', FOCUS)}
          >
            {p.linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5 text-[#9a9a9a]" />}
          </button>
          <LengthField label="H:" value={p.bounds.h} units={p.units} onChange={(h) => p.onBounds({ h })} />
        </span>
      )}
    </div>
  );
}
