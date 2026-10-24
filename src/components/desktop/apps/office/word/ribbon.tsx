import { useState } from 'react';
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Bold,
  BookOpenText,
  CalendarClock,
  CaseSensitive,
  ClipboardPaste,
  Columns2,
  Copy,
  FileMinus,
  FilePlus,
  Globe,
  Grid3x3,
  Hash,
  Highlighter,
  Image,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize,
  Omega,
  PaintBucket,
  Paintbrush,
  PanelBottom,
  PanelTop,
  Pilcrow,
  Ratio,
  RectangleHorizontal,
  RectangleVertical,
  RemoveFormatting,
  Replace,
  RotateCcw,
  Scissors,
  Search,
  SeparatorHorizontal,
  SpellCheck,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  TableCellsMerge,
  TableCellsSplit,
  TextSelect,
  Trash2,
  Underline,
  X,
  ZoomIn,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  BigButton,
  ColorButton,
  FontBox,
  FontColorGlyph,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTile,
  RibbonGroup,
  RibbonSpinner,
  Row,
  RowSep,
  SizeBox,
  SmallButton,
  Stack,
  SubMenu,
  type PickedColor,
} from '../chrome';
import { FONT_SIZES, fontStack } from '../fonts';
import type { Theme } from '../theme';
import { bulletPreview, type BulletKind, type NumberKind } from './numbering';
import type { CaseMode } from './commands';
import { PAPER_SIZES } from './paper';
import type { Section } from './read';
import type { Style } from './styles';

export interface RibbonState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sub: boolean;
  sup: boolean;
  font: string;
  size: number;
  align: string;
  styleId: string;
  listKind: string | null;
  bulleted: boolean;
  numbered: boolean;
  line: number | null;
  inTable: boolean;
  imageSelected: boolean;
  imageSize: { width: number; height: number } | null;
  marks: boolean;
  web: boolean;
  navPane: boolean;
  spellcheck: boolean;
  painter: boolean;
  indLeft: number;
  indRight: number;
  spBefore: number;
  spAfter: number;
  titlePg: boolean;
  tableBorders: boolean;
  ruler: boolean;
  /** The paragraph's indents in pixels, for the ruler. */
  indents: { left: number; first: number; right: number };
}

export interface WordCommands {
  paste(textOnly: boolean): void;
  cut(): void;
  copy(): void;
  formatPainter(): void;
  font(name: string): void;
  size(pt: number): void;
  grow(dir: 1 | -1): void;
  changeCase(mode: CaseMode): void;
  clearFormatting(): void;
  toggle(mark: 'bold' | 'italic' | 'underline' | 'strike' | 'subscript' | 'superscript'): void;
  highlight(c: PickedColor | null): void;
  fontColor(c: PickedColor | null): void;
  bullets(kind: BulletKind, force?: boolean): void;
  numbering(kind: NumberKind, force?: boolean): void;
  indent(dir: 1 | -1): void;
  toggleMarks(): void;
  align(a: 'left' | 'center' | 'right' | 'justify'): void;
  lineSpacing(n: number): void;
  spaceBefore(add: boolean): void;
  spaceAfter(add: boolean): void;
  shading(c: PickedColor | null): void;
  style(s: Style): void;
  find(): void;
  replace(): void;
  selectAll(): void;
  paragraphDialog(): void;
  fontDialog(): void;
  pageBreak(): void;
  blankPage(): void;
  table(cols: number, rows: number): void;
  tableDialog(): void;
  picture(): void;
  link(): void;
  editHeaderFooter(kind: 'header' | 'footer'): void;
  removeHeaderFooter(kind: 'header' | 'footer'): void;
  pageNumber(where: 'top' | 'bottom', align: 'left' | 'center' | 'right'): void;
  removePageNumbers(): void;
  dateTime(): void;
  symbol(ch: string): void;
  margins(m: { top: number; bottom: number; left: number; right: number }): void;
  pageSetup(): void;
  orientation(landscape: boolean): void;
  paperSize(w: number, h: number): void;
  setIndent(side: 'left' | 'right', inches: number): void;
  setSpacing(side: 'before' | 'after', pt: number): void;
  spelling(): void;
  wordCount(): void;
  web(on: boolean): void;
  navPane(): void;
  ruler(): void;
  zoomDialog(): void;
  zoom(z: number): void;
  onePage(): void;
  pageWidth(): void;
  tableShading(c: PickedColor | null): void;
  tableBorders(on: boolean): void;
  tableInsert(where: 'above' | 'below' | 'left' | 'right'): void;
  tableDelete(what: 'rows' | 'columns' | 'table'): void;
  mergeCells(): void;
  splitCell(): void;
  cellAlign(v: 'top' | 'middle' | 'bottom'): void;
  imageSize(w: number | null, h: number | null): void;
  resetImage(): void;
  differentFirstPage(on: boolean): void;
  hfDistance(kind: 'header' | 'footer', inches: number): void;
  closeHeaderFooter(): void;
}

