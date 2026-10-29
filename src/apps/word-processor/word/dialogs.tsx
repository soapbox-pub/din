import { useState } from 'react';
import { cn } from '@/lib/utils';
import { FIELD } from '@/shared/office/accent';
import { Field, OfficeButton, OfficeDialog, Spinner } from '@/shared/office/chrome';
import { FONT_CHOICES, FONT_SIZES, fontStack } from '@/shared/office/fonts';
import { PAPER_SIZES } from './paper';
import type { Section } from './read';

/** Word's dialogs, laid out the way Word lays them out. */

export interface FontValues {
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  superscript: boolean;
  subscript: boolean;
  color: string | null;
}

const LABEL = 'text-[12.5px] text-[#424242]';
const GROUP = 'mt-3 mb-1 border-b border-[#e0e0e0] pb-1 text-[12.5px] font-semibold text-[#242424]';

function ListPicker({ value, options, onChange, label, height = 112, render }: { value: string; options: string[]; onChange: (v: string) => void; label: string; height?: number; render?: (o: string) => React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <input aria-label={label} className={FIELD} value={value} onChange={(e) => onChange(e.target.value)} />
      <div role="listbox" aria-label={`${label} list`} className="overflow-y-auto rounded-[4px] border border-[#c8c8c8] bg-white" style={{ height }}>
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="option"
            aria-selected={o === value}
            onClick={() => onChange(o)}
            className={cn('block w-full truncate px-2 py-0.5 text-left text-[12.5px] hover:bg-[#f0f0f0]', o === value && 'bg-[var(--office-accent-light)] hover:bg-[var(--office-accent-light)]')}
          >
            {render ? render(o) : o}
          </button>
        ))}
      </div>
    </div>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[12.5px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5 accent-[var(--office-accent)]" />
      {children}
    </label>
  );
}

