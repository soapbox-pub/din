import type { ComponentProps, ComponentType, ReactNode, Ref } from 'react';
import { Search, X } from 'lucide-react';
import { WindowControls, WindowDragRegion } from '@/sdk/react';
import { cn } from '@/lib/utils';
import { emptyStateClass, flushPane, focusRing, sidebarHeadingClass, sidebarRowClass, toolButtonBase } from './appChromeStyles';
import { bundledIconProps } from './iconSizes';

/*
 * The chrome Din's apps share: toolbars and their buttons, sidebar rows,
 * list rows, search fields, segmented controls and pills. Mail is the
 * model, and Apple's Human Interface Guidelines settle what Mail doesn't:
 * 13px interface text, 28px sidebar rows with tinted icons and unshouted
 * 11px headings, round toolbar buttons, capsule buttons and fields, a
 * neutral selection in sidebars and an accent one in content.
 */

const toolSizes = {
  /** A toolbar's: 36px, round. */
  md: 'size-9 rounded-full',
  /** A row's or a field's: 28px, round. */
  sm: 'size-7 rounded-full',
  /** A sidebar row's or heading's accessory (its ⋯ or +): 24px, fitting inside it. */
  xs: 'size-6 rounded-md',
};

/**
 * A borderless icon button, named by `label` (its tooltip and accessible
 * name). `pressed` makes it a toggle that shows it's on.
 */
export function ToolButton({
  label,
  size = 'md',
  pressed,
  className,
  children,
  ref,
  ...props
}: ComponentProps<'button'> & { label: string; size?: keyof typeof toolSizes; pressed?: boolean; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...props}
      className={cn(
        toolButtonBase,
        toolSizes[size],
        pressed && 'bg-foreground/10 text-foreground hover:bg-foreground/10',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** The hairline between groups of a toolbar's buttons. */
export function ToolbarDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn('mx-1 h-5 w-px shrink-0 bg-border', className)} />;
}

/**
 * A bar of tools across a pane: 48px with a hairline under it, or 36px
 * (`compact`) for a secondary row such as formatting.
 */
export function Toolbar({ compact, className, ...props }: ComponentProps<'div'> & { compact?: boolean }) {
  return (
    <div
      role="toolbar"
      {...props}
      className={cn(
        'flex shrink-0 items-center gap-0.5 border-b border-border/60',
        compact ? 'h-9 px-3' : 'h-12 px-2',
        className,
      )}
    />
  );
}

/**
 * A row of a sidebar: its icon in the accent color, its name, and a count
 * or whatever `trailing` holds at the end.
 */
export function SidebarRow({
  icon: Icon,
  label,
  count,
  trailing,
  selected = false,
  iconClassName,
  className,
  ref,
  ...props
}: Omit<ComponentProps<'button'>, 'children'> & {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  label: ReactNode;
  count?: number;
  trailing?: ReactNode;
  selected?: boolean;
  iconClassName?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={ref} type="button" aria-current={selected || undefined} {...props} className={cn(sidebarRowClass(selected), className)}>
      {Icon && <Icon className={cn('size-4.5 shrink-0 text-ink-accent', iconClassName)} strokeWidth={1.75} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className={cn('shrink-0 text-xs tabular-nums', selected ? 'font-semibold' : 'text-muted-foreground')}>{count.toLocaleString()}</span>
      ) : null}
      {trailing}
    </button>
  );
}

/** The heading of a group of sidebar rows, with room at its end for a + or ⋯. */
export function SidebarHeading({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div {...props} className={cn(sidebarHeadingClass, className)}>
      {children}
    </div>
  );
}

/**
 * A search field: a capsule with its magnifier inside and a clear button
 * once there's something to clear. `md` (40px) goes in a toolbar, `sm`
 * (36px) at the top of a sidebar or list.
 */
export function SearchField({
  value,
  onValueChange,
  size = 'md',
  className,
  inputClassName,
  ref,
  onKeyDown,
  ...props
}: Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'size'> & {
  value: string;
  onValueChange: (value: string) => void;
  size?: 'md' | 'sm';
  inputClassName?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <Search
        aria-hidden
        className={cn('pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground')}
      />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onValueChange('');
          }
          onKeyDown?.(e);
        }}
        {...props}
        className={cn(
          'glass-control w-full rounded-full bg-foreground/[0.06] outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden',
          'focus-visible:bg-background focus-visible:shadow-sm focus-visible:ring-1 focus-visible:ring-border',
          size === 'md' ? 'h-10 pr-10 pl-10 text-sm' : 'h-9 pr-9 pl-10 text-sm',
          inputClassName,
        )}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onValueChange('')}
          className={cn(
            'absolute top-1/2 grid -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
            focusRing,
            size === 'md' ? 'right-2 size-7' : 'right-1.5 size-6',
          )}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

