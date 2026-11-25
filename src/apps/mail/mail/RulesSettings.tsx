import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Ban, Inbox, ListFilter, Loader2, MoreHorizontal, OctagonAlert, Pencil, Play, Plus, RefreshCw, ServerCog, Trash2, UserCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { ToolButton } from '@/shared/appChrome';
import { settingsEmpty, settingsGroup } from '@/shared/settingsChromeStyles';
import { toast } from '@/shared/toast';
import { cn } from '@/lib/utils';
import type { BlockedSender, MailAccount, MailRule, MailRules } from '@/lib/mail';
import { appliedSummary, describeBlocked, describeRule, ruleTitle, serverText } from '@/shared/mailRules';
import { openRuleWindow, rulesKey, useLabels, useMail, useMailboxes, useRules } from './api';
import { ContextEntries, DropdownEntries } from './MenuEntries';
import type { MenuEntry } from './menu';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

type RulePick = 'edit' | 'apply' | 'up' | 'down' | 'toggle' | 'delete';

function ruleMenu(rule: MailRule, index: number, count: number): MenuEntry<RulePick>[] {
  return [
    { kind: 'item', pick: 'edit', label: 'Edit Rule…', icon: Pencil },
    { kind: 'item', pick: 'apply', label: 'Apply to Inbox Now', icon: Play },
    { kind: 'item', pick: 'toggle', label: rule.enabled ? 'Turn Off' : 'Turn On', icon: ListFilter },
    { kind: 'separator' },
    { kind: 'item', pick: 'up', label: 'Move Up', icon: ArrowUp, disabled: index === 0 },
    { kind: 'item', pick: 'down', label: 'Move Down', icon: ArrowDown, disabled: index === count - 1 },
    { kind: 'separator' },
    { kind: 'item', pick: 'delete', label: 'Delete Rule…', icon: Trash2, destructive: true },
  ];
}

type BlockPick = 'junk' | 'trash' | 'unblock';

function blockMenu(b: BlockedSender): MenuEntry<BlockPick>[] {
  return [
    { kind: 'item', pick: 'junk', label: 'Send to Junk', icon: OctagonAlert, disabled: b.to === 'junk' },
    { kind: 'item', pick: 'trash', label: 'Send to Trash', icon: Trash2, disabled: b.to === 'trash' },
    { kind: 'separator' },
    { kind: 'item', pick: 'unblock', label: 'Unblock', icon: UserCheck },
  ];
}