export function FontDialog({ initial, onOk, onCancel }: { initial: FontValues; onOk: (v: FontValues) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof FontValues>(k: K, val: FontValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const style = v.bold && v.italic ? 'Bold Italic' : v.bold ? 'Bold' : v.italic ? 'Italic' : 'Regular';
  return (
    <OfficeDialog title="Font" onOk={() => onOk(v)} onCancel={onCancel} width={520}>
      <div className="grid grid-cols-[1fr_120px_72px] gap-3">
        <div>
          <div className={LABEL}>Font:</div>
          <ListPicker label="Font" value={v.font} options={FONT_CHOICES} onChange={(f) => set('font', f)} render={(o) => <span style={{ fontFamily: fontStack(o) }}>{o}</span>} />
        </div>
        <div>
          <div className={LABEL}>Font style:</div>
          <ListPicker
            label="Font style"
            value={style}
            options={['Regular', 'Italic', 'Bold', 'Bold Italic']}
            onChange={(s) => setV((p) => ({ ...p, bold: s.includes('Bold'), italic: s.includes('Italic') }))}
          />
        </div>
        <div>
          <div className={LABEL}>Size:</div>
          <ListPicker
            label="Size"
            value={String(v.size)}
            options={FONT_SIZES.map(String)}
            onChange={(s) => {
              const n = parseFloat(s);
              if (Number.isFinite(n) && n > 0) set('size', n);
            }}
          />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-[12.5px]">
          Font color:
          <input type="color" value={`#${v.color ?? '000000'}`} onChange={(e) => set('color', e.target.value.slice(1).toUpperCase())} className="h-7 w-12 cursor-pointer rounded-[4px] border border-[#c8c8c8] bg-white" />
        </label>
        <OfficeButton className="h-7 min-w-0 px-2 text-[12px] font-normal" onClick={() => set('color', null)}>
          Automatic
        </OfficeButton>
      </div>
      <div className={GROUP}>Effects</div>
      <div className="grid grid-cols-2">
        <Check checked={v.underline} onChange={(b) => set('underline', b)}>Underline</Check>
        <Check checked={v.strike} onChange={(b) => set('strike', b)}>Strikethrough</Check>
        <Check checked={v.superscript} onChange={(b) => setV((p) => ({ ...p, superscript: b, subscript: b ? false : p.subscript }))}>Superscript</Check>
        <Check checked={v.subscript} onChange={(b) => setV((p) => ({ ...p, subscript: b, superscript: b ? false : p.superscript }))}>Subscript</Check>
      </div>
      <div className={GROUP}>Preview</div>
      <div className="grid h-16 place-items-center overflow-hidden rounded-[4px] border border-[#e0e0e0] bg-white">
        <span
          style={{
            fontFamily: fontStack(v.font),
            fontSize: `${Math.min(v.size, 36)}pt`,
            fontWeight: v.bold ? 700 : 400,
            fontStyle: v.italic ? 'italic' : 'normal',
            textDecoration: [v.underline && 'underline', v.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
            color: v.color ? `#${v.color}` : '#000',
            verticalAlign: v.superscript ? 'super' : v.subscript ? 'sub' : undefined,
          }}
        >
          {v.font}
        </span>
      </div>
    </OfficeDialog>
  );
}

export interface ParagraphValues {
  align: 'left' | 'center' | 'right' | 'justify';
  indLeft: number;
  indRight: number;
  special: 'none' | 'firstLine' | 'hanging';
  by: number;
  spBefore: number;
  spAfter: number;
  lineMode: 'single' | '1.5' | 'double' | 'atLeast' | 'exactly' | 'multiple';
  lineAt: number;
}

export function ParagraphDialog({ initial, onOk, onCancel }: { initial: ParagraphValues; onOk: (v: ParagraphValues) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof ParagraphValues>(k: K, val: ParagraphValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const lineUnit = v.lineMode === 'atLeast' || v.lineMode === 'exactly' ? 'pt' : '';
  return (
    <OfficeDialog title="Paragraph" onOk={() => onOk(v)} onCancel={onCancel} width={500}>
      <div className={GROUP}>General</div>
      <Field label="Alignment:">
        <select className={cn(FIELD, 'w-40')} value={v.align} onChange={(e) => set('align', e.target.value as ParagraphValues['align'])}>
          <option value="left">Left</option>
          <option value="center">Centered</option>
          <option value="right">Right</option>
          <option value="justify">Justified</option>
        </select>
      </Field>
      <div className={GROUP}>Indentation</div>
      <div className="grid grid-cols-2 gap-x-6">
        <Field label="Left:">
          <Spinner value={v.indLeft} onChange={(n) => set('indLeft', n)} min={-11} max={22} step={0.1} decimals={2} unit={'"'} />
        </Field>
        <Field label="Special:">
          <select className={cn(FIELD, 'w-28')} value={v.special} onChange={(e) => set('special', e.target.value as ParagraphValues['special'])}>
            <option value="none">(none)</option>
            <option value="firstLine">First line</option>
            <option value="hanging">Hanging</option>
          </select>
        </Field>
        <Field label="Right:">
          <Spinner value={v.indRight} onChange={(n) => set('indRight', n)} min={-11} max={22} step={0.1} decimals={2} unit={'"'} />
        </Field>
        <Field label="By:">
          <Spinner value={v.by} onChange={(n) => set('by', n)} min={0} max={22} step={0.1} decimals={2} unit={'"'} />
        </Field>
      </div>
      <div className={GROUP}>Spacing</div>
      <div className="grid grid-cols-2 gap-x-6">
        <Field label="Before:">
          <Spinner value={v.spBefore} onChange={(n) => set('spBefore', n)} min={0} max={1584} step={6} unit="pt" />
        </Field>
        <Field label="Line spacing:">
          <select
            className={cn(FIELD, 'w-28')}
            value={v.lineMode}
            onChange={(e) => {
              const mode = e.target.value as ParagraphValues['lineMode'];
              setV((p) => ({ ...p, lineMode: mode, lineAt: mode === 'atLeast' || mode === 'exactly' ? 12 : mode === 'multiple' ? 1.15 : mode === '1.5' ? 1.5 : mode === 'double' ? 2 : 1 }));
            }}
          >
            <option value="single">Single</option>
            <option value="1.5">1.5 lines</option>
            <option value="double">Double</option>
            <option value="atLeast">At least</option>
            <option value="exactly">Exactly</option>
            <option value="multiple">Multiple</option>
          </select>
        </Field>
        <Field label="After:">
          <Spinner value={v.spAfter} onChange={(n) => set('spAfter', n)} min={0} max={1584} step={6} unit="pt" />
        </Field>
        <Field label="At:">
          <Spinner value={v.lineAt} onChange={(n) => set('lineAt', n)} min={lineUnit ? 0.7 : 0.06} max={lineUnit ? 1584 : 132} step={lineUnit ? 1 : 0.01} decimals={lineUnit ? 0 : 2} unit={lineUnit} />
        </Field>
      </div>
    </OfficeDialog>
  );
}

export function InsertTableDialog({ onOk, onCancel }: { onOk: (cols: number, rows: number) => void; onCancel: () => void }) {
  const [cols, setCols] = useState(5);
  const [rows, setRows] = useState(2);
  return (
    <OfficeDialog title="Insert Table" onOk={() => onOk(cols, rows)} onCancel={onCancel} width={300}>
      <div className={GROUP}>Table size</div>
      <Field label="Number of columns:">
        <Spinner value={cols} onChange={setCols} min={1} max={63} />
      </Field>
      <Field label="Number of rows:">
        <Spinner value={rows} onChange={setRows} min={1} max={32767} />
      </Field>
    </OfficeDialog>
  );
}

export function LinkDialog({ initialText, initialHref, hasSelection, onOk, onRemove, onCancel }: {
  initialText: string;
  initialHref: string;
  hasSelection: boolean;
  onOk: (text: string, href: string) => void;
  onRemove?: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [href, setHref] = useState(initialHref);
  const normalized = /^[a-z]+:/i.test(href.trim()) ? href.trim() : href.includes('@') && !href.includes('/') ? `mailto:${href.trim()}` : `https://${href.trim()}`;
  const valid = href.trim() !== '' && /^(https?:|mailto:)/i.test(normalized);
  return (
    <OfficeDialog
      title="Insert Hyperlink"
      onCancel={onCancel}
      width={460}
      onOk={valid ? () => onOk(text, normalized) : undefined}
      footer={
        <>
          {onRemove && <OfficeButton onClick={onRemove}>Remove Link</OfficeButton>}
          <span className="flex-1" />
          <OfficeButton primary disabled={!valid} onClick={() => onOk(text, normalized)}>
            OK
          </OfficeButton>
          <OfficeButton onClick={onCancel}>Cancel</OfficeButton>
        </>
      }
    >
      <label className="block py-1">
        <span className={LABEL}>Text to display:</span>
        <input className={cn(FIELD, 'mt-1 w-full')} value={text} disabled={hasSelection} onChange={(e) => setText(e.target.value)} />
      </label>
      <label className="block py-1">
        <span className={LABEL}>Address:</span>
        <input autoFocus className={cn(FIELD, 'mt-1 w-full')} value={href} placeholder="https://" onChange={(e) => setHref(e.target.value)} />
      </label>
    </OfficeDialog>
  );
}

export function ReplaceDialog({
  initialFind,
  onFind,
  onReplace,
  onReplaceAll,
  onCancel,
  message,
}: {
  initialFind: string;
  onFind: (q: string, matchCase: boolean, wholeWord: boolean) => void;
  onReplace: (q: string, r: string, matchCase: boolean, wholeWord: boolean) => void;
  onReplaceAll: (q: string, r: string, matchCase: boolean, wholeWord: boolean) => void;
  onCancel: () => void;
  message: string | null;
}) {
  const [find, setFind] = useState(initialFind);
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  return (
    <OfficeDialog
      title="Find and Replace"
      onCancel={onCancel}
      width={480}
      footer={
        <>
          <OfficeButton onClick={() => onReplace(find, replace, matchCase, wholeWord)} disabled={!find}>
            Replace
          </OfficeButton>
          <OfficeButton onClick={() => onReplaceAll(find, replace, matchCase, wholeWord)} disabled={!find}>
            Replace All
          </OfficeButton>
          <OfficeButton primary onClick={() => onFind(find, matchCase, wholeWord)} disabled={!find}>
            Find Next
          </OfficeButton>
          <OfficeButton onClick={onCancel}>Cancel</OfficeButton>
        </>
      }
    >
      <label className="flex items-center gap-3 py-1">
        <span className={cn(LABEL, 'w-24')}>Find what:</span>
        <input autoFocus className={cn(FIELD, 'flex-1')} value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onFind(find, matchCase, wholeWord)} />
      </label>
      <label className="flex items-center gap-3 py-1">
        <span className={cn(LABEL, 'w-24')}>Replace with:</span>
        <input className={cn(FIELD, 'flex-1')} value={replace} onChange={(e) => setReplace(e.target.value)} />
      </label>
      <div className="mt-2 flex gap-6">
        <Check checked={matchCase} onChange={setMatchCase}>Match case</Check>
        <Check checked={wholeWord} onChange={setWholeWord}>Find whole words only</Check>
      </div>
      <p role="status" className="mt-2 min-h-5 text-[12.5px] text-[#424242]">{message}</p>
    </OfficeDialog>
  );
}

export function WordCountDialog({ stats, onClose }: { stats: { pages: number; words: number; chars: number; charsNoSpaces: number; paragraphs: number }; onClose: () => void }) {
  const rows: [string, number][] = [
    ['Pages', stats.pages],
    ['Words', stats.words],
    ['Characters (no spaces)', stats.charsNoSpaces],
    ['Characters (with spaces)', stats.chars],
    ['Paragraphs', stats.paragraphs],
  ];
  return (
    <OfficeDialog title="Word Count" onCancel={onClose} width={340} footer={<OfficeButton primary onClick={onClose}>Close</OfficeButton>}>
      <div className={GROUP}>Statistics:</div>
      <table className="w-full text-[13px]">
        <tbody>
          {rows.map(([k, n]) => (
            <tr key={k}>
              <td className="py-1">{k}</td>
              <td className="py-1 text-right tabular-nums">{n.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </OfficeDialog>
  );
}


export function PageSetupDialog({ section, onOk, onCancel }: { section: Section; onOk: (s: Section) => void; onCancel: () => void }) {
  const inch = (px: number) => Math.round((px / 96) * 100) / 100;
  const [m, setM] = useState({ top: inch(section.mTop), bottom: inch(section.mBottom), left: inch(section.mLeft), right: inch(section.mRight) });
  const [landscape, setLandscape] = useState(section.pageW > section.pageH);
  const short = Math.min(section.pageW, section.pageH) / 96;
  const long = Math.max(section.pageW, section.pageH) / 96;
  const [paper, setPaper] = useState(PAPER_SIZES.find((p) => Math.abs(p.w - short) < 0.05 && Math.abs(p.h - long) < 0.05)?.name ?? 'Custom');
  const ok = () => {
    const p = PAPER_SIZES.find((x) => x.name === paper);
    const w = (p ? p.w : short) * 96;
    const h = (p ? p.h : long) * 96;
    onOk({
      ...section,
      pageW: landscape ? h : w,
      pageH: landscape ? w : h,
      mTop: m.top * 96,
      mBottom: m.bottom * 96,
      mLeft: m.left * 96,
      mRight: m.right * 96,
    });
  };
  const spin = (k: keyof typeof m) => <Spinner value={m[k]} onChange={(n) => setM((p) => ({ ...p, [k]: n }))} min={0} max={20} step={0.1} decimals={2} unit={'"'} />;
  return (
    <OfficeDialog title="Page Setup" onOk={ok} onCancel={onCancel} width={440}>
      <div className={GROUP}>Margins</div>
      <div className="grid grid-cols-2 gap-x-6">
        <Field label="Top:">{spin('top')}</Field>
        <Field label="Bottom:">{spin('bottom')}</Field>
        <Field label="Left:">{spin('left')}</Field>
        <Field label="Right:">{spin('right')}</Field>
      </div>
      <div className={GROUP}>Orientation</div>
      <div className="flex gap-3">
        {[false, true].map((l) => (
          <button
            key={String(l)}
            type="button"
            onClick={() => setLandscape(l)}
            className={cn('flex flex-col items-center gap-1 rounded-[4px] border px-4 py-2 text-[12.5px]', landscape === l ? 'border-[var(--office-accent)] bg-[var(--office-accent-light)]' : 'border-[#d1d1d1] hover:bg-[#f5f5f5]')}
          >
            <span className={cn('border border-[#616161] bg-white', l ? 'h-6 w-8' : 'h-8 w-6')} />
            {l ? 'Landscape' : 'Portrait'}
          </button>
        ))}
      </div>
      <div className={GROUP}>Paper</div>
      <Field label="Paper size:">
        <select className={cn(FIELD, 'w-44')} value={paper} onChange={(e) => setPaper(e.target.value)}>
          {PAPER_SIZES.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.label})
            </option>
          ))}
          {paper === 'Custom' && <option value="Custom">Custom</option>}
        </select>
      </Field>
    </OfficeDialog>
  );
}

export function ZoomDialog({ zoom, onOk, onCancel, onPageWidth, onWholePage }: { zoom: number; onOk: (z: number) => void; onCancel: () => void; onPageWidth: () => void; onWholePage: () => void }) {
  const [z, setZ] = useState(Math.round(zoom));
  return (
    <OfficeDialog title="Zoom" onOk={() => onOk(z)} onCancel={onCancel} width={360}>
      <div className={GROUP}>Zoom to</div>
      <div className="grid grid-cols-2 gap-1">
        {[200, 100, 75].map((p) => (
          <label key={p} className="flex items-center gap-2 py-0.5 text-[12.5px]">
            <input type="radio" name="zoom" checked={z === p} onChange={() => setZ(p)} className="accent-[var(--office-accent)]" />
            {p}%
          </label>
        ))}
        <button type="button" onClick={onPageWidth} className="rounded-[4px] py-0.5 text-left text-[12.5px] text-[var(--office-accent)] hover:underline">
          Page width
        </button>
        <button type="button" onClick={onWholePage} className="rounded-[4px] py-0.5 text-left text-[12.5px] text-[var(--office-accent)] hover:underline">
          Whole page
        </button>
      </div>
      <Field label="Percent:" className="mt-2">
        <Spinner value={z} onChange={setZ} min={10} max={500} step={10} unit="%" />
      </Field>
    </OfficeDialog>
  );
}
