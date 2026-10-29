import { useState } from 'react';
import { ArrowLeftRight, Bold, Check, Italic, TextAlignCenter, TextAlignEnd, TextAlignStart, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox, IconButton, NumberField, Select } from './chrome';
import { FOCUS } from './styles';
import type { GradientKind } from './paint';
import type { SelectMode } from './selection';
import { FONTS, TOOL_GROUPS, toolInfo, type BrushOptions, type ToolId, type ToolOptions } from './tools';
import type { Box } from './view';

// ---- Toolbar ---------------------------------------------------------------------

export function Toolbar({
  tool,
  choice,
  onTool,
  fg,
  bg,
  onSwap,
  onDefault,
  onEditColor,
}: {
  tool: ToolId;
  /** Which tool each multi-tool slot shows. */
  choice: Record<number, ToolId>;
  onTool: (t: ToolId) => void;
  fg: string;
  bg: string;
  onSwap: () => void;
  onDefault: () => void;
  onEditColor: (which: 'fg' | 'bg') => void;
}) {
  const [flyout, setFlyout] = useState<number | null>(null);
  return (
    <div className="relative flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-[#232323] bg-[#323232] py-1.5" role="toolbar" aria-label="Tools" aria-orientation="vertical">
      {TOOL_GROUPS.map((group, gi) => {
        const shown = group.find((t) => t.id === choice[gi]) ?? group[0];
        const active = group.some((t) => t.id === tool);
        const current = active ? toolInfo(tool) : shown;
        const Icon = current.icon;
        return (
          <div key={gi} className="relative">
            <button
              type="button"
              aria-label={`${current.name} (${current.key})`}
              title={`${current.name} (${current.key})${group.length > 1 ? ' — right-click for more' : ''}`}
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
              className={cn(
                'relative grid size-8 place-items-center rounded-[3px] text-[#d6d6d6]',
                active ? 'bg-[#1f1f1f] text-white' : 'hover:bg-[#4a4a4a]',
                FOCUS,
              )}
            >
              <Icon className="size-[18px]" />
              {group.length > 1 && (
                <svg className="absolute right-0.5 bottom-0.5 size-1.5 text-[#9a9a9a]" viewBox="0 0 4 4" aria-hidden>
                  <path d="M4 0V4H0Z" fill="currentColor" />
                </svg>
              )}
            </button>
            {flyout === gi && (
              <div
                role="menu"
                className="absolute top-0 left-full z-40 ml-1 w-56 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 shadow-xl shadow-black/40"
                onPointerLeave={() => setFlyout(null)}
              >
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
            aria-label="Set background color"
            title="Set background color"
            onClick={() => onEditColor('bg')}
            className={cn('absolute right-0 bottom-0 size-5 border border-[#111] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.4)]', FOCUS)}
            style={{ background: bg }}
          />
          <button
            type="button"
            aria-label="Set foreground color"
            title="Set foreground color"
            onClick={() => onEditColor('fg')}
            className={cn('absolute top-0 left-0 size-5 border border-[#111] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.4)]', FOCUS)}
            style={{ background: fg }}
          />
        </div>
        <div className="flex gap-0.5">
          <button type="button" aria-label="Default colors (D)" title="Default Foreground and Background Colors (D)" onClick={onDefault} className={cn('grid size-4 place-items-center', FOCUS)}>
            <span className="relative block size-3">
              <span className="absolute right-0 bottom-0 size-2 border border-black bg-white" />
              <span className="absolute top-0 left-0 size-2 border border-white bg-black" />
            </span>
          </button>
          <button type="button" aria-label="Swap colors (X)" title="Switch Foreground and Background Colors (X)" onClick={onSwap} className={cn('grid size-4 place-items-center text-[#cfcfcf]', FOCUS)}>
            <ArrowLeftRight className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Options bar -----------------------------------------------------------------------

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-[#232323]" />;
}

function BrushFields({ o, set, flow = true, hardness = true }: { o: BrushOptions; set: (p: Partial<BrushOptions>) => void; flow?: boolean; hardness?: boolean }) {
  return (
    <>
      <NumberField label="Size:" title="Size ([ and ])" value={o.size} min={1} max={2500} unit="px" width="w-16" onChange={(v) => set({ size: v })} />
      {hardness && <NumberField label="Hardness:" title="Hardness (Shift+[ and Shift+])" value={o.hardness} min={0} max={100} unit="%" onChange={(v) => set({ hardness: v })} />}
      <Divider />
      <NumberField label="Opacity:" title="Opacity (number keys)" value={o.opacity} min={1} max={100} unit="%" onChange={(v) => set({ opacity: v })} />
      {flow && <NumberField label="Flow:" title="Flow (Shift+number keys)" value={o.flow} min={1} max={100} unit="%" onChange={(v) => set({ flow: v })} />}
    </>
  );
}

const MODE_LABELS: [SelectMode, string, string][] = [
  ['replace', 'New selection', '▢'],
  ['add', 'Add to selection (Shift)', '⊕'],
  ['subtract', 'Subtract from selection (Alt)', '⊖'],
  ['intersect', 'Intersect with selection (Shift+Alt)', '⊗'],
];

function SelectModes({ mode, onMode }: { mode: SelectMode; onMode: (m: SelectMode) => void }) {
  return (
    <span className="flex items-center gap-0.5" role="radiogroup" aria-label="Selection mode">
      {MODE_LABELS.map(([m, label, glyph]) => (
        <IconButton key={m} label={label} pressed={mode === m} onClick={() => onMode(m)} role="radio" aria-checked={mode === m} className="text-sm">
          {glyph}
        </IconButton>
      ))}
    </span>
  );
}

export interface TransformControls {
  box: Box;
  onBox: (b: Box) => void;
  base: { w: number; h: number };
  onCommit: () => void;
  onCancel: () => void;
}

export function OptionsBar({
  tool,
  options,
  setOptions,
  transform,
  crop,
  typing,
  onTypeCommit,
  onTypeCancel,
}: {
  tool: ToolId;
  options: ToolOptions;
  setOptions: (fn: (o: ToolOptions) => ToolOptions) => void;
  transform: TransformControls | null;
  crop: { onCommit: () => void; onCancel: () => void; size: { w: number; h: number } } | null;
  typing: boolean;
  onTypeCommit: () => void;
  onTypeCancel: () => void;
}) {
  const set = <K extends keyof ToolOptions>(k: K, p: Partial<ToolOptions[K]>) =>
    setOptions((o) => ({ ...o, [k]: typeof o[k] === 'object' ? { ...(o[k] as object), ...p } : p }));
  const info = toolInfo(tool);
  const Icon = info.icon;

  let body: React.ReactNode = null;
  if (transform) {
    const { box, onBox, base } = transform;
    body = (
      <>
        <span className="text-xs text-[#bdbdbd]">Free Transform</span>
        <Divider />
        <NumberField label="X:" value={Math.round(box.cx)} unit="px" width="w-16" onChange={(v) => onBox({ ...box, cx: v })} />
        <NumberField label="Y:" value={Math.round(box.cy)} unit="px" width="w-16" onChange={(v) => onBox({ ...box, cy: v })} />
        <Divider />
        <NumberField label="W:" value={Math.round((box.w / base.w) * 1000) / 10} decimals={1} unit="%" width="w-16" onChange={(v) => onBox({ ...box, w: Math.max(1, (v / 100) * base.w) })} />
        <NumberField label="H:" value={Math.round((box.h / base.h) * 1000) / 10} decimals={1} unit="%" width="w-16" onChange={(v) => onBox({ ...box, h: Math.max(1, (v / 100) * base.h) })} />
        <Divider />
        <NumberField label="∠" title="Rotate" value={Math.round(((box.angle * 180) / Math.PI) * 10) / 10} decimals={1} unit="°" width="w-16" onChange={(v) => onBox({ ...box, angle: (v * Math.PI) / 180 })} />
        <span className="flex-1" />
        <IconButton label="Cancel transform (Esc)" onClick={transform.onCancel}>
          <X className="size-4" />
        </IconButton>
        <IconButton label="Commit transform (Enter)" onClick={transform.onCommit}>
          <Check className="size-4" />
        </IconButton>
      </>
    );
  } else if (tool === 'brush' || tool === 'pencil' || tool === 'eraser') {
    body = <BrushFields o={options[tool]} set={(p) => set(tool, p)} hardness={tool !== 'pencil'} flow={tool !== 'pencil'} />;
  } else if (tool === 'clone') {
    body = (
      <>
        <BrushFields o={options.clone} set={(p) => set('clone', p)} />
        <Divider />
        <Checkbox checked={options.clone.aligned} onChange={(v) => set('clone', { aligned: v })}>
          Aligned
        </Checkbox>
        <Checkbox checked={options.clone.sampleAll} onChange={(v) => set('clone', { sampleAll: v })}>
          Sample All Layers
        </Checkbox>
        <span className="ml-2 text-xs text-[#9a9a9a]">Alt+click to set the source</span>
      </>
    );
  } else if (tool === 'marquee' || tool === 'ellipse-marquee' || tool === 'lasso' || tool === 'polygon-lasso') {
    body = (
      <>
        <SelectModes mode={options.selectMode} onMode={(m) => setOptions((o) => ({ ...o, selectMode: m }))} />
        <Divider />
        <NumberField label="Feather:" value={options.feather} min={0} max={250} unit="px" onChange={(v) => setOptions((o) => ({ ...o, feather: v }))} />
      </>
    );
  } else if (tool === 'wand') {
    body = (
      <>
        <SelectModes mode={options.selectMode} onMode={(m) => setOptions((o) => ({ ...o, selectMode: m }))} />
        <Divider />
        <NumberField label="Tolerance:" value={options.wand.tolerance} min={0} max={255} onChange={(v) => set('wand', { tolerance: v })} />
        <Checkbox checked={options.wand.contiguous} onChange={(v) => set('wand', { contiguous: v })}>
          Contiguous
        </Checkbox>
        <Checkbox checked={options.wand.sampleAll} onChange={(v) => set('wand', { sampleAll: v })}>
          Sample All Layers
        </Checkbox>
      </>
    );
  } else if (tool === 'bucket') {
    body = (
      <>
        <NumberField label="Opacity:" value={options.bucket.opacity} min={1} max={100} unit="%" onChange={(v) => set('bucket', { opacity: v })} />
        <NumberField label="Tolerance:" value={options.bucket.tolerance} min={0} max={255} onChange={(v) => set('bucket', { tolerance: v })} />
        <Checkbox checked={options.bucket.contiguous} onChange={(v) => set('bucket', { contiguous: v })}>
          Contiguous
        </Checkbox>
        <Checkbox checked={options.bucket.sampleAll} onChange={(v) => set('bucket', { sampleAll: v })}>
          All Layers
        </Checkbox>
      </>
    );
  } else if (tool === 'gradient') {
    body = (
      <>
        <Select<'fg-bg' | 'fg-transparent'>
          label="Gradient colors"
          value={options.gradient.colors}
          onChange={(v) => set('gradient', { colors: v })}
          options={[
            ['fg-bg', 'Foreground to Background'],
            ['fg-transparent', 'Foreground to Transparent'],
          ]}
        />
        <Select<GradientKind>
          label="Gradient style"
          value={options.gradient.kind}
          onChange={(v) => set('gradient', { kind: v })}
          options={[
            ['linear', 'Linear'],
            ['radial', 'Radial'],
            ['angle', 'Angle'],
            ['reflected', 'Reflected'],
            ['diamond', 'Diamond'],
          ]}
        />
        <Divider />
        <NumberField label="Opacity:" value={options.gradient.opacity} min={1} max={100} unit="%" onChange={(v) => set('gradient', { opacity: v })} />
        <Checkbox checked={options.gradient.reverse} onChange={(v) => set('gradient', { reverse: v })}>
          Reverse
        </Checkbox>
      </>
    );
  } else if (tool === 'move') {
    body = (
      <>
        <Checkbox checked={options.move.autoSelect} onChange={(v) => set('move', { autoSelect: v })}>
          Auto-Select Layer
        </Checkbox>
        <span className="ml-2 text-xs text-[#9a9a9a]">Ctrl+click picks a layer · Alt+drag duplicates · arrows nudge</span>
      </>
    );
  } else if (tool === 'crop') {
    body = (
      <>
        {crop && (
          <span className="text-xs text-[#bdbdbd] tabular-nums">
            {crop.size.w} × {crop.size.h} px
          </span>
        )}
        <Divider />
        <Checkbox checked={options.crop.deletePixels} onChange={(v) => set('crop', { deletePixels: v })}>
          Delete Cropped Pixels
        </Checkbox>
        <span className="flex-1" />
        {crop && (
          <>
            <IconButton label="Cancel crop (Esc)" onClick={crop.onCancel}>
              <X className="size-4" />
            </IconButton>
            <IconButton label="Commit crop (Enter)" onClick={crop.onCommit}>
              <Check className="size-4" />
            </IconButton>
          </>
        )}
      </>
    );
  } else if (tool === 'type') {
    const t = options.type;
    body = (
      <>
        <Select
          label="Font family"
          value={t.font}
          onChange={(v) => set('type', { font: v })}
          options={(FONTS.includes(t.font) ? FONTS : [t.font, ...FONTS]).map((f) => [f, f] as const)}
          className="w-40"
        />
        <NumberField label="Size:" value={t.size} min={1} max={1296} step={1} unit="px" width="w-16" onChange={(v) => set('type', { size: v })} />
        <IconButton label="Bold" pressed={t.bold} onClick={() => set('type', { bold: !t.bold })}>
          <Bold className="size-4" />
        </IconButton>
        <IconButton label="Italic" pressed={t.italic} onClick={() => set('type', { italic: !t.italic })}>
          <Italic className="size-4" />
        </IconButton>
        <Divider />
        <IconButton label="Left align text" pressed={t.align === 'left'} onClick={() => set('type', { align: 'left' })}>
          <TextAlignStart className="size-4" />
        </IconButton>
        <IconButton label="Center text" pressed={t.align === 'center'} onClick={() => set('type', { align: 'center' })}>
          <TextAlignCenter className="size-4" />
        </IconButton>
        <IconButton label="Right align text" pressed={t.align === 'right'} onClick={() => set('type', { align: 'right' })}>
          <TextAlignEnd className="size-4" />
        </IconButton>
        <span className="ml-2 text-xs text-[#9a9a9a]">Color: the foreground color</span>
        <span className="flex-1" />
        {typing && (
          <>
            <IconButton label="Cancel edits (Esc)" onClick={onTypeCancel}>
              <X className="size-4" />
            </IconButton>
            <IconButton label="Commit (Ctrl+Enter)" onClick={onTypeCommit}>
              <Check className="size-4" />
            </IconButton>
          </>
        )}
      </>
    );
  } else if (tool === 'eyedropper') {
    body = (
      <Checkbox checked={options.eyedropper.sampleAll} onChange={(v) => set('eyedropper', { sampleAll: v })}>
        Sample All Layers
      </Checkbox>
    );
  } else if (tool === 'rectangle' || tool === 'ellipse') {
    body = <span className="text-xs text-[#9a9a9a]">Fills a new layer with the foreground color · Shift for a square or circle · Alt draws from the middle</span>;
  } else if (tool === 'hand') {
    body = <span className="text-xs text-[#9a9a9a]">Drag to scroll · hold Space with any tool</span>;
  } else if (tool === 'zoom') {
    body = <span className="text-xs text-[#9a9a9a]">Click to zoom in · Alt+click to zoom out · Ctrl+scroll anywhere</span>;
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b border-[#232323] bg-[#383838] px-2" role="toolbar" aria-label="Tool options">
      <span className="grid size-7 shrink-0 place-items-center rounded-[3px] bg-[#2a2a2a] text-[#e0e0e0]" title={info.name}>
        <Icon className="size-4" />
      </span>
      <Divider />
      {body}
    </div>
  );
}
