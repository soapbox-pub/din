import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS } from '@/shared/office/accent';
import { Field, OfficeButton, OfficeDialog, Spinner } from '@/shared/office/chrome';
import { FONT_CHOICES, FONT_SIZES, fontStack } from '@/shared/office/fonts';
import { PICKER_NAMES, PICKER_THEME_ORDER, pickerVariants, STANDARD_COLORS, tintColor, type Theme } from '@/shared/office/theme';
import type { FormatTab } from './commands';
import {
  accountingCode,
  categoryOf,
  CATEGORY_NAMES,
  CUSTOM_CODES,
  currencyCode,
  DATE_CODES,
  decimalsOf,
  FRACTION_CODES,
  NEGATIVES,
  numberCode,
  percentCode,
  scientificCode,
  SYMBOLS,
  TIME_CODES,
  type Category as FmtCategory,
  type Negative,
} from './formats';
import { CATEGORIES, FUNCTIONS } from './functions';
import type { BorderSide, BorderStyle, Font, HAlign, Style, VAlign } from './model';
import { formatValue } from './numfmt';
import type { Scalar } from './values';

/** Excel's dialogs: Format Cells, Insert Function, Find and Replace, Go To, and the small ones. */

const LABEL = 'mb-1 block text-[12.5px] font-semibold text-[#424242]';
const LIST = 'overflow-y-auto rounded-[4px] border border-[#c8c8c8] bg-white text-[12.5px]';

function ListBox<T extends string>({ items, value, onChange, render, className, label }: { items: readonly T[]; value: T; onChange: (v: T) => void; render?: (v: T) => React.ReactNode; className?: string; label: string }) {
  return (
    <div role="listbox" aria-label={label} tabIndex={0} className={cn(LIST, FOCUS, className)}
      onKeyDown={(e) => {
        const i = items.indexOf(value);
        if (e.key === 'ArrowDown' && i < items.length - 1) {
          e.preventDefault();
          onChange(items[i + 1]);
        } else if (e.key === 'ArrowUp' && i > 0) {
          e.preventDefault();
          onChange(items[i - 1]);
        }
      }}
    >
      {items.map((it) => (
        <div
          key={it}
          role="option"
          aria-selected={it === value}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(it)}
          className={cn('cursor-default truncate px-2 py-[3px]', it === value ? 'bg-[#d3eadb] text-[#0b3d21]' : 'hover:bg-[#f0f0f0]')}
        >
          {render ? render(it) : it}
        </div>
      ))}
    </div>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="mb-3 flex gap-1 border-b border-[#e0e0e0]">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === value}
          onClick={() => onChange(id)}
          className={cn('relative px-3 pt-1 pb-2 text-[13px]', id === value ? 'font-semibold text-[var(--office-accent)]' : 'text-[#424242] hover:text-[#242424]', FOCUS)}
        >
          {label}
          {id === value && <span className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-[var(--office-accent)]" />}
        </button>
      ))}
    </div>
  );
}

function Swatches({ theme, value, onPick, none }: { theme: Theme; value: string | null; onPick: (hex: string | null) => void; none: string }) {
  const sw = (hex: string, title: string) => (
    <button
      key={title + hex}
      type="button"
      title={title}
      aria-label={title}
      onClick={() => onPick(hex)}
      className={cn('size-[18px] border', value?.toUpperCase() === hex.toUpperCase() ? 'border-[#e86e15] ring-1 ring-[#e86e15]' : 'border-[#e0e0e0] hover:border-[#9e9e9e]', FOCUS)}
      style={{ background: `#${hex}` }}
    />
  );
  return (
    <div className="w-[230px]">
      <button type="button" onClick={() => onPick(null)} className={cn('mb-2 h-7 w-full rounded-[4px] border border-[#d1d1d1] text-[12.5px] hover:bg-[#f5f5f5]', !value && 'border-[var(--office-accent)]', FOCUS)}>
        {none}
      </button>
      <div className="grid grid-cols-10 gap-1">{PICKER_THEME_ORDER.map((n) => sw(theme.colors[n], PICKER_NAMES[n]))}</div>
      <div className="mt-1 grid grid-cols-10 gap-1">
        {[0, 1, 2, 3, 4].map((row) =>
          PICKER_THEME_ORDER.map((n) => {
            const [label, tint] = pickerVariants(theme.colors[n])[row];
            return sw(tintColor(theme.colors[n], tint), `${PICKER_NAMES[n]}, ${label}`);
          }),
        )}
      </div>
      <div className="mt-2 grid grid-cols-10 gap-1">{STANDARD_COLORS.map(([hex, name]) => sw(hex, name))}</div>
      <label className="mt-2 flex items-center gap-2 text-[12.5px]">
        More colors
        <input type="color" value={`#${value ?? '000000'}`} onChange={(e) => onPick(e.target.value.slice(1).toUpperCase())} className="h-6 w-10 cursor-pointer" />
      </label>
    </div>
  );
}

// ---- Format Cells ---------------------------------------------------------------------------------

export interface BorderResult {
  top?: BorderSide | null;
  bottom?: BorderSide | null;
  left?: BorderSide | null;
  right?: BorderSide | null;
  insideH?: BorderSide | null;
  insideV?: BorderSide | null;
}

export interface FormatResult {
  patch: (s: Style) => Style;
  borders: BorderResult | null;
  merge: boolean | null;
}

const NEG_LABELS: Record<Negative, (s: string) => React.ReactNode> = {
  '-': (s) => `-${s}`,
  red: (s) => <span className="text-[#ff0000]">{s}</span>,
  paren: (s) => `(${s})`,
  redParen: (s) => <span className="text-[#ff0000]">({s})</span>,
};

