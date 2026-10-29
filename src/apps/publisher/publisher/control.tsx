import {
  Baseline,
  FlipHorizontal2,
  FlipVertical2,
  Link2,
  RotateCcw,
  RotateCw,
  Strikethrough,
  Subscript,
  Superscript,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline,
  Unlink2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton, Select } from '@/shared/photo/chrome';
import type { Swatches } from './colors';
import { ComboField, LengthField, NumField } from './fields';
import { ProxyIcon } from './icons';
import type { CharLook, ParaLook, StyleInfo } from './styles';
import { SwatchButton } from './swatch';
import type { Attrs } from './text';
import type { Unit } from './units';

/**
 * InDesign's Control panel, under the menus: for objects, the reference
 * point, position, size, scale, rotation and shear, flips, fill and stroke
 * and opacity, fitting buttons for graphics frames; with the Type tool, the
 * character and paragraph formatting controls.
 */

export interface ObjectInfo {
  count: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  shear: number;
  sx: number;
  sy: number;
  fill: string | null | undefined;
  stroke: string | null | undefined;
  weight: number | null;
  strokeType: string | null;
  opacity: number | null;
  /** A graphics frame with something in it. */
  hasContent: boolean;
  textFrame: boolean;
  columns: number | null;
  /** The selection is content (direct selection). */
  content: boolean;
}

export interface Geometry {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  rotation?: number;
  shear?: number;
  sx?: number;
  sy?: number;
}

export interface TypeInfo {
  char: CharLook;
  para: ParaLook;
  fonts: string[];
  styles: string[];
  paraStyles: StyleInfo[];
  charStyles: StyleInfo[];
}

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-[#232323]" />;
}

function Stack({ children }: { children: React.ReactNode }) {
  return <span className="flex flex-col gap-0.5">{children}</span>;
}

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72];
const STROKES: readonly (readonly [string, string])[] = [
  ['StrokeStyle/$ID/Solid', 'Solid'],
  ['StrokeStyle/$ID/Dashed', 'Dashed'],
  ['StrokeStyle/$ID/Canned Dashed 3x2', 'Dashed (3 and 2)'],
  ['StrokeStyle/$ID/Canned Dashed 4x4', 'Dashed (4 and 4)'],
  ['StrokeStyle/$ID/Canned Dotted', 'Dotted'],
];

