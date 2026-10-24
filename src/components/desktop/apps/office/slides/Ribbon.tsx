import { useRef, useState } from 'react';
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FlipHorizontal2,
  FlipVertical2,
  Group,
  Italic,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  PaintBucket,
  Paintbrush,
  PenLine,
  RemoveFormatting,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  Search,
  SendToBack,
  SquareDashedMousePointer,
  Strikethrough,

  Underline,
  Ungroup,
  ALargeSmall,
  CaseSensitive,
  Subscript,
  Superscript,
  Hash,
  Calendar,
  PanelBottom,
  Grid3x3,
  StickyNote,
  Maximize,
  ZoomIn,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  BigButton,
  ColorButton,
  ColorPalette,
  FontBox,
  FontColorGlyph,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTile,
  Ribbon,
  RibbonGroup,
  Row,
  RowSep,
  SizeBox,
  SmallButton,
  Spinner,
  Stack,
  SubMenu,
  type PickedColor,
} from '../chrome';
import { FONT_SIZES } from '../fonts';
import type { Theme } from '../theme';
import {
  ArrangeIcon,
  BackgroundIcon,
  HideSlideIcon,
  LayoutIcon,
  NewSlideIcon,
  NormalViewIcon,
  PictureIcon,
  QuickStylesIcon,
  ResetIcon,
  SectionIcon,
  ShapeGlyph,
  ShapesIcon,
  ShowIcon,
  SlideSizeIcon,
  SorterIcon,
  TableIcon,
  TextBoxIcon,
  TransitionIcon,
} from './icons';
import { EMU_PER_INCH, type Layout, type SlideCtx, type Transition, type Xfrm } from './model';
import { DESIGNS, type DesignTheme } from './newDeck';
import { QUICK_SHAPES, SHAPE_GROUPS } from './shapes';
import { SlideImage } from './render';
import { COLOR_SETS, FONT_SETS } from './themes';

/**
 * PowerPoint's ribbon: Home, Insert, Design, Transitions, Slide Show and
 * View, plus Shape Format or Picture Format while a shape or picture is
 * selected, with Office's groups, names and order.
 */

export interface FormatState {
  font: string;
  size: number | null;
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  baseline: number;
  algn: string;
  bullet: 'none' | 'char' | 'auto';
  anchor: string;
}

export type CaseKind = 'sentence' | 'lower' | 'upper' | 'title' | 'toggle';
export type Align = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'distH' | 'distV';

export interface RibbonCommands {
  paste: () => void;
  cut: () => void;
  copy: () => void;
  formatPainter: () => void;
  newSlide: (layout?: string) => void;
  duplicateSlides: () => void;
  deleteSlides: () => void;
  setLayout: (layout: string) => void;
  resetSlide: () => void;
  font: (name: string) => void;
  size: (pt: number) => void;
  grow: (dir: 1 | -1) => void;
  clearFormatting: () => void;
  toggle: (k: 'b' | 'i' | 'u' | 'strike') => void;
  baseline: (v: number) => void;
  fontColor: (c: PickedColor | null) => void;
  changeCase: (k: CaseKind) => void;
  spacing: (spc: number) => void;
  bullets: (b: { char: string; font: string } | null) => void;
  numbering: (scheme: string | null) => void;
  level: (dir: 1 | -1) => void;
  lineSpacing: (v: number) => void;
  align: (a: string) => void;
  anchor: (a: string) => void;
  tool: (prst: string) => void;
  textBox: () => void;
  picture: () => void;
  table: (rows: number, cols: number) => void;
  slideNumber: () => void;
  headerFooter: () => void;
  dateTime: () => void;
  order: (o: 'front' | 'back' | 'forward' | 'backward') => void;
  alignShapes: (a: Align) => void;
  group: () => void;
  ungroup: () => void;
  rotate: (k: 'r90' | 'l90' | 'flipV' | 'flipH') => void;
  fill: (c: PickedColor | null) => void;
  outline: (c: PickedColor | null) => void;
  outlineWeight: (w: number) => void;
  outlineDash: (d: string) => void;
  arrows: (k: 'none' | 'end' | 'start' | 'both') => void;
  quickStyle: (accent: number, kind: 'fill' | 'outline' | 'subtle' | 'intense') => void;
  find: () => void;
  replace: () => void;
  selectAll: () => void;
  design: (d: DesignTheme) => void;
  colors: (name: string) => void;
  fonts: (major: string, minor: string) => void;
  slideSize: (wide: boolean) => void;
  background: (c: PickedColor | null) => void;
  backgroundPicture: () => void;
  backgroundAll: () => void;
  transition: (type: string, dir?: string) => void;
  transitionDuration: (ms: number) => void;
  transitionAll: () => void;
  advance: (onClick: boolean, after: number | null) => void;
  preview: () => void;
  show: (fromCurrent: boolean) => void;
  hideSlide: () => void;
  view: (v: 'normal' | 'sorter') => void;
  notes: () => void;
  gridlines: () => void;
  zoom: () => void;
  fit: () => void;
  boxSize: (dim: 'w' | 'h', emu: number) => void;
  resetPicture: () => void;
}

export interface RibbonState {
  tab: string;
  theme: Theme;
  layouts: Layout[];
  layoutCtx: (l: Layout) => SlideCtx | null;
  currentLayout: string;
  fmt: FormatState;
  sel: 'none' | 'shape' | 'picture' | 'multi';
  canGroup: boolean;
  canUngroup: boolean;
  box: Xfrm | null;
  hidden: boolean;
  transition?: Transition;
  view: 'normal' | 'sorter';
  notes: boolean;
  gridlines: boolean;
  fontColor: string;
  fillColor: string;
  lineColor: string;
  wide: boolean;
  painter: boolean;
  isLine: boolean;
  /** The window's width, for collapsing groups as PowerPoint does when it's narrow. */
  width: number;
}

