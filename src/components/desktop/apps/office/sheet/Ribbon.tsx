import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  Bold,
  BookOpen,
  Calculator,
  Calendar,
  ClipboardPaste,
  Copy,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Eraser,
  Eye,
  FileText,
  Hash,
  Italic,
  Landmark,
  Link2,
  Lightbulb,
  ListIndentDecrease,
  ListIndentIncrease,
  PaintBucket,
  Paintbrush,
  Percent,
  Replace,
  Scissors,
  Search,
  SpellCheck,
  Table,
  TextWrap,
  Type,
  Underline,
  ZoomIn,
  Rows3,
  Columns3,
  LocateFixed,
  ListChecks,
  Grid3x3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  BigButton,
  ColorButton,
  ComboBox,
  FontBox,
  FontColorGlyph,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTile,
  Row,
  RowSep,
  SizeBox,
  SmallButton,
  Stack,
  SubMenu,
  ColorPalette,
  RibbonGroup,
} from '../chrome';
import { FONT_SIZES } from '../fonts';
import { FOCUS } from '../accent';
import { CELL_STYLES } from './cellStyles';
import type { Cmd, RibbonState } from './commands';
import { formatLabel } from './formats';
import { FUNCTIONS, type Category } from './functions';
import {
  AccountingIcon,
  BorderIcon,
  CellStylesIcon,
  CommaIcon,
  DeleteCellsIcon,
  FillDownIcon,
  FindIcon,
  FormatCellsIcon,
  FreezeIcon,
  FunctionIcon,
  GridlinesIcon,
  InsertCellsIcon,
  MergeIcon,
  OrientationIcon,
  SigmaIcon,
  SortFilterIcon,
} from './icons';
import { FMT } from './numfmt';
import type { BorderPreset } from './ops';

/**
 * The ribbon's tabs, group by group, in Excel 365's layout and wording.
 */

const FORMAT_CHOICES: { label: string; code: string; sample: string }[] = [
  { label: 'General', code: 'General', sample: 'No specific format' },
  { label: 'Number', code: '0.00', sample: '1234.50' },
  { label: 'Currency', code: '"$"#,##0.00', sample: '$1,234.50' },
  { label: 'Accounting', code: FMT.accounting, sample: '$ 1,234.50' },
  { label: 'Short Date', code: 'm/d/yyyy', sample: '3/14/2026' },
  { label: 'Long Date', code: FMT.longDate, sample: 'Saturday, March 14, 2026' },
  { label: 'Time', code: FMT.time, sample: '9:30:00 AM' },
  { label: 'Percentage', code: '0.00%', sample: '12.50%' },
  { label: 'Fraction', code: '# ?/?', sample: '1 1/2' },
  { label: 'Scientific', code: '0.00E+00', sample: '1.23E+03' },
  { label: 'Text', code: '@', sample: 'Text as typed' },
];

const BORDERS: { preset: BorderPreset; label: string; sides: string; thick?: boolean; double?: boolean }[] = [
  { preset: 'bottom', label: 'Bottom Border', sides: 'b' },
  { preset: 'top', label: 'Top Border', sides: 't' },
  { preset: 'left', label: 'Left Border', sides: 'l' },
  { preset: 'right', label: 'Right Border', sides: 'r' },
  { preset: 'none', label: 'No Border', sides: '' },
  { preset: 'all', label: 'All Borders', sides: 'tblrhv' },
  { preset: 'outside', label: 'Outside Borders', sides: 'tblr' },
  { preset: 'thickOutside', label: 'Thick Outside Borders', sides: 'tblr', thick: true },
  { preset: 'doubleBottom', label: 'Bottom Double Border', sides: 'b', double: true },
  { preset: 'thickBottom', label: 'Thick Bottom Border', sides: 'b', thick: true },
  { preset: 'topBottom', label: 'Top and Bottom Border', sides: 'tb' },
  { preset: 'topThickBottom', label: 'Top and Thick Bottom Border', sides: 'tb', thick: true },
  { preset: 'topDoubleBottom', label: 'Top and Double Bottom Border', sides: 'tb', double: true },
  { preset: 'inside', label: 'Inside Borders', sides: 'hv' },
];