const H_ALIGNS: [HAlign, string][] = [
  ['general', 'General'],
  ['left', 'Left (Indent)'],
  ['center', 'Center'],
  ['right', 'Right (Indent)'],
  ['fill', 'Fill'],
  ['justify', 'Justify'],
  ['centerContinuous', 'Center Across Selection'],
  ['distributed', 'Distributed (Indent)'],
];
const V_ALIGNS: [VAlign, string][] = [
  ['top', 'Top'],
  ['center', 'Center'],
  ['bottom', 'Bottom'],
  ['justify', 'Justify'],
  ['distributed', 'Distributed'],
];
const LINE_STYLES: BorderStyle[] = ['hair', 'dotted', 'dashDotDot', 'dashDot', 'dashed', 'thin', 'mediumDashDotDot', 'slantDashDot', 'mediumDashDot', 'mediumDashed', 'medium', 'thick', 'double'];

function LineSample({ style }: { style: BorderStyle }) {
  const w = style === 'thick' ? 3 : style.startsWith('medium') || style === 'slantDashDot' ? 2 : 1;
  const dash = /dashDotDot/i.test(style) ? '6 2 2 2 2 2' : /dashDot/i.test(style) ? '6 2 2 2' : /dashed/i.test(style) ? '5 2' : style === 'dotted' ? '1 2' : style === 'hair' ? '1 1' : undefined;
  return (
    <svg width="56" height="10" aria-hidden>
      {style === 'double' ? (
        <path d="M2 3h52M2 7h52" stroke="#000" />
      ) : (
        <path d="M2 5h52" stroke="#000" strokeWidth={w} strokeDasharray={dash} />
      )}
    </svg>
  );
}

