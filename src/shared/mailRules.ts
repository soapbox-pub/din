/**
 * Mail's rules and blocked senders in words, for Mail's Rules settings and
 * `din mail` alike (electron/mail-rules.mts runs them; types in
 * src/lib/mail.ts).
 */
import type { BlockedSender, MailRule, RuleAction, RuleCondition, RuleField, RuleMatch, RulesApplied, RulesServer } from '@/lib/mail';

export const FIELD_NAMES: Record<RuleField, string> = {
  from: 'From',
  to: 'To or Cc',
  subject: 'Subject',
  'list-id': 'Mailing list (List-Id)',
  header: 'Header',
};

export const MATCH_NAMES: Record<RuleMatch, string> = {
  contains: 'contains',
  is: 'is',
  domain: 'is at the domain',
};

/** How each field can be matched, the first the usual one. */
export const FIELD_MATCHES: Record<RuleField, RuleMatch[]> = {
  from: ['is', 'domain', 'contains'],
  to: ['is', 'domain', 'contains'],
  subject: ['contains', 'is'],
  'list-id': ['contains'],
  header: ['contains', 'is'],
};

export const SPECIAL_PLACES = { junk: 'Junk', trash: 'Trash', archive: 'Archive' } as const;

export function describeCondition(c: RuleCondition): string {
  const field = c.field === 'header' ? `${c.header ?? 'header'}` : c.field === 'list-id' ? 'List-Id' : FIELD_NAMES[c.field];
  return `${field} ${MATCH_NAMES[c.match]} “${c.value}”`;
}

/** An action in words; `mailboxName` and `labelName` give a path's and a label id's names where they're known. */
export function describeAction(a: RuleAction, names: { mailbox?: (path: string) => string; label?: (id: string) => string } = {}): string {
  switch (a.type) {
    case 'move':
      return typeof a.to === 'string' ? `Move to “${names.mailbox?.(a.to) ?? a.to}”` : `Move to ${SPECIAL_PLACES[a.to.special]}`;
    case 'label':
      return `Label “${names.label?.(a.label) ?? a.label}”`;
    case 'read':
      return 'Mark as read';
    case 'flag':
      return 'Star';
    case 'forward':
      return `Forward to ${a.to}`;
  }
}

/** “If From is a@b and Subject contains x: Move to Junk, Mark as read”. */
export function describeRule(r: MailRule, names?: Parameters<typeof describeAction>[1]): string {
  const when = r.conditions.map(describeCondition).join(r.match === 'any' ? ' or ' : ' and ');
  const then = r.actions.map((a) => describeAction(a, names)).join(', ');
  return `If ${when}: ${then}${r.stop ? ', then stop' : ''}`;
}

export function ruleTitle(r: MailRule): string {
  return r.name || r.conditions.map(describeCondition).join(r.match === 'any' ? ' or ' : ' and ');
}

export function describeBlocked(b: BlockedSender): string {
  return `${b.sender.startsWith('@') ? `Everyone at ${b.sender.slice(1)}` : b.sender} → ${b.to === 'trash' ? 'Trash' : 'Junk'}`;
}

/** Only the server can do it (forwarding): where the server doesn't run the rules, it doesn't happen. */
export function serverOnly(a: RuleAction): boolean {
  return a.type === 'forward';
}

/** Where the rules run, in a sentence. */
export function serverText(s: RulesServer): string {
  switch (s.state) {
    case 'active':
      return 'Your mail server runs these, even while this computer is off, and Din runs them on new mail too.';
    case 'ready':
      return 'Your mail server can run these too: Din puts them there with your first rule or block.';
    case 'inactive':
      return `Your mail server runs another set of rules of yours (“${s.activeScript ?? 'unnamed'}”), so Din’s wait beside it there. Din runs them on new mail while it’s running.`;
    case 'edited':
      return 'Din’s rules on your mail server were changed somewhere else, so Din left them alone there. Din runs its own on new mail while it’s running.';
    case 'none':
      return 'Your mail server can’t be given rules, so Din runs them on new mail while it’s running.';
    case 'error':
      return `Din couldn’t reach your mail server’s rules${s.error ? ` (${s.error.replace(/\.$/, '')})` : ''}. Din runs them on new mail while it’s running.`;
    case 'unchecked':
      return 'Din runs these on new mail while it’s running, and puts them on your mail server too where it can.';
  }
}

/** What running the rules over the inbox did, in a sentence. */
export function appliedSummary(r: RulesApplied): string {
  if (!r.matched) return `Nothing in the inbox matched (${r.checked.toLocaleString()} looked at).`;
  return `${r.matched.toLocaleString()} matched of ${r.checked.toLocaleString()} looked at; ${r.moved.toLocaleString()} moved out of the inbox.`;
}

/** What a blank new rule starts as. */
export function newRule(): MailRule {
  return { id: '', name: '', enabled: true, match: 'all', conditions: [{ field: 'from', match: 'is', value: '' }], actions: [{ type: 'move', to: { special: 'archive' } }], stop: false };
}

/** Whether a sender typed is a whole address, rather than words or a domain. */
export function looksLikeAddress(s: string): boolean {
  return /^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/.test(s.trim());
}
