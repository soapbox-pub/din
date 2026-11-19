import { useSyncExternalStore } from 'react';
import { getMailDesktopBridge, type MailAccount, type MailboxInfo } from '@/lib/mail';

/**
 * The desktop's side of Mail's inboxes: their unread count, as Mail's Dock
 * badge shows it (MailHost keeps it), and marking mailboxes read, for the
 * tile's Mark All as Read and `din mail mark-read` alike.
 */

let unseenTotal = 0;
const listeners = new Set<() => void>();

/** The inboxes' unread count, as last told (MailHost). */
export function setMailUnseen(total: number): void {
  if (total === unseenTotal) return;
  unseenTotal = total;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The inboxes' unread count Mail's Dock badge shows (only Primary's, when only Primary notifies). */
export function useMailUnseen(): number {
  return useSyncExternalStore(subscribe, () => unseenTotal);
}

export interface MarkReadTarget {
  account: MailAccount;
  box: MailboxInfo;
}

/**
 * A mailbox in each account (picked by `pick`, else the inbox), for marking
 * read. An account with none is left out.
 */
export async function markReadTargets(
  accounts: MailAccount[],
  pick?: (boxes: MailboxInfo[]) => MailboxInfo | undefined,
): Promise<MarkReadTarget[]> {
  const mail = getMailDesktopBridge();
  if (!mail) return [];
  const targets: MarkReadTarget[] = [];
  for (const account of accounts) {
    const boxes = (await mail.mailboxes(account.id)).filter((b) => b.selectable);
    const box = pick ? pick(boxes) : boxes.find((b) => b.special === 'inbox');
    if (box) targets.push({ account, box });
  }
  return targets;
}

/** Mark every message in these mailboxes read, as Mail's Mark All as Read does; how many were unread. */
export async function markRead(targets: MarkReadTarget[]): Promise<number> {
  const mail = getMailDesktopBridge();
  if (!mail) throw new Error('Mail isn’t available here');
  let marked = 0;
  for (const t of targets) marked += await mail.markAllRead(t.account.id, t.box.path);
  return marked;
}

/** Mark every account's inbox read (Mail's Dock tile's Mark All as Read); how many were unread. */
export async function markInboxesRead(): Promise<number> {
  const mail = getMailDesktopBridge();
  if (!mail) throw new Error('Mail isn’t available here');
  return markRead(await markReadTargets(await mail.accounts()));
}
