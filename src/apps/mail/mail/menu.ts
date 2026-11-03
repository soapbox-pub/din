import { Archive, Folder, Forward, Inbox, LayoutPanelTop, Mail, MailMinus, MailOpen, OctagonAlert, Pencil, Plus, Reply, ReplyAll, Star, StarOff, Tag, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { CATEGORY_NAMES, type LabelColor, type MailboxInfo, type MailCategory, type MailLabels } from '@/lib/mail';
import type { Item } from './api';
import type { MessageAction } from './actions';
import { mailboxTitle, SPECIAL_ICONS } from './mailboxes';
import { labelColor, labelsOfItem } from './labels';
import { TAB_ICONS } from './tabs';

/** What a message menu can pick: an action, a mailbox to move to, a label to put on or take off, an inbox tab to send its sender to, or leaving its list. */
export type MenuPick = MessageAction | 'unsubscribe' | 'new-label' | { move: string } | { label: string; on: boolean } | { tab: MailCategory };

/** Messages shown in an inbox tab: the tabs shown, and the one they're in. */
export interface TabPlace {
  tabs: MailCategory[];
  current: MailCategory;
}

export type MenuEntry<P = MenuPick> =
  | { kind: 'item'; pick: P; label: string; icon: LucideIcon; disabled?: boolean; destructive?: boolean }
  /** Checked or not, with a label's color; picking it leaves the menu open, for the next. */
  | { kind: 'check'; pick: P; label: string; checked: boolean | 'indeterminate'; color?: LabelColor }
  | { kind: 'sub'; label: string; icon: LucideIcon; items: MenuEntry<P>[] }
  | { kind: 'separator' };

const item = (pick: MenuPick, label: string, icon: LucideIcon, more: { disabled?: boolean; destructive?: boolean } = {}): MenuEntry => ({ kind: 'item', pick, label, icon, ...more });
const separator: MenuEntry = { kind: 'separator' };

/**
 * The account's labels, checked where all these messages have one (and
 * partly where some do), to put on or take off; and New Label…. Empty
 * where the account can't keep labels.
 */
export function labelEntries(targets: Item[], info: MailLabels | undefined): MenuEntry[] {
  if (!targets.length || !info || info.kind === 'none') return [];
  const checks = info.labels.map((l): MenuEntry => {
    const have = targets.filter((t) => labelsOfItem(t, info).some((x) => x.id === l.id)).length;
    const checked = have === targets.length ? true : have ? 'indeterminate' : false;
    return { kind: 'check', pick: { label: l.id, on: checked !== true }, label: l.name, checked, color: labelColor(l) };
  });
  return [...checks, ...(checks.length ? [separator] : []), item('new-label', 'New Label…', Plus)];
}

/** The inbox tabs to send these messages' senders to, but the one they're in. */
function tabEntries(targets: Item[], place: TabPlace | null): MenuEntry[] {
  if (!place || !targets.some((t) => t.path.toUpperCase() === 'INBOX')) return [];
  return place.tabs.map((tab) => item({ tab }, CATEGORY_NAMES[tab], TAB_ICONS[tab], { disabled: tab === place.current }));
}

/**
 * What can be done to these messages (the row right-clicked, or the
 * selection it's in), for the right-click menu and the ⋯ button alike.
 * `boxes` are their account's mailboxes and `labels` its labels; `skip`
 * leaves out what's already a button beside the menu. `one` is whether
 * they're one message or one conversation (newest first), which Reply and
 * Forward answer. `place` is the inbox tab they're shown in, for Move to Tab.
 */
export function messageMenu(targets: Item[], boxes: MailboxInfo[], labels: MailLabels | undefined, skip: ReadonlySet<MenuPick> = new Set(), one = targets.length === 1, place: TabPlace | null = null): MenuEntry[] {
  if (!targets.length) return [];
  const first = targets[0];
  const many = !one;
  const allRead = targets.every((t) => t.seen);
  const allStarred = targets.every((t) => t.flagged);
  const inJunk = boxes.find((b) => b.path === first.path)?.special === 'junk';
  // On Gmail, as on its web page, moving to a label puts it on and takes the mailbox's off.
  const moveTargets = boxes.filter((b) => b.selectable && b.path !== first.path);
  const labelling = targets.every((t) => t.accountId === first.accountId) ? labelEntries(targets, labels) : [];
  const tabbing = tabEntries(targets, place);
  const groups: MenuEntry[][] = [
    first.draft && !many ? [item('open-draft', 'Open Draft', Pencil)] : [],
    [item('reply', 'Reply', Reply, { disabled: many }), item('reply-all', 'Reply All', ReplyAll, { disabled: many }), item('forward', 'Forward', Forward, { disabled: many })],
    [
      allRead ? item('unread', 'Mark as Unread', Mail) : item('read', 'Mark as Read', MailOpen),
      allStarred ? item('unflag', 'Remove Star', StarOff) : item('flag', 'Star', Star),
    ],
    [
      item('archive', 'Archive', Archive),
      inJunk ? item('not-junk', 'Not Junk', Inbox) : item('junk', 'Move to Junk', OctagonAlert),
      ...(moveTargets.length
        ? [{ kind: 'sub', label: 'Move to', icon: Folder, items: moveTargets.map((b) => item({ move: b.path }, mailboxTitle(b), b.special ? SPECIAL_ICONS[b.special] : Folder)) } satisfies MenuEntry]
        : []),
      ...(labelling.length ? [{ kind: 'sub', label: 'Label as', icon: Tag, items: labelling } satisfies MenuEntry] : []),
      ...(tabbing.length ? [{ kind: 'sub', label: 'Move to Tab', icon: LayoutPanelTop, items: tabbing } satisfies MenuEntry] : []),
    ],
    first.listUnsubscribe && !many ? [item('unsubscribe', 'Unsubscribe…', MailMinus)] : [],
    [item('trash', 'Delete', Trash2, { destructive: true })],
  ];
  const kept = groups.map((g) => g.filter((e) => e.kind !== 'item' || typeof e.pick === 'object' || !skip.has(e.pick))).filter((g) => g.length);
  return kept.flatMap((g, i) => (i ? [separator, ...g] : g));
}
