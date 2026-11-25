import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Plus, X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useWindowTitle } from '@/sdk/react';
import { FormWindow, PillButton, ToolButton } from '@/shared/appChrome';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { appliedSummary, FIELD_MATCHES, FIELD_NAMES, MATCH_NAMES, newRule, SPECIAL_PLACES } from '@/shared/mailRules';
import { RULE_FIELDS, type MailRule, type RuleAction, type RuleCondition, type RuleField, type RuleMatch, type RulesApplied } from '@/lib/mail';
import { rulesKey, useAccounts, useLabels, useLiveUpdates, useMail, useMailboxes, useRules, type RuleSeed } from './api';
import { useQueryClient } from '@tanstack/react-query';
import { mailboxTitle } from './mailboxes';

type ActionType = RuleAction['type'];

const ACTION_NAMES: Record<ActionType, string> = {
  move: 'Move to',
  label: 'Label as',
  read: 'Mark as read',
  flag: 'Star',
  forward: 'Forward a copy to',
};

function blankAction(type: ActionType, label: string | undefined): RuleAction {
  switch (type) {
    case 'move':
      return { type, to: { special: 'archive' } };
    case 'label':
      return { type, label: label ?? '' };
    case 'forward':
      return { type, to: '' };
    default:
      return { type };
  }
}

/** A move's place as the select holds it: `special:junk`, or `path:…`. */
function placeValue(to: Extract<RuleAction, { type: 'move' }>['to']): string {
  return typeof to === 'string' ? `path:${to}` : `special:${to.special}`;
}