export function FormatCellsDialog({
  initialTab,
  style,
  theme,
  sample,
  date1904,
  multi,
  merged,
  onOk,
  onCancel,
}: {
  initialTab: FormatTab;
  style: Style;
  theme: Theme;
  sample: Scalar;
  date1904: boolean;
  multi: boolean;
  merged: boolean;
  onOk: (r: FormatResult) => void;
  onCancel: () => void;
}) {
  const [tab, setTab] = useState<FormatTab>(initialTab);
  const [touched, setTouched] = useState(new Set<string>());
  const touch = (k: string) => setTouched((t) => new Set(t).add(k));
  // Number
  const [code, setCode] = useState(style.numFmt);
  const [cat, setCat] = useState<FmtCategory>(categoryOf(style.numFmt));
  const [decimals, setDecimals] = useState(decimalsOf(style.numFmt) || (categoryOf(style.numFmt) === 'General' ? 2 : 0));
  const [thousands, setThousands] = useState(style.numFmt.includes(','));
  const [negative, setNegative] = useState<Negative>(style.numFmt.includes('[Red]') ? (style.numFmt.includes('(') ? 'redParen' : 'red') : style.numFmt.includes('\\(') ? 'paren' : '-');
  const [symbol, setSymbol] = useState(/€/.test(style.numFmt) ? '€' : /£/.test(style.numFmt) ? '£' : /¥/.test(style.numFmt) ? '¥' : '$');
  const setNum = (c: string) => {
    setCode(c);
    touch('numFmt');
  };
  const build = (c: FmtCategory, d = decimals, th = thousands, neg = negative, sym = symbol): string | null => {
    switch (c) {
      case 'General':
        return 'General';
      case 'Number':
        return numberCode(d, th, neg);
      case 'Currency':
        return currencyCode(d, sym, neg);
      case 'Accounting':
        return accountingCode(d, sym);
      case 'Percentage':
        return percentCode(d);
      case 'Scientific':
        return scientificCode(d);
      case 'Text':
        return '@';
      default:
        return null;
    }
  };
  const update = (c: FmtCategory, d = decimals, th = thousands, neg = negative, sym = symbol) => {
    const b = build(c, d, th, neg, sym);
    if (b) setNum(b);
  };
  // Alignment
  const [h, setH] = useState<HAlign>(style.h);
  const [v, setV] = useState<VAlign>(style.v);
  const [indent, setIndent] = useState(style.indent ?? 0);
  const [wrap, setWrap] = useState(!!style.wrap);
  const [shrink, setShrink] = useState(!!style.shrink);
  const [merge, setMerge] = useState(merged);
  const [rotate, setRotate] = useState(style.rotate && style.rotate <= 90 ? style.rotate : style.rotate && style.rotate !== 255 ? 90 - style.rotate : 0);
  // Font
  const [font, setFont] = useState<Font>(style.font);
  const setF = (f: Partial<Font>) => {
    setFont((x) => ({ ...x, ...f }));
    touch('font');
  };
  // Border
  const [lineStyle, setLineStyle] = useState<BorderStyle>('thin');
  const [lineColor, setLineColor] = useState('000000');
  const [borders, setBorders] = useState<BorderResult>({
    top: style.border.t ?? null,
    bottom: style.border.b ?? null,
    left: style.border.l ?? null,
    right: style.border.r ?? null,
    insideH: multi ? null : undefined,
    insideV: multi ? null : undefined,
  });
  const line = (): BorderSide => ({ style: lineStyle, color: lineColor });
  const toggleSide = (k: keyof BorderResult) => {
    touch('border');
    setBorders((b) => ({ ...b, [k]: b[k] ? null : line() }));
  };
  // Fill
  const [fill, setFill] = useState<string | null>(style.fill);

  const preview = formatValue(typeof sample === 'number' || sample === null ? (sample ?? 1234.5) : sample, code, date1904, 20);
  const negPreview = (n: Negative) => NEG_LABELS[n](cat === 'Currency' ? `${symbol}1,234${decimals ? `.${'1'.padEnd(decimals, '0')}` : ''}` : `1${thousands ? ',' : ''}234${decimals ? `.${'1'.padEnd(decimals, '0')}` : ''}`);

  const ok = () => {
    const t = touched;
    onOk({
      patch: (s) => {
        let n = { ...s };
        if (t.has('numFmt')) n.numFmt = code;
        if (t.has('h')) n.h = h;
        if (t.has('v')) n.v = v;
        if (t.has('indent')) n.indent = indent || undefined;
        if (t.has('wrap')) n.wrap = wrap || undefined;
        if (t.has('shrink')) n.shrink = shrink || undefined;
        if (t.has('rotate')) n.rotate = rotate > 0 ? rotate : rotate < 0 ? 90 - rotate : undefined;
        if (t.has('font')) n = { ...n, font: { ...font } };
        if (t.has('fill')) n.fill = fill;
        return n;
      },
      borders: t.has('border') ? borders : null,
      merge: t.has('merge') ? merge : null,
    });
  };

  const fontStyles = ['Regular', 'Italic', 'Bold', 'Bold Italic'] as const;
  const fontStyle = font.bold && font.italic ? 'Bold Italic' : font.bold ? 'Bold' : font.italic ? 'Italic' : 'Regular';

  return (
    <OfficeDialog title="Format Cells" onOk={ok} onCancel={onCancel} width={620}>
      <Tabs<FormatTab>
        tabs={[
          ['number', 'Number'],
          ['alignment', 'Alignment'],
          ['font', 'Font'],
          ['border', 'Border'],
          ['fill', 'Fill'],
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="min-h-[340px]">
        {tab === 'number' && (
          <div className="flex gap-4">
            <div className="w-36 shrink-0">
              <span className={LABEL}>Category:</span>
              <ListBox
                label="Category"
                items={CATEGORY_NAMES}
                value={cat}
                className="h-[300px]"
                onChange={(c) => {
                  setCat(c);
                  if (c === 'Date') setNum('m/d/yyyy');
                  else if (c === 'Time') setNum(TIME_CODES[0]);
                  else if (c === 'Fraction') setNum('# ?/?');
                  else if (c !== 'Custom') update(c);
                }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <fieldset className="mb-3 rounded-[4px] border border-[#e0e0e0] px-3 py-2">
                <legend className="px-1 text-[12px] text-[#616161]">Sample</legend>
                <div className="h-5 truncate text-[13px]" style={{ color: preview.color }}>
                  {preview.text || ' '}
                </div>
              </fieldset>
              {cat === 'General' && <p className="text-[12.5px] text-[#424242]">General format cells have no specific number format.</p>}
              {(cat === 'Number' || cat === 'Currency' || cat === 'Accounting' || cat === 'Percentage' || cat === 'Scientific') && (
                <Field label="Decimal places:" className="justify-start">
                  <Spinner value={decimals} min={0} max={30} width={72} onChange={(d) => (setDecimals(d), update(cat, d))} />
                </Field>
              )}
              {cat === 'Number' && (
                <label className="my-2 flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={thousands} onChange={(e) => (setThousands(e.target.checked), update(cat, decimals, e.target.checked))} className="accent-[var(--office-accent)]" />
                  Use 1000 Separator (,)
                </label>
              )}
              {(cat === 'Currency' || cat === 'Accounting') && (
                <Field label="Symbol:" className="justify-start">
                  <select value={symbol} onChange={(e) => (setSymbol(e.target.value), update(cat, decimals, thousands, negative, e.target.value))} className={cn(FIELD, 'w-40')}>
                    {SYMBOLS.map(([sym, label]) => (
                      <option key={label} value={sym}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(cat === 'Number' || cat === 'Currency') && (
                <>
                  <span className={cn(LABEL, 'mt-2')}>Negative numbers:</span>
                  <ListBox label="Negative numbers" items={NEGATIVES} value={negative} className="h-24" render={negPreview} onChange={(n) => (setNegative(n), update(cat, decimals, thousands, n))} />
                </>
              )}
              {(cat === 'Date' || cat === 'Time' || cat === 'Fraction') && (
                <>
                  <span className={LABEL}>Type:</span>
                  <ListBox
                    label="Type"
                    items={cat === 'Date' ? DATE_CODES : cat === 'Time' ? TIME_CODES : FRACTION_CODES.map((f) => f[0])}
                    value={code}
                    className="h-[230px]"
                    onChange={setNum}
                    render={(c) => (cat === 'Fraction' ? FRACTION_CODES.find((f) => f[0] === c)?.[1] : formatValue(typeof sample === 'number' ? sample : 46095.3958, c, date1904, 40).text)}
                  />
                </>
              )}
              {cat === 'Text' && <p className="text-[12.5px] text-[#424242]">Text format cells are treated as text even when a number is in the cell. The cell is displayed exactly as entered.</p>}
              {cat === 'Custom' && (
                <>
                  <span className={LABEL}>Type:</span>
                  <input value={code} onChange={(e) => setNum(e.target.value)} className={cn(FIELD, 'mb-2 w-full font-mono text-[12px]')} aria-label="Custom format" />
                  <ListBox label="Formats" items={CUSTOM_CODES} value={code} className="h-[200px] font-mono text-[12px]" onChange={setNum} />
                </>
              )}
            </div>
          </div>
        )}
        {tab === 'alignment' && (
          <div className="flex gap-6">
            <div className="flex-1 space-y-2">
              <span className={LABEL}>Text alignment</span>
              <Field label="Horizontal:">
                <select value={h} onChange={(e) => (setH(e.target.value as HAlign), touch('h'))} className={cn(FIELD, 'w-52')}>
                  {H_ALIGNS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vertical:">
                <select value={v} onChange={(e) => (setV(e.target.value as VAlign), touch('v'))} className={cn(FIELD, 'w-52')}>
                  {V_ALIGNS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Indent:">
                <Spinner value={indent} min={0} max={250} width={72} onChange={(n) => (setIndent(n), touch('indent'))} />
              </Field>
              <span className={cn(LABEL, 'pt-2')}>Text control</span>
              {(
                [
                  ['Wrap text', wrap, (b: boolean) => (setWrap(b), touch('wrap'))],
                  ['Shrink to fit', shrink, (b: boolean) => (setShrink(b), touch('shrink'))],
                  ['Merge cells', merge, (b: boolean) => (setMerge(b), touch('merge'))],
                ] as const
              ).map(([label, val, set]) => (
                <label key={label} className="flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} className="accent-[var(--office-accent)]" />
                  {label}
                </label>
              ))}
            </div>
            <div className="w-40">
              <span className={LABEL}>Orientation</span>
              <div className="relative mb-2 grid h-32 place-items-center rounded-[4px] border border-[#e0e0e0]">
                <span className="text-[13px] text-[#242424]" style={{ transform: `rotate(${-rotate}deg)` }}>
                  Text ———
                </span>
              </div>
              <Field label="Degrees:">
                <Spinner value={rotate} min={-90} max={90} width={72} onChange={(n) => (setRotate(n), touch('rotate'))} />
              </Field>
            </div>
          </div>
        )}
        {tab === 'font' && (
          <div className="grid grid-cols-[1fr_140px_80px] gap-3">
            <div>
              <span className={LABEL}>Font:</span>
              <input value={font.name} onChange={(e) => setF({ name: e.target.value })} className={cn(FIELD, 'mb-1 w-full')} aria-label="Font" />
              <ListBox label="Fonts" items={FONT_CHOICES} value={font.name} className="h-40" onChange={(n) => setF({ name: n })} render={(n) => <span style={{ fontFamily: fontStack(n) }}>{n}</span>} />
            </div>
            <div>
              <span className={LABEL}>Font style:</span>
              <input value={fontStyle} readOnly className={cn(FIELD, 'mb-1 w-full')} aria-label="Font style" />
              <ListBox label="Font styles" items={fontStyles} value={fontStyle} className="h-40" onChange={(st) => setF({ bold: st.includes('Bold') || undefined, italic: st.includes('Italic') || undefined })} />
            </div>
            <div>
              <span className={LABEL}>Size:</span>
              <input value={font.size} onChange={(e) => Number(e.target.value) > 0 && setF({ size: Number(e.target.value) })} className={cn(FIELD, 'mb-1 w-full')} aria-label="Size" />
              <ListBox label="Sizes" items={FONT_SIZES.map(String)} value={String(font.size)} className="h-40" onChange={(n) => setF({ size: Number(n) })} />
            </div>
            <div className="col-span-3 flex gap-6">
              <div className="space-y-2">
                <Field label="Underline:">
                  <select value={font.underline ?? 'none'} onChange={(e) => setF({ underline: e.target.value === 'none' ? undefined : (e.target.value as Font['underline']) })} className={cn(FIELD, 'w-40')}>
                    <option value="none">None</option>
                    <option value="single">Single</option>
                    <option value="double">Double</option>
                    <option value="singleAccounting">Single Accounting</option>
                    <option value="doubleAccounting">Double Accounting</option>
                  </select>
                </Field>
                <span className={LABEL}>Effects</span>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={!!font.strike} onChange={(e) => setF({ strike: e.target.checked || undefined })} className="accent-[var(--office-accent)]" />
                  Strikethrough
                </label>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={font.vert === 'superscript'} onChange={(e) => setF({ vert: e.target.checked ? 'superscript' : undefined })} className="accent-[var(--office-accent)]" />
                  Superscript
                </label>
                <label className="flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" checked={font.vert === 'subscript'} onChange={(e) => setF({ vert: e.target.checked ? 'subscript' : undefined })} className="accent-[var(--office-accent)]" />
                  Subscript
                </label>
              </div>
              <div>
                <span className={LABEL}>Color:</span>
                <Swatches theme={theme} value={font.color ?? null} onPick={(c) => setF({ color: c ?? undefined })} none="Automatic" />
              </div>
              <div className="flex-1">
                <span className={LABEL}>Preview</span>
                <div className="grid h-24 place-items-center rounded-[4px] border border-[#e0e0e0] bg-white">
                  <span
                    style={{
                      fontFamily: fontStack(font.name),
                      fontSize: `${Math.min(font.size, 28) * 1.333}px`,
                      fontWeight: font.bold ? 700 : 400,
                      fontStyle: font.italic ? 'italic' : 'normal',
                      textDecoration: [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].join(' ').trim() || 'none',
                      color: font.color ? `#${font.color}` : '#000',
                    }}
                  >
                    AaBbCcYyZz
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
        {tab === 'border' && (
          <div className="flex gap-6">
            <div className="w-36">
              <span className={LABEL}>Line style:</span>
              <ListBox label="Line style" items={LINE_STYLES} value={lineStyle} className="h-56" onChange={setLineStyle} render={(st) => <LineSample style={st} />} />
              <span className={cn(LABEL, 'mt-2')}>Color:</span>
              <input type="color" value={`#${lineColor}`} onChange={(e) => setLineColor(e.target.value.slice(1).toUpperCase())} className="h-7 w-full cursor-pointer" aria-label="Line color" />
            </div>
            <div className="flex-1">
              <span className={LABEL}>Presets</span>
              <div className="mb-4 flex gap-3">
                {(
                  [
                    ['None', () => setBorders({ top: null, bottom: null, left: null, right: null, insideH: multi ? null : undefined, insideV: multi ? null : undefined })],
                    ['Outline', () => setBorders((b) => ({ ...b, top: line(), bottom: line(), left: line(), right: line() }))],
                    ['Inside', () => multi && setBorders((b) => ({ ...b, insideH: line(), insideV: line() }))],
                  ] as const
                ).map(([label, fn]) => (
                  <button key={label} type="button" disabled={label === 'Inside' && !multi} onClick={() => (fn(), touch('border'))} className={cn('flex w-16 flex-col items-center gap-1 rounded-[4px] p-1 text-[12px] hover:bg-[#f0f0f0] disabled:opacity-40', FOCUS)}>
                    <span className="grid size-10 place-items-center rounded-[3px] border border-[#c8c8c8] bg-white">
                      <span className={cn('size-6', label === 'Outline' ? 'border-2 border-black' : label === 'Inside' ? 'bg-[linear-gradient(#000,#000)_center/2px_100%_no-repeat,linear-gradient(#000,#000)_center/100%_2px_no-repeat] border border-dashed border-[#9e9e9e]' : 'border border-dashed border-[#9e9e9e]')} />
                    </span>
                    {label}
                  </button>
                ))}
              </div>
              <span className={LABEL}>Border</span>
              <div className="flex items-start gap-2">
                <div className="flex flex-col gap-1">
                  {(['top', 'insideH', 'bottom'] as const).map((k) => (
                    <button key={k} type="button" disabled={k === 'insideH' && !multi} onClick={() => toggleSide(k)} aria-pressed={!!borders[k]} className={cn('grid size-8 place-items-center rounded-[3px] border text-[10px] disabled:opacity-40', borders[k] ? 'border-[var(--office-accent)] bg-[#d3eadb]' : 'border-[#c8c8c8] bg-white', FOCUS)}>
                      {k === 'top' ? '▔' : k === 'bottom' ? '▁' : '─'}
                    </button>
                  ))}
                </div>
                <div className="relative grid h-[104px] w-[180px] place-items-center bg-white">
                  <div className="absolute inset-3 grid grid-cols-2 grid-rows-2 border border-dashed border-[#c8c8c8] text-[12px] text-[#9e9e9e]">
                    {['Text', 'Text', 'Text', 'Text'].slice(0, multi ? 4 : 1).map((t, i) => (
                      <span key={i} className={cn('grid place-items-center', !multi && 'col-span-2 row-span-2')}>
                        {t}
                      </span>
                    ))}
                  </div>
                  {borders.top && <span className="absolute inset-x-3 top-3 h-0 border-t-2" style={{ borderColor: `#${borders.top.color}` }} />}
                  {borders.bottom && <span className="absolute inset-x-3 bottom-3 h-0 border-b-2" style={{ borderColor: `#${borders.bottom.color}` }} />}
                  {borders.left && <span className="absolute inset-y-3 left-3 w-0 border-l-2" style={{ borderColor: `#${borders.left.color}` }} />}
                  {borders.right && <span className="absolute inset-y-3 right-3 w-0 border-r-2" style={{ borderColor: `#${borders.right.color}` }} />}
                  {borders.insideH && <span className="absolute inset-x-3 top-1/2 h-0 border-t-2" style={{ borderColor: `#${borders.insideH.color}` }} />}
                  {borders.insideV && <span className="absolute inset-y-3 left-1/2 w-0 border-l-2" style={{ borderColor: `#${borders.insideV.color}` }} />}
                </div>
              </div>
              <div className="mt-1 ml-10 flex gap-1">
                {(['left', 'insideV', 'right'] as const).map((k) => (
                  <button key={k} type="button" disabled={k === 'insideV' && !multi} onClick={() => toggleSide(k)} aria-pressed={!!borders[k]} className={cn('grid size-8 place-items-center rounded-[3px] border text-[10px] disabled:opacity-40', borders[k] ? 'border-[var(--office-accent)] bg-[#d3eadb]' : 'border-[#c8c8c8] bg-white', FOCUS)}>
                    {k === 'left' ? '▏' : k === 'right' ? '▕' : '│'}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-[12px] text-[#616161]">Click a preset, the preview, or the buttons above to apply borders.</p>
            </div>
          </div>
        )}
        {tab === 'fill' && (
          <div className="flex gap-8">
            <div>
              <span className={LABEL}>Background Color:</span>
              <Swatches theme={theme} value={fill} onPick={(c) => (setFill(c), touch('fill'))} none="No Color" />
            </div>
            <div className="flex-1">
              <span className={LABEL}>Sample</span>
              <div className="h-16 rounded-[4px] border border-[#e0e0e0]" style={{ background: fill ? `#${fill}` : '#fff' }} />
            </div>
          </div>
        )}
      </div>
    </OfficeDialog>
  );
}

// ---- Insert Function ------------------------------------------------------------------------------

export function InsertFunctionDialog({ initialCategory, recent, onOk, onCancel }: { initialCategory?: string; recent: string[]; onOk: (name: string) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(initialCategory ?? (recent.length ? 'Most Recently Used' : 'All'));
  const list = useMemo(() => {
    const all = Object.values(FUNCTIONS);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return all
        .filter((f) => f.name.toLowerCase().includes(q) || f.desc.toLowerCase().includes(q))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
        .map((f) => f.name);
    }
    if (cat === 'Most Recently Used') return recent.length ? recent : ['SUM', 'AVERAGE', 'IF', 'HYPERLINK', 'COUNT', 'MAX', 'SIN', 'SUMIF', 'PMT', 'STDEV'];
    if (cat === 'All') return all.map((f) => f.name).sort();
    return all.filter((f) => f.cat === cat).map((f) => f.name).sort();
  }, [query, cat, recent]);
  const [pick, setPick] = useState<string>(list[0] ?? 'SUM');
  const current = list.includes(pick) ? pick : list[0];
  const fn = current ? FUNCTIONS[current] : undefined;
  return (
    <OfficeDialog title="Insert Function" onOk={() => current && onOk(current)} onCancel={onCancel} width={520} okDisabled={!current}>
      <span className={LABEL}>Search for a function:</span>
      <input data-autofocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type a brief description of what you want to do and then click Go" className={cn(FIELD, 'mb-3 w-full')} aria-label="Search for a function" />
      <Field label="Or select a category:" className="mb-2 justify-start">
        <select value={cat} onChange={(e) => (setCat(e.target.value), setQuery(''))} className={cn(FIELD, 'w-56')}>
          <option>Most Recently Used</option>
          <option>All</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <span className={LABEL}>Select a function:</span>
      <div role="listbox" aria-label="Functions" className={cn(LIST, 'h-44')}>
        {list.map((n) => (
          <div
            key={n}
            role="option"
            aria-selected={n === current}
            onClick={() => setPick(n)}
            onDoubleClick={() => onOk(n)}
            className={cn('cursor-default px-2 py-[3px]', n === current ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}
          >
            {n}
          </div>
        ))}
        {!list.length && <p className="px-2 py-2 text-[#616161]">No functions match. Try other words.</p>}
      </div>
      {fn && (
        <div className="mt-3 min-h-[60px]">
          <p className="text-[12.5px] font-semibold">{fn.sig}</p>
          <p className="mt-1 text-[12.5px] text-[#424242]">{fn.desc}</p>
        </div>
      )}
    </OfficeDialog>
  );
}

// ---- Find and Replace -----------------------------------------------------------------------------

export interface FindOptions {
  what: string;
  with: string;
  matchCase: boolean;
  entire: boolean;
  inFormulas: boolean;
  byColumns: boolean;
  workbook: boolean;
}

export function FindDialog({ replace, initial, onFind, onReplace, onReplaceAll, onClose }: { replace: boolean; initial: string; onFind: (o: FindOptions) => string | null; onReplace: (o: FindOptions) => string | null; onReplaceAll: (o: FindOptions) => string; onClose: () => void }) {
  const [tab, setTab] = useState<'find' | 'replace'>(replace ? 'replace' : 'find');
  const [o, setO] = useState<FindOptions>({ what: initial, with: '', matchCase: false, entire: false, inFormulas: true, byColumns: false, workbook: false });
  const [more, setMore] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (p: Partial<FindOptions>) => setO((x) => ({ ...x, ...p }));
  return (
    <OfficeDialog
      title="Find and Replace"
      onCancel={onClose}
      onOk={() => setMsg(onFind(o))}
      width={480}
      footer={
        <>
          {tab === 'replace' && (
            <>
              <OfficeButton onClick={() => setMsg(onReplaceAll(o))}>Replace All</OfficeButton>
              <OfficeButton onClick={() => setMsg(onReplace(o))}>Replace</OfficeButton>
            </>
          )}
          <OfficeButton primary onClick={() => setMsg(onFind(o))}>
            Find Next
          </OfficeButton>
          <OfficeButton onClick={onClose}>Close</OfficeButton>
        </>
      }
    >
      <Tabs
        tabs={[
          ['find', 'Find'],
          ['replace', 'Replace'],
        ]}
        value={tab}
        onChange={setTab}
      />
      <Field label="Find what:">
        <input data-autofocus value={o.what} onChange={(e) => set({ what: e.target.value })} className={cn(FIELD, 'w-72')} />
      </Field>
      {tab === 'replace' && (
        <Field label="Replace with:">
          <input value={o.with} onChange={(e) => set({ with: e.target.value })} className={cn(FIELD, 'w-72')} />
        </Field>
      )}
      {more && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
          <Field label="Within:">
            <select value={o.workbook ? 'wb' : 'sheet'} onChange={(e) => set({ workbook: e.target.value === 'wb' })} className={cn(FIELD, 'w-28')}>
              <option value="sheet">Sheet</option>
              <option value="wb">Workbook</option>
            </select>
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={o.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} className="accent-[var(--office-accent)]" /> Match case
          </label>
          <Field label="Search:">
            <select value={o.byColumns ? 'cols' : 'rows'} onChange={(e) => set({ byColumns: e.target.value === 'cols' })} className={cn(FIELD, 'w-28')}>
              <option value="rows">By Rows</option>
              <option value="cols">By Columns</option>
            </select>
          </Field>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={o.entire} onChange={(e) => set({ entire: e.target.checked })} className="accent-[var(--office-accent)]" /> Match entire cell contents
          </label>
          <Field label="Look in:">
            <select value={o.inFormulas ? 'f' : 'v'} onChange={(e) => set({ inFormulas: e.target.value === 'f' })} className={cn(FIELD, 'w-28')}>
              <option value="f">Formulas</option>
              <option value="v">Values</option>
            </select>
          </Field>
        </div>
      )}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[12.5px] text-[#616161]">{msg}</span>
        <OfficeButton onClick={() => setMore((m) => !m)} className="min-w-0">
          Options {more ? '<<' : '>>'}
        </OfficeButton>
      </div>
    </OfficeDialog>
  );
}

// ---- Small dialogs --------------------------------------------------------------------------------

export function GoToDialog({ names, onOk, onCancel }: { names: string[]; onOk: (ref: string) => void; onCancel: () => void }) {
  const [ref, setRef] = useState('');
  return (
    <OfficeDialog title="Go To" onOk={() => ref.trim() && onOk(ref.trim())} onCancel={onCancel} width={360}>
      <span className={LABEL}>Go to:</span>
      <div role="listbox" aria-label="Names" className={cn(LIST, 'mb-3 h-36')}>
        {names.map((n) => (
          <div key={n} role="option" aria-selected={n === ref} onClick={() => setRef(n)} onDoubleClick={() => onOk(n)} className={cn('cursor-default px-2 py-[3px]', n === ref ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}>
            {n}
          </div>
        ))}
      </div>
      <Field label="Reference:">
        <input data-autofocus value={ref} onChange={(e) => setRef(e.target.value)} className={cn(FIELD, 'w-48')} />
      </Field>
    </OfficeDialog>
  );
}

export function NumberDialog({ title, label, value, min = 0, max = 409, decimals = 2, onOk, onCancel }: { title: string; label: string; value: number; min?: number; max?: number; decimals?: number; onOk: (v: number) => void; onCancel: () => void }) {
  const [text, setText] = useState(String(Number(value.toFixed(decimals))));
  const n = Number(text);
  const valid = text.trim() !== '' && Number.isFinite(n) && n >= min && n <= max;
  return (
    <OfficeDialog title={title} onOk={() => valid && onOk(n)} onCancel={onCancel} okDisabled={!valid} width={300}>
      <Field label={label}>
        <input data-autofocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} className={cn(FIELD, 'w-24')} inputMode="decimal" />
      </Field>
    </OfficeDialog>
  );
}

export function ChoiceDialog<T extends string>({ title, label, choices, initial, onOk, onCancel }: { title: string; label?: string; choices: [T, string][]; initial: T; onOk: (v: T) => void; onCancel: () => void }) {
  const [v, setV] = useState<T>(initial);
  return (
    <OfficeDialog title={title} onOk={() => onOk(v)} onCancel={onCancel} width={300}>
      {label && <span className={LABEL}>{label}</span>}
      <div role="radiogroup" className="space-y-1.5">
        {choices.map(([id, text]) => (
          <label key={id} className="flex items-center gap-2 text-[13px]">
            <input type="radio" name={title} checked={v === id} onChange={() => setV(id)} className="accent-[var(--office-accent)]" />
            {text}
          </label>
        ))}
      </div>
    </OfficeDialog>
  );
}

export function MessageDialog({ title, text, onClose }: { title: string; text: React.ReactNode; onClose: () => void }) {
  return (
    <OfficeDialog title={title} onOk={onClose} onCancel={onClose} width={400} footer={<OfficeButton primary className="primary" onClick={onClose}>OK</OfficeButton>}>
      <div className="text-[13px] leading-relaxed whitespace-pre-line">{text}</div>
    </OfficeDialog>
  );
}

export function ZoomDialog({ zoom, onOk, onCancel }: { zoom: number; onOk: (z: number | 'fit') => void; onCancel: () => void }) {
  const presets = [200, 100, 75, 50, 25];
  const [choice, setChoice] = useState<string>(presets.includes(zoom) ? String(zoom) : 'custom');
  const [custom, setCustom] = useState(String(zoom));
  const ok = () => onOk(choice === 'fit' ? 'fit' : choice === 'custom' ? Math.max(10, Math.min(400, Number(custom) || 100)) : Number(choice));
  return (
    <OfficeDialog title="Zoom" onOk={ok} onCancel={onCancel} width={260}>
      <span className={LABEL}>Magnification</span>
      <div className="space-y-1.5 text-[13px]">
        {[...presets.map((p) => [String(p), `${p}%`]), ['fit', 'Fit selection'], ['custom', 'Custom:']].map(([id, label]) => (
          <label key={id} className="flex items-center gap-2">
            <input type="radio" name="zoom" checked={choice === id} onChange={() => setChoice(id)} className="accent-[var(--office-accent)]" />
            {label}
            {id === 'custom' && <input value={custom} onFocus={() => setChoice('custom')} onChange={(e) => setCustom(e.target.value)} className={cn(FIELD, 'h-6 w-16')} aria-label="Custom zoom" />}
            {id === 'custom' && '%'}
          </label>
        ))}
      </div>
    </OfficeDialog>
  );
}

export function MoveSheetDialog({ sheets, current, onOk, onCancel }: { sheets: string[]; current: number; onOk: (before: number, copy: boolean) => void; onCancel: () => void }) {
  const [before, setBefore] = useState(Math.min(current + 1, sheets.length));
  const [copy, setCopy] = useState(false);
  const items = [...sheets, '(move to end)'];
  return (
    <OfficeDialog title="Move or Copy" onOk={() => onOk(before, copy)} onCancel={onCancel} width={340}>
      <span className={LABEL}>Before sheet:</span>
      <div role="listbox" aria-label="Before sheet" className={cn(LIST, 'mb-3 h-40')}>
        {items.map((n, i) => (
          <div key={i} role="option" aria-selected={i === before} onClick={() => setBefore(i)} className={cn('cursor-default px-2 py-[3px]', i === before ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}>
            {n}
          </div>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} className="accent-[var(--office-accent)]" /> Create a copy
      </label>
    </OfficeDialog>
  );
}

export function PickListDialog({ title, label, items, onOk, onCancel }: { title: string; label: string; items: string[]; onOk: (i: number) => void; onCancel: () => void }) {
  const [i, setI] = useState(0);
  return (
    <OfficeDialog title={title} onOk={() => items.length && onOk(i)} onCancel={onCancel} width={320}>
      <span className={LABEL}>{label}</span>
      <div role="listbox" aria-label={label} className={cn(LIST, 'h-36')}>
        {items.map((n, k) => (
          <div key={k} role="option" aria-selected={k === i} onClick={() => setI(k)} onDoubleClick={() => onOk(k)} className={cn('cursor-default px-2 py-[3px]', k === i ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}>
            {n}
          </div>
        ))}
      </div>
    </OfficeDialog>
  );
}

export interface SortLevel {
  col: number;
  asc: boolean;
}

export function SortDialog({ columns, initialHeader, initial, onOk, onCancel }: { columns: { index: number; label: string }[]; initialHeader: boolean; initial: number; onOk: (levels: SortLevel[], header: boolean) => void; onCancel: () => void }) {
  const [levels, setLevels] = useState<SortLevel[]>([{ col: initial, asc: true }]);
  const [header, setHeader] = useState(initialHeader);
  const set = (i: number, p: Partial<SortLevel>) => setLevels((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  return (
    <OfficeDialog title="Sort" onOk={() => onOk(levels, header)} onCancel={onCancel} width={520}>
      <div className="mb-2 flex items-center gap-2">
        <OfficeButton onClick={() => setLevels((ls) => [...ls, { col: columns[0]?.index ?? 0, asc: true }])} disabled={levels.length >= 6}>
          + Add Level
        </OfficeButton>
        <OfficeButton onClick={() => setLevels((ls) => (ls.length > 1 ? ls.slice(0, -1) : ls))} disabled={levels.length < 2}>
          Delete Level
        </OfficeButton>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} className="accent-[var(--office-accent)]" /> My data has headers
        </label>
      </div>
      <div className="space-y-1.5">
        {levels.map((l, i) => (
          <div key={i} className="flex items-center gap-2 text-[12.5px]">
            <span className="w-16 text-[#424242]">{i === 0 ? 'Sort by' : 'Then by'}</span>
            <select value={l.col} onChange={(e) => set(i, { col: Number(e.target.value) })} className={cn(FIELD, 'w-48')}>
              {columns.map((c) => (
                <option key={c.index} value={c.index}>
                  {c.label}
                </option>
              ))}
            </select>
            <select value={l.asc ? 'a' : 'd'} onChange={(e) => set(i, { asc: e.target.value === 'a' })} className={cn(FIELD, 'w-36')}>
              <option value="a">A to Z / Smallest to Largest</option>
              <option value="d">Z to A / Largest to Smallest</option>
            </select>
          </div>
        ))}
      </div>
    </OfficeDialog>
  );
}

export function RemoveDuplicatesDialog({ columns, initialHeader, onOk, onCancel }: { columns: { index: number; label: string }[]; initialHeader: boolean; onOk: (cols: number[], header: boolean) => void; onCancel: () => void }) {
  const [on, setOn] = useState(new Set(columns.map((c) => c.index)));
  const [header, setHeader] = useState(initialHeader);
  return (
    <OfficeDialog title="Remove Duplicates" onOk={() => on.size && onOk([...on].sort((a, b) => a - b), header)} onCancel={onCancel} okDisabled={!on.size} width={400}>
      <p className="mb-2 text-[12.5px]">To delete duplicate values, select one or more columns that contain duplicates.</p>
      <div className="mb-2 flex gap-2">
        <OfficeButton onClick={() => setOn(new Set(columns.map((c) => c.index)))}>Select All</OfficeButton>
        <OfficeButton onClick={() => setOn(new Set())}>Unselect All</OfficeButton>
        <span className="flex-1" />
        <label className="flex items-center gap-2 text-[12.5px]">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} className="accent-[var(--office-accent)]" /> My data has headers
        </label>
      </div>
      <div className={cn(LIST, 'h-36 p-1')}>
        {columns.map((c) => (
          <label key={c.index} className="flex items-center gap-2 px-1 py-[2px]">
            <input
              type="checkbox"
              checked={on.has(c.index)}
              onChange={(e) =>
                setOn((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(c.index);
                  else n.delete(c.index);
                  return n;
                })
              }
              className="accent-[var(--office-accent)]"
            />
            {c.label}
          </label>
        ))}
      </div>
    </OfficeDialog>
  );
}

export interface NameRow {
  name: string;
  formula: string;
  scope: string;
  value: string;
}

export function NameManagerDialog({ names, onEdit, onDelete, onNew, onClose }: { names: NameRow[]; onEdit: (name: string) => void; onDelete: (name: string) => void; onNew: () => void; onClose: () => void }) {
  const [pick, setPick] = useState<string | null>(names[0]?.name ?? null);
  return (
    <OfficeDialog title="Name Manager" onCancel={onClose} width={620} footer={<OfficeButton onClick={onClose}>Close</OfficeButton>}>
      <div className="mb-2 flex gap-2">
        <OfficeButton onClick={onNew}>New…</OfficeButton>
        <OfficeButton onClick={() => pick && onEdit(pick)} disabled={!pick}>
          Edit…
        </OfficeButton>
        <OfficeButton onClick={() => pick && onDelete(pick)} disabled={!pick}>
          Delete
        </OfficeButton>
      </div>
      <div className={cn(LIST, 'h-56')}>
        <div className="sticky top-0 grid grid-cols-[1fr_1fr_1.4fr_0.8fr] gap-2 border-b border-[#e0e0e0] bg-[#fafafa] px-2 py-1 text-[12px] font-semibold">
          <span>Name</span>
          <span>Value</span>
          <span>Refers To</span>
          <span>Scope</span>
        </div>
        {names.map((n) => (
          <div key={n.name + n.scope} onClick={() => setPick(n.name)} onDoubleClick={() => onEdit(n.name)} className={cn('grid cursor-default grid-cols-[1fr_1fr_1.4fr_0.8fr] gap-2 px-2 py-[3px]', pick === n.name ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}>
            <span className="truncate">{n.name}</span>
            <span className="truncate text-[#616161]">{n.value}</span>
            <span className="truncate font-mono text-[11.5px]">={n.formula}</span>
            <span className="truncate">{n.scope}</span>
          </div>
        ))}
        {!names.length && <p className="px-2 py-3 text-[#616161]">This workbook has no defined names.</p>}
      </div>
    </OfficeDialog>
  );
}

export function DefineNameDialog({ initial, onOk, onCancel }: { initial: { name: string; formula: string }; onOk: (name: string, formula: string) => string | null; onCancel: () => void }) {
  const [name, setName] = useState(initial.name);
  const [formula, setFormula] = useState(`=${initial.formula}`);
  const [error, setError] = useState<string | null>(null);
  return (
    <OfficeDialog title={initial.name ? 'Edit Name' : 'New Name'} onOk={() => setError(onOk(name.trim(), formula.replace(/^=/, '').trim()))} onCancel={onCancel} width={420}>
      <Field label="Name:">
        <input data-autofocus value={name} onChange={(e) => setName(e.target.value)} className={cn(FIELD, 'w-60')} />
      </Field>
      <Field label="Refers to:">
        <input value={formula} onChange={(e) => setFormula(e.target.value)} className={cn(FIELD, 'w-60 font-mono text-[12px]')} />
      </Field>
      {error && <p className="mt-2 text-[12.5px] text-[#c42b1c]">{error}</p>}
    </OfficeDialog>
  );
}

export function LinkDialog({ initial, onOk, onRemove, onCancel }: { initial: { text: string; url: string }; onOk: (text: string, url: string) => void; onRemove?: () => void; onCancel: () => void }) {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  return (
    <OfficeDialog
      title={initial.url ? 'Edit Hyperlink' : 'Insert Hyperlink'}
      onOk={() => url.trim() && onOk(text, url.trim())}
      onCancel={onCancel}
      okDisabled={!url.trim()}
      width={440}
      footer={
        <>
          {onRemove && <OfficeButton onClick={onRemove}>Remove Link</OfficeButton>}
          <OfficeButton primary className="primary" disabled={!url.trim()} onClick={() => onOk(text, url.trim())}>
            OK
          </OfficeButton>
          <OfficeButton onClick={onCancel}>Cancel</OfficeButton>
        </>
      }
    >
      <Field label="Text to display:">
        <input value={text} onChange={(e) => setText(e.target.value)} className={cn(FIELD, 'w-64')} />
      </Field>
      <Field label="Address:">
        <input data-autofocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com or #Sheet2!A1" className={cn(FIELD, 'w-64')} />
      </Field>
      <p className="mt-2 text-[12px] text-[#616161]">A web address, or # and a place in this workbook (like #Sheet2!A1).</p>
    </OfficeDialog>
  );
}
