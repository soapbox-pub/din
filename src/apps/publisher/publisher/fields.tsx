import { useId, useState } from 'react';
import { cn } from '@/lib/utils';
import { INPUT } from '@/shared/photo/styles';
import { fmtLength, parseLength, type Unit } from './units';

/**
 * InDesign's measurement fields: they show the document's units ("3p6",
 * "0.5 in"), take anything typed with a unit or plain arithmetic, step with
 * the arrow keys (Shift for ten), and scrub when their label is dragged.
 * A null value shows blank, for a selection whose values differ.
 */
export function LengthField({
  label,
  value,
  unit,
  onChange,
  min = -1e6,
  max = 1e6,
  width = 'w-[80px]',
  title,
  disabled,
  icon,
  step,
}: {
  label?: React.ReactNode;
  value: number | null;
  unit: Unit;
  onChange: (pt: number) => void;
  min?: number;
  max?: number;
  width?: string;
  title?: string;
  disabled?: boolean;
  /** A small glyph instead of a text label. */
  icon?: React.ReactNode;
  /** Arrow key step in points. */
  step?: number;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : value === null ? '' : fmtLength(value, unit);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const inc = step ?? (unit === 'in' ? 4.5 : unit === 'mm' || unit === 'cm' ? 72 / 25.4 : 1);
  const commit = (raw: string) => {
    if (value !== null && raw === fmtLength(value, unit)) return;
    const v = parseLength(raw, unit);
    if (v !== null && Number.isFinite(v)) onChange(clamp(v));
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0 || value === null) return;
    e.preventDefault();
    const start = e.clientX;
    const from = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onChange(clamp(from + ((ev.clientX - start) / 2) * inc * (ev.shiftKey ? 10 : 1)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      {(label !== undefined || icon) && (
        <label htmlFor={id} onPointerDown={scrub} className="flex cursor-ew-resize items-center text-[11px] whitespace-nowrap text-[#bdbdbd] select-none">
          {icon ?? label}
        </label>
      )}
      <input
        id={id}
        value={shown}
        disabled={disabled}
        aria-label={typeof label === 'string' ? label.replace(/:$/, '') : title}
        onFocus={(e) => {
          setText(value === null ? '' : fmtLength(value, unit));
          setFocused(true);
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Tab') {
            commit(text);
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(value === null ? '' : fmtLength(value, unit));
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== null) {
            e.preventDefault();
            const v = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * inc * (e.shiftKey ? 10 : 1));
            onChange(v);
            setText(fmtLength(v, unit));
          }
        }}
        className={cn(INPUT, 'h-[22px] text-[11px]', width)}
      />
    </span>
  );
}

/** A plain number with a unit suffix (percent, degrees, points of type). */
export function NumField({
  label,
  value,
  onChange,
  suffix = '',
  min = -1e6,
  max = 1e6,
  step = 1,
  decimals = 2,
  width = 'w-[58px]',
  title,
  disabled,
  icon,
  options,
  onAuto,
}: {
  label?: React.ReactNode;
  value: number | null;
  onChange: (v: number) => void;
  /** Typing "Auto" (leading). */
  onAuto?: () => void;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  width?: string;
  title?: string;
  disabled?: boolean;
  icon?: React.ReactNode;
  /** Values offered in a list, as InDesign's size and leading fields do. */
  options?: (number | string)[];
}) {
  const id = useId();
  const listId = useId();
  const fmt = (v: number) => `${Number(v.toFixed(decimals))}${suffix ? ` ${suffix}` : ''}`;
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : value === null ? '' : fmt(value);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (raw: string) => {
    if (value !== null && raw === fmt(value)) return;
    if (onAuto && /^\s*auto\s*$/i.test(raw)) return onAuto();
    const v = parseFloat(raw.replace(',', '.'));
    if (Number.isFinite(v)) onChange(clamp(v));
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0 || value === null) return;
    e.preventDefault();
    const start = e.clientX;
    const from = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onChange(clamp(Math.round((from + ((ev.clientX - start) / 2) * step * (ev.shiftKey ? 10 : 1)) / step) * step));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <span className="inline-flex items-center gap-1" title={title}>
      {(label !== undefined || icon) && (
        <label htmlFor={id} onPointerDown={scrub} className="flex cursor-ew-resize items-center text-[11px] whitespace-nowrap text-[#bdbdbd] select-none">
          {icon ?? label}
        </label>
      )}
      <input
        id={id}
        value={shown}
        disabled={disabled}
        list={options ? listId : undefined}
        aria-label={typeof label === 'string' ? label.replace(/:$/, '') : title}
        onFocus={(e) => {
          setText(value === null ? '' : fmt(value));
          setFocused(true);
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={(e) => {
          setFocused(false);
          commit(e.target.value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          // Picking from the list commits at once.
          if (options && options.map(String).includes(e.target.value)) {
            if (onAuto && e.target.value === 'Auto') return onAuto();
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(clamp(v));
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            commit(text);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(value === null ? '' : fmt(value));
            (e.target as HTMLInputElement).blur();
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== null) {
            e.preventDefault();
            const v = clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
            onChange(v);
            setText(fmt(v));
          }
        }}
        className={cn(INPUT, 'h-[22px] text-[11px]', width)}
      />
      {options && (
        <datalist id={listId}>
          {options.map((o) => (
            <option key={String(o)} value={String(o)} />
          ))}
        </datalist>
      )}
    </span>
  );
}

/** A text box with suggestions (font names). */
export function ComboField({
  value,
  onChange,
  options,
  label,
  width = 'w-40',
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  label: string;
  width?: string;
}) {
  const listId = useId();
  const [text, setText] = useState<string | null>(null);
  return (
    <>
      <input
        aria-label={label}
        title={label}
        value={text ?? value}
        list={listId}
        onFocus={(e) => {
          setText(value);
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (options.includes(e.target.value) && e.target.value !== value) onChange(e.target.value);
        }}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== value) onChange(v);
          setText(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={cn(INPUT, 'h-[22px] text-[11px]', width)}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}
