import type { LabelColor, MailAccount } from '@/lib/mail';
import { LABEL_STYLES } from './labels';

/** The colors Mail gives accounts that haven't been given one, in turn: far apart, gray last. */
const IN_TURN: LabelColor[] = ['blue', 'amber', 'green', 'red', 'purple', 'teal', 'orange', 'pink', 'indigo', 'gray'];

/**
 * An account's color, so mail in All Inboxes says which address it came to:
 * a dot on its sender's picture, the same dot beside the address in the
 * sidebar. Its own (Account Settings, or the sidebar's Color menu), else one
 * by its place in the list.
 */
export function accountColor(accounts: MailAccount[], id: string): LabelColor {
  const i = accounts.findIndex((a) => a.id === id);
  const own = accounts[i]?.color;
  if (own && own in LABEL_STYLES) return own;
  return IN_TURN[(i < 0 ? 0 : i) % IN_TURN.length];
}

/** The account's color as a dot's class. */
export function accountDot(accounts: MailAccount[], id: string): string {
  return LABEL_STYLES[accountColor(accounts, id)].dot;
}

/** Which account a message came to, as a list row marks it. */
export interface AccountMark {
  email: string;
  color: string;
}
