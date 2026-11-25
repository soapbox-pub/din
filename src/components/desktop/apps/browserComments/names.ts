import type { NostrMetadata } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';

/** What to call a comment's author: their name, or else a short npub. */
export function displayNameOf(metadata: NostrMetadata | undefined, pubkey: string): string {
  const name = metadata?.display_name?.trim() || metadata?.name?.trim();
  if (name) return name;
  const npub = nip19.npubEncode(pubkey);
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

/** Compact relative time: "now", "5m", "3h", "2d", or a date. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - seconds));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const date = new Date(seconds * 1000);
  const thisYear = date.getFullYear() === new Date(now * 1000).getFullYear();
  return date.toLocaleDateString([], thisYear ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}
