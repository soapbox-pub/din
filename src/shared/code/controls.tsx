import { cn } from '@/lib/utils';
import { ToolButton } from '@/shared/appChrome';

/** An icon button for toolbars and panels: the shared one, 28px when `small`. */
export function IconButton({
  label,
  onClick,
  pressed,
  disabled,
  small,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  small?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ToolButton size={small ? 'sm' : 'md'} label={label} pressed={pressed} onClick={onClick} disabled={disabled} className={className}>
      {children}
    </ToolButton>
  );
}

/** The small Aa / ab / .* switches inside a search field. */
export function OptionToggle({
  label,
  pressed,
  onToggle,
  children,
}: {
  label: string;
  pressed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'grid h-6 min-w-6 shrink-0 place-items-center rounded-md px-1 font-mono text-xs text-foreground/70',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        pressed && 'bg-selected text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** A one-line text field, optionally with option toggles at its end. */
export function FieldBox({
  className,
  invalid,
  children,
}: {
  className?: string;
  invalid?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 items-center gap-0.5 rounded-lg bg-foreground/[0.06] pr-1',
        'focus-within:ring-2 focus-within:ring-ring/60',
        invalid && 'ring-2 ring-destructive/40',
        className,
      )}
    >
      {children}
    </div>
  );
}

export const fieldInputClass =
  'h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground';

/** A text-only button for panels ("Replace", "Replace All"). */
export function TextButton({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'h-8 shrink-0 rounded-full px-3 text-sm text-foreground/85',
        'hover:bg-foreground/[0.07] hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
      )}
    >
      {children}
    </button>
  );
}
