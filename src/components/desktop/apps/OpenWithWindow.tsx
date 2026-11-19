import { useMemo, useState, type KeyboardEvent } from 'react';
import { AtSign } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { useNostrTarget } from '@/hooks/useNostrTarget';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { getKindLabel } from '@/lib/kindLabels';
import { knownKind, parseNostrUri, type ParsedNostrUri } from '@/lib/nostrUri';
import { cn, middleEllipsis } from '@/lib/utils';
import { AppIcon } from '@/shared/AppIcon';
import { ContentPane } from '@/shared/appChrome';

/**
 * Open With, as Android asks: a `nostr:` link with no default app for its
 * kind, the apps that open that kind, and Just once or Always (which makes
 * the app chosen the default for the kind, as Settings → Nostr & Storage
 * lists). Preview shows the link in the Web Browser instead. Opened by
 * useNostrLinks' openNostrUri; launch params `uri`, and `at` to start over.
 */
export function OpenWithWindow({ windowId, params }: AppComponentProps) {
  const uri = typeof params?.uri === 'string' ? params.uri : '';
  const parsed = useMemo(() => parseNostrUri(uri), [uri]);
  useWindowTitle('Open With');
  useOwnWindowHeader();
  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-4">
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">Open With</h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane className="ml-2">
        {parsed ? (
          <Chooser key={`${parsed.uri}:${String(params?.at)}`} parsed={parsed} windowId={windowId} />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">This isn’t a nostr: link Din can read.</p>
        )}
      </ContentPane>
    </div>
  );
}

function Chooser({ parsed, windowId }: { parsed: ParsedNostrUri; windowId: string }) {
  const { close, open } = useWindowActions();
  const { handlersFor, setDefault, openWith } = useNostrLinks();
  const { data: event, isPending } = useNostrTarget(parsed.target);
  const kind = event?.kind ?? knownKind(parsed.target);
  // Until a note1… is found, its kind (so who opens it) isn't known.
  const kindKnown = kind !== null;
  const apps = handlersFor(kind);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = apps.find((a) => a.id === chosenId) ?? apps[0];

  const kindLabel = kind === null ? null : getKindLabel(kind);
  const pubkey = parsed.target.type === 'event' ? (event?.pubkey ?? parsed.target.author) : (event?.pubkey ?? parsed.target.pubkey);
  const metadata = useAuthor(pubkey ?? undefined).data?.metadata;
  const who = (metadata?.display_name || metadata?.name)?.trim();

  const go = (app: AppDefinition | undefined, always: boolean) => {
    if (!app) return;
    if (always && kind !== null) setDefault(kind, app.id);
    openWith(app, parsed.uri);
    close(windowId);
  };
  const preview = () => {
    if (!hasTabConsumer()) open('web-browser');
    publishTabCommand({ type: 'open', url: parsed.uri });
    close(windowId);
  };

  // Arrows move between apps, Enter opens the chosen one just once, Escape lets it be.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(windowId);
      return;
    }
    if (apps.length === 0 || !chosen) return;
    const i = apps.indexOf(chosen);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = apps[(i + (e.key === 'ArrowDown' ? 1 : apps.length - 1)) % apps.length];
      setChosenId(next.id);
      document.getElementById(`open-with-${next.id}`)?.focus();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-pigment text-primary-foreground clay-pigment">
          <AtSign className="size-5" strokeWidth={1.75} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-[family-name:var(--font-title)] text-lg font-semibold">
            {kindLabel ?? (isPending ? 'Looking it up…' : 'Nostr link')}
            {who && <span className="font-normal text-muted-foreground"> · {who}</span>}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={parsed.uri}>
            {middleEllipsis(parsed.uri, 40)}
          </p>
        </div>
      </header>

      <div role="listbox" aria-label="Apps that open it" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 [&>*]:shrink-0">
        {apps.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No app on this computer opens {kindLabel ? `${kindLabel.toLowerCase()} links` : 'this link'}.
          </p>
        ) : (
          apps.map((app) => {
            const selected = app.id === chosen?.id;
            return (
              <button
                key={app.id}
                id={`open-with-${app.id}`}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                autoFocus={selected}
                onClick={() => setChosenId(app.id)}
                onDoubleClick={() => go(app, false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    go(app, false);
                  }
                }}
                className={cn(
                  'flex h-12 items-center gap-3 rounded-xl px-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  selected ? 'bg-selected' : 'hover:bg-foreground/5',
                )}
              >
                <AppIcon icon={app.icon} web={app.web} className="size-8 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
              </button>
            );
          })
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-2 pb-4">
        <Button variant="ghost" className="rounded-full" onClick={preview}>
          Preview
        </Button>
        <div className="flex-1" />
        <Button variant="outline" className="rounded-full" disabled={!chosen} onClick={() => go(chosen, false)}>
          Just once
        </Button>
        <Button
          className="rounded-full"
          disabled={!chosen || !kindKnown}
          title={kindKnown ? `Always open ${kindLabel?.toLowerCase() ?? 'these'} links in ${chosen?.name ?? 'it'}` : 'Waiting to learn what kind of link it is'}
          onClick={() => go(chosen, true)}
        >
          Always
        </Button>
      </footer>
    </div>
  );
}
