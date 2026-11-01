import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * The pieces of a Settings page about one thing - a Wi-Fi network, a
 * Bluetooth device, a phone - laid out the way Android does: a header that
 * goes back to the list, a hero with its icon and state, a row of actions,
 * and groups of switches and facts.
 */
export function DetailsPage({
  title,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label={backLabel} onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="truncate text-lg font-semibold text-foreground">{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function DetailsHero({
  icon,
  name,
  status,
  active,
}: {
  icon: React.ReactNode;
  name: string;
  status: React.ReactNode;
  active: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-gradient-to-b from-primary/10 to-transparent px-4 py-6 text-center">
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full [&_svg]:size-7',
          active ? 'bg-primary text-primary-foreground' : 'bg-foreground/10 text-muted-foreground',
        )}
      >
        {icon}
      </div>
      <p className="max-w-full truncate text-base font-semibold text-foreground">{name}</p>
      <p className={cn('flex items-center gap-1.5 text-sm', active ? 'text-primary' : 'text-muted-foreground')}>
        {status}
      </p>
    </div>
  );
}

export function ActionButtons({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2 *:min-w-0 *:flex-1">{children}</div>;
}

export function ActionButton({
  icon: Icon,
  label,
  onClick,
  pending,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto flex-col gap-1.5 py-3"
      disabled={disabled || pending}
      onClick={onClick}
    >
      {pending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Icon className="size-5" aria-hidden />}
      <span className="text-xs">{label}</span>
    </Button>
  );
}

export function DetailsError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {children}
    </p>
  );
}

export function DetailsSubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-sm font-medium text-muted-foreground">{children}</h3>;
}

export function DetailsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
      {children}
    </div>
  );
}

/** A group of facts, as `InfoRow`s. */
export function InfoList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
      {children}
    </dl>
  );
}

export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-sm text-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-sm text-muted-foreground select-text sm:text-right">{value}</dd>
    </div>
  );
}

export function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

export function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-40 rounded-xl bg-foreground/10" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-md bg-foreground/10" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl bg-foreground/10" />
    </div>
  );
}

/**
 * A device or network in a Settings list, Android-style: the whole row is one
 * button (open a connected one's page, connect any other), and `trailing`
 * sits beside it (a gear for a saved one's page). Connected rows are in the
 * primary color.
 */
export function DeviceRowButton({
  icon,
  name,
  detail,
  connected,
  pending,
  disabled,
  chevron,
  onClick,
  trailing,
  ...props
}: {
  icon: React.ReactNode;
  name: string;
  detail?: React.ReactNode;
  connected: boolean;
  pending?: boolean;
  disabled?: boolean;
  /** Show that the row opens a page. */
  chevron?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
} & Omit<React.ComponentProps<'div'>, 'onClick'>) {
  return (
    <div {...props} className={cn('flex items-center gap-1', trailing && 'pr-2', props.className)}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent',
          trailing ? 'rounded-l-lg' : 'rounded-lg',
        )}
      >
        <span className={cn('shrink-0 [&_svg]:size-5', connected ? 'text-primary' : 'text-muted-foreground')}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', connected ? 'font-medium text-primary' : 'text-foreground')}>
            {name}
          </span>
          {(detail || pending) && (
            <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
              {pending && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
              {detail}
            </span>
          )}
        </span>
        {chevron && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </button>
      {trailing}
    </div>
  );
}