const ALIGN_TIPS = {
  left: 'Align Left (Ctrl+L)',
  center: 'Center (Ctrl+E)',
  right: 'Align Right (Ctrl+R)',
  justify: 'Justify (Ctrl+J)',
};

const HIGHLIGHT_COLORS: [string, string][] = [
  ['FFFF00', 'Yellow'], ['00FF00', 'Bright Green'], ['00FFFF', 'Turquoise'], ['FF00FF', 'Pink'], ['0000FF', 'Blue'],
  ['FF0000', 'Red'], ['000080', 'Dark Blue'], ['008080', 'Teal'], ['008000', 'Green'], ['800080', 'Violet'],
  ['800000', 'Dark Red'], ['808000', 'Dark Yellow'], ['808080', 'Gray-50%'], ['C0C0C0', 'Gray-25%'], ['000000', 'Black'],
];

const SYMBOLS = '©®™€£¥¢§¶±≠≤≥÷×∞µαβπΩΣ√°½¼¾—–…•✓←→↑↓♥☺'.split('');

const BULLET_KINDS: BulletKind[] = ['disc', 'circle', 'square', 'diamond', 'arrow', 'check'];
const NUMBER_KINDS: [NumberKind, string[]][] = [
  ['1.', ['1.', '2.', '3.']],
  ['1)', ['1)', '2)', '3)']],
  ['I.', ['I.', 'II.', 'III.']],
  ['A.', ['A.', 'B.', 'C.']],
  ['a)', ['a)', 'b)', 'c)']],
  ['a.', ['a.', 'b.', 'c.']],
  ['i.', ['i.', 'ii.', 'iii.']],
];

function LineSpacingIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M7 3h8M7 6.5h8M7 10h8M7 13.5h8M3 2v12M1.2 4 3 2l1.8 2M1.2 12 3 14l1.8-2" />
    </svg>
  );
}

function TableGridPicker({ onPick }: { onPick: (cols: number, rows: number) => void }) {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  return (
    <div className="p-1">
      <div className="px-1 pb-1 text-[12px] font-semibold text-[#424242]">{hover[0] ? `${hover[0]}x${hover[1]} Table` : 'Insert Table'}</div>
      <div className="grid grid-cols-10 gap-[3px] p-1" onPointerLeave={() => setHover([0, 0])}>
        {Array.from({ length: 80 }, (_, i) => {
          const c = (i % 10) + 1;
          const r = Math.floor(i / 10) + 1;
          const on = c <= hover[0] && r <= hover[1];
          return (
            <MenuTile
              key={i}
              aria-label={`${c} by ${r} table`}
              onPointerEnter={() => setHover([c, r])}
              onFocus={() => setHover([c, r])}
              onSelect={() => onPick(c, r)}
              className={cn('size-[15px] cursor-pointer border outline-none', on ? 'border-[#e86e15] bg-[#fde7d3]' : 'border-[#c8c8c8] bg-white')}
            />
          );
        })}
      </div>
    </div>
  );
}

function StyleTile({ style, active, onClick }: { style: Style; active: boolean; onClick: () => void }) {
  const r = style.run;
  return (
    <button
      type="button"
      title={style.name}
      onClick={onClick}
      className={cn(
        'flex h-[66px] w-[78px] shrink-0 flex-col items-stretch justify-between rounded-[4px] border bg-white px-1.5 pt-1.5 pb-1 text-left hover:border-[#c8c8c8]',
        active ? 'border-[var(--office-accent)] bg-[var(--office-accent-light)] hover:border-[var(--office-accent)]' : 'border-transparent',
      )}
    >
      <span
        className="block overflow-hidden leading-tight whitespace-nowrap"
        style={{
          fontFamily: fontStack(r.font),
          fontSize: `${Math.max(9, Math.min(r.size ?? 11, 16)) * 1.15}px`,
          fontWeight: r.bold ? 700 : 400,
          fontStyle: r.italic ? 'italic' : 'normal',
          color: r.color ? `#${r.color}` : '#000',
          textDecoration: r.underline ? 'underline' : 'none',
        }}
      >
        AaBbCcDd
      </span>
      <span className="block truncate text-[11px] text-[#424242]">{style.name.replace(/^heading/, 'Heading')}</span>
    </button>
  );
}

