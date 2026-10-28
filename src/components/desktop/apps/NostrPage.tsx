import { useMemo, useState } from 'react';
import { AtSign, Check, Copy, ExternalLink } from 'lucide-react';

import { AppIcon } from '@/components/desktop/AppIcon';
import { NostrOpenWithDialog } from '@/components/desktop/NostrOpenWithDialog';
import { EmbeddedEvent } from '@/components/EmbeddedEvent';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  const [choosing, setChoosing] = useState(false);
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
    // Opaque, like the settings page: the surface underneath is a white
    // about:blank.
    <div className="absolute inset-0 overflow-auto bg-background bg-gradient-to-b from-background to-muted/30 px-6 py-12 text-foreground">
      <div className="mx-auto w-full max-w-xl space-y-6">
        <header className="flex items-center gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <AtSign className="size-6" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{kindLabel ?? 'Nostr event'}</h1>
            <p className="truncate font-mono text-sm text-muted-foreground" title={parsed.uri}>
              {middleEllipsis(parsed.uri, 40)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={copy}
            aria-label={copied ? 'Link copied' : 'Copy link'}
            title={copied ? 'Copied' : 'Copy link'}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        </header>

        {shown ? (
          <div className="space-y-2">
            <EmbeddedEvent event={shown} className="bg-card p-4 shadow-sm" />
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
          <div className="space-y-3 rounded-xl border bg-card p-4 shadow-sm" aria-label="Loading">
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
          <Card className="border-dashed">
            <CardContent className="px-8 py-12 text-center">
              <p className="mx-auto max-w-sm text-muted-foreground">
                None of your relays has this event, and neither do the ones the link suggests. It may have
                been deleted, or live on a relay Din doesn't know.
              </p>
            </CardContent>
          </Card>
        )}

        {apps.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {primary && (
              <Button onClick={() => open(primary)}>
                <AppIcon icon={primary.icon} className="size-4 rounded-sm" />
                Open in {primary.name}
              </Button>
            )}
            <Button variant={primary ? 'outline' : 'default'} onClick={() => setChoosing(true)}>
              <ExternalLink aria-hidden />
              Open with…
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No app on this computer opens {kindLabel ? `${kindLabel.toLowerCase()} links` : 'nostr: links'}. Apps
            offer to in their web app manifest, and installed ones show up here.
          </p>
        )}
      </div>

      <NostrOpenWithDialog
        open={choosing}
        onOpenChange={setChoosing}
        apps={apps}
        kind={kind}
        current={current}
        onOpen={open}
      />
    </div>
  );
}
