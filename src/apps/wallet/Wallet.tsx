import { useEffect, useState, type ComponentType } from 'react';
import { ArrowDownLeft, ArrowUpRight, Copy, History, PanelLeft, RefreshCw, Wallet as WalletIcon } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, middleEllipsis } from '@/lib/utils';
import { useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { EmptyState, SidebarRow, SidebarTitle, SidebarTitleIcon, ToolButton } from '@/shared/appChrome';
import { flushPane, sidebarWidthClass, toolIcon } from '@/shared/appChromeStyles';
import { formatBtc } from '@/shared/bitcoinAmounts';
import { restoredState, saveState, useOnLaunch, windowLaunch, type Launch } from '@/shared/launch';
import { toast } from '@/shared/toast';
import { ActivityView } from './wallet/Activity';
import { useAddress, useBalance, usePubkey, useRefresh } from './wallet/data';
import { ReceiveView } from './wallet/Receive';
import { SendView, type SendSeed } from './wallet/Send';

type Section = 'activity' | 'send' | 'receive';

const SECTIONS: { id: Section; label: string; icon: ComponentType<{ className?: string; strokeWidth?: number }> }[] = [
  { id: 'activity', label: 'Activity', icon: History },
  { id: 'send', label: 'Send', icon: ArrowUpRight },
  { id: 'receive', label: 'Receive', icon: ArrowDownLeft },
];

const ICON = '/icons/apps/wallet.png';

function isSection(value: unknown): value is Section {
  return value === 'activity' || value === 'send' || value === 'receive';
}

/**
 * What a launch asks for: a section, and for Send who and how much
 * (`{ section: 'send', to, amount }`, amount in sats; `din wallet send`).
 */
function fromLaunch({ params }: Launch): { section?: Section; seed?: SendSeed } {
  const section = isSection(params.section) ? params.section : undefined;
  const to = typeof params.to === 'string' ? params.to : undefined;
  const amount = typeof params.amount === 'number' && Number.isSafeInteger(params.amount) && params.amount > 0 ? params.amount : undefined;
  if (to || amount) return { section: section ?? 'send', seed: { to, amount } };
  return { section };
}

function initial(): { section: Section; seed?: SendSeed } {
  const launch = fromLaunch(windowLaunch());
  if (launch.section) return { section: launch.section, seed: launch.seed };
  const saved = restoredState() as { section?: unknown } | null;
  return { section: isSection(saved?.section) ? saved.section : 'activity' };
}

function Sidebar({
  section,
  onSection,
  address,
  onRefresh,
  className,
}: {
  section: Section;
  onSection: (section: Section) => void;
  address: string | null;
  onRefresh: () => void;
  className?: string;
}) {
  const balance = useBalance(address);
  const total = balance.data ? balance.data.confirmed + balance.data.pending : null;
  return (
    <nav aria-label="Wallet" className={cn('flex h-full shrink-0 flex-col', sidebarWidthClass, className)}>
      <SidebarTitle icon={<SidebarTitleIcon src={ICON} />} title="Wallet">
        <ToolButton label="Refresh" onClick={onRefresh} disabled={!address}>
          <RefreshCw {...toolIcon} />
        </ToolButton>
      </SidebarTitle>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {SECTIONS.map((s) => (
          <SidebarRow key={s.id} icon={s.icon} label={s.label} selected={section === s.id} onClick={() => onSection(s.id)} />
        ))}
      </div>
      {address && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => onSection('receive')}
              className="m-2 rounded-xl px-3 py-2.5 text-left hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
            >
              <span className="block text-xs text-muted-foreground">Bitcoin</span>
              {total === null ? (
                <span aria-label="Loading the balance" className="my-0.5 block h-4 w-24 animate-pulse rounded-md bg-muted" />
              ) : (
                <span className="block text-sm font-medium tabular-nums text-foreground">{formatBtc(total)} BTC</span>
              )}
              <span className="block truncate font-mono text-xs text-muted-foreground">{middleEllipsis(address, 22)}</span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            <ContextMenuItem
              onSelect={() => void navigator.clipboard.writeText(address).then(() => toast('Address copied'))}
            >
              <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
              Copy Address
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
    </nav>
  );
}

/**
 * Wallet: the signed-in account's onchain bitcoin. A Nostr pubkey is a
 * Taproot key, so the account already has an address (src/shared/bitcoin.ts);
 * this shows its balance and history from an Esplora server
 * (src/shared/esplora.ts), takes payments at it, and sends from it, signing
 * with Din's signer (`window.nostr.signPsbt`), whose prompt shows where the
 * money goes before anything is signed. No keys here, and nothing to set up.
 */
export function Wallet() {
  const [{ section, seed }, setView] = useState(initial);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pubkey, loading } = usePubkey();
  const address = useAddress(pubkey);
  const refresh = useRefresh();

  useWindowTitle(null);

  useEffect(() => saveState({ section }), [section]);

  useOnLaunch((launch) => {
    const next = fromLaunch(launch);
    if (next.section) setView({ section: next.section, seed: next.seed });
  });

  const go = (next: Section) => {
    setView({ section: next });
    setSidebarOpen(false);
  };

  let body;
  if (loading) {
    body = (
      <div className="mx-auto w-full max-w-2xl space-y-3 px-8 pt-8" aria-label="Loading">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-12 w-64" />
      </div>
    );
  } else if (!pubkey || !address) {
    body = (
      <EmptyState icon={WalletIcon} title="Sign in to use your wallet" className="m-auto">
        Your Nostr account is a Bitcoin wallet too. Sign in to Din to see it.
      </EmptyState>
    );
  } else if (section === 'send') {
    // Keyed so a new launch's recipient replaces what was typed.
    body = <SendView key={`${pubkey}:${seed?.to ?? ''}:${seed?.amount ?? ''}`} pubkey={pubkey} address={address} seed={seed} onDone={() => go('activity')} />;
  } else if (section === 'receive') {
    body = <ReceiveView address={address} pubkey={pubkey} />;
  } else {
    body = <ActivityView address={address} onSend={() => go('send')} onReceive={() => go('receive')} />;
  }

  return (
    <div className="@container/wallet relative flex h-full w-full text-foreground">
      {/* The strip above the inset content still drags the window. */}
      <WindowDragRegion className="absolute inset-x-0 top-0 h-2" />
      <Sidebar
        section={section}
        onSection={go}
        address={address}
        onRefresh={() => void refresh()}
        className={cn(
          sidebarOpen ? 'absolute inset-y-0 left-0 z-30 flex bg-background shadow-xl' : 'hidden',
          '@3xl/wallet:static @3xl/wallet:flex @3xl/wallet:bg-transparent @3xl/wallet:shadow-none',
        )}
      />
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close the sidebar"
          className="absolute inset-0 z-20 bg-background/40 @3xl/wallet:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 px-3">
          <ToolButton label="Show the sidebar" className="@3xl/wallet:hidden" onClick={() => setSidebarOpen(true)}>
            <PanelLeft {...toolIcon} />
          </ToolButton>
          <div className="min-w-2 flex-1" />
          <WindowControls />
        </WindowDragRegion>
        <main
          className={cn(
            '@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border/60 bg-background',
            '@3xl/wallet:mr-2 @3xl/wallet:mb-2 @3xl/wallet:rounded-2xl @3xl/wallet:border-t-0 @3xl/wallet:clay',
            flushPane,
          )}
        >
          {body}
        </main>
      </div>
    </div>
  );
}
