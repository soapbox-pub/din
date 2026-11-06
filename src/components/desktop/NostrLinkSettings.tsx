import { RotateCcw } from 'lucide-react';

import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { getKindLabel } from '@/lib/kindLabels';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * The apps nostr: links open in without asking, one per kind, as chosen with
 * "Always" in the Open with dialog; and the apps that open them at all.
 */
export function NostrLinkSettings() {
  const { defaults, handlers, defaultFor, setDefault } = useNostrLinks();

  const rows = Object.keys(defaults)
    .map(Number)
    .sort((a, b) => a - b)
    .map((kind) => ({ kind, app: defaultFor(kind) }));

  return (
    <div className="space-y-3">
      <div>
        <h3 className="px-1 text-sm font-semibold text-foreground/90">Nostr links</h3>
        <p className="px-1 text-xs text-muted-foreground">
          Where nostr: links open. Without a default, Din shows what a link points to and lets you pick an app.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {handlers.length === 0
            ? 'No installed app opens nostr: links yet. Apps that do say so in their web app manifest.'
            : `${handlers.length === 1 ? '1 installed app opens' : `${handlers.length} installed apps open`} nostr: links. Choose “Always” when you open one to make it the default for that kind of link.`}
        </p>
      ) : (
        <ul className={settingsGroup}>
          {rows.map(({ kind, app }) => (
            <ContextMenu key={kind}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 py-2 pr-2 pl-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{getKindLabel(kind)}</p>
                    <p className="text-xs text-muted-foreground">Kind {kind}</p>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    {app ? (
                      <>
                        <AppIcon icon={app.icon} web={app.web} className="size-5 shrink-0 rounded" />
                        <span className="truncate">{app.name}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">App not installed</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDefault(kind, null)}
                    aria-label={`Stop opening ${getKindLabel(kind).toLowerCase()} links automatically`}
                    title="Ask every time"
                  >
                    <RotateCcw aria-hidden />
                  </Button>
                </li>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => setDefault(kind, null)}>
                  <RotateCcw aria-hidden />
                  Ask every time
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </ul>
      )}
    </div>
  );
}
