import { ArrowLeft, ChevronRight, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { SettingsSection, SettingsSubHeading } from '@/shared/settingsSection';
import { settingsAlert, settingsCard, settingsGroup, settingsRowButton, settingsTokenClass } from '@/shared/settingsChromeStyles';

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
    <SettingsSection
      title={title}
      subpage
      leading={
        <Button variant="ghost" size="icon" aria-label={backLabel} onClick={onBack}>
          <ArrowLeft className="size-4.5" strokeWidth={1.75} />
        </Button>
      }
    >
      {children}
    </SettingsSection>
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
    <div className={cn(settingsCard, 'flex flex-col items-center gap-2 px-4 py-6 text-center')}>
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full [&_svg]:size-7',
          active ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-muted-foreground clay',
        )}
      >
        {icon}
      </div>
      <p className="max-w-full truncate text-base font-semibold text-foreground">{name}</p>
      <p className={cn('flex items-center gap-1.5 text-sm', active ? 'text-ink-accent' : 'text-muted-foreground')}>
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
    <p role="alert" className={cn(settingsAlert, 'px-4 py-2.5 text-xs text-destructive')}>
      {children}
    </p>
  );
}

export const DetailsSubHeading = SettingsSubHeading;

export function DetailsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className={settingsGroup}>{children}</div>
  );
}

/** A group of facts, as `InfoRow`s. */
export function InfoList({ children }: { children: React.ReactNode }) {
  return (
    <dl className={settingsGroup}>{children}</dl>
  );
}

export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 @2xl:flex-row @2xl:items-baseline @2xl:justify-between @2xl:gap-4">
      <dt className="shrink-0 text-sm text-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-sm text-muted-foreground select-text @2xl:text-right">{value}</dd>
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
          <Skeleton key={i} className="h-16 rounded-xl bg-foreground/10" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl bg-foreground/10" />
    </div>
  );
}

/**
 * A device or network in a Settings list, Android-style: the whole row is one
 * button (open a connected one's page, connect any other), and `trailing`
 * sits beside it (a gear for a saved one's page). A connected one's icon
 * is in the accent.
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
        className={cn(settingsRowButton, 'min-w-0 flex-1')}
      >
        <span aria-hidden className={settingsTokenClass(connected)}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm text-foreground', connected && 'font-medium')}>
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
