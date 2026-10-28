import { useState } from 'react';
import { Check, ExternalLink, Pin } from 'lucide-react';

import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { AppDefinition } from '@/lib/apps';
import { getKindLabel } from '@/lib/kindLabels';
import { cn } from '@/lib/utils';

/** What kind of app a handler is, under its name. */
function appKindLabel(app: AppDefinition): string {
  if (app.native) return 'App on this computer';
  if (app.web) return 'Website';
  return 'nsite';
}

/**
 * "Open with": the apps that open a nostr: link of this kind, the way
 * Android asks. Choose one, then open it just once or always for this kind.
 */
export function NostrOpenWithDialog({
  open,
  onOpenChange,
  apps,
  kind,
  current,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: AppDefinition[];
  /** The link's kind, or null when it isn't known (then "Always" can't be offered). */
  kind: number | null;
  /** The default app for this kind, if any. */
  current: AppDefinition | undefined;
  onOpen: (app: AppDefinition, always: boolean) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const chosen = apps.find((app) => app.id === selected) ?? current ?? apps[0];
  const kindLabel = kind === null ? null : getKindLabel(kind);

  const choose = (app: AppDefinition, always: boolean) => {
    onOpenChange(false);
    onOpen(app, always);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSelected(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Open with</DialogTitle>
          <DialogDescription>
            {kindLabel
              ? `Apps on this computer that open ${kindLabel.toLowerCase()} links.`
              : 'Apps on this computer that open nostr: links.'}
          </DialogDescription>
        </DialogHeader>

        <div role="listbox" aria-label="Apps" className="-mx-2 max-h-80 space-y-1 overflow-y-auto px-2 py-1">
          {apps.map((app) => {
            const active = chosen?.id === app.id;
            return (
              <ContextMenu key={app.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => setSelected(app.id)}
                    onDoubleClick={() => choose(app, false)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-muted',
                    )}
                  >
                    <AppIcon icon={app.icon} web={app.web} className="size-9 shrink-0 rounded-lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{app.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {current?.id === app.id ? 'Default' : appKindLabel(app)}
                      </span>
                    </span>
                    {active && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem onSelect={() => choose(app, false)}>
                    <ExternalLink aria-hidden />
                    Just once
                  </ContextMenuItem>
                  {kind !== null && (
                    <ContextMenuItem onSelect={() => choose(app, true)}>
                      <Pin aria-hidden />
                      Always
                    </ContextMenuItem>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {kind !== null && (
            <Button
              variant="outline"
              disabled={!chosen}
              onClick={() => chosen && choose(chosen, true)}
              title={kindLabel ? `Open every ${kindLabel.toLowerCase()} link in ${chosen?.name}` : undefined}
            >
              Always
            </Button>
          )}
          <Button disabled={!chosen} onClick={() => chosen && choose(chosen, false)}>
            Just once
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
