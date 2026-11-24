import type { MailAddress } from '@/lib/mail';
import { displayName } from '@/shared/mailCompose';

export {
  blankSeed,
  displayName,
  draftSeed,
  EMAIL,
  escapeHtml,
  formatAddress,
  forwardSeed,
  fullDate,
  parseAddresses,
  replySeed,
  textToHtml,
  type ComposeSeed,
} from '@/shared/mailCompose';

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const short = new Intl.DateTimeFormat(undefined, { year: '2-digit', month: 'numeric', day: 'numeric' });

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** As the message list shows it: a time today, Yesterday, a weekday this week, else a date. */
export function listDate(ms: number, now = new Date()): string {
  if (!ms) return '';
  const d = new Date(ms);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return time.format(d);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(d);
  return short.format(d);
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** A count kept short: 14k, not 14,123. */
export function shortCount(n: number): string {
  return compact.format(n).toLowerCase();
}

export function addressLine(list: MailAddress[]): string {
  return list.map(displayName).join(', ');
}

export function initials(a: MailAddress | undefined): string {
  const name = (a?.name || a?.address.split('@')[0] || '?').replace(/["'()[\]]/g, '').trim();
  const words = name.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 1);
  return letters.toUpperCase();
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
