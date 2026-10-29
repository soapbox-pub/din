import { useEffect, useId, useRef, useState } from 'react';
import { Menubar as MenubarPrimitive } from 'radix-ui';
import { Check, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FOCUS, INPUT, RANGE } from './styles';

/**
 * Photo Editor's widgets, in Photoshop's dark gray whatever Din's theme:
 * people coming from Photoshop find their way by its look as much as by its
 * menus. Number fields scrub when you drag their label, as Photoshop's do.
 */

// ---- Menus ---------------------------------------------------------------------

export function Menubar({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Root>) {
  return <MenubarPrimitive.Root className={cn('flex items-center', className)} {...props} />;
}

export function MenubarMenu(props: React.ComponentProps<typeof MenubarPrimitive.Menu>) {
  return <MenubarPrimitive.Menu {...props} />;
}

export function MenubarSub(props: React.ComponentProps<typeof MenubarPrimitive.Sub>) {
  return <MenubarPrimitive.Sub {...props} />;
}

export function MenubarTrigger({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn(
        'rounded-[3px] px-2 py-0.5 text-xs text-[#d6d6d6] outline-none select-none',
        'data-[highlighted]:bg-[#4a4a4a] data-[state=open]:bg-[#4a4a4a] data-[state=open]:text-white',
        className,
      )}
      {...props}
    />
  );
}

const CONTENT = 'z-50 min-w-56 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 text-xs text-[#e0e0e0] shadow-xl shadow-black/40';

export function MenubarContent({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.Content align="start" sideOffset={2} className={cn(CONTENT, className)} {...props} />
    </MenubarPrimitive.Portal>
  );
}

export function MenubarSubContent({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal>
      <MenubarPrimitive.SubContent alignOffset={-5} className={cn(CONTENT, 'max-h-[70vh] overflow-y-auto', className)} {...props} />
    </MenubarPrimitive.Portal>
  );
}

const ITEM = cn(
  'relative flex h-6 cursor-default items-center rounded-[3px] pr-2 pl-6 outline-none select-none',
  'data-[highlighted]:bg-[#2d8ceb] data-[highlighted]:text-white data-[disabled]:text-[#7a7a7a]',
);

function Shortcut({ children }: { children?: React.ReactNode }) {
  return children ? <span className="ml-auto pl-8 text-[#a0a0a0] [[data-highlighted]_&]:text-white/85">{children}</span> : null;
}

export function MenubarItem({
  shortcut,
  children,
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.Item className={cn(ITEM, className)} {...props}>
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </MenubarPrimitive.Item>
  );
}

export function MenubarCheckboxItem({
  shortcut,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.CheckboxItem> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.CheckboxItem className={ITEM} {...props}>
      <MenubarPrimitive.ItemIndicator className="absolute left-1.5">
        <Check className="size-3.5" />
      </MenubarPrimitive.ItemIndicator>
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </MenubarPrimitive.CheckboxItem>
  );
}

export function MenubarRadioItem({ children, ...props }: React.ComponentProps<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem className={ITEM} {...props}>
      <MenubarPrimitive.ItemIndicator className="absolute left-2 size-1.5 rounded-full bg-current" />
      {children}
    </MenubarPrimitive.RadioItem>
  );
}

export function MenubarSubTrigger({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  return (
    <MenubarPrimitive.SubTrigger disabled={disabled} className={cn(ITEM, 'data-[state=open]:bg-[#4a4a4a]')}>
      {children}
      <ChevronRight className="ml-auto size-3.5 pl-0" />
    </MenubarPrimitive.SubTrigger>
  );
}

export function MenubarSeparator() {
  return <MenubarPrimitive.Separator className="mx-1 my-1 h-px bg-[#2a2a2a]" />;
}

// ---- Buttons and fields ----------------------------------------------------------

export function Button({
  className,
  primary,
  ...props
}: React.ComponentProps<'button'> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'h-7 min-w-20 rounded-full px-4 text-xs font-medium transition-colors motion-reduce:transition-none disabled:opacity-40',
        primary
          ? 'bg-[#2d8ceb] text-white hover:bg-[#4a9df0] active:bg-[#1f78d1]'
          : 'border border-[#6a6a6a] text-[#e6e6e6] hover:border-[#8a8a8a] hover:bg-white/5 active:bg-white/10',
        FOCUS,
        className,
      )}
      {...props}
    />
  );
}

