import { useState } from 'react';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/photo/styles';
import { css, type Swatch } from './colors';
import { TOOL_GROUPS, toolInfo, type ToolId } from './tools';

/**
 * InDesign's Tools panel: one column of tools (right-click or hold for a
 * slot's other tools), then the fill and stroke proxy with swap and
 * default, Formatting Affects Container/Text, Apply Color/Gradient/None,
 * and the Normal and Preview view modes.
 */
export function Toolbar({
  tool,
  choice,
  onTool,
  fill,
  stroke,
  active,
  onActive,
  onSwap,
  onDefault,
  onApply,
  affectsText,
  onAffectsText,
  preview,
  onPreview,
}: {
  tool: ToolId;
  choice: Record<number, ToolId>;
  onTool: (t: ToolId) => void;
  fill: Swatch | null | undefined;
  stroke: Swatch | null | undefined;
  active: 'fill' | 'stroke';
  onActive: (a: 'fill' | 'stroke') => void;
  onSwap: () => void;
  onDefault: () => void;
  onApply: (what: 'color' | 'gradient' | 'none') => void;
  affectsText: boolean;
  onAffectsText: (v: boolean) => void;
  preview: boolean;
  onPreview: (v: boolean) => void;
}) {
  const [flyout, setFlyout] = useState<number | null>(null);
  const chip = (sw: Swatch | null | undefined): React.CSSProperties => {
    if (!sw || sw.kind === 'none') return { background: '#fff' };
    if (sw.kind === 'gradient' && sw.gradient) return { background: `linear-gradient(to right, ${sw.gradient.stops.map((s) => `${css(s.rgb)} ${s.location}%`).join(', ')})` };
    return { background: css(sw.rgb) };
  };
  const slash = (
    <svg viewBox="0 0 10 10" className="pointer-events-none absolute inset-0 size-full" aria-hidden>
      <path d="M0 10 10 0" stroke="#e00" strokeWidth="1.2" />
    </svg>
  );
  return (
    <div className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-x-visible overflow-y-auto border-r border-[#232323] bg-[#323232] py-1.5" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOL_GROUPS.map((group, gi) => {
        const shown = group.find((t) => t.id === choice[gi]) ?? group[0];
        const on = group.some((t) => t.id === tool);
        const current = on ? toolInfo(tool) : shown;
        const Icon = current.icon;
        const key = current.key ? ` (${current.key})` : '';
        return (
          <div key={gi} className={cn('relative', (gi === 2 || gi === 7 || gi === 10) && 'mt-1.5')}>
            <button
              type="button"
              aria-label={`${current.name}${key}`}
              title={`${current.name}${key}${group.length > 1 ? ' — right-click for more' : ''}`}
              aria-pressed={on}
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
              className={cn('relative grid size-8 place-items-center rounded-[3px] text-[#d6d6d6]', on ? 'bg-[#1f1f1f] text-white' : 'hover:bg-[#4a4a4a]', FOCUS)}
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
      <div className="mt-2 flex flex-col items-center gap-1">
        <div className="relative size-9">
          <button
            type="button"
            aria-label="Stroke (X)"
            title="Stroke (X)"
            onClick={() => onActive('stroke')}
            className={cn('absolute right-0 bottom-0 size-6 border border-[#111]', active === 'stroke' ? 'z-10' : 'z-0', FOCUS)}
            style={chip(stroke)}
          >
            <span className="absolute inset-[5px] border border-[#111] bg-[#323232]" />
            {(!stroke || stroke.kind === 'none') && slash}
          </button>
          <button
            type="button"
            aria-label="Fill (X)"
            title="Fill (X)"
            onClick={() => onActive('fill')}
            className={cn('absolute top-0 left-0 size-6 border border-[#111]', active === 'fill' ? 'z-10' : 'z-0', FOCUS)}
            style={chip(fill)}
          >
            {(!fill || fill.kind === 'none') && slash}
          </button>
          <button type="button" aria-label="Swap fill and stroke (Shift+X)" title="Swap Fill and Stroke (Shift+X)" onClick={onSwap} className={cn('absolute -top-0.5 -right-1 z-20 grid size-3.5 place-items-center text-[9px] text-[#cfcfcf]', FOCUS)}>
            ⤡
          </button>
          <button type="button" aria-label="Default fill and stroke (D)" title="Default Fill and Stroke (D)" onClick={onDefault} className={cn('absolute -bottom-0.5 -left-1 z-20 grid size-3.5 place-items-center', FOCUS)}>
            <span className="relative block size-2.5">
              <span className="absolute right-0 bottom-0 size-1.5 border border-black bg-[#323232]" />
              <span className="absolute top-0 left-0 size-1.5 border border-[#888] bg-white" />
            </span>
          </button>
        </div>
        <div className="flex gap-0.5">
          <button type="button" aria-label="Formatting affects container" title="Formatting affects container" aria-pressed={!affectsText} onClick={() => onAffectsText(false)} className={cn('grid size-4 place-items-center rounded-[2px] text-[9px]', !affectsText ? 'bg-[#1f1f1f] text-white' : 'text-[#9a9a9a]', FOCUS)}>
            ▢
          </button>
          <button type="button" aria-label="Formatting affects text" title="Formatting affects text" aria-pressed={affectsText} onClick={() => onAffectsText(true)} className={cn('grid size-4 place-items-center rounded-[2px] text-[10px] font-bold', affectsText ? 'bg-[#1f1f1f] text-white' : 'text-[#9a9a9a]', FOCUS)}>
            T
          </button>
        </div>
        <div className="flex gap-0.5">
          <button type="button" aria-label="Apply color (,)" title="Apply Color (,)" onClick={() => onApply('color')} className={cn('size-3 border border-[#111]', FOCUS)} style={{ background: '#3a76c4' }} />
          <button type="button" aria-label="Apply gradient (.)" title="Apply Gradient (.)" onClick={() => onApply('gradient')} className={cn('size-3 border border-[#111]', FOCUS)} style={{ background: 'linear-gradient(to right, #fff, #000)' }} />
          <button type="button" aria-label="Apply none (/)" title="Apply None (/)" onClick={() => onApply('none')} className={cn('relative size-3 border border-[#111] bg-white', FOCUS)}>
            {slash}
          </button>
        </div>
        <div className="mt-1 flex gap-0.5">
          <button type="button" aria-label="Normal view" title="Normal (W)" aria-pressed={!preview} onClick={() => onPreview(false)} className={cn('grid size-4 place-items-center rounded-[2px]', !preview ? 'bg-[#1f1f1f]' : '', FOCUS)}>
            <span className="block size-2.5 border border-dashed border-[#cfcfcf]" />
          </button>
          <button type="button" aria-label="Preview" title="Preview (W)" aria-pressed={preview} onClick={() => onPreview(true)} className={cn('grid size-4 place-items-center rounded-[2px]', preview ? 'bg-[#1f1f1f]' : '', FOCUS)}>
            <span className="block size-2.5 bg-[#cfcfcf]" />
          </button>
        </div>
      </div>
    </div>
  );
}