export function ControlPanel({
  mode,
  unit,
  refPoint,
  onRefPoint,
  obj,
  onGeometry,
  onAttrs,
  onOpacity,
  onTurn,
  onFit,
  onColumns,
  swatches,
  type,
  onChar,
  onPara,
  onParaStyle,
  onCharStyle,
  textFill,
  constrain,
  onConstrain,
}: {
  mode: 'object' | 'type' | 'none';
  unit: Unit;
  refPoint: [number, number];
  onRefPoint: (p: [number, number]) => void;
  obj: ObjectInfo | null;
  onGeometry: (g: Geometry) => void;
  onAttrs: (a: Attrs) => void;
  onOpacity: (v: number) => void;
  onTurn: (how: 'cw' | 'ccw' | 'flipH' | 'flipV') => void;
  onFit: (how: 'fill' | 'fit' | 'stretch' | 'center' | 'frameToContent') => void;
  onColumns: (n: number) => void;
  swatches: Swatches;
  type: TypeInfo | null;
  onChar: (a: Attrs) => void;
  onPara: (a: Attrs) => void;
  onParaStyle: (self: string) => void;
  onCharStyle: (self: string) => void;
  textFill: string | null;
  constrain: boolean;
  onConstrain: (v: boolean) => void;
}) {
  let body: React.ReactNode;
  if (mode === 'type' && type) {
    const c = type.char;
    const p = type.para;
    const toggle = (name: string, on: boolean, val: string, off: string) => onChar({ [name]: on ? off : val });
    const align = (j: string, label: string, icon: React.ReactNode) => (
      <IconButton label={label} pressed={p.justification === j} onClick={() => onPara({ Justification: j })} className="size-6">
        {icon}
      </IconButton>
    );
    body = (
      <>
        <Stack>
          <span className="flex items-center gap-1">
            <ComboField label="Font family" value={c.font} options={type.fonts} onChange={(v) => onChar({ AppliedFont: v })} width="w-[150px]" />
          </span>
          <span className="flex items-center gap-1">
            <ComboField label="Font style" value={c.fontStyle} options={type.styles} onChange={(v) => onChar({ FontStyle: v })} width="w-[150px]" />
          </span>
        </Stack>
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">tT</span>} title="Font size" value={c.size} suffix="pt" min={0.1} max={1296} step={1} options={SIZES} onChange={(v) => onChar({ PointSize: v })} />
          <NumField
            icon={<span className="w-4 text-[10px] font-semibold">A͟A</span>}
            title="Leading (blank for Auto)"
            value={c.leading ?? Math.round(c.size * c.autoLeading) / 100}
            suffix={c.leading === null ? 'pt (auto)' : 'pt'}
            min={0}
            max={5000}
            options={['Auto', ...SIZES.map((s) => Math.round(s * 1.2 * 10) / 10)]}
            onChange={(v) => onChar({ Leading: v })}
            onAuto={() => onChar({ Leading: 'Auto' })}
            width="w-[78px]"
          />
        </Stack>
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">VA</span>} title="Tracking" value={c.tracking} decimals={0} min={-1000} max={10000} step={10} onChange={(v) => onChar({ Tracking: v })} />
          <NumField icon={<Baseline className="size-3.5" />} title="Baseline shift" value={c.baselineShift} suffix="pt" min={-5000} max={5000} onChange={(v) => onChar({ BaselineShift: v })} />
        </Stack>
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">IT</span>} title="Vertical scale" value={c.vscale} suffix="%" decimals={1} min={1} max={1000} onChange={(v) => onChar({ VerticalScale: v })} />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">T</span>} title="Horizontal scale" value={c.hscale} suffix="%" decimals={1} min={1} max={1000} onChange={(v) => onChar({ HorizontalScale: v })} />
        </Stack>
        <Divider />
        <span className="grid grid-cols-3 gap-0.5">
          <IconButton label="All caps (Shift+Ctrl+K)" pressed={c.caps === 'AllCaps'} onClick={() => toggle('Capitalization', c.caps === 'AllCaps', 'AllCaps', 'Normal')} className="size-6 text-[10px] font-bold">
            TT
          </IconButton>
          <IconButton label="Superscript (Shift+Ctrl+=)" pressed={c.position === 'Superscript'} onClick={() => toggle('Position', c.position === 'Superscript', 'Superscript', 'Normal')} className="size-6">
            <Superscript className="size-3.5" />
          </IconButton>
          <IconButton label="Underline (Shift+Ctrl+U)" pressed={c.underline} onClick={() => onChar({ Underline: c.underline ? 'false' : 'true' })} className="size-6">
            <Underline className="size-3.5" />
          </IconButton>
          <IconButton label="Small caps (Shift+Ctrl+H)" pressed={c.caps === 'SmallCaps'} onClick={() => toggle('Capitalization', c.caps === 'SmallCaps', 'SmallCaps', 'Normal')} className="size-6 text-[10px] font-bold">
            Tт
          </IconButton>
          <IconButton label="Subscript (Alt+Shift+Ctrl+=)" pressed={c.position === 'Subscript'} onClick={() => toggle('Position', c.position === 'Subscript', 'Subscript', 'Normal')} className="size-6">
            <Subscript className="size-3.5" />
          </IconButton>
          <IconButton label="Strikethrough (Shift+Ctrl+/)" pressed={c.strike} onClick={() => onChar({ StrikeThru: c.strike ? 'false' : 'true' })} className="size-6">
            <Strikethrough className="size-3.5" />
          </IconButton>
        </span>
        <Divider />
        <Stack>
          <span className="flex items-center gap-1">
            <Select
              label="Character style"
              value={c.charStyle || 'CharacterStyle/$ID/[No character style]'}
              onChange={onCharStyle}
              options={type.charStyles.map((s) => [s.self, s.group ? `${s.group}: ${s.name}` : s.name] as const)}
              className="h-[22px] w-[150px] text-[11px]"
            />
          </span>
          <span className="flex items-center gap-1">
            <SwatchButton label="Text fill" value={textFill} swatches={swatches} onPick={(s) => onChar({ FillColor: s })} />
            <span className="text-[11px] text-[#9a9a9a]">Text color</span>
          </span>
        </Stack>
        <Divider />
        <span className="grid grid-cols-4 gap-0.5">
          {align('LeftAlign', 'Align left (Shift+Ctrl+L)', <TextAlignStart className="size-3.5" />)}
          {align('CenterAlign', 'Align center (Shift+Ctrl+C)', <TextAlignCenter className="size-3.5" />)}
          {align('RightAlign', 'Align right (Shift+Ctrl+R)', <TextAlignEnd className="size-3.5" />)}
          {align('FullyJustified', 'Justify all lines (Shift+Ctrl+F)', <TextAlignJustify className="size-3.5" />)}
          {align('LeftJustified', 'Justify with last line aligned left (Shift+Ctrl+J)', <JustifyIcon last="left" />)}
          {align('CenterJustified', 'Justify with last line aligned center', <JustifyIcon last="center" />)}
          {align('RightJustified', 'Justify with last line aligned right', <JustifyIcon last="right" />)}
          {align('ToBindingSide', 'Align towards spine', <SpineIcon />)}
        </span>
        <Divider />
        <Stack>
          <LengthField icon={<IndentGlyph kind="left" />} title="Left indent" value={p.leftIndent} unit={unit} onChange={(v) => onPara({ LeftIndent: v })} />
          <LengthField icon={<IndentGlyph kind="first" />} title="First line left indent" value={p.firstIndent} unit={unit} onChange={(v) => onPara({ FirstLineIndent: v })} />
        </Stack>
        <Stack>
          <LengthField icon={<IndentGlyph kind="right" />} title="Right indent" value={p.rightIndent} unit={unit} onChange={(v) => onPara({ RightIndent: v })} />
          <LengthField icon={<IndentGlyph kind="last" />} title="Last line right indent" value={p.lastIndent} unit={unit} onChange={(v) => onPara({ LastLineIndent: v })} />
        </Stack>
        <Stack>
          <LengthField icon={<SpaceGlyph before />} title="Space before" value={p.spaceBefore} unit={unit} min={0} onChange={(v) => onPara({ SpaceBefore: v })} />
          <LengthField icon={<SpaceGlyph />} title="Space after" value={p.spaceAfter} unit={unit} min={0} onChange={(v) => onPara({ SpaceAfter: v })} />
        </Stack>
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">A≡</span>} title="Drop cap number of lines" value={p.dropLines} decimals={0} min={0} max={25} onChange={(v) => onPara({ DropCapLines: Math.round(v) })} width="w-[44px]" />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">A+</span>} title="Drop cap one or more characters" value={p.dropChars} decimals={0} min={0} max={150} onChange={(v) => onPara({ DropCapCharacters: Math.round(v) })} width="w-[44px]" />
        </Stack>
        <Divider />
        <Stack>
          <Select
            label="Paragraph style"
            value={p.style}
            onChange={onParaStyle}
            options={type.paraStyles.map((s) => [s.self, s.group ? `${s.group}: ${s.name}` : s.name] as const)}
            className="h-[22px] w-[160px] text-[11px]"
          />
          <span className="flex items-center gap-0.5">
            <IconButton label="Bulleted list" pressed={p.list === 'BulletList'} onClick={() => onPara({ BulletsAndNumberingListType: p.list === 'BulletList' ? 'NoList' : 'BulletList' })} className="size-6 text-[13px]">
              •≡
            </IconButton>
            <IconButton label="Numbered list" pressed={p.list === 'NumberedList'} onClick={() => onPara({ BulletsAndNumberingListType: p.list === 'NumberedList' ? 'NoList' : 'NumberedList' })} className="size-6 text-[11px]">
              1≡
            </IconButton>
          </span>
        </Stack>
      </>
    );
  } else if (mode === 'object' && obj) {
    body = (
      <>
        <ProxyIcon value={refPoint} onChange={onRefPoint} />
        <Divider />
        <Stack>
          <LengthField label="X:" value={obj.x} unit={unit} onChange={(v) => onGeometry({ x: v })} />
          <LengthField label="Y:" value={obj.y} unit={unit} onChange={(v) => onGeometry({ y: v })} />
        </Stack>
        <Stack>
          <LengthField label="W:" value={obj.w} unit={unit} min={0} onChange={(v) => onGeometry({ w: v })} />
          <LengthField label="H:" value={obj.h} unit={unit} min={0} onChange={(v) => onGeometry({ h: v })} />
        </Stack>
        <IconButton label={constrain ? 'Constrain proportions: on' : 'Constrain proportions: off'} pressed={constrain} onClick={() => onConstrain(!constrain)} className="size-6">
          {constrain ? <Link2 className="size-3.5" /> : <Unlink2 className="size-3.5" />}
        </IconButton>
        <Divider />
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⇔</span>} title="Scale X percentage" value={obj.sx} suffix="%" decimals={1} min={0.1} max={10000} onChange={(v) => onGeometry({ sx: v })} width="w-[64px]" />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⇕</span>} title="Scale Y percentage" value={obj.sy} suffix="%" decimals={1} min={0.1} max={10000} onChange={(v) => onGeometry({ sy: v })} width="w-[64px]" />
        </Stack>
        <Stack>
          <NumField icon={<RotateCcw className="size-3" />} title="Rotation angle" value={obj.rotation} suffix="°" decimals={1} min={-360} max={360} onChange={(v) => onGeometry({ rotation: v })} width="w-[64px]" />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⧄</span>} title="Shear X angle" value={obj.shear} suffix="°" decimals={1} min={-89} max={89} onChange={(v) => onGeometry({ shear: v })} width="w-[64px]" />
        </Stack>
        <span className="grid grid-cols-2 gap-0.5">
          <IconButton label="Rotate 90° clockwise" onClick={() => onTurn('cw')} className="size-6">
            <RotateCw className="size-3.5" />
          </IconButton>
          <IconButton label="Flip horizontal" onClick={() => onTurn('flipH')} className="size-6">
            <FlipHorizontal2 className="size-3.5" />
          </IconButton>
          <IconButton label="Rotate 90° counterclockwise" onClick={() => onTurn('ccw')} className="size-6">
            <RotateCcw className="size-3.5" />
          </IconButton>
          <IconButton label="Flip vertical" onClick={() => onTurn('flipV')} className="size-6">
            <FlipVertical2 className="size-3.5" />
          </IconButton>
        </span>
        <Divider />
        <Stack>
          <span className="flex items-center gap-1">
            <span className="w-8 text-[11px] text-[#bdbdbd]">Fill</span>
            <SwatchButton label="Fill" value={obj.fill} swatches={swatches} onPick={(s) => onAttrs({ FillColor: s })} />
          </span>
          <span className="flex items-center gap-1">
            <span className="w-8 text-[11px] text-[#bdbdbd]">Stroke</span>
            <SwatchButton label="Stroke" value={obj.stroke} swatches={swatches} onPick={(s) => onAttrs({ StrokeColor: s })} stroke />
          </span>
        </Stack>
        <Stack>
          <NumField title="Stroke weight" value={obj.weight} suffix="pt" min={0} max={1000} step={0.25} decimals={3} options={[0, 0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100]} onChange={(v) => onAttrs({ StrokeWeight: v })} width="w-[64px]" />
          <Select
            label="Stroke type"
            value={obj.strokeType ?? 'StrokeStyle/$ID/Solid'}
            onChange={(v) => onAttrs({ StrokeType: v })}
            options={STROKES.some((s) => s[0] === obj.strokeType) || !obj.strokeType ? STROKES : [[obj.strokeType, obj.strokeType.replace(/^StrokeStyle\/(\$ID\/)?/, '')] as const, ...STROKES]}
            className="h-[22px] w-[90px] text-[11px]"
          />
        </Stack>
        <Divider />
        <NumField icon={<span className="text-[11px]">Opacity:</span>} title="Opacity" value={obj.opacity} suffix="%" decimals={0} min={0} max={100} options={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]} onChange={onOpacity} width="w-[60px]" />
        {obj.hasContent && (
          <>
            <Divider />
            <span className="flex items-center gap-0.5" role="group" aria-label="Fitting">
              <IconButton label="Fill frame proportionally (Alt+Shift+Ctrl+C)" onClick={() => onFit('fill')} className="size-6">
                <FitGlyph kind="fill" />
              </IconButton>
              <IconButton label="Fit content proportionally (Alt+Shift+Ctrl+E)" onClick={() => onFit('fit')} className="size-6">
                <FitGlyph kind="fit" />
              </IconButton>
              <IconButton label="Fit frame to content (Alt+Ctrl+C)" onClick={() => onFit('frameToContent')} className="size-6">
                <FitGlyph kind="frame" />
              </IconButton>
              <IconButton label="Fit content to frame (Alt+Ctrl+E)" onClick={() => onFit('stretch')} className="size-6">
                <FitGlyph kind="stretch" />
              </IconButton>
              <IconButton label="Center content (Shift+Ctrl+E)" onClick={() => onFit('center')} className="size-6">
                <FitGlyph kind="center" />
              </IconButton>
            </span>
          </>
        )}
        {obj.textFrame && obj.columns !== null && (
          <>
            <Divider />
            <NumField icon={<span className="text-[11px]">Columns:</span>} title="Number of columns" value={obj.columns} decimals={0} min={1} max={40} onChange={(v) => onColumns(Math.round(v))} width="w-[44px]" />
          </>
        )}
      </>
    );
  } else {
    // Nothing selected: InDesign keeps the fields, empty.
    body = (
      <>
        <ProxyIcon value={refPoint} onChange={onRefPoint} />
        <Divider />
        <Stack>
          <LengthField label="X:" value={null} unit={unit} onChange={() => {}} disabled />
          <LengthField label="Y:" value={null} unit={unit} onChange={() => {}} disabled />
        </Stack>
        <Stack>
          <LengthField label="W:" value={null} unit={unit} onChange={() => {}} disabled />
          <LengthField label="H:" value={null} unit={unit} onChange={() => {}} disabled />
        </Stack>
        <Divider />
        <Stack>
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⇔</span>} title="Scale X percentage" value={null} onChange={() => {}} disabled width="w-[64px]" />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⇕</span>} title="Scale Y percentage" value={null} onChange={() => {}} disabled width="w-[64px]" />
        </Stack>
        <Stack>
          <NumField icon={<RotateCcw className="size-3" />} title="Rotation angle" value={null} onChange={() => {}} disabled width="w-[64px]" />
          <NumField icon={<span className="w-4 text-[10px] font-semibold">⧄</span>} title="Shear X angle" value={null} onChange={() => {}} disabled width="w-[64px]" />
        </Stack>
      </>
    );
  }
  return (
    <div className="flex h-[58px] shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden border-b border-[#232323] bg-[#383838] px-2" role="toolbar" aria-label="Control">
      {body}
    </div>
  );
}