export function WordRibbon({
  tab,
  s,
  cmd,
  theme,
  gallery,
  section,
  lastHighlight,
  lastFontColor,
  lastShading,
  lastCellShading,
}: {
  tab: string;
  s: RibbonState;
  cmd: WordCommands;
  theme: Theme;
  gallery: Style[];
  section: Section;
  lastHighlight: string;
  lastFontColor: string;
  lastShading: string | null;
  lastCellShading: string | null;
}) {
  const [galleryOffset, setGalleryOffset] = useState(0);
  const inches = (px: number) => Math.round((px / 96) * 100) / 100;

  if (tab === 'home') {
    const visible = gallery.slice(galleryOffset, galleryOffset + 6);
    return (
      <>
        <RibbonGroup label="Clipboard">
          <BigButton
            icon={<ClipboardPaste className="text-[#7a5c2e]" />}
            label="Paste"
            tip="Paste (Ctrl+V)"
            split
            onClick={() => cmd.paste(false)}
            menu={
              <>
                <MenuLabel>Paste Options:</MenuLabel>
                <MenuItem icon={<ClipboardPaste />} onSelect={() => cmd.paste(false)}>
                  Keep Source Formatting
                </MenuItem>
                <MenuItem icon={<CaseSensitive />} onSelect={() => cmd.paste(true)} shortcut="Ctrl+Shift+V">
                  Keep Text Only
                </MenuItem>
              </>
            }
          />
          <Stack>
            <SmallButton icon={<Scissors />} label="Cut" text="Cut" tip="Cut (Ctrl+X)" onClick={cmd.cut} />
            <SmallButton icon={<Copy />} label="Copy" text="Copy" tip="Copy (Ctrl+C)" onClick={cmd.copy} />
            <SmallButton icon={<Paintbrush />} label="Format Painter" text="Format Painter" tip="Format Painter (Ctrl+Shift+C)" pressed={s.painter} onClick={cmd.formatPainter} />
          </Stack>
        </RibbonGroup>

        <RibbonGroup label="Font">
          <Stack className="gap-1 pt-0.5">
            <Row className="gap-1">
              <FontBox value={s.font} onCommit={cmd.font} theme={theme} width={136} />
              <SizeBox value={String(s.size)} onCommit={cmd.size} sizes={FONT_SIZES} />
              <SmallButton icon={<AArrowUp />} label="Increase Font Size (Ctrl+>)" onClick={() => cmd.grow(1)} />
              <SmallButton icon={<AArrowDown />} label="Decrease Font Size (Ctrl+<)" onClick={() => cmd.grow(-1)} />
              <RowSep />
              <SmallButton
                icon={<CaseSensitive />}
                label="Change Case"
                menu={
                  <>
                    <MenuItem onSelect={() => cmd.changeCase('sentence')}>Sentence case.</MenuItem>
                    <MenuItem onSelect={() => cmd.changeCase('lower')}>lowercase</MenuItem>
                    <MenuItem onSelect={() => cmd.changeCase('upper')}>UPPERCASE</MenuItem>
                    <MenuItem onSelect={() => cmd.changeCase('title')}>Capitalize Each Word</MenuItem>
                    <MenuItem onSelect={() => cmd.changeCase('toggle')}>tOGGLE cASE</MenuItem>
                  </>
                }
              />
              <SmallButton icon={<RemoveFormatting />} label="Clear All Formatting" onClick={cmd.clearFormatting} />
            </Row>
            <Row>
              <SmallButton icon={<Bold />} label="Bold (Ctrl+B)" pressed={s.bold} onClick={() => cmd.toggle('bold')} />
              <SmallButton icon={<Italic />} label="Italic (Ctrl+I)" pressed={s.italic} onClick={() => cmd.toggle('italic')} />
              <SmallButton icon={<Underline />} label="Underline (Ctrl+U)" pressed={s.underline} onClick={() => cmd.toggle('underline')} />
              <SmallButton icon={<Strikethrough />} label="Strikethrough" pressed={s.strike} onClick={() => cmd.toggle('strike')} />
              <SmallButton icon={<Subscript />} label="Subscript (Ctrl+=)" pressed={s.sub} onClick={() => cmd.toggle('subscript')} />
              <SmallButton icon={<Superscript />} label="Superscript (Ctrl+Shift++)" pressed={s.sup} onClick={() => cmd.toggle('superscript')} />
              <RowSep />
              <HighlightButton color={lastHighlight} onPick={cmd.highlight} />
              <ColorButton icon={<FontColorGlyph />} label="Font Color" color={lastFontColor} onApply={cmd.fontColor} theme={theme} automatic="Automatic" />
            </Row>
          </Stack>
        </RibbonGroup>

        <RibbonGroup label="Paragraph">
          <Stack className="gap-1 pt-0.5">
            <Row>
              <SmallButton
                icon={<List />}
                label="Bullets"
                split
                pressed={s.bulleted}
                onClick={() => cmd.bullets('disc')}
                menu={
                  <>
                    <MenuLabel>Bullet Library</MenuLabel>
                    <div className="grid grid-cols-3 gap-1 p-1">
                      {BULLET_KINDS.map((k) => (
                        <MenuTile
                          key={k}
                          onSelect={() => cmd.bullets(k, true)}
                          className={cn(
                            'grid h-14 w-16 cursor-pointer place-items-center rounded-[4px] border text-[22px] outline-none data-[highlighted]:border-[var(--office-accent)] data-[highlighted]:bg-[#f0f0f0]',
                            s.listKind === bulletPreview(k) ? 'border-[var(--office-accent)]' : 'border-[#e0e0e0]',
                          )}
                        >
                          {bulletPreview(k)}
                        </MenuTile>
                      ))}
                    </div>
                  </>
                }
              />
              <SmallButton
                icon={<ListOrdered />}
                label="Numbering"
                split
                pressed={s.numbered}
                onClick={() => cmd.numbering('1.')}
                menu={
                  <>
                    <MenuLabel>Numbering Library</MenuLabel>
                    <div className="grid grid-cols-3 gap-1 p-1">
                      {NUMBER_KINDS.map(([k, sample]) => (
                        <MenuTile
                          key={k}
                          onSelect={() => cmd.numbering(k, true)}
                          className="flex h-[72px] w-20 cursor-pointer flex-col justify-center gap-0.5 rounded-[4px] border border-[#e0e0e0] px-2 text-[11px] outline-none data-[highlighted]:border-[var(--office-accent)] data-[highlighted]:bg-[#f0f0f0]"
                        >
                          {sample.map((t) => (
                            <span key={t} className="flex items-center gap-1">
                              <span className="w-5">{t}</span>
                              <span className="h-px flex-1 bg-[#9e9e9e]" />
                            </span>
                          ))}
                        </MenuTile>
                      ))}
                    </div>
                  </>
                }
              />
              <SmallButton icon={<IndentDecrease />} label="Decrease Indent" onClick={() => cmd.indent(-1)} />
              <SmallButton icon={<IndentIncrease />} label="Increase Indent" onClick={() => cmd.indent(1)} />
              <RowSep />
              <SmallButton icon={<Pilcrow />} label="Show/Hide ¶ (Ctrl+*)" pressed={s.marks} onClick={cmd.toggleMarks} />
            </Row>
            <Row>
              {(['left', 'center', 'right', 'justify'] as const).map((a) => {
                const Icon = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify }[a];
                return <SmallButton key={a} icon={<Icon />} label={ALIGN_TIPS[a]} pressed={s.align === a} onClick={() => cmd.align(a)} />;
              })}
              <RowSep />
              <SmallButton
                icon={<LineSpacingIcon />}
                label="Line and Paragraph Spacing"
                menu={
                  <>
                    {[1, 1.15, 1.5, 2, 2.5, 3].map((n) => (
                      <MenuItem key={n} checked={s.line !== null && Math.abs(s.line - n) < 0.01} onSelect={() => cmd.lineSpacing(n)}>
                        {n.toFixed(n === 1.15 ? 2 : 1)}
                      </MenuItem>
                    ))}
                    <MenuSeparator />
                    <MenuItem onSelect={cmd.paragraphDialog}>Line Spacing Options…</MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => cmd.spaceBefore(s.spBefore === 0)}>{s.spBefore === 0 ? 'Add Space Before Paragraph' : 'Remove Space Before Paragraph'}</MenuItem>
                    <MenuItem onSelect={() => cmd.spaceAfter(s.spAfter === 0)}>{s.spAfter === 0 ? 'Add Space After Paragraph' : 'Remove Space After Paragraph'}</MenuItem>
                  </>
                }
              />
              <ColorButton icon={<PaintBucket className="size-4" />} label="Shading" color={lastShading} onApply={cmd.shading} theme={theme} none="No Color" />
            </Row>
          </Stack>
        </RibbonGroup>

        <RibbonGroup label="Styles">
          <div className="flex h-[72px] items-stretch overflow-hidden rounded-[4px] border border-[#e0e0e0]">
            <div className="flex items-center gap-0.5 p-0.5">
              {visible.map((st) => (
                <StyleTile key={st.id} style={st} active={st.id === s.styleId} onClick={() => cmd.style(st)} />
              ))}
            </div>
            <div className="flex w-4 flex-col border-l border-[#e0e0e0]">
              <button type="button" aria-label="Previous styles" disabled={galleryOffset === 0} onClick={() => setGalleryOffset((o) => Math.max(0, o - 6))} className="grid flex-1 place-items-center text-[9px] text-[#616161] hover:bg-[#f0f0f0] disabled:opacity-30">
                ▲
              </button>
              <button
                type="button"
                aria-label="More styles"
                disabled={galleryOffset + 6 >= gallery.length}
                onClick={() => setGalleryOffset((o) => Math.min(o + 6, Math.max(0, gallery.length - 1)))}
                className="grid flex-1 place-items-center text-[9px] text-[#616161] hover:bg-[#f0f0f0] disabled:opacity-30"
              >
                ▼
              </button>
            </div>
          </div>
        </RibbonGroup>

        <RibbonGroup label="Editing">
          <Stack>
            <SmallButton icon={<Search />} label="Find (Ctrl+F)" text="Find" onClick={cmd.find} />
            <SmallButton icon={<Replace />} label="Replace (Ctrl+H)" text="Replace" onClick={cmd.replace} />
            <SmallButton icon={<TextSelect />} label="Select" text="Select" menu={<MenuItem onSelect={cmd.selectAll} shortcut="Ctrl+A">Select All</MenuItem>} />
          </Stack>
        </RibbonGroup>
      </>
    );
  }

  if (tab === 'insert') {
    return (
      <>
        <RibbonGroup label="Pages">
          <Stack>
            <SmallButton icon={<FilePlus />} label="Blank Page" text="Blank Page" onClick={cmd.blankPage} />
            <SmallButton icon={<SeparatorHorizontal />} label="Page Break (Ctrl+Enter)" text="Page Break" onClick={cmd.pageBreak} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Tables">
          <BigButton
            icon={<Table className="text-[#185abd]" />}
            label="Table"
            menu={
              <>
                <TableGridPicker onPick={cmd.table} />
                <MenuSeparator />
                <MenuItem icon={<Grid3x3 />} onSelect={cmd.tableDialog}>
                  Insert Table…
                </MenuItem>
              </>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Illustrations">
          <BigButton icon={<Image className="text-[#0e7a5f]" />} label="Pictures" tip="Insert a picture from a file" onClick={cmd.picture} />
        </RibbonGroup>
        <RibbonGroup label="Links">
          <BigButton icon={<Link className="text-[#185abd]" />} label="Link" tip="Insert Link (Ctrl+K)" onClick={cmd.link} />
        </RibbonGroup>
        <RibbonGroup label="Header & Footer">
          <BigButton
            icon={<PanelTop />}
            label="Header"
            menu={
              <>
                <MenuItem onSelect={() => cmd.editHeaderFooter('header')}>Edit Header</MenuItem>
                <MenuItem onSelect={() => cmd.removeHeaderFooter('header')}>Remove Header</MenuItem>
              </>
            }
          />
          <BigButton
            icon={<PanelBottom />}
            label="Footer"
            menu={
              <>
                <MenuItem onSelect={() => cmd.editHeaderFooter('footer')}>Edit Footer</MenuItem>
                <MenuItem onSelect={() => cmd.removeHeaderFooter('footer')}>Remove Footer</MenuItem>
              </>
            }
          />
          <PageNumberButton cmd={cmd} />
        </RibbonGroup>
        <RibbonGroup label="Text">
          <BigButton icon={<CalendarClock />} label="Date & Time" onClick={cmd.dateTime} />
        </RibbonGroup>
        <RibbonGroup label="Symbols">
          <BigButton icon={<Omega />} label="Symbol" menu={<SymbolGrid onPick={cmd.symbol} />} />
        </RibbonGroup>
      </>
    );
  }

  if (tab === 'layout') {
    const MARGINS: [string, { top: number; bottom: number; left: number; right: number }][] = [
      ['Normal', { top: 1, bottom: 1, left: 1, right: 1 }],
      ['Narrow', { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }],
      ['Moderate', { top: 1, bottom: 1, left: 0.75, right: 0.75 }],
      ['Wide', { top: 1, bottom: 1, left: 2, right: 2 }],
    ];
    const cur = { top: inches(section.mTop), bottom: inches(section.mBottom), left: inches(section.mLeft), right: inches(section.mRight) };
    const landscape = section.pageW > section.pageH;
    return (
      <>
        <RibbonGroup label="Page Setup">
          <BigButton
            icon={<Columns2 />}
            label="Margins"
            menu={
              <>
                {MARGINS.map(([name, m]) => (
                  <MenuItem key={name} checked={m.top === cur.top && m.bottom === cur.bottom && m.left === cur.left && m.right === cur.right} onSelect={() => cmd.margins(m)}>
                    <span className="block font-semibold">{name}</span>
                    <span className="block text-[11.5px] text-[#616161]">
                      Top: {m.top}" Bottom: {m.bottom}" Left: {m.left}" Right: {m.right}"
                    </span>
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem onSelect={cmd.pageSetup}>Custom Margins…</MenuItem>
              </>
            }
          />
          <BigButton
            icon={landscape ? <RectangleHorizontal /> : <RectangleVertical />}
            label="Orientation"
            menu={
              <>
                <MenuItem icon={<RectangleVertical />} checked={!landscape} onSelect={() => cmd.orientation(false)}>
                  Portrait
                </MenuItem>
                <MenuItem icon={<RectangleHorizontal />} checked={landscape} onSelect={() => cmd.orientation(true)}>
                  Landscape
                </MenuItem>
              </>
            }
          />
          <BigButton
            icon={<Ratio />}
            label="Size"
            menu={
              <>
                {PAPER_SIZES.map((p) => {
                  const w = Math.min(section.pageW, section.pageH) / 96;
                  const h = Math.max(section.pageW, section.pageH) / 96;
                  return (
                    <MenuItem key={p.name} checked={Math.abs(p.w - w) < 0.05 && Math.abs(p.h - h) < 0.05} onSelect={() => cmd.paperSize(p.w, p.h)}>
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block text-[11.5px] text-[#616161]">{p.label}</span>
                    </MenuItem>
                  );
                })}
                <MenuSeparator />
                <MenuItem onSelect={cmd.pageSetup}>More Paper Sizes…</MenuItem>
              </>
            }
          />
          <Stack>
            <SmallButton
              icon={<SeparatorHorizontal />}
              label="Breaks"
              text="Breaks"
              menu={
                <>
                  <MenuLabel>Page Breaks</MenuLabel>
                  <MenuItem onSelect={cmd.pageBreak} shortcut="Ctrl+Enter">
                    <span className="block font-semibold">Page</span>
                    <span className="block text-[11.5px] text-[#616161]">Mark the point at which one page ends and the next page begins.</span>
                  </MenuItem>
                </>
              }
            />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Paragraph">
          <Stack className="gap-0.5">
            <div className="text-[11.5px] leading-4 font-semibold text-[#424242]">Indent</div>
            <RibbonSpinner caption="Left:" value={s.indLeft} onChange={(v) => cmd.setIndent('left', v)} min={-11} max={22} step={0.1} decimals={1} unit={'"'} />
            <RibbonSpinner caption="Right:" value={s.indRight} onChange={(v) => cmd.setIndent('right', v)} min={-11} max={22} step={0.1} decimals={1} unit={'"'} />
          </Stack>
          <span className="mx-1 w-px self-stretch bg-[#e1e1e1]" />
          <Stack className="gap-0.5">
            <div className="text-[11.5px] leading-4 font-semibold text-[#424242]">Spacing</div>
            <RibbonSpinner caption="Before:" value={s.spBefore} onChange={(v) => cmd.setSpacing('before', v)} min={0} max={1584} step={6} unit="pt" />
            <RibbonSpinner caption="After:" value={s.spAfter} onChange={(v) => cmd.setSpacing('after', v)} min={0} max={1584} step={6} unit="pt" />
          </Stack>
        </RibbonGroup>
      </>
    );
  }

  if (tab === 'review') {
    return (
      <RibbonGroup label="Proofing">
        <BigButton icon={<SpellCheck className="text-[#185abd]" />} label="Spelling" tip="Check spelling as you type" pressed={s.spellcheck} onClick={cmd.spelling} />
        <Stack>
          <SmallButton icon={<Hash />} label="Word Count" text="Word Count" onClick={cmd.wordCount} />
        </Stack>
      </RibbonGroup>
    );
  }

  if (tab === 'view') {
    return (
      <>
        <RibbonGroup label="Views">
          <BigButton icon={<BookOpenText />} label="Print Layout" pressed={!s.web} onClick={() => cmd.web(false)} />
          <BigButton icon={<Globe />} label="Web Layout" pressed={s.web} onClick={() => cmd.web(true)} />
        </RibbonGroup>
        <RibbonGroup label="Show">
          <Stack className="pt-1">
            <label className="flex h-6 cursor-pointer items-center gap-1.5 px-1 text-[12px]">
              <input type="checkbox" checked={s.ruler} onChange={cmd.ruler} className="size-3.5 accent-[var(--office-accent)]" />
              Ruler
            </label>
            <label className="flex h-6 cursor-pointer items-center gap-1.5 px-1 text-[12px]">
              <input type="checkbox" checked={s.navPane} onChange={cmd.navPane} className="size-3.5 accent-[var(--office-accent)]" />
              Navigation Pane
            </label>
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Zoom">
          <BigButton icon={<ZoomIn />} label="Zoom" onClick={cmd.zoomDialog} />
          <BigButton icon={<span className="text-[13px] font-semibold">100</span>} label="100%" onClick={() => cmd.zoom(100)} />
          <Stack>
            <SmallButton icon={<RectangleVertical />} label="One Page" text="One Page" onClick={cmd.onePage} />
            <SmallButton icon={<Maximize />} label="Page Width" text="Page Width" onClick={cmd.pageWidth} />
          </Stack>
        </RibbonGroup>
      </>
    );
  }

  if (tab === 'tableDesign') {
    return (
      <RibbonGroup label="Borders">
        <ColorButton big icon={<PaintBucket className="size-7" />} label="Shading" color={lastCellShading} onApply={cmd.tableShading} theme={theme} none="No Color" />
        <BigButton
          icon={<Grid3x3 />}
          label="Borders"
          menu={
            <>
              <MenuItem checked={s.tableBorders} onSelect={() => cmd.tableBorders(true)}>
                All Borders
              </MenuItem>
              <MenuItem checked={!s.tableBorders} onSelect={() => cmd.tableBorders(false)}>
                No Border
              </MenuItem>
            </>
          }
        />
      </RibbonGroup>
    );
  }

  if (tab === 'tableLayout') {
    return (
      <>
        <RibbonGroup label="Rows & Columns">
          <BigButton
            icon={<Trash2 />}
            label="Delete"
            menu={
              <>
                <MenuItem onSelect={() => cmd.tableDelete('columns')}>Delete Columns</MenuItem>
                <MenuItem onSelect={() => cmd.tableDelete('rows')}>Delete Rows</MenuItem>
                <MenuItem onSelect={() => cmd.tableDelete('table')}>Delete Table</MenuItem>
              </>
            }
          />
          <BigButton icon={<BetweenHorizontalStart />} label="Insert Above" onClick={() => cmd.tableInsert('above')} />
          <Stack>
            <SmallButton icon={<BetweenHorizontalEnd />} label="Insert Below" text="Insert Below" onClick={() => cmd.tableInsert('below')} />
            <SmallButton icon={<BetweenVerticalStart />} label="Insert Left" text="Insert Left" onClick={() => cmd.tableInsert('left')} />
            <SmallButton icon={<BetweenVerticalEnd />} label="Insert Right" text="Insert Right" onClick={() => cmd.tableInsert('right')} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Merge">
          <Stack>
            <SmallButton icon={<TableCellsMerge />} label="Merge Cells" text="Merge Cells" onClick={cmd.mergeCells} />
            <SmallButton icon={<TableCellsSplit />} label="Split Cells" text="Split Cells" onClick={cmd.splitCell} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Alignment">
          <Stack>
            <SmallButton icon={<AlignVerticalJustifyStart />} label="Align Top" text="Top" onClick={() => cmd.cellAlign('top')} />
            <SmallButton icon={<AlignVerticalJustifyCenter />} label="Align Center Vertically" text="Center" onClick={() => cmd.cellAlign('middle')} />
            <SmallButton icon={<AlignVerticalJustifyEnd />} label="Align Bottom" text="Bottom" onClick={() => cmd.cellAlign('bottom')} />
          </Stack>
        </RibbonGroup>
      </>
    );
  }

  if (tab === 'picture') {
    return (
      <RibbonGroup label="Size">
        <Stack className="gap-1 pt-1">
          <RibbonSpinner
            caption="Height:"
            value={inches(s.imageSize?.height ?? 0)}
            onChange={(v) => cmd.imageSize(null, v * 96)}
            min={0.1}
            max={22}
            step={0.1}
            decimals={2}
            unit={'"'}
          />
          <RibbonSpinner caption="Width:" value={inches(s.imageSize?.width ?? 0)} onChange={(v) => cmd.imageSize(v * 96, null)} min={0.1} max={22} step={0.1} decimals={2} unit={'"'} />
          <SmallButton icon={<RotateCcw />} label="Reset Size" text="Reset Size" onClick={cmd.resetImage} />
        </Stack>
      </RibbonGroup>
    );
  }

  if (tab === 'headerFooter') {
    return (
      <>
        <RibbonGroup label="Header & Footer">
          <PageNumberButton cmd={cmd} />
        </RibbonGroup>
        <RibbonGroup label="Insert">
          <BigButton icon={<CalendarClock />} label="Date & Time" onClick={cmd.dateTime} />
          <BigButton icon={<Image />} label="Pictures" onClick={cmd.picture} />
        </RibbonGroup>
        <RibbonGroup label="Options">
          <Stack className="pt-1">
            <label className="flex h-6 cursor-pointer items-center gap-1.5 px-1 text-[12px]">
              <input type="checkbox" checked={s.titlePg} onChange={(e) => cmd.differentFirstPage(e.target.checked)} className="size-3.5 accent-[var(--office-accent)]" />
              Different First Page
            </label>
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Position">
          <Stack className="gap-1 pt-1">
            <RibbonSpinner icon={<PanelTop />} caption="Header:" value={inches(section.mHeader)} onChange={(v) => cmd.hfDistance('header', v)} min={0} max={10} step={0.1} decimals={1} unit={'"'} width={64} />
            <RibbonSpinner icon={<PanelBottom />} caption="Footer:" value={inches(section.mFooter)} onChange={(v) => cmd.hfDistance('footer', v)} min={0} max={10} step={0.1} decimals={1} unit={'"'} width={64} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Close">
          <BigButton icon={<X className="text-[#c42b1c]" />} label="Close Header and Footer" onClick={cmd.closeHeaderFooter} />
        </RibbonGroup>
      </>
    );
  }
  return null;
}

function HighlightButton({ color, onPick }: { color: string; onPick: (c: PickedColor | null) => void }) {
  return (
    <SmallButton
      icon={
        <span className="flex flex-col items-center">
          <Highlighter className="size-4" />
          <span className="mt-[1px] h-[4px] w-4 rounded-[1px]" style={{ background: `#${color}` }} />
        </span>
      }
      label="Text Highlight Color"
      split
      onClick={() => onPick({ hex: color })}
      className="[&_button:first-child]:h-6"
      menu={
        <div className="p-1">
          <div className="grid grid-cols-5 gap-1 p-1">
            {HIGHLIGHT_COLORS.map(([hex, name]) => (
              <MenuTile
                key={hex}
                title={name}
                aria-label={name}
                onSelect={() => onPick({ hex })}
                className="size-6 cursor-pointer rounded-[2px] border border-[#c8c8c8] outline-none data-[highlighted]:ring-2 data-[highlighted]:ring-[#e86e15]"
                style={{ background: `#${hex}` }}
              />
            ))}
          </div>
          <MenuSeparator />
          <MenuItem onSelect={() => onPick(null)}>No Color</MenuItem>
        </div>
      }
    />
  );
}

function PageNumberButton({ cmd }: { cmd: WordCommands }) {
  return (
    <BigButton
      icon={<Hash />}
      label="Page Number"
      menu={
        <>
          <SubMenu label="Top of Page" icon={<PanelTop />}>
            <MenuItem onSelect={() => cmd.pageNumber('top', 'left')}>Plain Number 1 (Left)</MenuItem>
            <MenuItem onSelect={() => cmd.pageNumber('top', 'center')}>Plain Number 2 (Center)</MenuItem>
            <MenuItem onSelect={() => cmd.pageNumber('top', 'right')}>Plain Number 3 (Right)</MenuItem>
          </SubMenu>
          <SubMenu label="Bottom of Page" icon={<PanelBottom />}>
            <MenuItem onSelect={() => cmd.pageNumber('bottom', 'left')}>Plain Number 1 (Left)</MenuItem>
            <MenuItem onSelect={() => cmd.pageNumber('bottom', 'center')}>Plain Number 2 (Center)</MenuItem>
            <MenuItem onSelect={() => cmd.pageNumber('bottom', 'right')}>Plain Number 3 (Right)</MenuItem>
          </SubMenu>
          <MenuSeparator />
          <MenuItem icon={<FileMinus />} onSelect={cmd.removePageNumbers}>
            Remove Page Numbers
          </MenuItem>
        </>
      }
    />
  );
}

function SymbolGrid({ onPick }: { onPick: (ch: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5 p-1">
      {SYMBOLS.map((ch) => (
        <MenuTile
          key={ch}
          onSelect={() => onPick(ch)}
          className="grid size-8 cursor-pointer place-items-center rounded-[3px] border border-[#e0e0e0] text-[16px] outline-none data-[highlighted]:border-[var(--office-accent)] data-[highlighted]:bg-[#f0f0f0]"
        >
          {ch}
        </MenuTile>
      ))}
    </div>
  );
}

