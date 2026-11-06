import { use } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SettingsGroupContext, SettingsSearchingContext } from '@/shared/settingsContexts';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * A section of Settings: a column of its cards, under its name only while
 * search shows several sections one after another (and for assistive tech
 * always); otherwise the chosen sidebar row already says it. A page within
 * a section (`subpage`, a Wi-Fi network's details) always shows its own.
 */
export function SettingsSection({
  title,
  actions,
  leading,
  subpage = false,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  /** Before the title, as a subpage's back button. */
  leading?: React.ReactNode;
  subpage?: boolean;
  children: React.ReactNode;
}) {
  const searching = use(SettingsSearchingContext);
  const titled = searching || subpage;
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4 [&>*]:shrink-0">
      <header className={cn('flex items-center justify-between gap-2', !titled && !actions && !leading && 'sr-only')}>
        <div className="flex min-w-0 items-center gap-2">
          {leading}
          <h2 className={cn('truncate font-[family-name:var(--font-title)] text-lg font-semibold text-foreground', !titled && 'sr-only')}>{title}</h2>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * Settings that belong together, as rows of one card parted by hairlines
 * rather than a card each: the settings in it that would be cards of their
 * own (a switch row, a choice) know they're in it.
 */
export function SettingsGroup({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <SettingsGroupContext value>
      <div className={cn(settingsGroup, className)}>{children}</div>
    </SettingsGroupContext>
  );
}

/** The heading of a group of cards within a section. */
export function SettingsSubHeading({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h3 className={cn('mt-2 px-1 font-[family-name:var(--font-title)] text-[15px] font-semibold text-foreground', className)}>{children}</h3>;
}

/** What a section shows when it has nothing to show, or can't work here. */
export function SettingsFallback({
  icon: Icon,
  spin,
  action,
  children,
}: {
  icon?: LucideIcon;
  spin?: boolean;
  /** What to do about it, below what it says: a button that turns it on, say. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-12 text-center">
      {Icon && <Icon className={cn('mx-auto mb-4 size-8 text-muted-foreground/70', spin && 'motion-safe:animate-spin')} strokeWidth={1.5} aria-hidden />}
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