function placeOf(value: string): Extract<RuleAction, { type: 'move' }>['to'] {
  if (value.startsWith('special:')) return { special: value.slice(8) as 'junk' | 'trash' | 'archive' };
  return value.slice(5);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

/**
 * A rule, made or edited in a window of its own (launched with `{ window:
 * 'rule', accountId, rule?, conditions? }`, see openRuleWindow): what to look
 * for, what to do, and whether the rules after it look too.
 */
export function RuleWindow({ seed }: { seed: RuleSeed }) {
  useLiveUpdates();
  const mail = useMail();
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const account = accounts.find((a) => a.id === seed.accountId) ?? null;
  const only = useMemo(() => (account ? [account] : []), [account]);
  const boxes = (useMailboxes(only).boxes.get(seed.accountId) ?? []).filter((b) => b.selectable && b.special !== 'junk' && b.special !== 'trash' && b.special !== 'archive' && b.special !== 'inbox');
  const labelInfo = useLabels(only).get(seed.accountId);
  const rules = useRules(seed.accountId);
  const existing = seed.rule ? rules.data?.rules.find((r) => r.id === seed.rule) : undefined;
  const [edited, setEdited] = useState<MailRule | null>(seed.rule ? null : { ...newRule(), conditions: seed.conditions?.length ? seed.conditions : newRule().conditions });
  // An existing rule is the form until it's changed.
  const draft = edited ?? existing ?? null;
  const setDraft = (next: MailRule | ((d: MailRule | null) => MailRule | null)) => setEdited((d) => (typeof next === 'function' ? next(d ?? existing ?? null) : next));
  const [applyNow, setApplyNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [applied, setApplied] = useState<RulesApplied | null>(null);
  useWindowTitle(seed.rule ? 'Edit Rule' : 'New Rule');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const server = rules.data?.server;
  const forwardsHere = server?.state === 'active';
  const labels = labelInfo && labelInfo.kind !== 'none' ? labelInfo.labels : [];

  const setCondition = (i: number, patch: Partial<RuleCondition>) =>
    setDraft((d) => d && { ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setAction = (i: number, next: RuleAction) => setDraft((d) => d && { ...d, actions: d.actions.map((a, j) => (j === i ? next : a)) });

  const save = async () => {
    if (!mail || !draft || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await mail.saveRule(seed.accountId, draft);
      qc.setQueryData(rulesKey(seed.accountId), saved);
      if (!applyNow) return void window.close();
      const id = draft.id || saved.rules[saved.rules.length - 1].id;
      setDraft((d) => d && { ...d, id });
      setApplied(await mail.applyRules(seed.accountId, { rule: id }));
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const moving = draft?.actions.some((a) => a.type === 'move') ?? false;
  const missing = !draft || draft.conditions.some((c) => !c.value.trim() || (c.field === 'header' && !c.header?.trim())) || draft.actions.some((a) => (a.type === 'forward' && !a.to.trim()) || (a.type === 'label' && !a.label));

  return (
    <FormWindow
      title={seed.rule ? 'Edit Rule' : 'New Rule'}
      description={account ? `For new mail to ${account.email}. Din runs it as mail comes in, and so does your mail server where it can.` : undefined}
      footer={
        applied ? (
          <PillButton variant="primary" onClick={() => window.close()}>
            Done
          </PillButton>
        ) : (
          <>
            <PillButton onClick={() => window.close()} disabled={busy}>
              Cancel
            </PillButton>
            <PillButton variant="primary" onClick={() => void save()} disabled={!draft || busy || missing}>
              {busy && <LoaderCircle className="animate-spin" aria-hidden />}
              {seed.rule ? 'Save' : 'Add Rule'}
            </PillButton>
          </>
        )
      }
    >
      {!draft ? (
        rules.isLoading || !rules.data ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full rounded-full" />
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">That rule isn’t there any more.</p>
        )
      ) : applied ? (
        <p role="status" className="rounded-xl bg-selected px-3 py-2 text-sm">
          Saved, and applied to the inbox: {appliedSummary(applied)}
        </p>
      ) : (
        <>
          <label className="grid gap-1.5 px-1">
            <span className="text-sm font-medium">Name</span>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Optional" />
          </label>

          <section className="space-y-2">
            <div className="flex items-center gap-2 px-1 text-sm">
              <span>If</span>
              <NativeSelect size="sm" value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value === 'any' ? 'any' : 'all' })} aria-label="Which conditions">
                <option value="all">all</option>
                <option value="any">any</option>
              </NativeSelect>
              <span>of these are true:</span>
            </div>
            <div className={settingsGroup}>
              {draft.conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <NativeSelect
                    size="sm"
                    value={c.field}
                    aria-label="What to look at"
                    onChange={(e) => {
                      const field = e.target.value as RuleField;
                      const match = FIELD_MATCHES[field].includes(c.match) ? c.match : FIELD_MATCHES[field][0];
                      setCondition(i, { field, match, header: field === 'header' ? (c.header ?? '') : undefined });
                    }}
                  >
                    {RULE_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {FIELD_NAMES[f]}
                      </option>
                    ))}
                  </NativeSelect>
                  {c.field === 'header' && (
                    <Input className="h-8 w-36" value={c.header ?? ''} onChange={(e) => setCondition(i, { header: e.target.value })} placeholder="X-Header" aria-label="Header name" spellCheck={false} />
                  )}
                  <NativeSelect size="sm" value={c.match} aria-label="How it matches" onChange={(e) => setCondition(i, { match: e.target.value as RuleMatch })}>
                    {FIELD_MATCHES[c.field].map((m) => (
                      <option key={m} value={m}>
                        {MATCH_NAMES[m]}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    className="h-8 min-w-40 flex-1"
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                    placeholder={c.match === 'domain' ? 'example.com' : c.match === 'is' && (c.field === 'from' || c.field === 'to') ? 'name@example.com' : 'Words'}
                    aria-label="What to match"
                    spellCheck={false}
                  />
                  <ToolButton size="sm" label="Remove this condition" disabled={draft.conditions.length === 1} onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })}>
                    <X className="size-4" strokeWidth={1.75} />
                  </ToolButton>
                </div>
              ))}
            </div>
            <PillButton size="sm" onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: 'subject', match: 'contains', value: '' }] })} disabled={draft.conditions.length >= 20}>
              <Plus aria-hidden /> Add Condition
            </PillButton>
          </section>

          <section className="space-y-2">
            <p className="px-1 text-sm">Then:</p>
            <div className={settingsGroup}>
              {draft.actions.map((a, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <NativeSelect size="sm" value={a.type} aria-label="What to do" onChange={(e) => setAction(i, blankAction(e.target.value as ActionType, labels[0]?.id))}>
                    {(Object.keys(ACTION_NAMES) as ActionType[]).map((t) => (
                      <option key={t} value={t} disabled={(t === 'move' && moving && a.type !== 'move') || (t === 'label' && !labels.length)}>
                        {ACTION_NAMES[t]}
                      </option>
                    ))}
                  </NativeSelect>
                  {a.type === 'move' && (
                    <NativeSelect size="sm" className="min-w-40 flex-1" value={placeValue(a.to)} aria-label="Mailbox" onChange={(e) => setAction(i, { type: 'move', to: placeOf(e.target.value) })}>
                      {(Object.keys(SPECIAL_PLACES) as (keyof typeof SPECIAL_PLACES)[]).map((s) => (
                        <option key={s} value={`special:${s}`}>
                          {SPECIAL_PLACES[s]}
                        </option>
                      ))}
                      {boxes.map((b) => (
                        <option key={b.path} value={`path:${b.path}`}>
                          {mailboxTitle(b)}
                        </option>
                      ))}
                      {typeof a.to === 'string' && !boxes.some((b) => b.path === a.to) && <option value={`path:${a.to}`}>{a.to}</option>}
                    </NativeSelect>
                  )}
                  {a.type === 'label' && (
                    <NativeSelect size="sm" className="min-w-40 flex-1" value={a.label} aria-label="Label" onChange={(e) => setAction(i, { type: 'label', label: e.target.value })}>
                      {labels.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                      {a.label && !labels.some((l) => l.id === a.label) && <option value={a.label}>{a.label}</option>}
                    </NativeSelect>
                  )}
                  {a.type === 'forward' && (
                    <Input className="h-8 min-w-40 flex-1" type="email" value={a.to} onChange={(e) => setAction(i, { type: 'forward', to: e.target.value })} placeholder="name@example.com" aria-label="Forward to" spellCheck={false} />
                  )}
                  {(a.type === 'read' || a.type === 'flag') && <span className="flex-1" />}
                  <ToolButton size="sm" label="Remove this action" disabled={draft.actions.length === 1} onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, j) => j !== i) })}>
                    <X className="size-4" strokeWidth={1.75} />
                  </ToolButton>
                  {a.type === 'forward' && !forwardsHere && (
                    <p className="w-full px-1 text-xs text-muted-foreground">Only your mail server can forward mail, and it isn’t running Din’s rules, so this won’t happen until it is.</p>
                  )}
                </div>
              ))}
            </div>
            <PillButton size="sm" onClick={() => setDraft({ ...draft, actions: [...draft.actions, blankAction(moving ? 'read' : 'move', labels[0]?.id)] })} disabled={draft.actions.length >= 10}>
              <Plus aria-hidden /> Add Action
            </PillButton>
          </section>

          <div className={settingsGroup}>
            <label className="flex items-center justify-between gap-4 px-4 py-3">
              <span>
                <span className="block text-sm">Stop here</span>
                <span className="block text-xs text-muted-foreground">The rules after this one skip mail it matches.</span>
              </span>
              <Switch checked={draft.stop} onCheckedChange={(stop) => setDraft({ ...draft, stop })} />
            </label>
            {seed.rule && (
              <label className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-sm">On</span>
                <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
              </label>
            )}
            <label className="flex items-center gap-3 px-4 py-3">
              <Checkbox checked={applyNow} onCheckedChange={(on) => setApplyNow(on === true)} />
              <span className="text-sm">Also apply it to what’s in the inbox now</span>
            </label>
          </div>

          {problem && (
            <p role="alert" className="px-1 text-sm text-destructive">
              {problem}
            </p>
          )}
        </>
      )}
    </FormWindow>
  );
}
