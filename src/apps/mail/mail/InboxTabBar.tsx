import { useRef, type KeyboardEvent } from 'react';
import { EyeOff, Settings } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CATEGORY_NAMES, type MailCategory } from '@/lib/mail';
import { cn } from '@/lib/utils';
import { TAB_ICONS } from './tabs';

/** Each tab's own color, as Gmail's: its underline and its count of new mail. */
const TAB_COLORS: Record<MailCategory, { line: string; text: string; count: string }> = {
  primary: { line: 'bg-primary', text: 'text-primary', count: 'bg-primary text-primary-foreground' },
  promotions: { line: 'bg-emerald-600', text: 'text-emerald-700 dark:text-emerald-400', count: 'bg-emerald-700 text-white' },
  social: { line: 'bg-blue-600', text: 'text-blue-700 dark:text-blue-400', count: 'bg-blue-700 text-white' },
  updates: { line: 'bg-orange-600', text: 'text-orange-700 dark:text-orange-400', count: 'bg-orange-700 text-white' },
  forums: { line: 'bg-violet-600', text: 'text-violet-700 dark:text-violet-400', count: 'bg-violet-700 text-white' },
};

/**
 * The inbox's tabs, above its list, as Gmail's: Primary and the ones shown,
 * each with how much new mail it has had since it was last open (Primary's
 * isn't counted, as on Gmail). Right-clicking one hides it or opens Settings.
 */
export function InboxTabBar({
  tabs,
  current,
  fresh,
  onPick,
  onHide,
  onSettings,
}: {
  tabs: MailCategory[];
  current: MailCategory;
  /** New mail in each tab. */
  fresh: Partial<Record<MailCategory, number>>;
  onPick: (tab: MailCategory) => void;
  onHide: (tab: MailCategory) => void;
  onSettings: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    const at = tabs.indexOf(current);
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const tab = tabs[(to + tabs.length) % tabs.length];
    onPick(tab);
    bar.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
  };

  return (
    <div ref={bar} role="tablist" aria-label="Inbox tabs" onKeyDown={onKeyDown} className="@container flex shrink-0 border-b border-border/60 px-2">
      {tabs.map((tab) => {
        const Icon = TAB_ICONS[tab];
        const active = tab === current;
        const count = tab === 'primary' ? 0 : fresh[tab] ?? 0;
        const color = TAB_COLORS[tab];
        return (
          <ContextMenu key={tab}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                role="tab"
                data-tab={tab}
                aria-selected={active}
                aria-label={count ? `${CATEGORY_NAMES[tab]}, ${count} new` : CATEGORY_NAMES[tab]}
                tabIndex={active ? 0 : -1}
                onClick={() => onPick(tab)}
                className={cn(
                  'relative flex h-12 max-w-60 min-w-0 flex-1 items-center justify-center gap-3 rounded-t-lg px-3 text-sm outline-none @xl:justify-start @xl:px-4',
                  'hover:bg-foreground/[0.05] focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset',
                  active ? cn('font-medium', color.text) : 'text-muted-foreground',
                )}
              >
                <span className="relative shrink-0">
                  <Icon className="size-4.5" strokeWidth={1.75} />
                  {count > 0 && <span aria-hidden className={cn('absolute -top-1 -right-1 size-2 rounded-full @xl:hidden', color.line)} />}
                </span>
                <span className="hidden truncate @xl:inline">{CATEGORY_NAMES[tab]}</span>
                {count > 0 && (
                  <span aria-hidden className={cn('hidden shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums @3xl:inline', color.count)}>
                    {count > 99 ? '99+' : count} new
                  </span>
                )}
                {active && <span aria-hidden className={cn('absolute inset-x-2 bottom-0 h-0.75 rounded-t-full', color.line)} />}
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              {tab !== 'primary' && (
                <>
                  <ContextMenuItem onSelect={() => onHide(tab)}>
                    <EyeOff /> Hide {CATEGORY_NAMES[tab]}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
              <ContextMenuItem onSelect={onSettings}>
                <Settings /> Inbox Tabs Settings…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