const SYMBOLS = ['©', '®', '™', '€', '£', '¥', '¢', '°', '±', '×', '÷', '≠', '≤', '≥', '≈', '∞', '√', 'π', 'Σ', 'µ', 'Ω', '→', '←', '↑', '↓', '✓', '✗', '•', '…', '§', '¶', '½', '¼', '¾'];

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className={cn('flex h-6 cursor-default items-center gap-1.5 rounded-[4px] px-1 text-[12px] whitespace-nowrap hover:bg-[#f0f0f0]')}>
      <input type="checkbox" checked={checked} onChange={onChange} className={cn('size-3.5 accent-[var(--office-accent)]', FOCUS)} />
      {label}
    </label>
  );
}

function functionMenu(cmd: Cmd, cat: Category) {
  const names = Object.values(FUNCTIONS)
    .filter((f) => f.cat === cat)
    .map((f) => f.name)
    .sort();
  return (
    <>
      {names.map((n) => (
        <MenuItem key={n} onSelect={() => cmd.useFunction(n)} title={FUNCTIONS[n].desc}>
          {n}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={<FunctionIcon className="size-4" />} onSelect={() => cmd.insertFunction(cat)}>
        Insert Function…
      </MenuItem>
    </>
  );
}

const CAT_ICONS: Record<Category, React.ReactNode> = {
  Financial: <Landmark className="text-[#107c41]" />,
  Logical: <Lightbulb className="text-[#c19c00]" />,
  Text: <Type className="text-[#185abd]" />,
  'Date & Time': <Calendar className="text-[#c43e1c]" />,
  'Lookup & Reference': <Search className="text-[#5c2d91]" />,
  'Math & Trig': <Calculator className="text-[#107c41]" />,
  Statistical: <Hash className="text-[#185abd]" />,
  Information: <BookOpen className="text-[#616161]" />,
};

export function SheetRibbon({ tab, cmd, st }: { tab: string; cmd: Cmd; st: RibbonState }) {
  const s = st.style;
  if (tab === 'home') {
    return (
      <>
        <RibbonGroup label="Clipboard">
          <BigButton
            icon={<ClipboardPaste className="text-[#424242]" />}
            label="Paste"
            tip="Paste (Ctrl+V)"
            onClick={() => cmd.paste()}
            split
            menu={
              <>
                <MenuLabel>Paste Options</MenuLabel>
                <MenuItem onSelect={() => cmd.paste('all')} shortcut="Ctrl+V">
                  Paste
                </MenuItem>
                <MenuItem onSelect={() => cmd.paste('formulas')}>Formulas</MenuItem>
                <MenuItem onSelect={() => cmd.paste('noBorders')}>No Borders</MenuItem>
                <MenuItem onSelect={() => cmd.paste('transpose')}>Transpose</MenuItem>
                <MenuSeparator />
                <MenuLabel>Paste Values</MenuLabel>
                <MenuItem onSelect={() => cmd.paste('values')}>Values</MenuItem>
                <MenuItem onSelect={() => cmd.paste('valuesFormats')}>Values &amp; Number Formatting</MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => cmd.paste('formats')}>Formatting</MenuItem>
              </>
            }
          />
          <Stack>
            <SmallButton icon={<Scissors />} label="Cut" tip="Cut (Ctrl+X)" text="Cut" onClick={cmd.cut} />
            <SmallButton icon={<Copy />} label="Copy" tip="Copy (Ctrl+C)" text="Copy" onClick={cmd.copy} />
            <SmallButton icon={<Paintbrush />} label="Format Painter" text="Format Painter" pressed={st.painter} onClick={() => cmd.painter(false)} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Font">
          <Stack>
            <Row>
              <FontBox value={s.font.name} onCommit={cmd.font} theme={st.theme} width={120} />
              <SizeBox value={String(s.font.size)} onCommit={cmd.size} sizes={FONT_SIZES} />
              <SmallButton icon={<AArrowUp />} label="Increase Font Size" tip="Increase Font Size (Ctrl+Shift+>)" onClick={() => cmd.growFont(1)} />
              <SmallButton icon={<AArrowDown />} label="Decrease Font Size" tip="Decrease Font Size (Ctrl+Shift+<)" onClick={() => cmd.growFont(-1)} />
            </Row>
            <Row>
              <SmallButton icon={<Bold />} label="Bold" tip="Bold (Ctrl+B)" pressed={!!s.font.bold} onClick={() => cmd.toggle('bold')} />
              <SmallButton icon={<Italic />} label="Italic" tip="Italic (Ctrl+I)" pressed={!!s.font.italic} onClick={() => cmd.toggle('italic')} />
              <SmallButton
                icon={<Underline />}
                label="Underline"
                tip="Underline (Ctrl+U)"
                pressed={!!s.font.underline}
                onClick={() => cmd.toggle('underline')}
                split
                menu={
                  <>
                    <MenuItem icon={<Underline />} onSelect={() => cmd.underline('single')}>
                      Underline
                    </MenuItem>
                    <MenuItem icon={<span className="text-[13px] leading-none underline decoration-double">U</span>} onSelect={() => cmd.underline('double')}>
                      Double Underline
                    </MenuItem>
                  </>
                }
              />
              <RowSep />
              <SmallButton
                icon={<BorderIcon sides="b" />}
                label="Borders"
                tip="Bottom Border"
                onClick={() => cmd.border('bottom')}
                split
                menuClassName="min-w-60"
                menu={
                  <>
                    <MenuLabel>Borders</MenuLabel>
                    {BORDERS.map((b) => (
                      <MenuItem key={b.preset} icon={<BorderIcon sides={b.sides} thick={b.thick} double={b.double} />} onSelect={() => cmd.border(b.preset)}>
                        {b.label}
                      </MenuItem>
                    ))}
                    <MenuSeparator />
                    <MenuItem icon={<Grid3x3 />} onSelect={() => cmd.formatDialog('border')}>
                      More Borders…
                    </MenuItem>
                  </>
                }
              />
              <RowSep />
              <ColorButton icon={<PaintBucket className="size-4" />} label="Fill Color" color={st.fillColor} onApply={cmd.fillColor} theme={st.theme} none="No Fill" />
              <ColorButton icon={<FontColorGlyph />} label="Font Color" color={st.fontColor} onApply={cmd.fontColor} theme={st.theme} automatic="Automatic" />
            </Row>
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Alignment">
          <Stack>
            <Row>
              <SmallButton icon={<AlignVerticalJustifyStart />} label="Top Align" pressed={s.v === 'top'} onClick={() => cmd.valign('top')} />
              <SmallButton icon={<AlignVerticalJustifyCenter />} label="Middle Align" pressed={s.v === 'center'} onClick={() => cmd.valign('center')} />
              <SmallButton icon={<AlignVerticalJustifyEnd />} label="Bottom Align" pressed={s.v === 'bottom'} onClick={() => cmd.valign('bottom')} />
              <RowSep />
              <SmallButton
                icon={<OrientationIcon />}
                label="Orientation"
                menu={
                  <>
                    <MenuItem onSelect={() => cmd.rotate(45)}>Angle Counterclockwise</MenuItem>
                    <MenuItem onSelect={() => cmd.rotate(135)}>Angle Clockwise</MenuItem>
                    <MenuItem onSelect={() => cmd.rotate(255)}>Vertical Text</MenuItem>
                    <MenuItem onSelect={() => cmd.rotate(90)}>Rotate Text Up</MenuItem>
                    <MenuItem onSelect={() => cmd.rotate(180)}>Rotate Text Down</MenuItem>
                    <MenuItem onSelect={() => cmd.rotate(0)} checked={!s.rotate}>
                      Horizontal
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => cmd.formatDialog('alignment')}>Format Cell Alignment</MenuItem>
                  </>
                }
              />
              <SmallButton icon={<TextWrap />} label="Wrap Text" text="Wrap Text" pressed={!!s.wrap} onClick={cmd.wrap} />
            </Row>
            <Row>
              <SmallButton icon={<AlignLeft />} label="Align Left" pressed={s.h === 'left'} onClick={() => cmd.halign('left')} />
              <SmallButton icon={<AlignCenter />} label="Center" pressed={s.h === 'center'} onClick={() => cmd.halign('center')} />
              <SmallButton icon={<AlignRight />} label="Align Right" pressed={s.h === 'right'} onClick={() => cmd.halign('right')} />
              <RowSep />
              <SmallButton icon={<ListIndentDecrease />} label="Decrease Indent" onClick={() => cmd.indent(-1)} />
              <SmallButton icon={<ListIndentIncrease />} label="Increase Indent" onClick={() => cmd.indent(1)} />
              <SmallButton
                icon={<MergeIcon />}
                label="Merge & Center"
                text="Merge & Center"
                pressed={st.merged}
                onClick={() => (st.merged ? cmd.unmerge() : cmd.merge('center'))}
                split
                menu={
                  <>
                    <MenuItem icon={<MergeIcon />} onSelect={() => cmd.merge('center')}>
                      Merge &amp; Center
                    </MenuItem>
                    <MenuItem onSelect={() => cmd.merge('across')}>Merge Across</MenuItem>
                    <MenuItem onSelect={() => cmd.merge('merge')}>Merge Cells</MenuItem>
                    <MenuItem onSelect={cmd.unmerge}>Unmerge Cells</MenuItem>
                  </>
                }
              />
            </Row>
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Number">
          <Stack>
            <Row>
              <ComboBox
                value={formatLabel(s.numFmt)}
                label="Number Format"
                width={112}
                options={FORMAT_CHOICES.map((f) => ({ value: f.label }))}
                renderOption={(o) => {
                  const f = FORMAT_CHOICES.find((x) => x.label === o.value)!;
                  return (
                    <span className="flex flex-col py-0.5">
                      <span className="text-[12.5px] font-semibold">{f.label}</span>
                      <span className="text-[11px] text-[#616161]">{f.sample}</span>
                    </span>
                  );
                }}
                onCommit={(v) => {
                  const f = FORMAT_CHOICES.find((x) => x.label.toLowerCase() === v.toLowerCase());
                  if (f) cmd.numFmt(f.code);
                  else if (/more/i.test(v)) cmd.formatDialog('number');
                }}
              />
            </Row>
            <Row>
              <SmallButton
                icon={<AccountingIcon />}
                label="Accounting Number Format"
                onClick={() => cmd.numFmt(FMT.accounting)}
                split
                menu={
                  <>
                    <MenuItem onSelect={() => cmd.numFmt(FMT.accounting)}>$ English (United States)</MenuItem>
                    <MenuItem onSelect={() => cmd.numFmt('_([$€-x-euro2] * #,##0.00_);_([$€-x-euro2] * \\(#,##0.00\\);_([$€-x-euro2] * "-"??_);_(@_)')}>€ Euro (€ 123)</MenuItem>
                    <MenuItem onSelect={() => cmd.numFmt('_([$£-809]* #,##0.00_);_([$£-809]* \\(#,##0.00\\);_([$£-809]* "-"??_);_(@_)')}>£ English (United Kingdom)</MenuItem>
                    <MenuItem onSelect={() => cmd.numFmt('_([$¥-411]* #,##0_);_([$¥-411]* \\(#,##0\\);_([$¥-411]* "-"_);_(@_)')}>¥ Japanese</MenuItem>
                    <MenuSeparator />
                    <MenuItem onSelect={() => cmd.formatDialog('number')}>More Accounting Formats…</MenuItem>
                  </>
                }
              />
              <SmallButton icon={<Percent />} label="Percent Style" tip="Percent Style (Ctrl+Shift+%)" onClick={() => cmd.numFmt('0%')} />
              <SmallButton icon={<CommaIcon />} label="Comma Style" onClick={() => cmd.numFmt(FMT.comma)} />
              <RowSep />
              <SmallButton icon={<DecimalsArrowRight />} label="Increase Decimal" onClick={() => cmd.decimals(1)} />
              <SmallButton icon={<DecimalsArrowLeft />} label="Decrease Decimal" onClick={() => cmd.decimals(-1)} />
            </Row>
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Styles">
          <BigButton
            icon={<CellStylesIcon />}
            label="Cell Styles"
            menuClassName="w-[440px]"
            menu={
              <>
                {(['Good, Bad and Neutral', 'Data and Model', 'Titles and Headings', 'Number Format'] as const).map((g) => (
                  <div key={g}>
                    <MenuLabel>{g}</MenuLabel>
                    <div className="flex flex-wrap gap-1 px-1 pb-1">
                      {CELL_STYLES.filter((c) => c.group === g).map((c) => {
                        const look = c.apply({ ...st.style, numFmt: 'General', fill: null, border: {}, font: { name: 'Calibri', size: 11 } }, st.theme);
                        return (
                          <MenuTile
                            key={c.name}
                            onSelect={() => cmd.cellStyle(c.name)}
                            className="flex h-7 w-[100px] cursor-pointer items-center overflow-hidden rounded-[2px] px-1.5 text-[12px] whitespace-nowrap outline-none ring-[#107c41] data-[highlighted]:ring-2"
                            style={{
                              background: look.fill ? `#${look.fill}` : '#fff',
                              color: look.font.color ? `#${look.font.color}` : '#000',
                              fontWeight: look.font.bold ? 700 : 400,
                              fontStyle: look.font.italic ? 'italic' : undefined,
                              borderBottom: look.border.b ? `${look.border.b.style === 'thick' ? 3 : look.border.b.style === 'double' ? 3 : 1}px ${look.border.b.style === 'double' ? 'double' : 'solid'} #${look.border.b.color}` : '1px solid #e0e0e0',
                              border: look.border.l ? `1px solid #${look.border.l.color}` : undefined,
                            }}
                          >
                            {c.name}
                          </MenuTile>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Cells">
          <BigButton
            icon={<InsertCellsIcon />}
            label="Insert"
            split
            onClick={() => cmd.insert('cells')}
            menu={
              <>
                <MenuItem onSelect={() => cmd.insert('cells')}>Insert Cells…</MenuItem>
                <MenuItem icon={<Rows3 />} onSelect={() => cmd.insert('rows')}>
                  Insert Sheet Rows
                </MenuItem>
                <MenuItem icon={<Columns3 />} onSelect={() => cmd.insert('cols')}>
                  Insert Sheet Columns
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => cmd.insert('sheet')}>Insert Sheet</MenuItem>
              </>
            }
          />
          <BigButton
            icon={<DeleteCellsIcon />}
            label="Delete"
            split
            onClick={() => cmd.remove('cells')}
            menu={
              <>
                <MenuItem onSelect={() => cmd.remove('cells')}>Delete Cells…</MenuItem>
                <MenuItem icon={<Rows3 />} onSelect={() => cmd.remove('rows')}>
                  Delete Sheet Rows
                </MenuItem>
                <MenuItem icon={<Columns3 />} onSelect={() => cmd.remove('cols')}>
                  Delete Sheet Columns
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => cmd.remove('sheet')} disabled={st.sheetCount < 2}>
                  Delete Sheet
                </MenuItem>
              </>
            }
          />
          <BigButton
            icon={<FormatCellsIcon />}
            label="Format"
            menu={
              <>
                <MenuLabel>Cell Size</MenuLabel>
                <MenuItem onSelect={cmd.rowHeight}>Row Height…</MenuItem>
                <MenuItem onSelect={() => cmd.autofit('row')}>AutoFit Row Height</MenuItem>
                <MenuItem onSelect={cmd.colWidth}>Column Width…</MenuItem>
                <MenuItem onSelect={() => cmd.autofit('col')}>AutoFit Column Width</MenuItem>
                <MenuItem onSelect={cmd.defaultWidth}>Default Width…</MenuItem>
                <MenuLabel>Visibility</MenuLabel>
                <SubMenu label="Hide & Unhide" icon={<Eye />}>
                  <MenuItem onSelect={() => cmd.hide('row')} shortcut="Ctrl+9">
                    Hide Rows
                  </MenuItem>
                  <MenuItem onSelect={() => cmd.hide('col')} shortcut="Ctrl+0">
                    Hide Columns
                  </MenuItem>
                  <MenuItem onSelect={() => cmd.hide('sheet')}>Hide Sheet</MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => cmd.unhide('row')} shortcut="Ctrl+Shift+9">
                    Unhide Rows
                  </MenuItem>
                  <MenuItem onSelect={() => cmd.unhide('col')}>Unhide Columns</MenuItem>
                  <MenuItem onSelect={() => cmd.unhide('sheet')}>Unhide Sheet…</MenuItem>
                </SubMenu>
                <MenuLabel>Organize Sheets</MenuLabel>
                <MenuItem onSelect={cmd.renameSheet}>Rename Sheet</MenuItem>
                <MenuItem onSelect={cmd.moveSheet}>Move or Copy Sheet…</MenuItem>
                <SubMenu label="Tab Color">
                  <ColorPalette theme={st.theme} onPick={cmd.tabColor} none="No Color" onMore={() => cmd.formatDialog('fill')} />
                </SubMenu>
                <MenuSeparator />
                <MenuItem icon={<FormatCellsIcon className="size-4" />} onSelect={() => cmd.formatDialog()} shortcut="Ctrl+1">
                  Format Cells…
                </MenuItem>
              </>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Editing">
          <Stack>
            <SmallButton
              icon={<SigmaIcon />}
              label="AutoSum"
              text="AutoSum"
              tip="AutoSum (Alt+=)"
              onClick={() => cmd.autoSum('SUM')}
              split
              menu={
                <>
                  <MenuItem onSelect={() => cmd.autoSum('SUM')}>Sum</MenuItem>
                  <MenuItem onSelect={() => cmd.autoSum('AVERAGE')}>Average</MenuItem>
                  <MenuItem onSelect={() => cmd.autoSum('COUNT')}>Count Numbers</MenuItem>
                  <MenuItem onSelect={() => cmd.autoSum('MAX')}>Max</MenuItem>
                  <MenuItem onSelect={() => cmd.autoSum('MIN')}>Min</MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => cmd.insertFunction()}>More Functions…</MenuItem>
                </>
              }
            />
            <SmallButton
              icon={<FillDownIcon />}
              label="Fill"
              text="Fill"
              menu={
                <>
                  <MenuItem onSelect={() => cmd.fill('down')} shortcut="Ctrl+D">
                    Down
                  </MenuItem>
                  <MenuItem onSelect={() => cmd.fill('right')} shortcut="Ctrl+R">
                    Right
                  </MenuItem>
                  <MenuItem onSelect={() => cmd.fill('up')}>Up</MenuItem>
                  <MenuItem onSelect={() => cmd.fill('left')}>Left</MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => cmd.fill('series')}>Series (extend the selection’s pattern)</MenuItem>
                </>
              }
            />
            <SmallButton
              icon={<Eraser />}
              label="Clear"
              text="Clear"
              menu={
                <>
                  <MenuItem onSelect={() => cmd.clear('all')}>Clear All</MenuItem>
                  <MenuItem onSelect={() => cmd.clear('formats')}>Clear Formats</MenuItem>
                  <MenuItem onSelect={() => cmd.clear('contents')} shortcut="Delete">
                    Clear Contents
                  </MenuItem>
                </>
              }
            />
          </Stack>
          <BigButton
            icon={<SortFilterIcon />}
            label="Sort & Filter"
            menu={
              <>
                <MenuItem icon={<ArrowDownAZ />} onSelect={() => cmd.sort(true)}>
                  Sort A to Z
                </MenuItem>
                <MenuItem icon={<ArrowDownZA />} onSelect={() => cmd.sort(false)}>
                  Sort Z to A
                </MenuItem>
                <MenuItem icon={<ArrowUpDown />} onSelect={cmd.customSort}>
                  Custom Sort…
                </MenuItem>
              </>
            }
          />
          <BigButton
            icon={<FindIcon />}
            label="Find & Select"
            menu={
              <>
                <MenuItem icon={<Search />} onSelect={() => cmd.find(false)} shortcut="Ctrl+F">
                  Find…
                </MenuItem>
                <MenuItem icon={<Replace />} onSelect={() => cmd.find(true)} shortcut="Ctrl+H">
                  Replace…
                </MenuItem>
                <MenuItem icon={<LocateFixed />} onSelect={cmd.goTo} shortcut="Ctrl+G">
                  Go To…
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={cmd.selectAll} shortcut="Ctrl+A">
                  Select All
                </MenuItem>
              </>
            }
          />
        </RibbonGroup>
      </>
    );
  }
  if (tab === 'insert') {
    return (
      <>
        <RibbonGroup label="Tables">
          <BigButton icon={<Table className="text-[#107c41]" />} label="Table" disabled tip="Tables aren’t available in Spreadsheet yet" />
        </RibbonGroup>
        <RibbonGroup label="Functions">
          <BigButton icon={<FunctionIcon />} label="Function" tip="Insert Function (Shift+F3)" onClick={() => cmd.insertFunction()} />
        </RibbonGroup>
        <RibbonGroup label="Links">
          <BigButton icon={<Link2 className="text-[#185abd]" />} label="Link" tip="Insert Link (Ctrl+K)" onClick={cmd.link} />
        </RibbonGroup>
        <RibbonGroup label="Symbols">
          <BigButton
            icon={<span className="text-[24px] leading-none text-[#424242]">Ω</span>}
            label="Symbol"
            menuClassName="w-[236px]"
            menu={
              <div className="grid grid-cols-8 gap-0.5 p-1">
                {SYMBOLS.map((ch) => (
                  <MenuTile key={ch} onSelect={() => cmd.useFunction(`symbol:${ch}`)} className="grid size-7 cursor-pointer place-items-center rounded-[3px] text-[15px] outline-none data-[highlighted]:bg-[#e0e0e0]">
                    {ch}
                  </MenuTile>
                ))}
              </div>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Sheets">
          <BigButton icon={<FileText className="text-[#107c41]" />} label="New Sheet" tip="Insert Worksheet (Shift+F11)" onClick={cmd.newSheet} />
        </RibbonGroup>
      </>
    );
  }
  if (tab === 'layout') {
    return (
      <>
        <RibbonGroup label="Page Setup">
          <BigButton
            icon={<FileText className="text-[#616161]" />}
            label="Margins"
            menu={
              <>
                <MenuItem onSelect={() => cmd.margins('normal')}>Normal — Top 0.75″ Bottom 0.75″ Left 0.7″ Right 0.7″</MenuItem>
                <MenuItem onSelect={() => cmd.margins('wide')}>Wide — Top 1″ Bottom 1″ Left 1″ Right 1″</MenuItem>
                <MenuItem onSelect={() => cmd.margins('narrow')}>Narrow — Top 0.75″ Bottom 0.75″ Left 0.25″ Right 0.25″</MenuItem>
              </>
            }
          />
          <BigButton
            icon={<FileText className={cn('text-[#616161]', st.orientation === 'landscape' && 'rotate-90')} />}
            label="Orientation"
            menu={
              <>
                <MenuItem checked={st.orientation === 'portrait'} onSelect={() => cmd.orientation('portrait')}>
                  Portrait
                </MenuItem>
                <MenuItem checked={st.orientation === 'landscape'} onSelect={() => cmd.orientation('landscape')}>
                  Landscape
                </MenuItem>
              </>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Sheet Options">
          <div className="flex gap-3 px-1">
            <div className="flex flex-col">
              <span className="px-1 text-[12px] font-semibold">Gridlines</span>
              <Check label="View" checked={st.gridlines} onChange={() => cmd.view('gridlines')} />
            </div>
            <div className="flex flex-col">
              <span className="px-1 text-[12px] font-semibold">Headings</span>
              <Check label="View" checked={st.headings} onChange={() => cmd.view('headings')} />
            </div>
          </div>
        </RibbonGroup>
      </>
    );
  }
  if (tab === 'formulas') {
    return (
      <>
        <RibbonGroup label="Function Library">
          <BigButton icon={<FunctionIcon />} label="Insert Function" tip="Insert Function (Shift+F3)" onClick={() => cmd.insertFunction()} />
          <BigButton
            icon={<SigmaIcon className="size-7" />}
            label="AutoSum"
            split
            onClick={() => cmd.autoSum('SUM')}
            menu={
              <>
                <MenuItem onSelect={() => cmd.autoSum('SUM')}>Sum</MenuItem>
                <MenuItem onSelect={() => cmd.autoSum('AVERAGE')}>Average</MenuItem>
                <MenuItem onSelect={() => cmd.autoSum('COUNT')}>Count Numbers</MenuItem>
                <MenuItem onSelect={() => cmd.autoSum('MAX')}>Max</MenuItem>
                <MenuItem onSelect={() => cmd.autoSum('MIN')}>Min</MenuItem>
              </>
            }
          />
          {(['Financial', 'Logical', 'Text', 'Date & Time', 'Lookup & Reference', 'Math & Trig'] as Category[]).map((cat) => (
            <BigButton key={cat} icon={CAT_ICONS[cat]} label={cat === 'Lookup & Reference' ? 'Lookup & Ref' : cat} menuClassName="max-h-[60vh]" menu={functionMenu(cmd, cat)} />
          ))}
          <BigButton
            icon={<ListChecks className="text-[#616161]" />}
            label="More Functions"
            menu={
              <>
                {(['Statistical', 'Information'] as Category[]).map((cat) => (
                  <SubMenu key={cat} label={cat} icon={CAT_ICONS[cat]}>
                    {functionMenu(cmd, cat)}
                  </SubMenu>
                ))}
              </>
            }
          />
        </RibbonGroup>
        <RibbonGroup label="Defined Names">
          <BigButton icon={<Table className="text-[#616161]" />} label="Name Manager" tip="Name Manager (Ctrl+F3)" onClick={cmd.nameManager} />
          <Stack>
            <SmallButton icon={<Type />} label="Define Name" text="Define Name" onClick={cmd.defineName} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Formula Auditing">
          <Stack>
            <SmallButton icon={<span className="text-[11px] font-semibold italic">fx</span>} label="Show Formulas" text="Show Formulas" tip="Show Formulas (Ctrl+`)" pressed={st.showFormulas} onClick={cmd.showFormulas} />
          </Stack>
        </RibbonGroup>
        <RibbonGroup label="Calculation">
          <BigButton icon={<Calculator className="text-[#107c41]" />} label="Calculate Now" tip="Calculate Now (F9)" onClick={cmd.calculate} />
        </RibbonGroup>
      </>
    );
  }
  if (tab === 'data') {
    return (
      <>
        <RibbonGroup label="Sort & Filter">
          <Stack>
            <SmallButton icon={<ArrowDownAZ />} label="Sort A to Z" text="" onClick={() => cmd.sort(true)} />
            <SmallButton icon={<ArrowDownZA />} label="Sort Z to A" onClick={() => cmd.sort(false)} />
          </Stack>
          <BigButton icon={<SortFilterIcon />} label="Sort" onClick={cmd.customSort} />
        </RibbonGroup>
        <RibbonGroup label="Data Tools">
          <BigButton icon={<Table className="text-[#c42b1c]" />} label="Remove Duplicates" onClick={cmd.removeDuplicates} />
        </RibbonGroup>
        <RibbonGroup label="Calculation">
          <BigButton icon={<Calculator className="text-[#107c41]" />} label="Calculate Now" onClick={cmd.calculate} />
        </RibbonGroup>
      </>
    );
  }
  if (tab === 'review') {
    return (
      <>
        <RibbonGroup label="Proofing">
          <BigButton icon={<SpellCheck className="text-[#185abd]" />} label="Spelling" disabled tip="Spelling isn’t available in Spreadsheet yet" />
          <BigButton icon={<ListChecks className="text-[#107c41]" />} label="Workbook Statistics" onClick={() => cmd.status('stats')} />
        </RibbonGroup>
      </>
    );
  }
  // View
  return (
    <>
      <RibbonGroup label="Workbook Views">
        <BigButton icon={<GridlinesIcon className="size-7" />} label="Normal" pressed />
      </RibbonGroup>
      <RibbonGroup label="Show">
        <div className="flex flex-col">
          <Check label="Formula Bar" checked={st.formulaBar} onChange={() => cmd.view('formulaBar')} />
          <Check label="Gridlines" checked={st.gridlines} onChange={() => cmd.view('gridlines')} />
          <Check label="Headings" checked={st.headings} onChange={() => cmd.view('headings')} />
        </div>
      </RibbonGroup>
      <RibbonGroup label="Zoom">
        <BigButton icon={<ZoomIn className="text-[#616161]" />} label="Zoom" onClick={cmd.zoomDialog} />
        <BigButton icon={<span className="text-[15px] font-semibold text-[#616161]">100</span>} label="100%" onClick={() => cmd.zoomTo(100)} />
        <BigButton icon={<ZoomIn className="text-[#107c41]" />} label="Zoom to Selection" onClick={cmd.zoomSelection} />
      </RibbonGroup>
      <RibbonGroup label="Window">
        <BigButton
          icon={<FreezeIcon />}
          label="Freeze Panes"
          menuClassName="w-80"
          menu={
            <>
              {st.freeze.rows || st.freeze.cols ? (
                <MenuItem icon={<FreezeIcon className="size-6" />} onSelect={() => cmd.freeze('none')}>
                  <span className="block font-semibold">Unfreeze Panes</span>
                  <span className="block text-[11.5px] text-[#616161]">Unlock all rows and columns to scroll through the entire worksheet.</span>
                </MenuItem>
              ) : (
                <MenuItem icon={<FreezeIcon className="size-6" />} onSelect={() => cmd.freeze('panes')}>
                  <span className="block font-semibold">Freeze Panes</span>
                  <span className="block text-[11.5px] text-[#616161]">Keep rows and columns visible while the rest of the worksheet scrolls (based on current selection).</span>
                </MenuItem>
              )}
              <MenuItem icon={<FreezeIcon kind="row" className="size-6" />} onSelect={() => cmd.freeze('row')}>
                <span className="block font-semibold">Freeze Top Row</span>
                <span className="block text-[11.5px] text-[#616161]">Keep the top row visible while scrolling through the rest of the worksheet.</span>
              </MenuItem>
              <MenuItem icon={<FreezeIcon kind="col" className="size-6" />} onSelect={() => cmd.freeze('col')}>
                <span className="block font-semibold">Freeze First Column</span>
                <span className="block text-[11.5px] text-[#616161]">Keep the first column visible while scrolling through the rest of the worksheet.</span>
              </MenuItem>
            </>
          }
        />
      </RibbonGroup>
    </>
  );
}
