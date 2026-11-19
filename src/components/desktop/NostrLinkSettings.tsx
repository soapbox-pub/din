import { RotateCcw } from 'lucide-react';

import { AppIcon } from '@/shared/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/hooks/useAppContext';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { getKindLabel } from '@/lib/kindLabels';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * Where nostr: links open: whether a link with no default asks which app
 * (the Open With chooser) or shows in the Web Browser, and the app each
 * kind opens in without asking, as chosen with "Always", which can be
 * changed here or let go of. `din settings set nostr.links-chooser` and
 * `din nostr link-default` do the same.
 */
export function NostrLinkSettings() {
  const { config, updateConfig } = useAppContext();
  const { defaults, handlers, handlersFor, defaultFor, setDefault } = useNostrLinks();
  const chooser = config.nostrLinkChooser !== false;

  const rows = Object.keys(defaults)
    .map(Number)
    .sort((a, b) => a - b)
    .map((kind) => ({ kind, app: defaultFor(kind), choices: handlersFor(kind) }));

  return (
    <div className="space-y-3">
      <div>
        <h3 className="px-1 text-sm font-semibold text-foreground/90">Nostr links</h3>
        <p className="px-1 text-xs text-muted-foreground">
          Where nostr: links open.{' '}
          {handlers.length === 0
            ? 'No installed app opens them yet; apps that do say so in their web app manifest.'
            : `${handlers.length === 1 ? '1 installed app opens' : `${handlers.length} installed apps open`} them.`}
        </p>
      </div>

      <div className={settingsGroup}>
        <label htmlFor="nostr-link-chooser" className="flex min-h-14 items-center gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">Ask which app to use</span>
            <span className="block text-xs text-muted-foreground">
              {chooser
                ? 'A link with no default app asks, with Just once or Always.'
                : 'A link with no default app shows in the Web Browser, with a way to open it in an app.'}
            </span>
          </span>
          <Switch
            id="nostr-link-chooser"
            checked={chooser}
            onCheckedChange={(on) => updateConfig((c) => ({ ...c, nostrLinkChooser: on }))}
          />
        </label>
      </div>

      {rows.length > 0 && (
        <ul className={settingsGroup} aria-label="Default apps">
          {rows.map(({ kind, app, choices }) => (
            <ContextMenu key={kind}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 py-2 pr-2 pl-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{getKindLabel(kind)}</p>
                    <p className="text-xs text-muted-foreground">Kind {kind}</p>
                  </div>
                  {app && choices.length > 0 ? (
                    <Select value={app.id} onValueChange={(id) => setDefault(kind, id)}>
                      <SelectTrigger
                        size="sm"
                        className="w-44"
                        aria-label={`The app ${getKindLabel(kind).toLowerCase()} links open in`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {choices.map((choice) => (
                          <SelectItem key={choice.id} value={choice.id}>
                            <AppIcon icon={choice.icon} web={choice.web} className="size-5 shrink-0 rounded" />
                            <span className="truncate">{choice.name}</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-sm text-muted-foreground">App not installed</span>
                  )}
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
      {rows.length === 0 && handlers.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground">
          Choose “Always” when you open one to make that app the default for its kind of link.
        </p>
      )}
    </div>
  );
}