/**
 * A segmented control: one of a few choices, the chosen one raised. `md`
 * (32px) sits in a toolbar, `sm` in a pane's header.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onValueChange,
  size = 'sm',
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string; disabled?: boolean }[];
  onValueChange: (value: T) => void;
  size?: 'md' | 'sm';
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('flex w-fit max-w-full shrink-0 rounded-full bg-foreground/[0.06] p-0.5', size === 'md' ? 'h-8 text-[13px]' : 'text-xs', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.title}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => onValueChange(o.value)}
          className={cn(
            'flex items-center justify-center gap-1 font-medium disabled:pointer-events-none disabled:opacity-50',
            'rounded-full',
            size === 'md' ? 'px-3 [&_svg]:size-4' : 'px-2 py-1 [&_svg]:size-3.5',
            focusRing,
            // The chosen segment raised out of the track: lighter than it in
            // either scheme, as a key above its bed, never a darker hole.
            value === o.value ? 'bg-background text-foreground clay dark:bg-foreground/[0.14]' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A capsule button in an app's content: Reply, Load Images, Try Again.
 * `primary` fills it with the accent.
 */
export function PillButton({
  size = 'md',
  variant = 'outline',
  className,
  ref,
  ...props
}: ComponentProps<'button'> & { size?: 'md' | 'sm'; variant?: 'outline' | 'primary'; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-50',
        focusRing,
        size === 'md' ? 'h-9 px-4 text-sm [&_svg]:size-4' : 'h-7 px-3 text-xs [&_svg]:size-3.5',
        variant === 'outline' ? 'border border-border/70 bg-background clay hover:bg-foreground/[0.05]' : 'bg-pigment text-primary-foreground clay-pigment hover:brightness-110',
        className,
      )}
    />
  );
}

/** A small capsule of status: "Unverified", "One-click", a count. */
export function StatusPill({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      {...props}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] font-medium text-muted-foreground', className)}
    />
  );
}

/** The strip along a window's foot that says what's there: "12 items, 3 selected". */
export function StatusBar({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn('flex h-7 shrink-0 items-center gap-3 border-t border-border/60 px-3 text-xs text-muted-foreground', className)}
    />
  );
}

/**
 * An app's content beside its sidebar, as Mail has it: a solid panel inset
 * from the window's frosted surface, which the sidebar and title bar sit on
 * with no line between them. Without a sidebar beside it (`inset` false)
 * it fills the window under a hairline instead. Once the window fills its
 * part of the screen (maximized, snapped, full screen: `data-window-flush`
 * on the window, set by the desktop and window.din's runtime), the panel
 * meets the screen's edges too, ruled off from the sidebar and title bar
 * by a hairline, rather than floating as a box in a window with no edges.
 */
export function ContentPane({ inset = true, className, ...props }: ComponentProps<'main'> & { inset?: boolean }) {
  return (
    <main
      {...props}
      className={cn(
        // A size container, so what's in it lays itself out by the window's
        // width, not the screen's (a desktop-drawn app's viewport is the screen).
        '@container flex min-w-0 flex-1 flex-col overflow-hidden bg-background',
        // Meeting the screen's edges, or leaving them, with the window's 250ms.
        inset
          ? cn('mr-2 mb-2 rounded-2xl clay transition-[margin,border-radius] duration-250 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none', flushPane)
          : 'border-t border-border/60',
        className,
      )}
    />
  );
}

/**
 * The top of a sidebar, where the window's title bar runs across it: the
 * app's icon and name in the theme's title font, as Mail's, and its buttons
 * (`children`) at the end. It drags the window.
 */
export function SidebarTitle({
  icon,
  title,
  children,
  className,
  region: Region = WindowDragRegion,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
  /** What drags the window: window.din's (an app's), unless the desktop draws the window and passes its own. */
  region?: ComponentType<ComponentProps<'div'>>;
}) {
  return (
    // The icon's center is on the sidebar rows' icons' (27px in) and a
    // toolbar's first button's.
    <Region className={cn('flex h-12 shrink-0 items-center gap-2 pr-2 pl-3.75', className)}>
      {icon}
      <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-lg font-medium text-foreground/90">{title}</h1>
      {children}
    </Region>
  );
}

/** An app's own icon as a sidebar's title shows it. */
export function SidebarTitleIcon({ src }: { src: string }) {
  return <img {...bundledIconProps(src)} alt="" aria-hidden draggable={false} className="size-6 shrink-0 object-contain" />;
}

/**
 * What an empty list, pane or search says: an optional icon, the words, and
 * what to do about it (`action`), plain and centered with no box around it.
 */
export function EmptyState({
  icon: Icon,
  title,
  action,
  className,
  children,
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  title?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn(emptyStateClass, className)}>
      {Icon && <Icon className="mb-3 size-8 text-muted-foreground/70" strokeWidth={1.5} />}
      {title && <p className="font-medium text-foreground">{title}</p>}
      {children && <div className={cn('max-w-sm', title && 'mt-1')}>{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * A window an app opens for what's more than a quick question (its
 * settings, an import, a form; see "Windows, Not Dialogs"): a 48px title
 * bar with the title and the window controls, the content in a solid
 * scrolling pane below it, and `footer` (its buttons) along the pane's foot.
 */
export function FormWindow({
  title,
  description,
  footer,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-[15px] font-semibold">{title}</h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane inset={false} className="border-t-0">
        {/* What's in it scrolls, never squeezed to fit a short window. */}
        <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0', className)}>
          {description && <p className="px-1 text-sm text-muted-foreground">{description}</p>}
          {children}
        </div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 px-4 pb-4">{footer}</div>}
      </ContentPane>
    </div>
  );
}
