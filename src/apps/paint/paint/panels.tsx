import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS, RAISED, SUNKEN } from './styles';
import { MIXER } from './effects';
import { PixelIcon } from './icons';
import { TOOLS, type FillMode, type Tool } from './tools';
import { patternFn } from './patterns';
import {
  FONT_SIZES,
  FONTS,
  PALETTES,
  PATTERNS,
  STAMP_SIZES,
  STAMPS,
  WACKY,
  type PatternId,
  type WackyId,
} from './presets';
import { brushMask, pack, Surface, TRANSPARENT, type BrushShape, type Color } from './raster';

export function ToolBox({ tool, onTool }: { tool: Tool; onTool: (t: Tool) => void }) {
  return (
    <div role="toolbar" aria-label="Tools" aria-orientation="vertical" className="grid grid-cols-2">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-label={t.name}
          aria-pressed={tool === t.id}
          title={`${t.name}${t.key ? ` (${t.key.toUpperCase()})` : ''}`}
          onClick={() => onTool(t.id)}
          className={cn(
            'grid size-[26px] place-items-center',
            tool === t.id
              ? cn(SUNKEN, 'bg-[repeating-conic-gradient(#ffffff_0_25%,#c0c0c0_0_50%)] bg-[length:2px_2px]')
              : RAISED,
            FOCUS,
          )}
        >
          <PixelIcon name={t.id} />
        </button>
      ))}
    </div>
  );
}

function Option({
  label,
  selected,
  onClick,
  children,
  className,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn('grid place-items-center', selected ? 'bg-[#000080] text-white' : 'text-black', FOCUS, className)}
    >
      {children}
    </button>
  );
}

function MaskPreview({ size, shape, color }: { size: number; shape: BrushShape; color: string }) {
  const cells = brushMask(size, shape);
  const half = Math.floor((size - 1) / 2);
  return (
    <svg width={12} height={12} viewBox="-6 -6 12 12" shapeRendering="crispEdges" aria-hidden>
      {shape === 'square'
        ? <rect x={-half} y={-half} width={size} height={size} fill={color} />
        : cells.map(([x, y]) => <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} fill={color} />)}
    </svg>
  );
}

export interface ToolOptions {
  brush: { size: number; shape: BrushShape };
  eraserSize: number;
  lineWidth: number;
  sprayRadius: number;
  fillMode: FillMode;
  selectTransparent: boolean;
}

const BRUSHES: { size: number; shape: BrushShape }[] = [
  { size: 7, shape: 'round' }, { size: 4, shape: 'round' }, { size: 1, shape: 'round' },
  { size: 8, shape: 'square' }, { size: 5, shape: 'square' }, { size: 2, shape: 'square' },
  { size: 8, shape: 'slash' }, { size: 5, shape: 'slash' }, { size: 2, shape: 'slash' },
  { size: 8, shape: 'backslash' }, { size: 5, shape: 'backslash' }, { size: 2, shape: 'backslash' },
];

