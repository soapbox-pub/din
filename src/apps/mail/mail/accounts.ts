import type { MailAccount } from '@/lib/mail';

/**
 * Each account's own color, by its place in the list, so mail in All Inboxes
 * says which address it came to: a dot on its sender's picture, the same dot
 * beside the address in the sidebar.
 */
const ACCOUNT_COLORS = ['bg-sky-500', 'bg-amber-500', 'bg-emerald-500', 'bg-rose-500', 'bg-violet-500', 'bg-teal-500', 'bg-orange-500', 'bg-fuchsia-500'];

export function accountColor(accounts: MailAccount[], id: string): string {
  const i = accounts.findIndex((a) => a.id === id);
  return ACCOUNT_COLORS[(i < 0 ? 0 : i) % ACCOUNT_COLORS.length];
}

/** Which account a message came to, as a list row marks it. */
export interface AccountMark {
  email: string;
  color: string;
}
