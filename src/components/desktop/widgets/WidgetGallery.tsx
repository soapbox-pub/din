import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { AlertTriangle, Clock, LayoutGrid, Search, StickyNote, UserRound, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useAuthor } from '@/hooks/useAuthor';
import {
  builtinWidgets,
  grantedDomains,
  missingDomains,
  nappletFilter,
  parseNappletManifest,
  type NappletSource,
  type WidgetSource,
} from '@/lib/widgets';
import { DOMAIN_LABELS } from './domainLabels';

const ICONS: Record<string, LucideIcon> = { clock: Clock, 'sticky-note': StickyNote, 'user-round': UserRound };

/** Each napplet once, its newest manifest, of those that check out. */
function napplets(events: NostrEvent[]): NappletSource[] {
  const newest = new Map<string, { at: number; source: NappletSource }>();
  for (const event of events) {
    try {
      const source = parseNappletManifest(event);
      const seen = newest.get(source.address);
      if (!seen || event.created_at > seen.at) newest.set(source.address, { at: event.created_at, source });
    } catch {
      // Not a valid widget.
    }
  }
  return [...newest.values()].sort((a, b) => b.at - a.at).map((n) => n.source);
}

/** "Add Widgets…": the built-in widgets, and widgets from Nostr (napplets). */
export function WidgetGallery() {
  const { galleryOpen, setGalleryOpen, add } = useWidgets();
  const [confirming, setConfirming] = useState<NappletSource | null>(null);

  const place = (source: WidgetSource) => {
    add(source);
    setConfirming(null);
    setGalleryOpen(false);
  };

  return (
    <Dialog open={galleryOpen} onOpenChange={(open) => {
      setGalleryOpen(open);
      if (!open) setConfirming(null);
    }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {confirming ? (
          <ConfirmNapplet source={confirming} onCancel={() => setConfirming(null)} onAdd={() => place(confirming)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Widgets</DialogTitle>
              <DialogDescription>Widgets sit on your desktop, under your windows.</DialogDescription>
            </DialogHeader>
            <section aria-labelledby="builtin-widgets" className="space-y-3">
              <h3 id="builtin-widgets" className="text-sm font-medium text-muted-foreground">Din</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                {[...builtinWidgets()].map(([id, manifest]) => {
                  const Icon = ICONS[manifest.icon] ?? LayoutGrid;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => place({ type: 'builtin', id })}
                      className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <span className="font-medium">{manifest.name}</span>
                      <span className="text-sm text-muted-foreground">{manifest.description}</span>
                    </button>
                  );
                })}
              </div>
            </section>
            <NostrWidgets onPick={setConfirming} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NostrWidgets({ onPick }: { onPick: (source: NappletSource) => void }) {
  const { nostr } = useNostr();
  const [address, setAddress] = useState('');
  const [lookup, setLookup] = useState<{ state: 'idle' | 'finding' } | { state: 'error'; message: string }>({ state: 'idle' });

  const browse = useQuery({
    queryKey: ['napplets', 'recent'],
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }) =>
      napplets(await nostr.query([{ kinds: [35129], limit: 40 }], { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) })),
  });

  const find = async (e: FormEvent) => {
    e.preventDefault();
    const target = nappletFilter(address);
    if (!target) {
      setLookup({ state: 'error', message: 'That isn\'t a widget address. Widget addresses start with naddr1.' });
      return;
    }
    setLookup({ state: 'finding' });
    try {
      const signal = AbortSignal.timeout(8000);
      const pools = target.relays.length > 0 ? [nostr, nostr.group(target.relays)] : [nostr];
      const found = (await Promise.all(pools.map((p) => p.query([target.filter], { signal }).catch(() => [])))).flat();
      const [source] = napplets(found);
      if (!source) {
        setLookup({ state: 'error', message: 'No widget was found at that address, or it isn\'t valid.' });
        return;
      }
      setLookup({ state: 'idle' });
      onPick(source);
    } catch {
      setLookup({ state: 'error', message: 'No widget was found at that address.' });
    }
  };

  return (
    <section aria-labelledby="nostr-widgets" className="space-y-3">
      <h3 id="nostr-widgets" className="text-sm font-medium text-muted-foreground">From Nostr</h3>
      <form onSubmit={find} className="flex gap-2">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="naddr1…"
          aria-label="Widget address"
          aria-invalid={lookup.state === 'error' || undefined}
          spellCheck={false}
        />
        <Button type="submit" variant="secondary" disabled={!address.trim() || lookup.state === 'finding'}>
          <Search aria-hidden /> Find
        </Button>
      </form>
      {lookup.state === 'error' && <p className="text-sm text-destructive" role="alert">{lookup.message}</p>}
      {browse.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-2 p-4">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : browse.data && browse.data.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {browse.data.map((source) => <NappletCard key={source.address} source={source} onPick={() => onPick(source)} />)}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="px-8 py-8 text-center">
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              No widgets were found on your relays. Paste a widget's address above to add it.
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function useAuthorName(pubkey: string): string {
  const author = useAuthor(pubkey);
  return author.data?.metadata?.display_name || author.data?.metadata?.name || `${nip19.npubEncode(pubkey).slice(0, 16)}…`;
}

function NappletCard({ source, onPick }: { source: NappletSource; onPick: () => void }) {
  const author = useAuthorName(source.pubkey);
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex flex-col items-start gap-1 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <span className="font-medium">{source.title}</span>
      <span className="text-xs text-muted-foreground">by {author}</span>
      <span className="line-clamp-2 text-sm text-muted-foreground">{source.description}</span>
    </button>
  );
}

function ConfirmNapplet({ source, onCancel, onAdd }: { source: NappletSource; onCancel: () => void; onAdd: () => void }) {
  const author = useAuthorName(source.pubkey);
  const domains = grantedDomains(source).filter((d) => d !== 'shell');
  const missing = missingDomains(source);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add {source.title}?</DialogTitle>
        <DialogDescription>A widget by {author}.</DialogDescription>
      </DialogHeader>
      <p className="text-sm whitespace-pre-line">{source.description}</p>
      <div className="space-y-2 rounded-xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">This widget can</p>
        {domains.length === 0 ? (
          <p className="text-muted-foreground">Only show itself. It can't reach the internet or your account.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {domains.map((d) => <li key={d}>{DOMAIN_LABELS[d]}</li>)}
          </ul>
        )}
        <p className="text-muted-foreground">It can't reach the internet, sign anything as you, or see your other apps.</p>
      </div>
      {missing.length > 0 && (
        <p className="flex gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          It also asks for things Din doesn't offer widgets yet ({missing.join(', ')}), so parts of it may not work.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>Back</Button>
        <Button onClick={onAdd}>Add Widget</Button>
      </div>
    </>
  );
}
