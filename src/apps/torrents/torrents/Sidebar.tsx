import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Torrent } from '@/lib/torrents';
import { SidebarHeading, SidebarRow, SidebarTitle, SidebarTitleIcon } from '@/shared/appChrome';
import { sidebarWidthClass } from '@/shared/appChromeStyles';
import { FILTERS, type Filter } from './model';

export function Sidebar({
  torrents,
  filter,
  onFilter,
  actions,
  className,
}: {
  torrents: Torrent[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
  /** The app's actions, beside its name. */
  actions?: ReactNode;
  className?: string;
}) {
  const count = (test: (t: Torrent) => boolean) => torrents.filter(test).length;
  return (
    <nav aria-label="Transfers" className={cn('flex h-full shrink-0 flex-col', sidebarWidthClass, className)}>
      <SidebarTitle icon={<SidebarTitleIcon src="/icons/apps/torrents.png" />} title="Torrents">
        {actions}
      </SidebarTitle>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 [&>*]:shrink-0">
        <SidebarHeading>Transfers</SidebarHeading>
        <div className="space-y-0.5">
          {FILTERS.map((f) => {
            const n = count(f.test);
            if (f.id === 'errors' && n === 0 && filter !== 'errors') return null;
            return (
              <SidebarRow
                key={f.id}
                icon={f.icon}
                label={f.label}
                count={n}
                selected={filter === f.id}
                iconClassName={f.id === 'errors' ? 'text-destructive' : undefined}
                onClick={() => onFilter(f.id)}
              />
            );
          })}
        </div>
      </div>
    </nav>
  );
}