/** A row with its menu on a right-click and on its ⋯ button. */
function MenuRow<P>({ entries, onPick, label, children, onDoubleClick }: { entries: MenuEntry<P>[]; onPick: (p: P) => void; label: string; children: React.ReactNode; onDoubleClick?: () => void }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-h-12 items-center gap-3 px-4 py-2 hover:bg-foreground/5" onDoubleClick={onDoubleClick}>
          {children}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolButton size="sm" label={`More for ${label}`} title="More">
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
              </ToolButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownEntries entries={entries} onPick={onPick} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextEntries entries={entries} onPick={onPick} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Settings → Rules: an account's blocked senders and rules, in the order
 * they run, and whether its mail server runs them too. Rules are edited in
 * a window of their own (RuleWindow).
 */
export function RulesSettings({ accounts, initial }: { accounts: MailAccount[]; initial: string | null }) {
  const mail = useMail();
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string | null>(initial);
  const account = accounts.find((a) => a.id === chosen) ?? accounts[0];
  const query = useRules(account?.id ?? null);
  const data = query.data;
  const only = useMemo(() => (account ? [account] : []), [account]);
  const boxes = useMailboxes(only).boxes.get(account?.id ?? '') ?? [];
  const labels = useLabels(only).get(account?.id ?? '');
  const names = {
    mailbox: (path: string) => boxes.find((b) => b.path === path)?.name ?? path,
    label: (id: string) => labels?.labels.find((l) => l.id === id)?.name ?? id,
  };
  const [sender, setSender] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MailRule | null>(null);
  const [replacing, setReplacing] = useState(false);

  if (!account) {
    return <p className={settingsEmpty}>Add a mail account first, and its rules go here.</p>;
  }

  const keep = (next: MailRules) => qc.setQueryData(rulesKey(account.id), next);
  const act = async (what: string, fn: () => Promise<MailRules | void>) => {
    if (!mail) return;
    setBusy(what);
    setProblem(null);
    try {
      const next = await fn();
      if (next) keep(next);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(null);
    }
  };
  const apply = (rule?: MailRule) =>
    act(rule ? `apply:${rule.id}` : 'apply', async () => {
      const r = await mail!.applyRules(account.id, rule ? { rule: rule.id } : undefined);
      toast(rule ? `Applied “${ruleTitle(rule)}”` : 'Applied the rules to the inbox', { body: appliedSummary(r) });
    });

  const block = () => {
    const who = sender.trim();
    if (!who) return;
    void act('block', async () => {
      const next = await mail!.block(account.id, who);
      setSender('');
      return next;
    });
  };

  const onBlockPick = (b: BlockedSender, pick: BlockPick) => {
    if (pick === 'unblock') void act(`unblock:${b.sender}`, () => mail!.unblock(account.id, b.sender));
    else void act(`block:${b.sender}`, () => mail!.block(account.id, b.sender, pick));
  };

  const rules = data?.rules ?? [];
  const onRulePick = (rule: MailRule, index: number, pick: RulePick) => {
    if (pick === 'edit') openRuleWindow({ accountId: account.id, rule: rule.id });
    else if (pick === 'apply') void apply(rule);
    else if (pick === 'toggle') void act(`toggle:${rule.id}`, () => mail!.saveRule(account.id, { ...rule, enabled: !rule.enabled }));
    else if (pick === 'delete') setDeleting(rule);
    else {
      const ids = rules.map((r) => r.id);
      const to = pick === 'up' ? index - 1 : index + 1;
      [ids[index], ids[to]] = [ids[to], ids[index]];
      void act('order', () => mail!.orderRules(account.id, ids));
    }
  };

  const server = data?.server;
  const takeOver = server?.state === 'inactive' || server?.state === 'edited';

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
      {accounts.length > 1 && (
        <label className="flex items-center justify-between gap-4">
          <span className="text-[13px] font-medium">Account</span>
          <NativeSelect size="sm" value={account.id} onChange={(e) => setChosen(e.target.value)} aria-label="Account">
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </NativeSelect>
        </label>
      )}

      <div className="flex items-start gap-3 rounded-xl bg-selected p-3">
        <ServerCog className="mt-0.5 size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[13px]">{server ? serverText(server) : 'Looking…'}</p>
          <div className="flex flex-wrap gap-2">
            {takeOver && (
              <DialogButton
                variant="primary"
                disabled={!!busy}
                onClick={() => (server?.state === 'edited' ? setReplacing(true) : void act('sync', () => mail!.syncRules(account.id, { takeOver: true })))}
              >
                {server?.state === 'edited' ? 'Put Din’s Back on the Server…' : 'Use Din’s Rules on the Server'}
              </DialogButton>
            )}
            {server && server.state !== 'none' && (
              <DialogButton disabled={!!busy} onClick={() => void act('sync', () => mail!.syncRules(account.id))}>
                {busy === 'sync' ? <Loader2 className="mr-1 inline size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="mr-1 inline size-4" strokeWidth={1.75} />}
                Check Again
              </DialogButton>
            )}
          </div>
          {server?.state === 'inactive' && (
            <p className="text-xs text-muted-foreground">
              Using Din’s keeps your own on the server{server.extensions.includes('include') ? ', and runs it after Din’s' : ', turned off'}.
            </p>
          )}
        </div>
      </div>

      <section className="space-y-2">
        <div className="px-1">
          <h2 className="text-[13px] font-medium">Blocked Senders</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Their new mail goes straight to Junk. Block someone from a message’s menu, or here.</p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            block();
          }}
        >
          <Input value={sender} onChange={(e) => setSender(e.target.value)} placeholder="Address, or @domain for everyone there" aria-label="Sender to block" spellCheck={false} className="flex-1" />
          <DialogButton type="submit" disabled={!sender.trim() || !!busy}>
            <Ban className="mr-1 inline size-4" strokeWidth={1.75} /> Block
          </DialogButton>
        </form>
        {query.isLoading ? null : data?.blocked.length ? (
          <div className={settingsGroup}>
            {data.blocked.map((b) => (
              <MenuRow key={b.sender} entries={blockMenu(b)} onPick={(p) => onBlockPick(b, p)} label={b.sender}>
                <Ban className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm" title={describeBlocked(b)}>
                  {b.sender.startsWith('@') ? `Everyone at ${b.sender.slice(1)}` : b.sender}
                </span>
                <NativeSelect size="sm" value={b.to} aria-label={`Where ${b.sender}’s mail goes`} onChange={(e) => onBlockPick(b, e.target.value as 'junk' | 'trash')}>
                  <option value="junk">Junk</option>
                  <option value="trash">Trash</option>
                </NativeSelect>
              </MenuRow>
            ))}
          </div>
        ) : (
          <p className={cn(settingsEmpty, 'rounded-xl border border-dashed border-border/70')}>Nobody’s blocked.</p>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-end gap-2 px-1">
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-medium">Rules</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Run on new mail in the inbox, top to bottom, after the blocked senders.</p>
          </div>
          {rules.length > 0 && (
            <DialogButton disabled={!!busy} onClick={() => void apply()}>
              {busy === 'apply' ? <Loader2 className="mr-1 inline size-4 animate-spin motion-reduce:animate-none" /> : <Inbox className="mr-1 inline size-4" strokeWidth={1.75} />}
              Apply to Inbox
            </DialogButton>
          )}
          <DialogButton variant="primary" onClick={() => openRuleWindow({ accountId: account.id })}>
            <Plus className="mr-1 inline size-4" strokeWidth={1.75} /> New Rule…
          </DialogButton>
        </div>
        {query.isLoading ? null : rules.length ? (
          <div className={settingsGroup}>
            {rules.map((r, i) => (
              <MenuRow key={r.id} entries={ruleMenu(r, i, rules.length)} onPick={(p) => onRulePick(r, i, p)} label={ruleTitle(r)} onDoubleClick={() => openRuleWindow({ accountId: account.id, rule: r.id })}>
                <Switch checked={r.enabled} aria-label={r.enabled ? `Turn off ${ruleTitle(r)}` : `Turn on ${ruleTitle(r)}`} onCheckedChange={() => onRulePick(r, i, 'toggle')} />
                <div className={cn('min-w-0 flex-1', !r.enabled && 'opacity-60')}>
                  <p className="truncate text-sm font-medium">{ruleTitle(r)}</p>
                  <p className="truncate text-xs text-muted-foreground" title={describeRule(r, names)}>
                    {describeRule(r, names)}
                  </p>
                </div>
              </MenuRow>
            ))}
          </div>
        ) : (
          <p className={cn(settingsEmpty, 'rounded-xl border border-dashed border-border/70')}>No rules yet. Make one here, or from a message’s menu with Make Rule….</p>
        )}
      </section>

      {problem && (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      )}

      {deleting && (
        <Overlay label="Delete Rule" onClose={() => setDeleting(null)}>
          <div className="space-y-2 px-5 pt-5 pb-4">
            <h2 className="text-[15px] font-semibold">Delete the rule “{ruleTitle(deleting)}”?</h2>
            <p className="text-[13px] text-muted-foreground">New mail isn’t sorted by it any more, here or on the server. The mail it already moved stays where it is.</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
            <DialogButton onClick={() => setDeleting(null)}>Cancel</DialogButton>
            <DialogButton
              variant="destructive"
              autoFocus
              onClick={() => {
                const id = deleting.id;
                setDeleting(null);
                void act(`delete:${id}`, () => mail!.deleteRule(account.id, id));
              }}
            >
              Delete Rule
            </DialogButton>
          </div>
        </Overlay>
      )}
      {replacing && (
        <Overlay label="Replace Rules on the Server" onClose={() => setReplacing(false)}>
          <div className="space-y-2 px-5 pt-5 pb-4">
            <h2 className="text-[15px] font-semibold">Replace the changed rules on the server?</h2>
            <p className="text-[13px] text-muted-foreground">Din’s rules on your mail server were changed somewhere else. Din puts its own back over those changes.</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
            <DialogButton onClick={() => setReplacing(false)}>Cancel</DialogButton>
            <DialogButton
              variant="destructive"
              autoFocus
              onClick={() => {
                setReplacing(false);
                void act('sync', () => mail!.syncRules(account.id, { takeOver: true }));
              }}
            >
              Replace
            </DialogButton>
          </div>
        </Overlay>
      )}
    </div>
  );
}