/** The little box under the tools, with the current tool's sizes and styles. */
export function OptionsBox({
  tool,
  options,
  zoom,
  onChange,
  onZoom,
}: {
  tool: Tool;
  options: ToolOptions;
  zoom: number;
  onChange: (patch: Partial<ToolOptions>) => void;
  onZoom: (z: number) => void;
}) {
  const fg = (selected: boolean) => (selected ? '#ffffff' : '#000000');
  let body: React.ReactNode = null;
  if (tool === 'brush') {
    body = (
      <div className="grid grid-cols-3 gap-px p-0.5">
        {BRUSHES.map((b) => {
          const on = options.brush.size === b.size && options.brush.shape === b.shape;
          return (
            <Option key={`${b.shape}${b.size}`} label={`${b.shape} brush, ${b.size} px`} selected={on} onClick={() => onChange({ brush: b })} className="h-3.5">
              <MaskPreview size={b.size} shape={b.shape} color={fg(on)} />
            </Option>
          );
        })}
      </div>
    );
  } else if (tool === 'eraser') {
    body = (
      <div className="flex flex-col items-stretch gap-0.5 p-0.5">
        {[4, 6, 8, 10].map((s) => (
          <Option key={s} label={`${s} px eraser`} selected={options.eraserSize === s} onClick={() => onChange({ eraserSize: s })} className="h-3.5">
            <span className="block" style={{ width: s, height: s, background: fg(options.eraserSize === s) }} />
          </Option>
        ))}
      </div>
    );
  } else if (tool === 'line' || tool === 'curve') {
    body = (
      <div className="flex flex-col items-stretch gap-0.5 p-0.5">
        {[1, 2, 3, 4, 5].map((w) => (
          <Option key={w} label={`${w} px line`} selected={options.lineWidth === w} onClick={() => onChange({ lineWidth: w })} className="h-3">
            <span className="block w-8" style={{ height: w, background: fg(options.lineWidth === w) }} />
          </Option>
        ))}
      </div>
    );
  } else if (tool === 'airbrush') {
    body = (
      <div className="flex flex-col items-stretch gap-0.5 p-0.5">
        {[4, 8, 12].map((r) => (
          <Option key={r} label={`${r} px spray`} selected={options.sprayRadius === r} onClick={() => onChange({ sprayRadius: r })} className="h-5">
            <span
              className="block rounded-full"
              style={{
                width: r + 4,
                height: r + 4,
                backgroundImage: `radial-gradient(${fg(options.sprayRadius === r)} 0.6px, transparent 0.8px)`,
                backgroundSize: '3px 3px',
              }}
            />
          </Option>
        ))}
      </div>
    );
  } else if (tool === 'rect' || tool === 'ellipse' || tool === 'roundrect' || tool === 'polygon') {
    const modes: { id: FillMode; label: string }[] = [
      { id: 'outline', label: 'Outline' },
      { id: 'both', label: 'Outline and fill' },
      { id: 'fill', label: 'Fill only' },
    ];
    body = (
      <div className="flex flex-col items-stretch gap-0.5 p-0.5">
        {modes.map((m) => {
          const on = options.fillMode === m.id;
          return (
            <Option key={m.id} label={m.label} selected={on} onClick={() => onChange({ fillMode: m.id })} className="h-4">
              <span
                className="block h-2.5 w-8"
                style={{
                  border: m.id === 'fill' ? 'none' : `1px solid ${fg(on)}`,
                  background: m.id === 'outline' ? 'transparent' : '#808080',
                }}
              />
            </Option>
          );
        })}
      </div>
    );
  } else if (tool === 'select') {
    body = (
      <div className="flex flex-col items-stretch gap-0.5 p-0.5">
        {[false, true].map((t) => (
          <Option
            key={String(t)}
            label={t ? 'Transparent selection (background color shows through)' : 'Opaque selection'}
            selected={options.selectTransparent === t}
            onClick={() => onChange({ selectTransparent: t })}
            className="h-6"
          >
            <svg width={28} height={18} viewBox="0 0 28 18" shapeRendering="crispEdges" aria-hidden>
              {!t && <rect x={1} y={1} width={26} height={16} fill="#ffffff" stroke="#000" />}
              <circle cx={10} cy={9} r={5} fill="#ff0000" />
              <rect x={14} y={4} width={9} height={10} fill="#0000ff" />
            </svg>
          </Option>
        ))}
      </div>
    );
  } else if (tool === 'magnifier') {
    body = (
      <div className="flex flex-col items-stretch p-0.5">
        {[1, 2, 6, 8].map((z) => (
          <Option key={z} label={`${z}× zoom`} selected={zoom === z} onClick={() => onZoom(z)} className="h-3.5 text-[11px] leading-none">
            {z}x
          </Option>
        ))}
      </div>
    );
  }
  return (
    <div className={cn('mx-auto mt-1 h-[70px] w-[48px] overflow-hidden bg-[#c0c0c0]', SUNKEN, 'p-[2px]')}>
      {body}
    </div>
  );
}

