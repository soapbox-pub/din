import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface Segment<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Shown beside the label only on wide windows. */
  hint?: string;
  disabled?: boolean;
}

/** A row of choices, one of them on: macOS's segmented control. Arrow keys move between them. */
export function Segmented<T extends string>({
  label,
  value,
  segments,
  onChange,
  disabled,
  className,
  iconOnly,
}: {
  label: string;
  value: T;
  segments: Segment<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  /** Labels go to screen readers and tooltips only. */
  iconOnly?: boolean;
}) {
  const move = (delta: number) => {
    const enabled = segments.filter((s) => !s.disabled);
    const at = enabled.findIndex((s) => s.value === value);
    const next = enabled[(at + delta + enabled.length) % enabled.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5', disabled && 'opacity-50', className)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {segments.map((segment) => {
        const on = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={iconOnly ? segment.label : undefined}
            title={iconOnly ? segment.label : undefined}
            tabIndex={on ? 0 : -1}
            disabled={disabled || segment.disabled}
            onClick={() => onChange(segment.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none',
              on && 'bg-background text-foreground clay dark:bg-foreground/[0.14]',
            )}
          >
            {segment.icon}
            {!iconOnly && <span>{segment.label}</span>}
            {!iconOnly && segment.hint && <span className="hidden text-xs text-muted-foreground @3xl/studio:inline">{segment.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