function LayoutGallery({ state, onPick, label }: { state: RibbonState; onPick: (part: string) => void; label: string }) {
  return (
    <div className="w-[396px] p-1">
      <MenuLabel>{label}</MenuLabel>
      <div className="grid grid-cols-3 gap-2 p-1">
        {state.layouts.map((l) => {
          const ctx = state.layoutCtx(l);
          return (
            <MenuTile
              key={l.part}
              onSelect={() => onPick(l.part)}
              className={cn(
                'flex cursor-pointer flex-col items-center gap-1 rounded-[3px] p-1 outline-none data-[highlighted]:bg-[#fbe5de]',
                l.part === state.currentLayout && 'bg-[#f6d3c8]',
              )}
            >
              <span className="block overflow-hidden border border-[#c8c8c8] bg-white">{ctx && <SlideImage ctx={ctx} width={112} />}</span>
              <span className="w-[112px] truncate text-center text-[11px]">{l.name}</span>
            </MenuTile>
          );
        })}
      </div>
    </div>
  );
}

function ShapeGallery({ onPick }: { onPick: (prst: string) => void }) {
  return (
    <div className="w-[300px] p-1">
      {SHAPE_GROUPS.map((g) => (
        <div key={g.name}>
          <MenuLabel>{g.name}</MenuLabel>
          <div className="flex flex-wrap px-1">
            {g.shapes.map(([prst, name]) => (
              <MenuTile key={prst} title={name} aria-label={name} onSelect={() => onPick(prst)} className="grid size-6 cursor-pointer place-items-center rounded-[3px] outline-none data-[highlighted]:bg-[#e8e8e8]">
                <ShapeGlyph prst={prst} />
              </MenuTile>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The ribbon's in-place shapes gallery: a grid of the common ones, and More for all. */
function QuickShapes({ onPick }: { onPick: (prst: string) => void }) {
  const name = (prst: string) => SHAPE_GROUPS.flatMap((g) => g.shapes).find(([p]) => p === prst)?.[1] ?? prst;
  return (
    <div className="flex items-start gap-0.5">
      <div className="grid h-[72px] grid-cols-6 gap-px overflow-hidden rounded-[3px] border border-[#e0e0e0] bg-white p-0.5">
        {QUICK_SHAPES.map((prst) => (
          <button key={prst} type="button" title={name(prst)} aria-label={name(prst)} onClick={() => onPick(prst)} className="grid size-[22px] place-items-center rounded-[2px] hover:bg-[#e8e8e8]">
            <ShapeGlyph prst={prst} size={18} />
          </button>
        ))}
      </div>
      <SmallButton label="More Shapes" icon={<ShapesIcon className="size-4" />} menu={<ShapeGallery onPick={onPick} />} className="h-[72px]" />
    </div>
  );
}

function TableGrid({ onPick }: { onPick: (r: number, c: number) => void }) {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return (
    <div className="p-2">
      <div className="pb-1.5 text-[12px] text-[#424242]">{hover[0] ? `${hover[1]}x${hover[0]} Table` : 'Insert Table'}</div>
      <div className="grid grid-cols-10 gap-[3px]" onMouseLeave={() => setHover([0, 0])}>
        {Array.from({ length: 8 }, (_, r) =>
          Array.from({ length: 10 }, (_, c) => (
            <MenuTile
              key={`${r}-${c}`}
              onMouseEnter={() => setHover([r + 1, c + 1])}
              onFocus={() => setHover([r + 1, c + 1])}
              onSelect={() => onPick(r + 1, c + 1)}
              aria-label={`${c + 1} by ${r + 1} table`}
              className={cn('size-[15px] cursor-pointer border outline-none', r < hover[0] && c < hover[1] ? 'border-[#c43e1c] bg-[#fbe0d8]' : 'border-[#bdbdbd] bg-white')}
            />
          )),
        )}
      </div>
    </div>
  );
}

const BULLETS: { label: string; char: string; font: string; shown: string }[] = [
  { label: 'Filled Round Bullets', char: '•', font: 'Arial', shown: '•' },
  { label: 'Hollow Round Bullets', char: 'o', font: 'Courier New', shown: 'o' },
  { label: 'Filled Square Bullets', char: '§', font: 'Wingdings', shown: '▪' },
  { label: 'Hollow Square Bullets', char: 'q', font: 'Wingdings', shown: '❑' },
  { label: 'Star Bullets', char: 'v', font: 'Wingdings', shown: '❖' },
  { label: 'Arrow Bullets', char: 'Ø', font: 'Wingdings', shown: '➢' },
  { label: 'Checkmark Bullets', char: 'ü', font: 'Wingdings', shown: '✓' },
];

const NUMBERING: [string, string][] = [
  ['arabicPeriod', '1.  2.  3.'],
  ['arabicParenR', '1)  2)  3)'],
  ['romanUcPeriod', 'I.  II.  III.'],
  ['alphaUcPeriod', 'A.  B.  C.'],
  ['alphaLcParenR', 'a)  b)  c)'],
  ['alphaLcPeriod', 'a.  b.  c.'],
  ['romanLcPeriod', 'i.  ii.  iii.'],
];

const WEIGHTS: [number, string][] = [[3175, '¼ pt'], [6350, '½ pt'], [9525, '¾ pt'], [12700, '1 pt'], [19050, '1½ pt'], [28575, '2¼ pt'], [38100, '3 pt'], [57150, '4½ pt'], [76200, '6 pt']];
const DASHES: [string, string, string][] = [
  ['solid', 'Solid', ''],
  ['sysDot', 'Round Dot', '1 2'],
  ['sysDash', 'Square Dot', '2 1'],
  ['dash', 'Dash', '5 3'],
  ['dashDot', 'Dash Dot', '5 3 1 3'],
  ['lgDash', 'Long Dash', '9 3'],
  ['lgDashDot', 'Long Dash Dot', '9 3 1 3'],
  ['lgDashDotDot', 'Long Dash Dot Dot', '9 3 1 3 1 3'],
];

const TRANSITIONS: [string, string][] = [['none', 'None'], ['cut', 'Cut'], ['fade', 'Fade'], ['push', 'Push'], ['wipe', 'Wipe'], ['cover', 'Cover']];

function ArrangeMenu({ cmd, state }: { cmd: RibbonCommands; state: RibbonState }) {
  const shape = state.sel !== 'none';
  return (
    <>
      <MenuLabel>Order Objects</MenuLabel>
      <MenuItem icon={<BringToFront />} disabled={!shape} onSelect={() => cmd.order('front')}>Bring to Front</MenuItem>
      <MenuItem icon={<SendToBack />} disabled={!shape} onSelect={() => cmd.order('back')}>Send to Back</MenuItem>
      <MenuItem icon={<ArrowUpToLine />} disabled={!shape} onSelect={() => cmd.order('forward')}>Bring Forward</MenuItem>
      <MenuItem icon={<ArrowDownToLine />} disabled={!shape} onSelect={() => cmd.order('backward')}>Send Backward</MenuItem>
      <MenuSeparator />
      <MenuLabel>Group Objects</MenuLabel>
      <MenuItem icon={<Group />} disabled={!state.canGroup} onSelect={cmd.group} shortcut="Ctrl+G">Group</MenuItem>
      <MenuItem icon={<Ungroup />} disabled={!state.canUngroup} onSelect={cmd.ungroup} shortcut="Ctrl+Shift+G">Ungroup</MenuItem>
      <MenuSeparator />
      <MenuLabel>Position Objects</MenuLabel>
      <SubMenu label="Align" icon={<AlignStartVertical />}>
        <AlignItems cmd={cmd} disabled={!shape} />
      </SubMenu>
      <SubMenu label="Rotate" icon={<RotateCw />}>
        <RotateItems cmd={cmd} disabled={!shape} />
      </SubMenu>
    </>
  );
}

function AlignItems({ cmd, disabled }: { cmd: RibbonCommands; disabled: boolean }) {
  return (
    <>
      <MenuItem icon={<AlignStartVertical />} disabled={disabled} onSelect={() => cmd.alignShapes('left')}>Align Left</MenuItem>
      <MenuItem icon={<AlignCenterVertical />} disabled={disabled} onSelect={() => cmd.alignShapes('center')}>Align Center</MenuItem>
      <MenuItem icon={<AlignEndVertical />} disabled={disabled} onSelect={() => cmd.alignShapes('right')}>Align Right</MenuItem>
      <MenuItem icon={<AlignStartHorizontal />} disabled={disabled} onSelect={() => cmd.alignShapes('top')}>Align Top</MenuItem>
      <MenuItem icon={<AlignCenterHorizontal />} disabled={disabled} onSelect={() => cmd.alignShapes('middle')}>Align Middle</MenuItem>
      <MenuItem icon={<AlignEndHorizontal />} disabled={disabled} onSelect={() => cmd.alignShapes('bottom')}>Align Bottom</MenuItem>
      <MenuSeparator />
      <MenuItem icon={<AlignHorizontalDistributeCenter />} disabled={disabled} onSelect={() => cmd.alignShapes('distH')}>Distribute Horizontally</MenuItem>
      <MenuItem icon={<AlignVerticalDistributeCenter />} disabled={disabled} onSelect={() => cmd.alignShapes('distV')}>Distribute Vertically</MenuItem>
    </>
  );
}

function RotateItems({ cmd, disabled }: { cmd: RibbonCommands; disabled: boolean }) {
  return (
    <>
      <MenuItem icon={<RotateCw />} disabled={disabled} onSelect={() => cmd.rotate('r90')}>Rotate Right 90°</MenuItem>
      <MenuItem icon={<RotateCcw />} disabled={disabled} onSelect={() => cmd.rotate('l90')}>Rotate Left 90°</MenuItem>
      <MenuItem icon={<FlipVertical2 />} disabled={disabled} onSelect={() => cmd.rotate('flipV')}>Flip Vertical</MenuItem>
      <MenuItem icon={<FlipHorizontal2 />} disabled={disabled} onSelect={() => cmd.rotate('flipH')}>Flip Horizontal</MenuItem>
    </>
  );
}

/** A palette whose More Colors… opens the system color picker. */
function PaletteWithMore({ theme, onPick, none, automatic }: { theme: Theme; onPick: (c: PickedColor | null) => void; none?: string; automatic?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <ColorPalette theme={theme} onPick={onPick} none={none} automatic={automatic} onMore={() => setTimeout(() => input.current?.click(), 50)} />
      <input ref={input} type="color" tabIndex={-1} aria-hidden className="pointer-events-none absolute size-0 opacity-0" onChange={(e) => onPick({ hex: e.target.value.slice(1).toUpperCase() })} />
    </>
  );
}

function OutlineMenu({ cmd, state }: { cmd: RibbonCommands; state: RibbonState }) {
  return (
    <>
      <PaletteWithMore theme={state.theme} onPick={cmd.outline} none="No Outline" />
      <MenuSeparator />
      <SubMenu label="Weight" icon={<PenLine />}>
        {WEIGHTS.map(([w, label]) => (
          <MenuItem key={w} onSelect={() => cmd.outlineWeight(w)}>
            <span className="flex items-center gap-3">
              <span className="w-10 text-[11.5px]">{label}</span>
              <span className="block w-24 bg-[#242424]" style={{ height: Math.max(1, (w / 12700) * 1.33) }} />
            </span>
          </MenuItem>
        ))}
      </SubMenu>
      <SubMenu label="Dashes" icon={<PenLine />}>
        {DASHES.map(([d, label, arr]) => (
          <MenuItem key={d} onSelect={() => cmd.outlineDash(d)} title={label}>
            <svg width="120" height="8" aria-label={label}>
              <line x1="0" y1="4" x2="120" y2="4" stroke="#242424" strokeWidth="2" strokeDasharray={arr || undefined} />
            </svg>
          </MenuItem>
        ))}
      </SubMenu>
      {state.isLine && (
        <SubMenu label="Arrows" icon={<PenLine />}>
          <MenuItem onSelect={() => cmd.arrows('none')}>No Arrows</MenuItem>
          <MenuItem onSelect={() => cmd.arrows('end')}>Arrow at End</MenuItem>
          <MenuItem onSelect={() => cmd.arrows('start')}>Arrow at Start</MenuItem>
          <MenuItem onSelect={() => cmd.arrows('both')}>Arrows at Both Ends</MenuItem>
        </SubMenu>
      )}
    </>
  );
}

function QuickStyleGallery({ cmd, theme }: { cmd: RibbonCommands; theme: Theme }) {
  const kinds: ['outline' | 'fill' | 'subtle' | 'intense', string][] = [['outline', 'Colored Outline'], ['fill', 'Colored Fill'], ['subtle', 'Subtle Effect'], ['intense', 'Intense Effect']];
  return (
    <div className="p-1">
      <MenuLabel>Theme Styles</MenuLabel>
      <div className="grid grid-cols-6 gap-1.5 p-1">
        {kinds.map(([kind, label]) =>
          [1, 2, 3, 4, 5, 6].map((n) => {
            const c = `#${theme.colors[`accent${n}` as 'accent1']}`;
            const style =
              kind === 'outline' ? { background: '#fff', border: `1.5px solid ${c}`, color: c }
                : kind === 'fill' ? { background: c, border: `1.5px solid ${c}`, color: '#fff', filter: 'saturate(0.95)' }
                  : kind === 'subtle' ? { background: `color-mix(in srgb, ${c} 20%, white)`, border: `1px solid ${c}`, color: '#242424' }
                    : { background: c, color: '#fff', boxShadow: '0 2px 3px rgba(0,0,0,0.35)', fontWeight: 600 };
            return (
              <MenuTile key={`${kind}${n}`} title={`${label} - Accent ${n}`} aria-label={`${label} - Accent ${n}`} onSelect={() => cmd.quickStyle(n, kind)} className="grid h-8 w-11 cursor-pointer place-items-center rounded-[2px] text-[13px] outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-[#f4b183]" style={style}>
                Abc
              </MenuTile>
            );
          }),
        )}
      </div>
    </div>
  );
}

function SizeGroup({ cmd, state }: { cmd: RibbonCommands; state: RibbonState }) {
  const box = state.box;
  return (
    <RibbonGroup label="Size">
      <Stack className="pt-1">
        <span className="flex h-7 items-center gap-1.5 text-[12px] text-[#424242]">
          <span className="w-12">Height:</span>
          <Spinner value={box ? box.h / EMU_PER_INCH : 0} onChange={(v) => cmd.boxSize('h', v * EMU_PER_INCH)} min={0} max={56} step={0.1} decimals={2} unit={'"'} width={78} label="Shape Height" />
        </span>
        <span className="flex h-7 items-center gap-1.5 text-[12px] text-[#424242]">
          <span className="w-12">Width:</span>
          <Spinner value={box ? box.w / EMU_PER_INCH : 0} onChange={(v) => cmd.boxSize('w', v * EMU_PER_INCH)} min={0} max={56} step={0.1} decimals={2} unit={'"'} width={78} label="Shape Width" />
        </span>
      </Stack>
    </RibbonGroup>
  );
}

function ArrangeGroup({ cmd, state }: { cmd: RibbonCommands; state: RibbonState }) {
  const shape = state.sel !== 'none';
  return (
    <RibbonGroup label="Arrange">
      <Stack>
        <SmallButton icon={<ArrowUpToLine />} label="Bring Forward" text="Bring Forward" disabled={!shape} onClick={() => cmd.order('forward')} split menu={<><MenuItem onSelect={() => cmd.order('forward')}>Bring Forward</MenuItem><MenuItem onSelect={() => cmd.order('front')}>Bring to Front</MenuItem></>} />
        <SmallButton icon={<ArrowDownToLine />} label="Send Backward" text="Send Backward" disabled={!shape} onClick={() => cmd.order('backward')} split menu={<><MenuItem onSelect={() => cmd.order('backward')}>Send Backward</MenuItem><MenuItem onSelect={() => cmd.order('back')}>Send to Back</MenuItem></>} />
      </Stack>
      <Stack>
        <SmallButton icon={<AlignStartVertical />} label="Align" text="Align" disabled={!shape} menu={<AlignItems cmd={cmd} disabled={!shape} />} />
        <SmallButton icon={<Group />} label="Group" text="Group" disabled={!state.canGroup && !state.canUngroup} menu={<><MenuItem icon={<Group />} disabled={!state.canGroup} onSelect={cmd.group}>Group</MenuItem><MenuItem icon={<Ungroup />} disabled={!state.canUngroup} onSelect={cmd.ungroup}>Ungroup</MenuItem></>} />
        <SmallButton icon={<RotateCw />} label="Rotate" text="Rotate" disabled={!shape} menu={<RotateItems cmd={cmd} disabled={!shape} />} />
      </Stack>
    </RibbonGroup>
  );
}

export function SlidesRibbon({ state, cmd, collapsed }: { state: RibbonState; cmd: RibbonCommands; collapsed: boolean }) {
  const f = state.fmt;
  const shape = state.sel !== 'none';
  const layoutMenu = (label: string, pick: (p: string) => void) => <LayoutGallery state={state} onPick={pick} label={label} />;
  const t = state.transition;
  const compact = state.width < 1360;
  const tight = state.width < 1160;
  switch (state.tab) {
    case 'home':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Clipboard">
            <BigButton icon={<ClipboardPaste />} label="Paste" tip="Paste (Ctrl+V)" onClick={cmd.paste} />
            <Stack>
              <SmallButton icon={<Scissors />} label="Cut" tip="Cut (Ctrl+X)" text={tight ? undefined : 'Cut'} onClick={cmd.cut} />
              <SmallButton icon={<Copy />} label="Copy" tip="Copy (Ctrl+C)" text={tight ? undefined : 'Copy'} onClick={cmd.copy} />
              <SmallButton icon={<Paintbrush />} label="Format Painter" text={tight ? undefined : 'Format Painter'} pressed={state.painter} disabled={!shape && !state.painter} onClick={cmd.formatPainter} />
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Slides">
            <BigButton icon={<NewSlideIcon />} label="New Slide" tip="New Slide (Ctrl+M)" split onClick={() => cmd.newSlide()} menu={<>{layoutMenu('Office Theme', (p) => cmd.newSlide(p))}<MenuSeparator /><MenuItem icon={<CopyPlus />} onSelect={cmd.duplicateSlides}>Duplicate Selected Slides</MenuItem></>} menuClassName="max-h-[80vh]" />
            <Stack>
              <SmallButton icon={<LayoutIcon />} label="Layout" text={tight ? undefined : 'Layout'} menu={layoutMenu('Office Theme', cmd.setLayout)} />
              <SmallButton icon={<ResetIcon />} label="Reset" tip="Reset the position, size, and formatting of the slide placeholders to their default settings." text={tight ? undefined : 'Reset'} onClick={cmd.resetSlide} />
              <SmallButton icon={<SectionIcon />} label="Delete" tip="Delete Slide" text={tight ? undefined : 'Delete'} onClick={cmd.deleteSlides} />
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Font">
            <Stack>
              <Row>
                <FontBox value={f.font} onCommit={cmd.font} theme={state.theme} width={136} />
                <SizeBox value={f.size === null ? '' : String(f.size)} onCommit={cmd.size} sizes={FONT_SIZES} />
                <SmallButton icon={<ALargeSmall />} label="Increase Font Size" tip="Increase Font Size (Ctrl+Shift+>)" onClick={() => cmd.grow(1)} />
                <SmallButton icon={<ALargeSmall className="scale-75" />} label="Decrease Font Size" tip="Decrease Font Size (Ctrl+Shift+<)" onClick={() => cmd.grow(-1)} />
                <RowSep />
                <SmallButton icon={<RemoveFormatting />} label="Clear All Formatting" tip="Clear All Formatting (Ctrl+Space)" onClick={cmd.clearFormatting} />
              </Row>
              <Row>
                <SmallButton icon={<Bold />} label="Bold" tip="Bold (Ctrl+B)" pressed={f.b} onClick={() => cmd.toggle('b')} />
                <SmallButton icon={<Italic />} label="Italic" tip="Italic (Ctrl+I)" pressed={f.i} onClick={() => cmd.toggle('i')} />
                <SmallButton icon={<Underline />} label="Underline" tip="Underline (Ctrl+U)" pressed={f.u} onClick={() => cmd.toggle('u')} />
                <SmallButton icon={<Strikethrough />} label="Strikethrough" pressed={f.strike} onClick={() => cmd.toggle('strike')} />
                <SmallButton icon={<Subscript />} label="Subscript" tip="Subscript (Ctrl+=)" pressed={f.baseline < 0} onClick={() => cmd.baseline(f.baseline < 0 ? 0 : -25000)} />
                <SmallButton icon={<Superscript />} label="Superscript" tip="Superscript (Ctrl+Shift++)" pressed={f.baseline > 0} onClick={() => cmd.baseline(f.baseline > 0 ? 0 : 30000)} />
                <SmallButton
                  icon={<span className="text-[11px] font-semibold tracking-[0.12em]">AV</span>}
                  label="Character Spacing"
                  menu={<>{([[-300, 'Very Tight'], [-150, 'Tight'], [0, 'Normal'], [300, 'Loose'], [600, 'Very Loose']] as [number, string][]).map(([v, l]) => <MenuItem key={v} onSelect={() => cmd.spacing(v)}>{l}</MenuItem>)}</>}
                />
                <SmallButton
                  icon={<CaseSensitive />}
                  label="Change Case"
                  menu={<><MenuItem onSelect={() => cmd.changeCase('sentence')}>Sentence case.</MenuItem><MenuItem onSelect={() => cmd.changeCase('lower')}>lowercase</MenuItem><MenuItem onSelect={() => cmd.changeCase('upper')}>UPPERCASE</MenuItem><MenuItem onSelect={() => cmd.changeCase('title')}>Capitalize Each Word</MenuItem><MenuItem onSelect={() => cmd.changeCase('toggle')}>tOGGLE cASE</MenuItem></>}
                />
                <RowSep />
                <ColorButton icon={<FontColorGlyph />} label="Font Color" color={state.fontColor} onApply={cmd.fontColor} theme={state.theme} automatic="Automatic" />
              </Row>
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Paragraph">
            <Stack>
              <Row>
                <SmallButton icon={<List />} label="Bullets" pressed={f.bullet === 'char'} split onClick={() => cmd.bullets(f.bullet === 'char' ? null : BULLETS[0])} menu={<><MenuItem onSelect={() => cmd.bullets(null)}>None</MenuItem>{BULLETS.map((b) => <MenuItem key={b.label} onSelect={() => cmd.bullets(b)}><span className="flex items-center gap-3"><span className="w-4 text-center text-[16px]">{b.shown}</span>{b.label}</span></MenuItem>)}</>} />
                <SmallButton icon={<ListOrdered />} label="Numbering" pressed={f.bullet === 'auto'} split onClick={() => cmd.numbering(f.bullet === 'auto' ? null : 'arabicPeriod')} menu={<><MenuItem onSelect={() => cmd.numbering(null)}>None</MenuItem>{NUMBERING.map(([s, l]) => <MenuItem key={s} onSelect={() => cmd.numbering(s)}>{l}</MenuItem>)}</>} />
                <RowSep />
                <SmallButton icon={<ListIndentDecrease />} label="Decrease List Level" tip="Decrease List Level (Shift+Tab)" onClick={() => cmd.level(-1)} />
                <SmallButton icon={<ListIndentIncrease />} label="Increase List Level" tip="Increase List Level (Tab)" onClick={() => cmd.level(1)} />
                <RowSep />
                <SmallButton icon={<LineSpacingIcon />} label="Line Spacing" menu={<>{[1, 1.5, 2, 2.5, 3].map((v) => <MenuItem key={v} onSelect={() => cmd.lineSpacing(v)}>{v.toFixed(1)}</MenuItem>)}</>} />
              </Row>
              <Row>
                <SmallButton icon={<AlignLeft />} label="Align Left" tip="Align Left (Ctrl+L)" pressed={f.algn === 'l'} onClick={() => cmd.align('l')} />
                <SmallButton icon={<AlignCenter />} label="Center" tip="Center (Ctrl+E)" pressed={f.algn === 'ctr'} onClick={() => cmd.align('ctr')} />
                <SmallButton icon={<AlignRight />} label="Align Right" tip="Align Right (Ctrl+R)" pressed={f.algn === 'r'} onClick={() => cmd.align('r')} />
                <SmallButton icon={<AlignJustify />} label="Justify" tip="Justify (Ctrl+J)" pressed={f.algn === 'just'} onClick={() => cmd.align('just')} />
                <RowSep />
                <SmallButton
                  icon={f.anchor === 'ctr' ? <AlignVerticalJustifyCenter /> : f.anchor === 'b' ? <AlignVerticalJustifyEnd /> : <AlignVerticalJustifyStart />}
                  label="Align Text"
                  menu={<><MenuItem icon={<AlignVerticalJustifyStart />} checked={f.anchor === 't'} onSelect={() => cmd.anchor('t')}>Top</MenuItem><MenuItem icon={<AlignVerticalJustifyCenter />} checked={f.anchor === 'ctr'} onSelect={() => cmd.anchor('ctr')}>Middle</MenuItem><MenuItem icon={<AlignVerticalJustifyEnd />} checked={f.anchor === 'b'} onSelect={() => cmd.anchor('b')}>Bottom</MenuItem></>}
                />
              </Row>
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Drawing">
            {compact ? <BigButton icon={<ShapesIcon />} label="Shapes" menu={<ShapeGallery onPick={cmd.tool} />} /> : <QuickShapes onPick={cmd.tool} />}
            <BigButton icon={<ArrangeIcon />} label="Arrange" menu={<ArrangeMenu cmd={cmd} state={state} />} />
            <BigButton icon={<QuickStylesIcon />} label="Quick Styles" disabled={!shape} menu={<QuickStyleGallery cmd={cmd} theme={state.theme} />} />
            <Stack>
              <ColorButton icon={<PaintBucket className="size-4" />} label="Shape Fill" color={state.fillColor} onApply={cmd.fill} theme={state.theme} none="No Fill" />
              <SmallButton icon={<PenLine />} label="Shape Outline" menu={<OutlineMenu cmd={cmd} state={state} />} />
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Editing">
            {compact ? (
              <BigButton
                icon={<Search />}
                label="Editing"
                menu={
                  <>
                    <MenuItem icon={<Search />} onSelect={cmd.find} shortcut="Ctrl+F">Find</MenuItem>
                    <MenuItem icon={<Replace />} onSelect={cmd.replace} shortcut="Ctrl+H">Replace</MenuItem>
                    <MenuItem icon={<SquareDashedMousePointer />} onSelect={cmd.selectAll} shortcut="Ctrl+A">Select All</MenuItem>
                  </>
                }
              />
            ) : (
              <Stack>
                <SmallButton icon={<Search />} label="Find" tip="Find (Ctrl+F)" text="Find" onClick={cmd.find} />
                <SmallButton icon={<Replace />} label="Replace" tip="Replace (Ctrl+H)" text="Replace" onClick={cmd.replace} />
                <SmallButton icon={<SquareDashedMousePointer />} label="Select" text="Select" menu={<MenuItem onSelect={cmd.selectAll} shortcut="Ctrl+A">Select All</MenuItem>} />
              </Stack>
            )}
          </RibbonGroup>
        </Ribbon>
      );
    case 'insert':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Slides">
            <BigButton icon={<NewSlideIcon />} label="New Slide" split onClick={() => cmd.newSlide()} menu={layoutMenu('Office Theme', (p) => cmd.newSlide(p))} />
          </RibbonGroup>
          <RibbonGroup label="Tables">
            <BigButton icon={<TableIcon />} label="Table" menu={<TableGrid onPick={cmd.table} />} />
          </RibbonGroup>
          <RibbonGroup label="Images">
            <BigButton icon={<PictureIcon />} label="Pictures" tip="Insert a picture from this computer" onClick={cmd.picture} />
          </RibbonGroup>
          <RibbonGroup label="Illustrations">
            <BigButton icon={<ShapesIcon />} label="Shapes" menu={<ShapeGallery onPick={cmd.tool} />} />
          </RibbonGroup>
          <RibbonGroup label="Text">
            <BigButton icon={<TextBoxIcon />} label="Text Box" tip="Draw a text box" onClick={cmd.textBox} />
            <Stack>
              <SmallButton icon={<PanelBottom />} label="Header & Footer" text="Header & Footer" onClick={cmd.headerFooter} />
              <SmallButton icon={<Calendar />} label="Date & Time" text="Date & Time" onClick={cmd.dateTime} />
              <SmallButton icon={<Hash />} label="Slide Number" text="Slide Number" onClick={cmd.slideNumber} />
            </Stack>
          </RibbonGroup>
        </Ribbon>
      );
    case 'design':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Themes">
            <div className="flex h-[72px] items-start gap-1">
              {DESIGNS.map((d) => (
                <button key={d.id} type="button" title={d.name} aria-label={d.name} onClick={() => cmd.design(d)} className="h-[60px] w-[86px] overflow-hidden rounded-[3px] border border-[#d1d1d1] hover:border-[#c43e1c] hover:shadow">
                  <DesignSwatch d={d} />
                </button>
              ))}
            </div>
          </RibbonGroup>
          <RibbonGroup label="Variants">
            <Stack>
              <SmallButton icon={<span className="flex gap-px">{[1, 2, 3, 4].map((n) => <span key={n} className="block h-3 w-1.5" style={{ background: `#${state.theme.colors[`accent${n}` as 'accent1']}` }} />)}</span>} label="Colors" text="Colors" menu={<>{COLOR_SETS.map((c) => <MenuItem key={c.name} onSelect={() => cmd.colors(c.name)}><span className="flex items-center gap-2"><span className="flex gap-px">{(['dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'] as const).map((k) => <span key={k} className="block size-3.5" style={{ background: `#${c.colors[k]}` }} />)}</span>{c.name}</span></MenuItem>)}</>} menuClassName="max-h-[70vh]" />
              <SmallButton icon={<span className="text-[13px] leading-none font-serif">A</span>} label="Fonts" text="Fonts" menu={<>{FONT_SETS.map(([name, major, minor]) => <MenuItem key={name} onSelect={() => cmd.fonts(major, minor)}><span className="flex flex-col"><span className="text-[11px] text-[#616161]">{name}</span><span className="text-[15px]" style={{ fontFamily: `"${major}"` }}>{major}</span><span className="text-[12px]" style={{ fontFamily: `"${minor}"` }}>{minor}</span></span></MenuItem>)}</>} menuClassName="max-h-[70vh]" />
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Customize">
            <BigButton icon={<SlideSizeIcon />} label="Slide Size" menu={<><MenuItem checked={!state.wide} onSelect={() => cmd.slideSize(false)}>Standard (4:3)</MenuItem><MenuItem checked={state.wide} onSelect={() => cmd.slideSize(true)}>Widescreen (16:9)</MenuItem></>} />
            <BigButton
              icon={<BackgroundIcon />}
              label="Format Background"
              menu={<><PaletteWithMore theme={state.theme} onPick={cmd.background} automatic="Reset Background" /><MenuSeparator /><MenuItem icon={<PictureIcon />} onSelect={cmd.backgroundPicture}>Picture…</MenuItem><MenuItem onSelect={cmd.backgroundAll}>Apply to All</MenuItem></>}
            />
          </RibbonGroup>
        </Ribbon>
      );
    case 'transitions':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Preview">
            <BigButton icon={<Eye />} label="Preview" onClick={cmd.preview} disabled={!t || t.type === 'none'} />
          </RibbonGroup>
          <RibbonGroup label="Transition to This Slide">
            {TRANSITIONS.map(([type, label]) => (
              <BigButton key={type} icon={<TransitionIcon type={type} />} label={label} pressed={(t?.type ?? 'none') === type} onClick={() => cmd.transition(type)} />
            ))}
            <BigButton
              icon={<ArrangeIcon />}
              label="Effect Options"
              disabled={!t || !['push', 'wipe', 'cover'].includes(t.type)}
              menu={<>{([['l', 'From Right'], ['r', 'From Left'], ['u', 'From Bottom'], ['d', 'From Top']] as [string, string][]).map(([d, l]) => <MenuItem key={d} checked={t?.dir === d} onSelect={() => cmd.transition(t?.type ?? 'push', d)}>{l}</MenuItem>)}</>}
            />
          </RibbonGroup>
          <RibbonGroup label="Timing">
            <Stack className="pt-1">
              <span className="flex h-7 items-center gap-1.5 text-[12px] text-[#424242]">
                <span className="w-16">Duration:</span>
                <Spinner value={(t?.dur ?? 700) / 1000} onChange={(v) => cmd.transitionDuration(Math.round(v * 1000))} min={0.01} max={59} step={0.25} decimals={2} width={70} label="Duration" />
              </span>
              <SmallButton icon={<CopyPlus />} label="Apply To All" text="Apply To All" onClick={cmd.transitionAll} />
            </Stack>
            <Stack className="pt-1">
              <label className="flex h-7 items-center gap-1.5 text-[12px] text-[#424242]">
                <input type="checkbox" checked={t?.advClick !== false} onChange={(e) => cmd.advance(e.target.checked, t?.advTm ?? null)} className="accent-[#c43e1c]" />
                On Mouse Click
              </label>
              <span className="flex h-7 items-center gap-1.5 text-[12px] text-[#424242]">
                <input type="checkbox" aria-label="Advance after" checked={t?.advTm !== undefined} onChange={(e) => cmd.advance(t?.advClick !== false, e.target.checked ? 5000 : null)} className="accent-[#c43e1c]" />
                <span>After:</span>
                <Spinner value={(t?.advTm ?? 0) / 1000} onChange={(v) => cmd.advance(t?.advClick !== false, Math.round(v * 1000))} min={0} max={3600} step={1} decimals={2} width={70} label="Advance after seconds" />
              </span>
            </Stack>
          </RibbonGroup>
        </Ribbon>
      );
    case 'show':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Start Slide Show">
            <BigButton icon={<ShowIcon />} label="From Beginning" tip="From Beginning (F5)" onClick={() => cmd.show(false)} />
            <BigButton icon={<ShowIcon current />} label="From Current Slide" tip="From Current Slide (Shift+F5)" onClick={() => cmd.show(true)} />
          </RibbonGroup>
          <RibbonGroup label="Set Up">
            <BigButton icon={<HideSlideIcon />} label="Hide Slide" pressed={state.hidden} onClick={cmd.hideSlide} />
          </RibbonGroup>
        </Ribbon>
      );
    case 'view':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Presentation Views">
            <BigButton icon={<NormalViewIcon />} label="Normal" pressed={state.view === 'normal'} onClick={() => cmd.view('normal')} />
            <BigButton icon={<SorterIcon />} label="Slide Sorter" pressed={state.view === 'sorter'} onClick={() => cmd.view('sorter')} />
          </RibbonGroup>
          <RibbonGroup label="Show">
            <Stack className="pt-1">
              <label className="flex h-6 items-center gap-1.5 text-[12px]">
                <input type="checkbox" checked={state.gridlines} onChange={cmd.gridlines} className="accent-[#c43e1c]" /> <Grid3x3 className="size-3.5" /> Gridlines
              </label>
              <label className="flex h-6 items-center gap-1.5 text-[12px]">
                <input type="checkbox" checked={state.notes} onChange={cmd.notes} className="accent-[#c43e1c]" /> <StickyNote className="size-3.5" /> Notes
              </label>
            </Stack>
          </RibbonGroup>
          <RibbonGroup label="Zoom">
            <BigButton icon={<ZoomIn />} label="Zoom" onClick={cmd.zoom} />
            <BigButton icon={<Maximize />} label="Fit to Window" onClick={cmd.fit} />
          </RibbonGroup>
        </Ribbon>
      );
    case 'shapeFormat':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Insert Shapes">
            <QuickShapes onPick={cmd.tool} />
          </RibbonGroup>
          <RibbonGroup label="Shape Styles">
            <BigButton icon={<QuickStylesIcon />} label="Quick Styles" menu={<QuickStyleGallery cmd={cmd} theme={state.theme} />} />
            <Stack>
              <ColorButton icon={<PaintBucket className="size-4" />} label="Shape Fill" color={state.fillColor} onApply={cmd.fill} theme={state.theme} none="No Fill" />
              <SmallButton icon={<PenLine />} label="Shape Outline" text="Shape Outline" menu={<OutlineMenu cmd={cmd} state={state} />} />
            </Stack>
          </RibbonGroup>
          <ArrangeGroup cmd={cmd} state={state} />
          <SizeGroup cmd={cmd} state={state} />
        </Ribbon>
      );
    case 'pictureFormat':
      return (
        <Ribbon collapsed={collapsed}>
          <RibbonGroup label="Adjust">
            <BigButton icon={<ResetIcon />} label="Reset Picture" onClick={cmd.resetPicture} />
          </RibbonGroup>
          <RibbonGroup label="Picture Styles">
            <Stack>
              <SmallButton icon={<PenLine />} label="Picture Border" text="Picture Border" menu={<OutlineMenu cmd={cmd} state={state} />} />
            </Stack>
          </RibbonGroup>
          <ArrangeGroup cmd={cmd} state={state} />
          <SizeGroup cmd={cmd} state={state} />
        </Ribbon>
      );
  }
  return <Ribbon collapsed={collapsed}>{null}</Ribbon>;
}

function LineSpacingIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden>
      <path d="M7 3.5h7M7 6.5h7M7 9.5h7M7 12.5h7" />
      <path d="M3 2.5v11M1.5 4L3 2.5 4.5 4M1.5 12L3 13.5 4.5 12" />
    </svg>
  );
}

export function DesignSwatch({ d }: { d: DesignTheme }) {
  const c = d.colors;
  const bg = d.dark ? `linear-gradient(180deg, #${c.dk2}, #${c.dk1})` : d.id === 'vivid' || d.id === 'minimal' ? `#${c.lt2}` : '#fff';
  const text = d.dark ? `#${c.lt1}` : `#${c.dk1}`;
  return (
    <span className="relative flex h-full w-full flex-col justify-between p-1.5 text-left" style={{ background: bg }}>
      {d.id === 'vivid' && <span className="absolute inset-x-0 top-0 h-[30%]" style={{ background: `#${c.accent1}` }} />}
      {d.id === 'ocean' && <span className="absolute inset-0" style={{ background: `linear-gradient(135deg, #${c.dk2}, #${c.accent1})` }} />}
      <span className="relative text-[15px] leading-none" style={{ color: d.id === 'ocean' ? '#fff' : text, fontFamily: `"${d.major}", sans-serif` }}>
        Aa
      </span>
      <span className="relative flex gap-px">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <span key={n} className="block h-1.5 flex-1" style={{ background: `#${c[`accent${n}` as 'accent1']}` }} />
        ))}
      </span>
    </span>
  );
}