function Swatch({
  color,
  label,
  onPick,
  onEdit,
}: {
  color: Color;
  label: string;
  onPick: (secondary: boolean) => void;
  onEdit?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — click for foreground, right-click for background${onEdit ? ', double-click to change' : ''}`}
      onClick={() => onPick(false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onPick(true);
      }}
      onDoubleClick={onEdit}
      className={cn('size-4 p-0', SUNKEN, FOCUS)}
    >
      <span
        className="block size-full border border-transparent"
        style={
          color === TRANSPARENT
            ? { background: 'repeating-conic-gradient(#c0c0c0 0 25%, #ffffff 0 50%) 0 0 / 6px 6px' }
            : { background: color }
        }
      />
    </button>
  );
}

const CHECKER = 'repeating-conic-gradient(#c0c0c0 0 25%, #ffffff 0 50%) 0 0 / 8px 8px';

/** The two current colors, and the palette to pick new ones from. */
export function ColorBox({
  primary,
  secondary,
  palette,
  paletteId,
  onPick,
  onSwap,
  onEditSwatch,
  onPalette,
}: {
  primary: Color;
  secondary: Color;
  palette: Color[];
  paletteId: string;
  onPick: (color: Color, secondary: boolean) => void;
  onSwap: () => void;
  onEditSwatch: (index: number) => void;
  onPalette: (id: string) => void;
}) {
  const rows = palette.length > 16 ? 2 : palette.length > 8 ? 2 : 1;
  const cols = Math.ceil((palette.length + 1) / rows);
  return (
    <div className="flex items-center gap-1.5">
      <div className={cn('relative size-[34px] shrink-0', SUNKEN)} style={{ background: 'repeating-conic-gradient(#ffffff 0 25%, #c0c0c0 0 50%) 0 0 / 2px 2px' }}>
        <button
          type="button"
          onClick={onSwap}
          aria-label="Swap colors (X)"
          title="Swap colors (X)"
          className={cn('absolute right-0.5 bottom-0.5 size-[15px]', RAISED, FOCUS)}
          style={{ background: secondary === TRANSPARENT ? CHECKER : secondary }}
        />
        <button
          type="button"
          onClick={onSwap}
          aria-label="Foreground color"
          title="Foreground color — click to swap"
          className={cn('absolute top-0.5 left-0.5 size-[15px]', RAISED, FOCUS)}
          style={{ background: primary === TRANSPARENT ? CHECKER : primary }}
        />
      </div>
      <div className="grid gap-0" style={{ gridTemplateColumns: `repeat(${cols}, 16px)` }}>
        <Swatch color={TRANSPARENT} label="See-through" onPick={(s) => onPick(TRANSPARENT, s)} />
        {palette.map((c, i) => (
          <Swatch key={i} color={c} label={c} onPick={(s) => onPick(c, s)} onEdit={() => onEditSwatch(i)} />
        ))}
      </div>
      <select
        value={paletteId}
        onChange={(e) => onPalette(e.target.value)}
        aria-label="Palette"
        title="Palette"
        className={cn('ml-1 h-[21px] bg-white px-1 text-black outline-none', FIELD, FOCUS)}
      >
        {PALETTES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function PatternSwatch({ id, fg, bg }: { id: PatternId; fg: Color; bg: Color }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    const s = new Surface(24, 24);
    s.fillRect(0, 0, 24, 24, patternFn(id, pack(fg), pack(bg), 24));
    c.putImageData(s.image, 0, 0);
  }, [id, fg, bg]);
  return (
    <canvas
      ref={ref}
      width={24}
      height={24}
      className="size-6"
      style={{ imageRendering: 'pixelated', background: CHECKER }}
    />
  );
}

function TrayButton({
  label,
  selected,
  onClick,
  children,
  className,
}: {
  label: string;
  selected?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'grid shrink-0 place-items-center bg-[#c0c0c0] motion-safe:transition-transform motion-safe:active:scale-90',
        selected ? cn(SUNKEN, 'bg-[#ffffe0]') : RAISED,
        FOCUS,
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface TraySettings {
  wacky: WackyId;
  stamp: string;
  stampGroup: number;
  stampSize: number;
  pattern: PatternId;
  mixer: string;
  font: string;
  fontSize: number;
  bold: boolean;
  crisp: boolean;
}

const SELECT = cn('h-[21px] bg-white px-1 text-black outline-none', FIELD, FOCUS);

/**
 * The Kid Pix drawer along the bottom: stamps, wacky brushes, the mixer's
 * tricks, fill patterns and the text tool's fonts.
 */
export function Tray({
  tool,
  settings,
  primary,
  secondary,
  onChange,
  onMix,
}: {
  tool: Tool;
  settings: TraySettings;
  primary: Color;
  secondary: Color;
  onChange: (patch: Partial<TraySettings>) => void;
  onMix: (id: string) => void;
}) {
  const crisp = (
    <label className="flex shrink-0 items-center gap-1 whitespace-nowrap" title="Hard pixel edges, no smoothing">
      <input type="checkbox" checked={settings.crisp} onChange={(e) => onChange({ crisp: e.target.checked })} className="accent-[#000080]" />
      Crisp pixels
    </label>
  );
  let body: React.ReactNode;
  switch (tool) {
    case 'stamp': {
      const group = STAMPS[settings.stampGroup] ?? STAMPS[0];
      body = (
        <>
          <select value={settings.stampGroup} onChange={(e) => onChange({ stampGroup: Number(e.target.value) })} aria-label="Stamp set" className={SELECT}>
            {STAMPS.map((g, i) => (
              <option key={g.name} value={i}>
                {g.name}
              </option>
            ))}
          </select>
          <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto py-0.5">
            {group.stamps.map((s) => (
              <TrayButton key={s} label={`Stamp ${s}`} selected={settings.stamp === s} onClick={() => onChange({ stamp: s })} className="size-8 text-xl leading-none">
                {s}
              </TrayButton>
            ))}
          </div>
          <select value={settings.stampSize} onChange={(e) => onChange({ stampSize: Number(e.target.value) })} aria-label="Stamp size" className={SELECT}>
            {STAMP_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>
          {crisp}
        </>
      );
      break;
    }
    case 'wacky':
      body = (
        <div className="flex min-w-0 flex-1 flex-wrap gap-0.5 py-0.5">
          {WACKY.map((w) => (
            <TrayButton key={w.id} label={w.name} selected={settings.wacky === w.id} onClick={() => onChange({ wacky: w.id })} className="h-8 gap-1 px-2 text-xs [grid-auto-flow:column]">
              <span className="text-lg leading-none">{w.emoji}</span>
              <span>{w.name}</span>
            </TrayButton>
          ))}
        </div>
      );
      break;
    case 'mixer':
      body = (
        <div className="flex min-w-0 flex-1 flex-wrap gap-0.5 py-0.5">
          {MIXER.map((m) => (
            <TrayButton
              key={m.id}
              label={m.name}
              selected={settings.mixer === m.id}
              onClick={() => {
                onChange({ mixer: m.id });
                onMix(m.id);
              }}
              className="h-8 gap-1 px-2 text-xs [grid-auto-flow:column]"
            >
              <span className="text-lg leading-none">{m.emoji}</span>
              <span className="whitespace-nowrap">{m.name}</span>
            </TrayButton>
          ))}
        </div>
      );
      break;
    case 'fill':
      body = (
        <div className="flex min-w-0 flex-1 flex-wrap gap-0.5 py-0.5">
          {PATTERNS.map((p) => (
            <TrayButton key={p.id} label={p.name} selected={settings.pattern === p.id} onClick={() => onChange({ pattern: p.id })} className="h-8 gap-1.5 px-1.5 text-xs [grid-auto-flow:column]">
              <PatternSwatch id={p.id} fg={primary} bg={secondary} />
              <span className="whitespace-nowrap">{p.name}</span>
            </TrayButton>
          ))}
        </div>
      );
      break;
    case 'text':
      body = (
        <>
          <select value={settings.font} onChange={(e) => onChange({ font: e.target.value })} aria-label="Font" className={SELECT}>
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select value={settings.fontSize} onChange={(e) => onChange({ fontSize: Number(e.target.value) })} aria-label="Font size" className={SELECT}>
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <TrayButton label="Bold" selected={settings.bold} onClick={() => onChange({ bold: !settings.bold })} className="h-[22px] w-6 font-bold">
            B
          </TrayButton>
          {crisp}
          <span className="truncate text-[#404040]">Text is drawn in the foreground color.</span>
        </>
      );
      break;
    case 'dynamite':
      body = <span className="py-2">💥 Click the picture to blow it all away. Don’t worry, Undo puts it back.</span>;
      break;
    default:
      return null;
  }
  return <div className="flex min-h-10 items-center gap-2 border-t border-t-white px-1.5 py-0.5">{body}</div>;
}
