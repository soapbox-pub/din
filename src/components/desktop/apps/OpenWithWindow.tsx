import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AtSign, Bitcoin } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useNostrLinks } from '@/hooks/useNostrLinks';
import { useBitcoinLinks } from '@/hooks/useBitcoinLinks';
import { isBitcoinUri } from '@/lib/bitcoinUri';
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
 * A `bitcoin:` link with more than one app to pay it and none chosen with
 * Always gets the same question (useBitcoinLinks' openBitcoinUri).
 */
export function OpenWithWindow({ windowId, params }: AppComponentProps) {
  const uri = typeof params?.uri === 'string' ? params.uri : '';
  const parsed = useMemo(() => parseNostrUri(uri), [uri]);
  const bitcoin = !parsed && isBitcoinUri(uri);
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
        ) : bitcoin ? (
          <BitcoinChooser key={`${uri}:${String(params?.at)}`} uri={uri.trim()} windowId={windowId} />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">This isn’t a link Din can read.</p>
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

  return (
    <AppChoices
      apps={apps}
      chosen={chosen}
      onChoose={(app) => setChosenId(app.id)}
      onGo={go}
      onEscape={() => close(windowId)}
      icon={<AtSign className="size-5" strokeWidth={1.75} aria-hidden />}
      title={
        <>
          {kindLabel ?? (isPending ? 'Looking it up…' : 'Nostr link')}
          {who && <span className="font-normal text-muted-foreground"> · {who}</span>}
        </>
      }
      subtitle={parsed.uri}
      empty={`No app on this computer opens ${kindLabel ? `${kindLabel.toLowerCase()} links` : 'this link'}.`}
      alwaysDisabled={!kindKnown}
      alwaysTitle={kindKnown ? `Always open ${kindLabel?.toLowerCase() ?? 'these'} links in ${chosen?.name ?? 'it'}` : 'Waiting to learn what kind of link it is'}
      extra={
        <Button variant="ghost" className="rounded-full" onClick={preview}>
          Preview
        </Button>
      }
    />
  );
}

/**
 * The chooser itself: what the link is, the apps that open it (arrows move
 * between them, Enter or a double-click opens one just once, Escape lets it
 * be), and Just once or Always.
 */
function AppChoices({
  apps,
  chosen,
  onChoose,
  onGo,
  onEscape,
  icon,
  title,
  subtitle,
  empty,
  alwaysDisabled = false,
  alwaysTitle,
  extra,
}: {
  apps: AppDefinition[];
  chosen: AppDefinition | undefined;
  onChoose: (app: AppDefinition) => void;
  onGo: (app: AppDefinition | undefined, always: boolean) => void;
  onEscape: () => void;
  icon: ReactNode;
  title: ReactNode;
  subtitle: string;
  empty: string;
  alwaysDisabled?: boolean;
  alwaysTitle?: string;
  extra?: ReactNode;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
      return;
    }
    if (apps.length === 0 || !chosen) return;
    const i = apps.indexOf(chosen);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = apps[(i + (e.key === 'ArrowDown' ? 1 : apps.length - 1)) % apps.length];
      onChoose(next);
      document.getElementById(`open-with-${next.id}`)?.focus();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-pigment text-primary-foreground clay-pigment">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-[family-name:var(--font-title)] text-lg font-semibold">{title}</p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={subtitle}>
            {middleEllipsis(subtitle, 40)}
          </p>
        </div>
      </header>

      <div role="listbox" aria-label="Apps that open it" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2 [&>*]:shrink-0">
        {apps.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">{empty}</p>
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
                onClick={() => onChoose(app)}
                onDoubleClick={() => onGo(app, false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onGo(app, false);
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
        {extra}
        <div className="flex-1" />
        <Button variant="outline" className="rounded-full" disabled={!chosen} onClick={() => onGo(chosen, false)}>
          Just once
        </Button>
        <Button className="rounded-full" disabled={!chosen || alwaysDisabled} title={alwaysTitle} onClick={() => onGo(chosen, true)}>
          Always
        </Button>
      </footer>
    </div>
  );
}

/** Who a `bitcoin:` link pays, for the header: its address, and how much when it says. */
function describeBitcoinUri(uri: string): { address: string; amount: string | null; label: string | null } {
  const body = uri.slice('bitcoin:'.length);
  const q = body.indexOf('?');
  const params = new URLSearchParams(q === -1 ? '' : body.slice(q + 1));
  const amount = params.get('amount');
  return {
    address: q === -1 ? body : body.slice(0, q),
    amount: amount && /^\d{1,8}(\.\d{1,8})?$/.test(amount) ? `${amount} BTC` : null,
    label: params.get('label')?.trim() || null,
  };
}

/** Open With for a `bitcoin:` link: the apps that pay them, Just once or Always. */
function BitcoinChooser({ uri, windowId }: { uri: string; windowId: string }) {
  const { close } = useWindowActions();
  const { handlers: apps, setDefault, openWith } = useBitcoinLinks();
  const [chosenId, setChosenId] = useState<string | null>(null);
  const chosen = apps.find((a) => a.id === chosenId) ?? apps[0];
  const { address, amount, label } = describeBitcoinUri(uri);

  const go = (app: AppDefinition | undefined, always: boolean) => {
    if (!app) return;
    if (always) setDefault(app.id);
    openWith(app, uri);
    close(windowId);
  };

  return (
    <AppChoices
      apps={apps}
      chosen={chosen}
      onChoose={(app) => setChosenId(app.id)}
      onGo={go}
      onEscape={() => close(windowId)}
      icon={<Bitcoin className="size-5" strokeWidth={1.75} aria-hidden />}
      title={
        <>
          {amount ? `Pay ${amount}` : 'Bitcoin payment'}
          {label && <span className="font-normal text-muted-foreground"> · {label}</span>}
        </>
      }
      subtitle={address || uri}
      empty="No app on this computer opens bitcoin: links."
      alwaysTitle={chosen ? `Always open bitcoin: links in ${chosen.name}` : undefined}
    />
  );
}
