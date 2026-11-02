import { Archive, Folder, Forward, Inbox, Mail, MailMinus, MailOpen, OctagonAlert, Pencil, Reply, ReplyAll, Star, StarOff, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MailboxInfo } from '@/lib/mail';
import type { Item } from './api';
import type { MessageAction } from './actions';
import { mailboxTitle, SPECIAL_ICONS } from './mailboxes';

/** What a message menu can pick: an action, a mailbox to move to, or leaving its list. */
export type MenuPick = MessageAction | 'unsubscribe' | { move: string };

export type MenuEntry =
  | { kind: 'item'; pick: MenuPick; label: string; icon: LucideIcon; disabled?: boolean; destructive?: boolean }
  | { kind: 'sub'; label: string; icon: LucideIcon; items: MenuEntry[] }
  | { kind: 'separator' };

const item = (pick: MenuPick, label: string, icon: LucideIcon, more: { disabled?: boolean; destructive?: boolean } = {}): MenuEntry => ({ kind: 'item', pick, label, icon, ...more });
const separator: MenuEntry = { kind: 'separator' };

/**
 * What can be done to these messages (the row right-clicked, or the
 * selection it's in), for the right-click menu and the ⋯ button alike.
 * `boxes` are their account's mailboxes; `skip` leaves out what's
 * already a button beside the menu. `one` is whether they're one message
 * or one conversation (newest first), which Reply and Forward answer.
 */
export function messageMenu(targets: Item[], boxes: MailboxInfo[], skip: ReadonlySet<MenuPick> = new Set(), one = targets.length === 1): MenuEntry[] {
  if (!targets.length) return [];
  const first = targets[0];
  const many = !one;
  const allRead = targets.every((t) => t.seen);
  const allStarred = targets.every((t) => t.flagged);
  const inJunk = boxes.find((b) => b.path === first.path)?.special === 'junk';
  const moveTargets = boxes.filter((b) => b.selectable && b.path !== first.path);
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
    ],
    first.listUnsubscribe && !many ? [item('unsubscribe', 'Unsubscribe…', MailMinus)] : [],
    [item('trash', 'Delete', Trash2, { destructive: true })],
  ];
  const kept = groups.map((g) => g.filter((e) => e.kind !== 'item' || typeof e.pick === 'object' || !skip.has(e.pick))).filter((g) => g.length);
  return kept.flatMap((g, i) => (i ? [separator, ...g] : g));
}
