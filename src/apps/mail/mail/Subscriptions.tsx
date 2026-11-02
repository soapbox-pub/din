import { useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, Loader2, MailMinus, MailSearch, MailX, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { useDin } from '@/sdk/react';
import { cn } from '@/lib/utils';
import { UNSUBSCRIBE_METHODS, type MailAccount, type MailSubscription, type UnsubscribeMethod, type UnsubscribeResult } from '@/lib/mail';
import { useMail, useMessage, useSubscriptions, type Item } from './api';
import { Avatar } from './Reader';
import { displayName } from './format';

/** How far back each "Look Further Back" goes, in months. */
const SPANS = [6, 12, 24, 60];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function ago(ms: number): string {
  const days = Math.round((ms - Date.now()) / 86_400_000);
  if (days > -1) return 'today';
  if (days > -30) return relative.format(days, 'day');
  if (days > -365) return relative.format(Math.round(days / 30), 'month');
  return relative.format(Math.round(days / 365), 'year');
}

function rowKey(s: Pick<MailSubscription, 'accountId' | 'id'>): string {
  return `${s.accountId}\u0000${s.id}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** What unsubscribing these will do, in a sentence or two. */
function plan(list: MailSubscription[], trash: boolean): string[] {
  const by = (m: UnsubscribeMethod) => list.filter((s) => s.method === m).length;
  const ways = [
    by('one-click') && `${by('one-click').toLocaleString()} with one click`,
    by('email') && `${by('email').toLocaleString()} by sending an email from your account`,
    by('web') && `${by('web').toLocaleString()} only on a web page you finish yourself`,
  ].filter(Boolean);
  const out = [`Mail unsubscribes ${ways.join(', ')}.`];
  const unverified = list.filter((s) => !s.verified).length;
  if (unverified) {
    const who =
      unverified < list.length
        ? `${unverified.toLocaleString()} of their senders couldn’t be checked as who they say they are.`
        : list.length === 1
          ? 'Its sender couldn’t be checked as who it says it is.'
          : 'None of their senders could be checked as who they say they are.';
    out.push(`${who} Unsubscribing from a stranger tells them your address is read.`);
  }
  if (trash) {
    const emails = list.reduce((n, s) => n + s.count, 0);
    out.push(`Their mail in your inbox (at least ${plural(emails, 'email')}) moves to the Trash.`);
  }
  return out;
}

function MethodTag({ s }: { s: Pick<MailSubscription, 'method' | 'verified'> }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {!s.verified && (
        <span title="Its sender couldn’t be checked" className="flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <ShieldAlert className="size-3" /> Unverified
        </span>
      )}
      <span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{UNSUBSCRIBE_METHODS[s.method]}</span>
    </span>
  );
}

function Outcome({ result, onOpen }: { result: UnsubscribeResult; onOpen: (url: string) => void }) {
  if (result.status === 'done') {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        <CircleCheck className="size-3.5" /> Unsubscribed{result.trashed ? `, ${plural(result.trashed, 'email')} to Trash` : ''}
      </span>
    );
  }
  if (result.status === 'page' && result.url) {
    const url = result.url;
    return (
      <button type="button" onClick={() => onOpen(url)} title={result.error ?? undefined} className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60">
        <ExternalLink className="size-3.5" /> Open Page to Finish
      </button>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-destructive" title={result.error ?? undefined}>
      <CircleAlert className="size-3.5 shrink-0" /> <span className="truncate">{result.error ?? 'Failed'}</span>
    </span>
  );
}

const Row = ({
  s,
  account,
  checked,
  onCheck,
  result,
  busy,
  onOpen,
  className,
  ...props
}: ComponentProps<'div'> & {
  s: MailSubscription;
  account: string | null;
  checked: boolean;
  onCheck: (on: boolean) => void;
  result: UnsubscribeResult | undefined;
  busy: boolean;
  onOpen: (url: string) => void;
}) => {
  const name = displayName({ name: s.name, address: s.address }) || s.listId || 'Unknown Sender';
  return (
    <div
      {...props}
      className={cn('mx-2 flex items-center gap-3 rounded-lg px-3 py-2.5', checked ? 'bg-primary/[0.07]' : 'hover:bg-foreground/5', className)}
    >
      <Checkbox checked={checked} onCheckedChange={(v) => onCheck(v === true)} aria-label={`Select ${name}`} />
      <Avatar who={{ name: s.name, address: s.address }} className="size-9 text-xs" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-[13px] font-semibold">{name}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{s.address}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">
            {plural(s.count, 'email')} · last {ago(s.last)}
            {account && ` · ${account}`}
          </span>
          {s.unsubscribed && !result && (
            s.since > 0 ? (
              <span className="flex items-center gap-1 truncate font-medium text-amber-700 dark:text-amber-300">
                <CircleAlert className="size-3.5 shrink-0" /> Still mailing: {plural(s.since, 'email')} since you unsubscribed
              </span>
            ) : (
              <span className="truncate">Unsubscribed {day.format(s.unsubscribed)}</span>
            )
          )}
        </div>
      </div>
      {busy ? (
        <Loader2 aria-label="Unsubscribing" className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : result ? (
        <Outcome result={result} onOpen={onOpen} />
      ) : (
        <MethodTag s={s} />
      )}
    </div>
  );
};

function ListSkeleton() {
  return (
    <div className="space-y-1 px-2 pt-2" aria-busy="true" aria-label="Looking for mailing lists">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <div className="size-4 rounded bg-foreground/10" />
          <div className="size-9 animate-pulse rounded-full bg-foreground/10 motion-reduce:animate-none" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-foreground/10 motion-reduce:animate-none" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-foreground/[0.07] motion-reduce:animate-none" />
          </div>
          <div className="h-5 w-20 animate-pulse rounded-full bg-foreground/[0.07] motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

/**
 * Subscriptions: every mailing list in the inboxes, most mail first, to
 * leave many at once (and clear out their mail).
 */
export function Subscriptions({ accounts, onShowMail }: { accounts: MailAccount[]; onShowMail: (s: MailSubscription) => void }) {
  const din = useDin();
  const mail = useMail();
  const qc = useQueryClient();
  const [span, setSpan] = useState(0);
  const months = SPANS[span];
  const { list, errors, pending, fetching } = useSubscriptions(accounts, months);
  const [sort, setSort] = useState<'count' | 'recent'>('count');
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [trash, setTrash] = useState(false);
  const [asking, setAsking] = useState<{ list: MailSubscription[]; trash: boolean } | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [results, setResults] = useState<Map<string, UnsubscribeResult>>(() => new Map());

  const sorted = useMemo(() => {
    const out = [...list];
    if (sort === 'recent') out.sort((x, y) => y.last - x.last);
    return out;
  }, [list, sort]);
  // Lists left already go below, unless they're still mailing.
  const current = sorted.filter((s) => !s.unsubscribed || s.since > 0 || results.has(rowKey(s)));
  const left = sorted.filter((s) => !current.includes(s));
  const chosen = sorted.filter((s) => checked.has(rowKey(s)));
  const accountName = (id: string) => (accounts.length > 1 ? accounts.find((a) => a.id === id)?.name ?? null : null);
  const openPage = (url: string) => void din.app.openUrl(url);

  const check = (s: MailSubscription, on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      if (on) n.add(rowKey(s));
      else n.delete(rowKey(s));
      return n;
    });
  const allChecked = current.length > 0 && current.every((s) => checked.has(rowKey(s)));

  const run = async (targets: MailSubscription[], withTrash: boolean) => {
    if (!mail || !targets.length) return;
    setAsking(null);
    setBusy(new Set(targets.map(rowKey)));
    const byAccount = new Map<string, string[]>();
    for (const s of targets) byAccount.set(s.accountId, [...(byAccount.get(s.accountId) ?? []), s.id]);
    const done: [string, UnsubscribeResult][] = [];
    for (const [accountId, ids] of byAccount) {
      try {
        for (const r of await mail.unsubscribe(accountId, ids, { trash: withTrash })) done.push([rowKey({ accountId, id: r.id }), r]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const id of ids) done.push([rowKey({ accountId, id }), { id, status: 'failed', method: null, url: null, error: message, trashed: 0 }]);
      }
    }
    setResults((r) => new Map([...r, ...done]));
    setBusy(new Set());
    setChecked((c) => new Set([...c].filter((k) => !done.some(([d, r]) => d === k && r.status === 'done'))));
    const pages = done.filter(([, r]) => r.status === 'page').length;
    const failed = done.filter(([, r]) => r.status === 'failed').length;
    const ok = done.length - pages - failed;
    din.toast(ok ? `Unsubscribed from ${plural(ok, 'list')}` : 'Nothing was unsubscribed', {
      body: [pages && `${plural(pages, 'list')} ${pages === 1 ? 'needs' : 'need'} a web page to finish.`, failed && `${plural(failed, 'list')} couldn’t be unsubscribed.`].filter(Boolean).join(' ') || undefined,
    });
    void qc.invalidateQueries({ queryKey: ['mail', 'subscriptions'] });
    if (withTrash) {
      void qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      void qc.invalidateQueries({ queryKey: ['mail', 'mailboxes'] });
    }
  };

  const ask = (targets: MailSubscription[], withTrash: boolean) => {
    if (targets.length) setAsking({ list: targets, trash: withTrash });
  };

  const total = list.length;
  const subtitle = pending && !total ? 'Looking through your inbox…' : `${plural(total, 'mailing list')} in the last ${months >= 12 ? plural(months / 12, 'year') : `${months} months`}`;

  const row = (s: MailSubscription) => {
    const key = rowKey(s);
    const targets = checked.has(key) && chosen.length > 1 ? chosen : [s];
    const many = targets.length > 1;
    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger asChild>
          <Row
            s={s}
            account={accountName(s.accountId)}
            checked={checked.has(key)}
            onCheck={(on) => check(s, on)}
            result={results.get(key)}
            busy={busy.has(key)}
            onOpen={openPage}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              check(s, !checked.has(key));
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-60">
          <ContextMenuItem disabled={busy.size > 0} onSelect={() => ask(targets, false)}>
            <MailMinus /> {many ? `Unsubscribe from ${targets.length}…` : 'Unsubscribe…'}
          </ContextMenuItem>
          <ContextMenuItem disabled={busy.size > 0} onSelect={() => ask(targets, true)}>
            <MailX /> {many ? `Unsubscribe from ${targets.length} and Delete Their Mail…` : 'Unsubscribe and Delete Their Mail…'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={many} onSelect={() => onShowMail(s)}>
            <MailSearch /> Show Their Mail
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <section aria-label="Subscriptions" className="relative flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border/60 pr-3 pl-4">
        <div className="min-w-0 flex-1 pl-1 leading-tight">
          <h1 className="truncate text-[15px] font-bold">Subscriptions</h1>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div role="group" aria-label="Sort" className="mr-1 flex rounded-md bg-foreground/[0.06] p-0.5 text-xs">
          {(['count', 'recent'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={sort === k}
              onClick={() => setSort(k)}
              className={cn('rounded px-2 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60', sort === k ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
            >
              {k === 'count' ? 'Most Mail' : 'Most Recent'}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label="Look again"
          title="Look again"
          onClick={() => void qc.invalidateQueries({ queryKey: ['mail', 'subscriptions'] })}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <RefreshCw className={cn('size-4', fetching && 'animate-spin motion-reduce:animate-none')} strokeWidth={1.75} />
        </button>
      </div>

      {[...errors].map(([id, error]) => (
        <div key={id} role="alert" className="flex items-center gap-2 border-b border-border/60 bg-destructive/5 px-5 py-2 text-[13px]">
          <CircleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate">{accounts.find((a) => a.id === id)?.name}: {error}</span>
        </div>
      ))}

      {pending && !total ? (
        <ListSkeleton />
      ) : !total ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
            <MailMinus className="mx-auto mb-3 size-10 text-muted-foreground/60" strokeWidth={1.25} />
            <p className="text-[15px] font-medium">No mailing lists</p>
            <p className="mt-1 text-[13px] text-muted-foreground">Nothing in your inbox from the last {months >= 12 ? plural(months / 12, 'year') : `${months} months`} says how to unsubscribe.</p>
            {span < SPANS.length - 1 && (
              <button type="button" onClick={() => setSpan(span + 1)} className="mt-4 text-[13px] font-medium text-primary outline-none hover:underline focus-visible:underline">
                Look Further Back
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-5 text-[13px]">
            <label className="flex items-center gap-3">
              <Checkbox
                checked={allChecked ? true : chosen.length ? 'indeterminate' : false}
                onCheckedChange={(v) => setChecked(v === true ? new Set([...checked, ...current.map(rowKey)]) : new Set())}
                aria-label="Select all"
              />
              <span className="text-muted-foreground">{chosen.length ? `${chosen.length.toLocaleString()} selected` : 'Select All'}</span>
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-1 pb-4" aria-label="Mailing lists">
            {current.map(row)}
            {left.length > 0 && (
              <>
                <h2 className="mx-5 mt-5 mb-1 text-[11px] font-semibold text-muted-foreground">Unsubscribed</h2>
                {left.map(row)}
              </>
            )}
            <div className="mt-4 flex items-center justify-center gap-2 px-5 text-xs text-muted-foreground">
              <span>Mail looked at your inbox from the last {months >= 12 ? plural(months / 12, 'year') : `${months} months`}.</span>
              {span < SPANS.length - 1 && (
                <button type="button" onClick={() => setSpan(span + 1)} disabled={fetching} className="font-medium text-primary outline-none hover:underline focus-visible:underline disabled:opacity-50">
                  Look Further Back
                </button>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border/60 bg-muted/30 px-5 py-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
              <Checkbox checked={trash} onCheckedChange={(v) => setTrash(v === true)} />
              <Trash2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">Also move their mail to the Trash</span>
            </label>
            <DialogButton variant="primary" disabled={!chosen.length || busy.size > 0} onClick={() => ask(chosen, trash)} className="flex items-center gap-2">
              {busy.size > 0 && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
              {busy.size > 0 ? 'Unsubscribing…' : chosen.length ? `Unsubscribe (${chosen.length.toLocaleString()})` : 'Unsubscribe'}
            </DialogButton>
          </div>
        </>
      )}

      {asking && (
        <Overlay label="Unsubscribe" onClose={() => setAsking(null)}>
          <div className="space-y-2 px-5 pt-5 pb-4">
            <h2 className="text-[15px] font-semibold">
              {asking.list.length === 1 ? `Unsubscribe from ${displayName({ name: asking.list[0].name, address: asking.list[0].address })}?` : `Unsubscribe from ${asking.list.length.toLocaleString()} lists?`}
            </h2>
            {plan(asking.list, asking.trash).map((line) => (
              <p key={line} className="text-[13px] text-muted-foreground">{line}</p>
            ))}
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
            <DialogButton onClick={() => setAsking(null)}>Cancel</DialogButton>
            <DialogButton variant={asking.trash ? 'destructive' : 'primary'} autoFocus onClick={() => void run(asking.list, asking.trash)}>
              Unsubscribe
            </DialogButton>
          </div>
        </Overlay>
      )}
    </section>
  );
}

/** Leave the list one message came from, after asking. */
export function UnsubscribeDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const din = useDin();
  const mail = useMail();
  const qc = useQueryClient();
  const message = useMessage(item);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UnsubscribeResult | null>(null);
  const info = message.data?.unsubscribe ?? null;
  const who = displayName(message.data?.from[0] ?? item.from[0]) || 'this sender';

  const go = async () => {
    if (!mail) return;
    setBusy(true);
    try {
      const r = await mail.unsubscribeMessage(item.accountId, item.path, item.uid);
      setResult(r);
      if (r.status === 'done') {
        void qc.invalidateQueries({ queryKey: ['mail', 'message', item.accountId, item.path, item.uid] });
        void qc.invalidateQueries({ queryKey: ['mail', 'subscriptions'] });
      }
    } catch (error) {
      setResult({ id: '', status: 'failed', method: null, url: null, error: error instanceof Error ? error.message : String(error), trashed: 0 });
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  let actions: ReactNode;
  if (result?.status === 'done') {
    body = <p className="text-[13px] text-muted-foreground">You’re unsubscribed from {who}{result.method === 'email' ? ': Mail sent the request from your account' : ''}. Mail may still come for a few days.</p>;
    actions = <DialogButton variant="primary" autoFocus onClick={onClose}>Done</DialogButton>;
  } else if (result?.status === 'page' && result.url) {
    const url = result.url;
    body = <p className="text-[13px] text-muted-foreground">{who} only lets you unsubscribe on its web page.{result.error ? ` (${result.error})` : ''}</p>;
    actions = (
      <>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" autoFocus onClick={() => { void din.app.openUrl(url); onClose(); }}>Open Page</DialogButton>
      </>
    );
  } else if (result) {
    body = <p role="alert" className="text-[13px] text-destructive">{result.error ?? 'Mail couldn’t unsubscribe.'}</p>;
    actions = <DialogButton autoFocus onClick={onClose}>Close</DialogButton>;
  } else if (!info) {
    body = message.isPending ? <Loader2 className="size-5 animate-spin text-muted-foreground motion-reduce:animate-none" /> : <p className="text-[13px] text-muted-foreground">This message doesn’t say how to unsubscribe.</p>;
    actions = <DialogButton onClick={onClose}>Cancel</DialogButton>;
  } else {
    const way = info.method === 'one-click' ? 'Mail tells the sender’s server, with one click.' : info.method === 'email' ? 'Mail sends an unsubscribe email from your account.' : 'It’s done on the sender’s web page, which Mail opens for you to finish.';
    body = (
      <>
        <p className="text-[13px] text-muted-foreground">{way}</p>
        {!info.verified && (
          <p className="flex gap-2 text-[13px] text-amber-700 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" /> This message couldn’t be checked as coming from who it says. If it’s spam, move it to Junk instead: unsubscribing tells a spammer your address is read.
          </p>
        )}
      </>
    );
    actions = (
      <>
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" autoFocus disabled={busy} onClick={() => void go()} className="flex items-center gap-2">
          {busy && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />} Unsubscribe
        </DialogButton>
      </>
    );
  }

  return (
    <Overlay label="Unsubscribe" onClose={onClose}>
      <div className="space-y-2 px-5 pt-5 pb-4">
        <h2 className="text-[15px] font-semibold">{result?.status === 'done' ? 'Unsubscribed' : `Unsubscribe from ${who}?`}</h2>
        {body}
      </div>
      <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">{actions}</div>
    </Overlay>
  );
}
