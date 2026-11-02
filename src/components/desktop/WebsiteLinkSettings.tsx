import { AppIcon } from '@/components/desktop/AppIcon';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Switch } from '@/components/ui/switch';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { websiteLabel } from '@/lib/nsiteApps';

/**
 * The websites whose links installed nsites open, each with a switch: the
 * nsite asks for the website in its manifest (`scope_extensions`), and the
 * website names the nsite back in its web-app-origin-association.
 */
export function WebsiteLinkSettings() {
  const { linkedWebsites, getApp, setOpensLinks } = useInstalledApps();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Website links</h3>
        <p className="text-xs text-muted-foreground">
          Links to these websites open in an installed nsite that the website says is its own.
        </p>
      </div>

      {linkedWebsites.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          No installed nsite opens a website’s links yet. A website names its nsite in its
          web-app-origin-association file.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {linkedWebsites.map((website) => {
            const app = getApp(website.appId);
            const label = websiteLabel(website);
            const name = app?.name ?? 'its app';
            return (
              <ContextMenu key={`${website.appId} ${website.origin}`}>
                <ContextMenuTrigger asChild>
                  <li className="flex items-center gap-3 px-3 py-2">
                    {app && <AppIcon icon={app.icon} web={app.web} className="size-5 shrink-0 rounded" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{label}</p>
                      <p className="truncate text-xs text-muted-foreground">Opens in {name}</p>
                    </div>
                    <Switch
                      checked={website.on}
                      onCheckedChange={(on) => setOpensLinks(website.appId, on)}
                      aria-label={`Open ${label} links in ${name}`}
                    />
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuCheckboxItem
                    checked={website.on}
                    onCheckedChange={(on) => setOpensLinks(website.appId, on)}
                  >
                    Open links in {name}
                  </ContextMenuCheckboxItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </ul>
      )}
    </div>
  );
}
