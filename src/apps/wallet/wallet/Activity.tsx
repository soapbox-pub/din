import { ArrowDownLeft, ArrowUpRight, Clock, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, middleEllipsis } from '@/lib/utils';
import { EmptyState, PillButton, StatusPill } from '@/shared/appChrome';
import { focusRing } from '@/shared/appChromeStyles';
import { formatBtc, formatSats, formatUsd } from '@/shared/bitcoinAmounts';
import { explorerUrl, type Activity as ActivityItem } from '@/shared/esplora';
import { toast } from '@/shared/toast';
import { useActivity, useBalance, usePrice } from './data';

const DAY_MS = 86_400_000;

function when(item: ActivityItem): string {
  if (!item.confirmed || !item.time) return 'Pending';
  const date = new Date(item.time * 1000);
  const age = Date.now() - date.getTime();
  if (age < DAY_MS && date.getDate() === new Date().getDate()) {
    return `Today, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  });
}

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast(`Couldn’t copy the ${what.toLowerCase()}`, { destructive: true }),
  );
}

/** What a row's right-click menu does with a transaction. */
function ActivityMenuItems({ item }: { item: ActivityItem }) {
  return (
    <>
      <ContextMenuItem onSelect={() => window.open(explorerUrl('tx', item.txid))}>
        <ExternalLink className="size-4.5" strokeWidth={1.75} aria-hidden />
        View on mempool.space
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => copy(item.txid, 'Transaction ID')}>
        <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
        Copy Transaction ID
      </ContextMenuItem>
      {item.counterparty && (
        <ContextMenuItem onSelect={() => copy(item.counterparty!, 'Address')}>
          <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
          {item.net < 0 ? 'Copy Recipient’s Address' : 'Copy Sender’s Address'}
        </ContextMenuItem>
      )}
    </>
  );
}

function ActivityRow({ item, price }: { item: ActivityItem; price: number | null | undefined }) {
  const received = item.net >= 0;
  const Icon = !item.confirmed ? Clock : received ? ArrowDownLeft : ArrowUpRight;
  const label = received ? 'Received' : 'Sent';
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => window.open(explorerUrl('tx', item.txid))}
            title="View on mempool.space"
            className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-foreground/5', focusRing)}
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-ink-accent">
              <Icon className="size-4.5" strokeWidth={1.75} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">{label}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {when(item)}
                {item.counterparty && <> · {received ? 'from' : 'to'} <span className="font-mono">{middleEllipsis(item.counterparty, 18)}</span></>}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block text-sm font-medium text-foreground">
                {received ? '+' : '−'}
                {formatBtc(Math.abs(item.net))} BTC
              </span>
              <span className="block text-xs text-muted-foreground">
                {price ? formatUsd(Math.abs(item.net), price) : formatSats(Math.abs(item.net))}
              </span>
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ActivityMenuItems item={item} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <ul className="space-y-1 px-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="flex items-center gap-3 py-2.5">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-20" />
        </li>
      ))}
    </ul>
  );
}

/** The balance, and every transaction that touched the address. */
export function ActivityView({ address, onSend, onReceive }: { address: string; onSend: () => void; onReceive: () => void }) {
  const balance = useBalance(address);
  const activity = useActivity(address);
  const price = usePrice().data;
  const total = balance.data ? balance.data.confirmed + balance.data.pending : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pt-8 pb-6 @2xl:px-8">
        <header className="px-3">
          <h2 className="text-sm font-medium text-muted-foreground">Balance</h2>
          {balance.data ? (
            <>
              <p className="mt-1 font-[family-name:var(--font-title)] text-5xl font-semibold tracking-tight tabular-nums text-foreground">
                {formatBtc(total)} <span className="text-2xl font-medium text-muted-foreground">BTC</span>
              </p>
              <p className="mt-1 text-lg text-muted-foreground tabular-nums">
                {price ? `${formatUsd(total, price)} · ` : ''}
                {formatSats(total)}
              </p>
              {balance.data.pending !== 0 && (
                <StatusPill className="mt-3">
                  <Clock className="size-3" aria-hidden />
                  {balance.data.pending > 0
                    ? `${formatBtc(balance.data.pending)} BTC on its way`
                    : `${formatBtc(-balance.data.pending)} BTC leaving, waiting to confirm`}
                </StatusPill>
              )}
            </>
          ) : balance.isError ? (
            <div className="mt-2 space-y-3">
              <p className="text-sm text-muted-foreground">The Bitcoin network couldn’t be reached. {balance.error.message}</p>
              <PillButton size="sm" onClick={() => void balance.refetch()}>
                <RefreshCw aria-hidden />
                Try Again
              </PillButton>
            </div>
          ) : (
            <div className="mt-2 space-y-2" aria-label="Loading the balance">
              <Skeleton className="h-12 w-64" />
              <Skeleton className="h-5 w-40" />
            </div>
          )}
          <div className="mt-6 flex gap-2">
            <PillButton variant="primary" onClick={onSend} disabled={!balance.data || total <= 0}>
              <ArrowUpRight aria-hidden />
              Send
            </PillButton>
            <PillButton onClick={onReceive}>
              <ArrowDownLeft aria-hidden />
              Receive
            </PillButton>
          </div>
        </header>

        <section className="mt-10" aria-labelledby="wallet-activity">
          <h2 id="wallet-activity" className="px-3 pb-2 text-sm font-semibold text-foreground">
            Activity
          </h2>
          {activity.isPending ? (
            <RowsSkeleton />
          ) : activity.isError && activity.items.length === 0 ? (
            <EmptyState
              title="Your activity couldn’t be loaded"
              action={
                <PillButton size="sm" onClick={() => void activity.refetch()}>
                  Try Again
                </PillButton>
              }
            >
              {activity.error.message}
            </EmptyState>
          ) : activity.items.length === 0 ? (
            <EmptyState
              icon={ArrowDownLeft}
              title="No bitcoin yet"
              action={<PillButton onClick={onReceive}>Receive Bitcoin</PillButton>}
            >
              What’s sent to your address shows up here.
            </EmptyState>
          ) : (
            <>
              <ul className="space-y-0.5">
                {activity.items.map((item) => (
                  <ActivityRow key={item.txid} item={item} price={price} />
                ))}
              </ul>
              {activity.hasNextPage && (
                <div className="mt-4 flex justify-center">
                  <PillButton size="sm" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>
                    {activity.isFetchingNextPage ? 'Loading…' : 'Show Older'}
                  </PillButton>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