function JustifyIcon({ last }: { last: 'left' | 'center' | 'right' }) {
  const x = last === 'left' ? 4 : last === 'center' ? 7 : 10;
  return (
    <svg viewBox="0 0 20 20" className="size-3.5" aria-hidden>
      <path d="M3 4h14M3 8h14M3 12h14" stroke="currentColor" strokeWidth="1.6" />
      <path d={`M${x - 1} 16h7`} stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function SpineIcon() {
  return (
    <svg viewBox="0 0 20 20" className="size-3.5" aria-hidden>
      <path d="M3 4h10M3 8h12M3 12h9M3 16h11" stroke="currentColor" strokeWidth="1.6" />
      <path d="M17.5 3v14" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function IndentGlyph({ kind }: { kind: 'left' | 'right' | 'first' | 'last' }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      {kind === 'left' && <path d="M5 4h9M5 7h9M5 10h9M5 13h9M2 5v7" stroke="currentColor" strokeWidth="1.2" fill="none" />}
      {kind === 'right' && <path d="M2 4h9M2 7h9M2 10h9M2 13h9M14 5v7" stroke="currentColor" strokeWidth="1.2" fill="none" />}
      {kind === 'first' && <path d="M6 4h8M2 7h12M2 10h12M2 13h12" stroke="currentColor" strokeWidth="1.2" fill="none" />}
      {kind === 'last' && <path d="M2 4h12M2 7h12M2 10h12M2 13h8" stroke="currentColor" strokeWidth="1.2" fill="none" />}
    </svg>
  );
}

function SpaceGlyph({ before }: { before?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
      {before ? <path d="M2 2h12M2 9h12M2 12h12M2 15h12M8 3v4" stroke="currentColor" strokeWidth="1.2" fill="none" /> : <path d="M2 1h12M2 4h12M2 7h12M2 14h12M8 9v4" stroke="currentColor" strokeWidth="1.2" fill="none" />}
    </svg>
  );
}

function FitGlyph({ kind }: { kind: 'fill' | 'fit' | 'frame' | 'stretch' | 'center' }) {
  return (
    <svg viewBox="0 0 18 18" className={cn('size-4')} aria-hidden>
      <rect x="3" y="4" width="12" height="10" fill="none" stroke="currentColor" strokeWidth="1" />
      {kind === 'fill' && <rect x="1.5" y="2.5" width="15" height="13" fill="currentColor" opacity="0.45" />}
      {kind === 'fit' && <rect x="5" y="4" width="8" height="10" fill="currentColor" opacity="0.6" />}
      {kind === 'frame' && <path d="M1 1l3 3M17 1l-3 3M1 17l3-3M17 17l-3-3" stroke="currentColor" strokeWidth="1" />}
      {kind === 'stretch' && <rect x="3" y="4" width="12" height="10" fill="currentColor" opacity="0.6" />}
      {kind === 'center' && <rect x="6.5" y="6.5" width="5" height="5" fill="currentColor" opacity="0.7" />}
    </svg>
  );
}