export function IconButton({
  label,
  pressed,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { label: string; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-[3px] text-[#cfcfcf] hover:bg-[#4a4a4a] hover:text-white disabled:opacity-35 disabled:hover:bg-transparent',
        pressed && 'bg-[#1f1f1f] text-white hover:bg-[#1f1f1f]',
        FOCUS,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * A number with a label you can drag sideways to change it, like Photoshop's
 * scrubby sliders. Typing commits on Enter or blur; arrows step (Shift by 10).
 */
export function NumberField({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  width = 'w-14',
  disabled,
  title,
  decimals = 0,
}: {
  label?: React.ReactNode;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  width?: string;
  disabled?: boolean;
  title?: string;
  decimals?: number;
}) {
  const id = useId();
  const fmt = (v: number) => (decimals ? v.toFixed(decimals) : String(Math.round(v)));
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : fmt(value);
  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onChange(clampV(v));
    setText(fmt(Number.isFinite(v) ? clampV(v) : value));
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    const start = e.clientX;
    const from = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const k = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      onChange(clampV(Math.round((from + ((ev.clientX - start) / 2) * step * k) / step) * step));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {label !== undefined && (
        <label htmlFor={id} onPointerDown={scrub} className="cursor-ew-resize text-xs whitespace-nowrap text-[#bdbdbd] select-none">
          {label}
        </label>
      )}
      <span className="relative inline-flex items-center">
        <input
          id={id}
          value={shown}
          disabled={disabled}
          inputMode="decimal"
          onFocus={(e) => {
            setText(fmt(value));
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
            if (e.key === 'Enter') {
              commit(text);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              setText(fmt(value));
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const v = clampV(value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
              onChange(v);
              setText(fmt(v));
            }
          }}
          className={cn(INPUT, width, unit && 'pr-5')}
        />
        {unit && <span className="pointer-events-none absolute right-1.5 text-[10px] text-[#9a9a9a]">{unit}</span>}
      </span>
    </span>
  );
}

/** A labelled slider with its number beside it, for dialogs and Properties. */
export function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  decimals = 0,
  track,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
  /** A CSS background for the track, e.g. a hue rainbow. */
  track?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-[#cfcfcf]">{label}</span>
        <NumberField value={value} onChange={onChange} min={min} max={max} step={step} unit={unit} decimals={decimals} />
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn(RANGE, FOCUS)}
        style={track ? ({ '--track': track } as React.CSSProperties) : undefined}
      />
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string] | null)[];
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(INPUT, 'cursor-pointer pr-1', className)}
    >
      {options.map((o, i) =>
        o ? (
          <option key={o[0]} value={o[0]}>
            {o[1]}
          </option>
        ) : (
          <option key={`sep${i}`} disabled>
            ──────────
          </option>
        ),
      )}
    </select>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-[#d6d6d6] select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        onKeyDown={(e) => e.stopPropagation()}
        className={cn('size-3.5 cursor-pointer accent-[#2d8ceb]', FOCUS)}
      />
      {children}
    </label>
  );
}

// ---- Dialogs ---------------------------------------------------------------------

/** A Photoshop-style modal inside the window: title, body, OK and Cancel on the right. */
export function Dialog({
  title,
  onCancel,
  onOk,
  okLabel = 'OK',
  okDisabled,
  children,
  extra,
  className,
}: {
  title: string;
  onCancel: () => void;
  onOk?: () => void;
  okLabel?: string;
  okDisabled?: boolean;
  children: React.ReactNode;
  /** Beside the buttons: Preview checkboxes and the like. */
  extra?: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? el).focus();
    }
  }, []);
  return (
    <div
      className="absolute inset-0 z-40 grid place-items-center bg-black/35 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && onOk && !okDisabled && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur();
            requestAnimationFrame(onOk);
          }
        }}
        className={cn(
          'flex max-h-full w-[380px] max-w-full flex-col overflow-hidden rounded-lg border border-[#1c1c1c] bg-[#383838] text-[#e0e0e0] shadow-2xl shadow-black/50 outline-none',
          className,
        )}
      >
        <div className="flex h-8 shrink-0 items-center border-b border-[#2a2a2a] bg-[#323232] px-3 text-xs font-semibold">{title}</div>
        <div className="min-h-0 overflow-y-auto p-4">{children}</div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[#2a2a2a] px-4 py-3">
          <div className="min-w-0 flex-1">{extra}</div>
          <Button onClick={onCancel}>Cancel</Button>
          {onOk && (
            <Button primary onClick={onOk} disabled={okDisabled}>
              {okLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
