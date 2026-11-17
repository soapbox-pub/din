import type { PhoneConversation } from '@/lib/phone';
import { formatAddress, phoneDigits } from '@/shared/phone';
import { describeReaction } from '@/shared/phoneReactions';

/** "3:41 PM" today, "Yesterday", a weekday this week, then a date. */
export function listTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

/** The heading over a run of messages: "Today 3:41 PM", "Tuesday 9:02 AM", "Mar 4, 2026 at 9:02 AM". */
export function separatorTime(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: 'long' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`;
}

/** A name as written, or a number formatted. */
export function displayName(name: string): string {
  return name.split(', ').map(formatAddress).join(', ');
}

/** Up to two letters for an avatar, or null for a number (which gets a person icon). */
export function initials(name: string): string | null {
  if (/^[+\d\s().-]+$/.test(name)) return null;
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

/** Someone in a conversation: the name to show (a contact's, or the number) and their address. */
export interface Person {
  name: string;
  address: string;
}

/**
 * Each person's color, the same everywhere they appear in a conversation
 * (their avatar, their name over their messages, their tile in a group's):
 * an avatar's gradient, and their name's text in it, dark enough to read in
 * either scheme. Hues far enough apart to tell at a glance.
 */
const PALETTE = [
  { avatar: 'from-sky-400 to-blue-600', text: 'text-blue-700 dark:text-sky-300' },
  { avatar: 'from-emerald-400 to-emerald-600', text: 'text-emerald-700 dark:text-emerald-300' },
  { avatar: 'from-orange-400 to-orange-600', text: 'text-orange-700 dark:text-orange-300' },
  { avatar: 'from-pink-400 to-pink-600', text: 'text-pink-700 dark:text-pink-300' },
  { avatar: 'from-violet-400 to-violet-600', text: 'text-violet-700 dark:text-violet-300' },
  { avatar: 'from-lime-500 to-green-700', text: 'text-green-700 dark:text-lime-300' },
  { avatar: 'from-red-500 to-red-700', text: 'text-red-700 dark:text-red-300' },
  { avatar: 'from-amber-400 to-amber-600', text: 'text-amber-700 dark:text-amber-300' },
  { avatar: 'from-teal-400 to-cyan-700', text: 'text-cyan-700 dark:text-teal-300' },
];

export type PersonColor = (typeof PALETTE)[number];

/** What a person's color goes by: their number's digits, so it's theirs whether or not they're a contact, and the same however the number is written. */
export function personKey(address: string): string {
  const digits = phoneDigits(address);
  return digits || address.trim().toLowerCase();
}

function hashIndex(key: string): number {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % PALETTE.length;
}

/**
 * The colors of a conversation's people: each their number's own, unless
 * someone before them (by number) has it already, when they take the next
 * free one, so no two in a group share a color while there are colors to go
 * round. The same people always get the same colors.
 */
export function colorsFor(addresses: string[]): (address: string) => PersonColor {
  const taken = new Set<number>();
  const assigned = new Map<string, number>();
  for (const key of [...new Set(addresses.map(personKey))].sort()) {
    let i = hashIndex(key);
    for (let step = 0; step < PALETTE.length && taken.has(i); step++) i = (i + 1) % PALETTE.length;
    taken.add(i);
    if (taken.size >= PALETTE.length) taken.clear();
    assigned.set(key, i);
  }
  return (address) => PALETTE[assigned.get(personKey(address)) ?? hashIndex(personKey(address))];
}

/** A first name, for a contact; a number as it's written, for anyone else. */
export function shortName(name: string): string {
  if (/^[+\d\s().-]+$/.test(name)) return formatAddress(name);
  return name.trim().split(/\s+/)[0] || name;
}

/** Whether a person is named (a contact), not just a number. */
function named(p: Person): boolean {
  return !/^[+\d\s().-]+$/.test(p.name);
}

/** People with contact names first, then bare numbers, each in the order they came. */
export function namedFirst(people: Person[]): Person[] {
  return [...people.filter(named), ...people.filter((p) => !named(p))];
}

/** A group's title: first names, contacts before numbers, and how many more past three. */
export function groupTitle(people: Person[]): string {
  const names = namedFirst(people).map((p) => shortName(p.name));
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} & ${names.length - 3} more`;
}

/**
 * The people in a conversation, with names: the list's name is theirs
 * joined in the same order as its addresses (electron/phone.mts), when it
 * splits into as many.
 */
export function peopleOf(c: PhoneConversation): Person[] {
  const names = c.name.split(', ');
  return c.addresses.map((address, i) => ({ address, name: names.length === c.addresses.length ? names[i] : address }));
}

export function conversationKey(c: { phoneId: string; threadId: string }): string {
  return `${c.phoneId}\u0000${c.threadId}`;
}

export function preview(c: PhoneConversation): string {
  const m = c.last;
  const text =
    describeReaction(m.body) ??
    (m.body.replace(/\s+/g, ' ').trim() ||
      (m.images.length ? (m.images.length === 1 ? 'Picture' : `${m.images.length} pictures`) : m.unfetched ? 'Picture message' : ''));
  if (m.outgoing) return `You: ${text}`;
  // In a group, whose it is.
  if (c.addresses.length > 1 && m.sender) {
    const person = peopleOf(c).find((p) => personKey(p.address) === personKey(m.sender ?? ''));
    return `${shortName(person?.name ?? m.sender)}: ${text}`;
  }
  return text;
}
