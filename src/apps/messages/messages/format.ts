import type { PhoneConversation } from '@/lib/phone';
import { formatAddress } from '@/shared/phone';

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

const AVATAR_COLORS = [
  'from-sky-400 to-blue-600',
  'from-emerald-400 to-teal-600',
  'from-amber-400 to-orange-600',
  'from-rose-400 to-pink-600',
  'from-violet-400 to-purple-600',
  'from-lime-400 to-green-600',
  'from-cyan-400 to-sky-600',
  'from-fuchsia-400 to-rose-600',
];

export function avatarColor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function conversationKey(c: { phoneId: string; threadId: string }): string {
  return `${c.phoneId}\u0000${c.threadId}`;
}

export function preview(c: PhoneConversation): string {
  const m = c.last;
  const text = m.body.replace(/\s+/g, ' ').trim() || (m.images.length ? (m.images.length === 1 ? 'Picture' : `${m.images.length} pictures`) : '');
  return m.outgoing ? `You: ${text}` : text;
}
