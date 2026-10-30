import { Archive, FileText, Flag, Inbox, Mails, OctagonAlert, Send, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { MailboxInfo, SpecialMailbox } from '@/lib/mail';

/** What a dragged set of messages carries: their list keys. */
export const MAIL_DRAG = 'application/x-din-mail';

export const SPECIAL_ICONS: Record<SpecialMailbox, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: OctagonAlert,
  archive: Archive,
  all: Mails,
  flagged: Flag,
};

export const SPECIAL_NAMES: Record<SpecialMailbox, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  all: 'All Mail',
  flagged: 'Flagged',
};

/** How a mailbox reads in Mail: special mailboxes by their usual names. */
export function mailboxTitle(box: MailboxInfo | undefined): string {
  if (!box) return '';
  return box.special ? SPECIAL_NAMES[box.special] : box.name;
}
