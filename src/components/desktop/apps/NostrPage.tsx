import { useMemo, useState } from 'react';
import { AtSign, Check, ChevronDown, Copy, ExternalLink, Pin } from 'lucide-react';

import { AppIcon } from '@/components/desktop/AppIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmbeddedEvent } from '@/components/EmbeddedEvent';
import { Button } from '@/components/ui/button';
import { EmptyState, ToolButton } from '@/shared/appChrome';
import { toolIcon } from '@/shared/appChromeStyles';
import { Skeleton } from '@/components/ui/skeleton';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { useNostrTarget } from '@/hooks/useNostrTarget';
import type { AppDefinition } from '@/lib/apps';
import type { DraftEvent } from '@/lib/draftEvent';
import { getKindLabel } from '@/lib/kindLabels';
import { knownKind, parseNostrUri } from '@/lib/nostrUri';
import { middleEllipsis } from '@/lib/utils';

/**
 * A `nostr:` link in the Web Browser: what it names, drawn the way the
 * signer prompt draws an event, and buttons to open it in an app that says
 * it can (src/hooks/useNostrLinks.ts). An internal page, painted over the
 * tab's parked surface like about:preferences.
 */
export function NostrPage({ uri }: { uri: string }) {
  const parsed = useMemo(() => parseNostrUri(uri), [uri]);
  const target = parsed?.target ?? null;
  const { data: event, isPending } = useNostrTarget(target);
  const { handlersFor, defaultFor, setDefault, openWith } = useNostrLinks();
  const [copied, setCopied] = useState(false);

  if (!parsed || !target) return null;

  const kind = event?.kind ?? knownKind(target);
  const apps = handlersFor(kind);
  const current = defaultFor(kind);
  // The one to offer first: the default, or the only app there is.
  const primary = current ?? (apps.length === 1 ? apps[0] : undefined);
  const kindLabel = kind === null ? null : getKindLabel(kind);

  // A profile no relay has is still somebody: draw the face and the npub.
  const shown: DraftEvent | null =
    event ?? (target.type === 'profile' && !isPending ? { kind: 0, content: '{}', tags: [], pubkey: target.pubkey } : null);

  const open = (app: AppDefinition, always = false) => {
    if (always && kind !== null) setDefault(kind, app.id);
    openWith(app, parsed.uri);
  };

  const copy = () => {
    void navigator.clipboard
      ?.writeText(parsed.uri)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    // Opaque: the surface underneath is a white about:blank.
    <div className="absolute inset-0 overflow-auto bg-background px-6 py-12 text-foreground">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6 [&>*]:shrink-0">
        <header className="flex items-center gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-full bg-pigment text-primary-foreground clay-pigment">
            <AtSign className="size-6" strokeWidth={1.75} aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold tracking-tight">{kindLabel ?? 'Nostr event'}</h1>
            <p className="truncate font-mono text-sm text-muted-foreground" title={parsed.uri}>
              {middleEllipsis(parsed.uri, 40)}
            </p>
          </div>
          <ToolButton label={copied ? 'Link copied' : 'Copy link'} onClick={copy}>
            {copied ? <Check {...toolIcon} aria-hidden /> : <Copy {...toolIcon} aria-hidden />}
          </ToolButton>
        </header>

        {shown ? (
          <div className="space-y-2">
            <EmbeddedEvent event={shown} className="border-0 bg-card p-4 clay" />
            {event && event.kind !== 0 && (
              <p className="px-1 text-xs text-muted-foreground">
                {new Date(event.created_at * 1000).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>
            )}
          </div>
        ) : isPending ? (
          <div className="space-y-3 rounded-xl bg-card p-4 clay" aria-label="Loading">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : (
          <EmptyState>
            None of your relays has this event, and neither do the ones the link suggests. It may have been deleted,
            or live on a relay Din doesn't know.
          </EmptyState>
        )}

        {apps.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {primary && (
              <Button onClick={() => open(primary)}>
                <AppIcon icon={primary.icon} className="size-4 rounded-sm" />
                Open in {primary.name}
              </Button>
            )}
            {/* Which app, as a menu: each opens it once, or from Always for every link of its kind. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant={primary ? 'outline' : 'default'}>
                  <ExternalLink aria-hidden />
                  Open With
                  <ChevronDown className="opacity-70" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                {apps.map((app) => (
                  <DropdownMenuItem key={app.id} onSelect={() => open(app)}>
                    <AppIcon icon={app.icon} web={app.web} className="size-5 shrink-0 rounded" />
                    <span className="min-w-0 flex-1 truncate">{app.name}</span>
                    {current?.id === app.id && <Check className="text-ink-accent" aria-hidden />}
                  </DropdownMenuItem>
                ))}
                {kind !== null && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <Pin aria-hidden />
                        Always Open {kindLabel ? `${kindLabel} Links` : 'These Links'} In
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-56">
                        <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={(id) => {
                          const app = apps.find((a) => a.id === id);
                          if (app) open(app, true);
                        }}>
                          {apps.map((app) => (
                            <DropdownMenuRadioItem key={app.id} value={app.id}>
                              {app.name}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">
            No app on this computer opens {kindLabel ? `${kindLabel.toLowerCase()} links` : 'nostr: links'}. Apps
            offer to in their web app manifest, and installed ones show up here.
          </p>
        )}
      </div>

    </div>
  );
}
