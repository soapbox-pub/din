import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { FUNCTIONS } from './functions';
import { callAt, sigParts, spans, suggest } from './editing';

/**
 * The text of a cell being typed, as a textarea over a colored copy of
 * itself: references show in the colors of their boxes on the grid, the
 * way Excel colors them. Below it, the function autocomplete and the
 * tooltip naming the arguments of the function the caret is in.
 */
export function EditText({
  value,
  selStart,
  selEnd,
  onChange,
  onCaret,
  onKeyDown,
  onFocus,
  onMouseDown,
  inputRef,
  style,
  className,
  wrap,
  active,
  acIndex,
  onPick,
  names,
  label,
  popupUp,
  pad,
  colored,
}: {
  value: string;
  selStart: number;
  selEnd: number;
  onChange: (value: string, start: number, end: number) => void;
  onCaret: (start: number, end: number) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus?: () => void;
  onMouseDown?: (e: React.MouseEvent<HTMLTextAreaElement>) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  style?: React.CSSProperties;
  className?: string;
  wrap: boolean;
  /** Whether this is where the typing happens (shows the autocomplete and caret sync). */
  active: boolean;
  acIndex: number;
  onPick: (name: string) => void;
  names?: string[];
  label: string;
  popupUp?: boolean;
  /** Padding inside the text box (CSS). */
  pad?: string;
  /** Color the references (while a formula is being edited). */
  colored?: boolean;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? own;
  const mirror = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active || document.activeElement !== el) return;
    if (el.selectionStart !== selStart || el.selectionEnd !== selEnd) el.setSelectionRange(selStart, selEnd);
  });

  const parts = colored ?? active ? spans(value) : [{ text: value }];
  const sug = active ? suggest(value, selStart, names) : null;
  const call = active && !sug ? callAt(value, selStart) : null;
  const sig = call ? sigParts(call.name) : null;
  const ws = wrap ? 'pre-wrap' : 'pre';
  const common = 'absolute inset-0 m-0 border-0 p-0 outline-none [font:inherit] [letter-spacing:inherit] [line-height:inherit] [tab-size:4]';
  return (
    <div className={cn('relative', className)} style={style}>
      <div ref={mirror} aria-hidden className={cn(common, 'pointer-events-none overflow-hidden break-words')} style={{ whiteSpace: ws, padding: pad }}>
        {parts.map((p, i) => (
          <span key={i} style={p.color ? { color: p.color } : undefined}>
            {p.text}
          </span>
        ))}
        {'\u200b'}
      </div>
      <textarea
        ref={ref}
        value={value}
        aria-label={label}
        spellCheck={false}
        wrap={wrap ? 'soft' : 'off'}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart, e.target.selectionEnd)}
        onSelect={(e) => onCaret(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onMouseDown={onMouseDown}
        onScroll={(e) => {
          if (mirror.current) {
            mirror.current.scrollTop = e.currentTarget.scrollTop;
            mirror.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        className={cn(common, 'resize-none overflow-hidden bg-transparent text-transparent caret-black select-text selection:bg-[#b3d7f5] selection:text-transparent')}
        style={{ whiteSpace: ws, padding: pad }}
      />
      {sug && (
        <div
          role="listbox"
          aria-label="Functions"
          className={cn('absolute left-0 z-30 flex items-start gap-1', popupUp ? 'bottom-full mb-1' : 'top-full mt-1')}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="min-w-48 overflow-hidden rounded-[4px] border border-[#c8c8c8] bg-white py-0.5 text-[12px] text-[#242424] shadow-[0_4px_12px_rgba(0,0,0,0.18)] [font-family:'Inter_Variable','Segoe_UI',sans-serif]">
            {sug.items.map((n, i) => (
              <button
                key={n}
                type="button"
                role="option"
                aria-selected={i === acIndex % sug.items.length}
                onClick={() => onPick(n)}
                className={cn('flex w-full items-center gap-2 px-2 py-[3px] text-left whitespace-nowrap', i === acIndex % sug.items.length ? 'bg-[#d3eadb]' : 'hover:bg-[#f0f0f0]')}
              >
                <span className="grid size-4 place-items-center rounded-[2px] bg-[#e7f2eb] text-[9px] font-bold text-[#107c41] italic">fx</span>
                {n}
              </button>
            ))}
          </div>
          {FUNCTIONS[sug.items[acIndex % sug.items.length]] && (
            <div className="w-60 rounded-[4px] border border-[#d6d6d6] bg-[#fffef0] px-2 py-1 text-[11.5px] leading-snug text-[#424242] shadow-sm [font-family:'Inter_Variable','Segoe_UI',sans-serif]">
              {FUNCTIONS[sug.items[acIndex % sug.items.length]].desc}
            </div>
          )}
        </div>
      )}
      {sig && call && (
        <div
          className={cn(
            'pointer-events-none absolute left-0 z-30 rounded-[3px] border border-[#c8c8c8] bg-[#fffef0] px-1.5 py-0.5 text-[11.5px] whitespace-nowrap text-[#242424] shadow-sm [font-family:"Inter_Variable","Segoe_UI",sans-serif]',
            popupUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <span className="text-[#0e5c9e] underline">{sig.head}</span>(
          {sig.args.map((a, i) => {
            const current = i === call.arg || (i === sig.args.length - 1 && a === '...' && call.arg >= i) || (a.includes('...') && call.arg >= i);
            return (
              <span key={i}>
                {i > 0 && ', '}
                <span className={current ? 'font-bold' : undefined}>{a}</span>
              </span>
            );
          })}
          )
        </div>
      )}
    </div>
  );
}
