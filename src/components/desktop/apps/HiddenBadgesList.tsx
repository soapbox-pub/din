import { AppWindow, Bell } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useAppContext } from '@/hooks/useAppContext';
import { hiddenBadges, withBadgeHidden } from '@/lib/hiddenBadges';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';
import { SettingsToken } from '@/shared/settingsChrome';

/**
 * The apps whose Dock or taskbar badge the user hid (a tile's right-click
 * "Hide badge"), each with Show to bring it back: the way back for an app no
 * longer in the Dock. Nothing while none is hidden.
 */
export function HiddenBadgesList() {
  const { config, updateConfig } = useAppContext();
  const { getApp } = useInstalledApps();
  const hidden = hiddenBadges(config);
  if (hidden.length === 0) return null;

  const show = (id: string) => updateConfig((c) => withBadgeHidden(c, id, false));
  const rows = hidden
    .map((id) => ({ id, app: getApp(id), name: getApp(id)?.name ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <SettingsSubHeading>Hidden badges</SettingsSubHeading>
      <p className="mb-3 px-1 text-xs text-muted-foreground">
        These apps’ icons in the Dock and taskbar don’t show a badge. Their notifications still come.
      </p>
      <ul className={settingsGroup}>
        {rows.map(({ id, app, name }) => (
          <ContextMenu key={id}>
            <ContextMenuTrigger asChild>
              <li className="flex items-center gap-3 px-4 py-3">
                {app ? (
                  <AppIcon icon={app.icon} web={app.web} className="size-8 shrink-0 rounded-md" />
                ) : (
                  <SettingsToken icon={AppWindow} />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={() => show(id)}>
                  Show badge
                </Button>
              </li>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-56">
              <ContextMenuItem onSelect={() => show(id)}>
                <Bell aria-hidden /> Show badge
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </ul>
    </div>
  );
}
