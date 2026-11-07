/**
 * Games' sidebar: Home, Favorites, Recently Played, then each system with
 * games in ~/roms. A system whose games can't be played yet is still there,
 * dimmed, so its games can be seen.
 */
import { Clock, Gamepad2, House, Maximize2, Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import type { GameSystem } from '@/lib/games';
import { cn } from '@/lib/utils';
import { SidebarHeading, SidebarRow, SidebarTitle, SidebarTitleIcon, ToolButton } from '@/shared/appChrome';
import { sidebarWidthClass, toolIcon } from '@/shared/appChromeStyles';

export function Sidebar({
  systems,
  loading,
  section,
  favorites,
  onSection,
  onFullscreen,
  className,
}: {
  systems: GameSystem[];
  loading: boolean;
  section: string;
  favorites: number;
  onSection: (section: string) => void;
  onFullscreen: () => void;
  className?: string;
}) {
  return (
    <nav aria-label="Games" className={cn('flex h-full shrink-0 flex-col', sidebarWidthClass, className)}>
      <SidebarTitle icon={<SidebarTitleIcon src="/icons/apps/games.png" />} title="Games">
        <ToolButton label="Full Screen" onClick={onFullscreen}>
          <Maximize2 {...toolIcon} />
        </ToolButton>
      </SidebarTitle>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          <SidebarRow data-nav icon={House} label="Home" selected={section === 'home'} onClick={() => onSection('home')} />
          <SidebarRow data-nav icon={Star} label="Favorites" count={favorites} selected={section === 'favorites'} onClick={() => onSection('favorites')} />
          <SidebarRow data-nav icon={Clock} label="Recently Played" selected={section === 'recent'} onClick={() => onSection('recent')} />
        </div>
        <SidebarHeading className="mt-3">Systems</SidebarHeading>
        <div className="space-y-0.5">
          {loading &&
            Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex h-8 items-center gap-2 px-2.5">
                <Skeleton className="size-4.5 rounded" />
                <Skeleton className="h-3.5 w-32" />
              </div>
            ))}
          {systems.map((s) => (
            <SidebarRow
              key={s.id}
              data-nav
              icon={Gamepad2}
              label={s.name}
              count={s.count}
              title={s.unavailable ?? `${s.maker}, ${s.year}`}
              selected={section === `system:${s.id}`}
              onClick={() => onSection(`system:${s.id}`)}
              className={cn(!s.playable && 'text-muted-foreground')}
              iconClassName={cn(!s.playable && 'text-muted-foreground')}
            />
          ))}
        </div>
      </div>
    </nav>
  );
}
