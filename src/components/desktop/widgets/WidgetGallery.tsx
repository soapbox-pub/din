import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNostr } from '@nostrify/react';
import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { AlertTriangle, Plus, Search, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useDesktopTheme } from '@/hooks/useDesktopTheme';
import { GuestSurface } from '@/platform/GuestSurface';
import { guestsAvailable } from '@/platform/guest';
import { cn } from '@/lib/utils';
import {
  builtinWidget,
  builtinWidgets,
  declaredDomains,
  isPermissionDomain,
  missingDomains,
  nappletFilter,
  parseNappletManifest,
  spanPixels,
  WIDGET_SIZES,
  WIDGETS_PARTITION,
  widgetUrl,
  type NappletSource,
  type PermissionDomain,
  type PlacedWidget,
  type WidgetSize,
} from '@/lib/widgets';
import { BuiltinIcon, NappletIcon, PermissionRow } from './permissions';
import { useNappletHost } from './useNappletHost';


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

type Pane = { kind: 'builtin'; id: string } | { kind: 'nostr' } | { kind: 'confirm'; source: NappletSource };

/** "Add Widgets…": the built-in widgets, live on the user's wallpaper, and widgets from Nostr. */
export function WidgetGallery() {
  const { galleryOpen, setGalleryOpen, add } = useWidgets();
  const first = [...builtinWidgets().keys()][0] ?? '';
  const [pane, setPane] = useState<Pane>({ kind: 'builtin', id: first });

  const close = () => {
    setGalleryOpen(false);
    setPane({ kind: 'builtin', id: first });
  };

  return (
    <Dialog open={galleryOpen} onOpenChange={(open) => (open ? setGalleryOpen(true) : close())}>
      <DialogContent className="grid h-[min(760px,90vh)] grid-cols-1 gap-0 overflow-hidden p-0 sm:max-w-5xl md:grid-cols-[232px_1fr]">
        <nav aria-label="Widgets" className="hidden flex-col gap-1 overflow-y-auto border-r bg-muted/40 p-4 md:flex">
          <DialogTitle className="px-2 pb-2 text-lg">Add Widgets</DialogTitle>
          <DialogDescription className="sr-only">Pick a widget for your desktop.</DialogDescription>
          {[...builtinWidgets()].map(([id, manifest]) => {
            const selected = pane.kind === 'builtin' && pane.id === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={selected || undefined}
                onClick={() => setPane({ kind: 'builtin', id })}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
                  <BuiltinIcon name={manifest.icon} className="size-4" />
                </span>
                {manifest.name}
              </button>
            );
          })}
          <div className="my-2 border-t" />
          <button
            type="button"
            aria-current={pane.kind !== 'builtin' || undefined}
            onClick={() => setPane({ kind: 'nostr' })}
            className={cn(
              'flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              pane.kind !== 'builtin' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
            )}
          >
            <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500/25 to-violet-500/5 text-violet-600 dark:text-violet-300">
              <Search className="size-4" aria-hidden />
            </span>
            From Nostr
          </button>
        </nav>
        <div className="min-h-0 overflow-y-auto">
          {pane.kind === 'builtin' && (
            <BuiltinPane
              id={pane.id}
              onPick={(id) => setPane({ kind: 'builtin', id })}
              onAdd={(size) => {
                add({ type: 'builtin', id: pane.id }, { size });
                close();
              }}
            />
          )}
          {pane.kind === 'nostr' && <NostrPane onPick={(source) => setPane({ kind: 'confirm', source })} />}
          {pane.kind === 'confirm' && (
            <PermissionScreen
              source={pane.source}
              onCancel={() => setPane({ kind: 'nostr' })}
              onAdd={(denied) => {
                add(pane.source, { denied });
                close();
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The user's wallpaper, for widgets to be seen on as they'd look on the desktop. */
function WallpaperStage({ children, className }: { children: React.ReactNode; className?: string }) {
  const theme = useDesktopTheme();
  const image = theme
    ? theme.background?.mimeType.startsWith('image/') ? theme.background.url : null
    : '/wallpaper.jpg';
  return (
    <div className={cn('relative isolate overflow-hidden rounded-2xl bg-background', className)}>
      {image && <img src={image} alt="" aria-hidden draggable={false} className="absolute inset-0 -z-10 size-full object-cover" />}
      {children}
    </div>
  );
}

function BuiltinPane({ id, onPick, onAdd }: { id: string; onPick: (id: string) => void; onAdd: (size: WidgetSize) => void }) {
  const manifest = builtinWidget(id);
  if (!manifest) return null;
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-1 pr-8">
        <h2 className="text-2xl font-semibold tracking-tight">{manifest.name}</h2>
        <p className="text-muted-foreground">{manifest.description}</p>
      </div>
      {/* On narrow screens, where the sidebar is hidden. */}
      <div className="flex flex-wrap gap-2 md:hidden">
        {[...builtinWidgets()].map(([other, m]) => (
          <Button key={other} size="sm" variant={other === id ? 'default' : 'outline'} onClick={() => onPick(other)}>{m.name}</Button>
        ))}
      </div>
      <WallpaperStage className="p-8">
        <div className="flex flex-wrap items-start justify-center gap-8">
          {manifest.sizes.map((size) => (
            <div key={`${id}:${size}`} className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => onAdd(size)}
                aria-label={`Add ${manifest.name}, ${WIDGET_SIZES[size].label}`}
                className="group relative rounded-3xl focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
              >
                <WidgetPreview id={id} size={size} />
                <span className="absolute -top-2 -left-2 grid size-7 place-items-center rounded-full bg-white text-slate-900 opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <Plus className="size-4" aria-hidden />
                </span>
              </button>
              <span className="rounded-full bg-black/40 px-3 py-0.5 text-sm text-white backdrop-blur">{WIDGET_SIZES[size].label}</span>
            </div>
          ))}
        </div>
      </WallpaperStage>
      <div className="flex justify-end">
        <Button onClick={() => onAdd(manifest.size)}>
          <Plus aria-hidden /> Add Widget
        </Button>
      </div>
    </div>
  );
}

/** A built-in widget, live, at a size: its own guest, answered like any other, but not to be touched. */
function WidgetPreview({ id, size }: { id: string; size: WidgetSize }) {
  const widget = useMemo<PlacedWidget>(
    () => ({ id: `preview:${id}`, source: { type: 'builtin', id }, monitor: '', col: 0, row: 0, cols: WIDGET_SIZES[size].cols, rows: WIDGET_SIZES[size].rows }),
    [id, size],
  );
  const [webContentsId, setWebContentsId] = useState<number | null>(null);
  useNappletHost(webContentsId, widget, () => {});
  const { width, height } = spanPixels(WIDGET_SIZES[size]);
  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      {guestsAvailable() ? (
        <GuestSurface
          src={widgetUrl(widget.source)}
          partition={WIDGETS_PARTITION}
          className="relative h-full w-full overflow-hidden rounded-3xl"
          onAttach={setWebContentsId}
        />
      ) : (
        <div className="grid h-full place-items-center rounded-3xl bg-black/30 text-sm text-white">Preview in Din's desktop app</div>
      )}
      <div className="absolute inset-0" />
    </div>
  );
}

function NostrPane({ onPick }: { onPick: (source: NappletSource) => void }) {
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
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="space-y-1 pr-8">
        <h2 className="text-2xl font-semibold tracking-tight">From Nostr</h2>
        <p className="text-muted-foreground">Widgets anyone can publish. You choose what each one may do.</p>
      </div>
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
      {lookup.state === 'error' && <p className="-mt-4 text-sm text-destructive" role="alert">{lookup.message}</p>}
      {browse.isPending ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="flex gap-4 p-4">
                <Skeleton className="size-12 rounded-2xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : browse.data && browse.data.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {browse.data.map((source) => <NappletCard key={source.address} source={source} onPick={() => onPick(source)} />)}
        </div>
      ) : (
        <Card className="border-dashed">
          <CardContent className="px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-muted-foreground">
              No widgets were found on your relays. Paste a widget's address above to add it.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
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
      className="flex items-start gap-4 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <NappletIcon source={source} className="size-12 shrink-0 text-xl" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{source.title}</span>
        <span className="block truncate text-xs text-muted-foreground">by {author}</span>
        <span className="mt-1 line-clamp-2 text-sm text-muted-foreground">{source.description}</span>
      </span>
    </button>
  );
}

/** Android-style: who it is, then each permission it asks for with a switch, then Add or Cancel. */
function PermissionScreen({ source, onCancel, onAdd }: { source: NappletSource; onCancel: () => void; onAdd: (denied: PermissionDomain[]) => void }) {
  const author = useAuthorName(source.pubkey);
  const asked = declaredDomains(source).filter(isPermissionDomain);
  const missing = missingDomains(source);
  const [denied, setDenied] = useState<PermissionDomain[]>([]);

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 px-6 py-10">
      <NappletIcon source={source} className="size-20 text-3xl shadow-md" />
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Add {source.title} to your desktop?</h2>
        <p className="text-sm text-muted-foreground">A widget by {author}</p>
        <p className="line-clamp-4 text-sm whitespace-pre-line text-muted-foreground">{source.description}</p>
      </div>
      <div className="w-full rounded-2xl border bg-card px-4">
        {asked.length === 0 ? (
          <div className="flex items-start gap-4 py-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <div>
              <p className="font-medium">No special permissions</p>
              <p className="text-sm text-muted-foreground">It can't reach the internet, your account or your files.</p>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            <p className="py-3 text-sm font-medium text-muted-foreground">This widget wants to use</p>
            {asked.map((domain) => (
              <PermissionRow
                key={domain}
                domain={domain}
                allowed={!denied.includes(domain)}
                required={source.requires.includes(domain)}
                onChange={(allowed) => setDenied((list) => (allowed ? list.filter((d) => d !== domain) : [...list, domain]))}
              />
            ))}
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <p className="flex gap-2 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          It also asks for things Din doesn't offer widgets yet ({missing.join(', ')}), so parts of it may not work.
        </p>
      )}
      <p className="text-center text-xs text-muted-foreground">You can change these later in About This Widget.</p>
      <div className="flex w-full flex-col gap-2">
        <Button size="lg" className="w-full rounded-full" onClick={() => onAdd(denied)}>Add Widget</Button>
        <Button size="lg" variant="ghost" className="w-full rounded-full" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
