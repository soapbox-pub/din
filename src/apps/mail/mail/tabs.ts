import { Inbox, Info, MessagesSquare, Tag, Users, type LucideIcon } from 'lucide-react';
import type { MailCategory } from '@/lib/mail';

export const TAB_ICONS: Record<MailCategory, LucideIcon> = {
  primary: Inbox,
  promotions: Tag,
  social: Users,
  updates: Info,
  forums: MessagesSquare,
};

const SEEN_KEY = 'din:mail:tabs-seen';

/**
 * When each tab was last open, for its count of new mail, as Gmail's: what
 * came since. Tabs never opened count from the first time Mail asks.
 */
export function tabsSeen(): Record<MailCategory, number> {
  let saved: Partial<Record<MailCategory, number>> = {};
  try {
    saved = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Partial<Record<MailCategory, number>>) ?? {};
  } catch {
    // Counted from now, below.
  }
  const now = Date.now();
  const out = { primary: now, promotions: now, social: now, updates: now, forums: now, ...saved };
  if (Object.keys(saved).length < Object.keys(out).length) localStorage.setItem(SEEN_KEY, JSON.stringify(out));
  return out;
}

export function markTabSeen(tab: MailCategory): void {
  localStorage.setItem(SEEN_KEY, JSON.stringify({ ...tabsSeen(), [tab]: Date.now() }));
}
