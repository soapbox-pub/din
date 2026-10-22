import { z } from 'zod';
import { AtSign, Heart, MessageCircle, Repeat2, Zap, type LucideIcon } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import type { NostrEvent } from '@nostrify/nostrify';

/**
 * Notification model for Din.
 *
 * Din surfaces the standard Nostr interactions that name the logged-in user in
 * a `p` tag — mentions/replies, reposts, reactions, comments, and zaps — as
 * desktop notifications (the menu-bar clock's panel + a transient on-screen display).
 *
 * Per-type preferences and the read cursor roam across devices through the
 * encrypted app-data layer (see `useNotificationSettings`), so relays never
 * see which interactions a user cares about.
 */

/** Every Nostr kind that can appear as a Din notification. */
export const ALL_NOTIFICATION_KINDS = [1, 6, 16, 7, 9735, 1111] as const;

/**
 * A category of notification the user can toggle on or off. Each maps to one
 * or more Nostr kinds (see {@link getEnabledNotificationKinds}).
 */
export type NotificationCategory =
  | 'mentions'
  | 'reposts'
  | 'reactions'
  | 'comments'
  | 'zaps';

/** Per-type notification preferences. Every category defaults to enabled. */
export const NotificationPreferencesSchema = z.object({
  /** Kind 1 notes that tag the user (mentions and replies). */
  mentions: z.boolean().default(true),
  /** Kind 6/16 reposts of the user's notes. */
  reposts: z.boolean().default(true),
  /** Kind 7 reactions (likes) on the user's notes. */
  reactions: z.boolean().default(true),
  /** Kind 1111 NIP-22 comments on the user's content. */
  comments: z.boolean().default(true),
  /** Kind 9735 lightning zap receipts. */
  zaps: z.boolean().default(true),
  /** Only notify about interactions from people the user follows. */
  onlyFollowing: z.boolean().default(false),
  /** Show a transient on-screen popup when a new notification arrives. */
  osd: z.boolean().default(true),
});

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/** Default preferences: everything on, no follow gate, OSD enabled. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  mentions: true,
  reposts: true,
  reactions: true,
  comments: true,
  zaps: true,
  onlyFollowing: false,
  osd: true,
};

/**
 * Persisted notifications state: the per-type preferences plus the read
 * cursor (a Unix-seconds timestamp; everything newer than it is "unread").
 */
export const NotificationSettingsSchema = z.object({
  preferences: NotificationPreferencesSchema.default(DEFAULT_NOTIFICATION_PREFERENCES),
  /** Unix seconds of the newest notification the user has seen. */
  cursor: z.number().default(0),
});

export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

/** Default persisted state used before anything is stored. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  preferences: DEFAULT_NOTIFICATION_PREFERENCES,
  cursor: 0,
};

/**
 * Derive the set of Nostr kinds to request from the per-type preferences.
 * Falls back to every kind so the relay query never sends an empty `kinds`
 * array (which would match nothing).
 */
export function getEnabledNotificationKinds(
  prefs: NotificationPreferences | undefined | null,
): number[] {
  const p = prefs ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const kinds: number[] = [];

  if (p.mentions) kinds.push(1);
  if (p.reposts) kinds.push(6, 16);
  if (p.reactions) kinds.push(7);
  if (p.comments) kinds.push(1111);
  if (p.zaps) kinds.push(9735);

  return kinds.length > 0 ? kinds : [...ALL_NOTIFICATION_KINDS];
}

/** Human-facing metadata about the ordered notification categories. */
export const NOTIFICATION_CATEGORY_META: {
  id: NotificationCategory;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  { id: 'mentions', label: 'Mentions & replies', description: 'When someone mentions or replies to you', icon: AtSign },
  { id: 'comments', label: 'Comments', description: 'Comments on your posts and content', icon: MessageCircle },
  { id: 'reposts', label: 'Reposts', description: 'When someone reposts your notes', icon: Repeat2 },
  { id: 'reactions', label: 'Reactions', description: 'Likes and reactions on your notes', icon: Heart },
  { id: 'zaps', label: 'Zaps', description: 'Lightning zaps you receive', icon: Zap },
];

/** Which broad kind bucket a notification event belongs to. */
export type NotificationKind = 'mention' | 'repost' | 'reaction' | 'comment' | 'zap';

/** Classify a notification event into its display bucket. */
export function classifyNotification(event: NostrEvent): NotificationKind {
  switch (event.kind) {
    case 6:
    case 16:
      return 'repost';
    case 7:
      return 'reaction';
    case 9735:
      return 'zap';
    case 1111:
      return 'comment';
    default:
      return 'mention';
  }
}

/** Icon + short verb describing what an actor did, for the UI. */
export const NOTIFICATION_KIND_META: Record<
  NotificationKind,
  { icon: LucideIcon; verb: string }
> = {
  mention: { icon: AtSign, verb: 'mentioned you' },
  comment: { icon: MessageCircle, verb: 'commented on your post' },
  repost: { icon: Repeat2, verb: 'reposted your note' },
  reaction: { icon: Heart, verb: 'reacted to your note' },
  zap: { icon: Zap, verb: 'zapped you' },
};

/** The `e` tag (referenced event id) an interaction points at, if any. */
export function getReferencedEventId(event: NostrEvent): string | undefined {
  const eTag = event.tags.findLast(([name]) => name === 'e');
  return eTag?.[1];
}

/**
 * Parse the zapped amount (in sats) from a kind 9735 zap receipt by reading the
 * `amount` (millisats) tag of the embedded zap request in the `description`
 * tag. Returns 0 when it can't be determined.
 */
export function getZapAmountSats(event: NostrEvent): number {
  try {
    const description = event.tags.find(([name]) => name === 'description')?.[1];
    if (!description) return 0;
    const request: unknown = JSON.parse(description);
    if (typeof request !== 'object' || request === null || !('tags' in request)) return 0;
    const tags = (request as { tags: unknown }).tags;
    if (!Array.isArray(tags)) return 0;
    const amountTag = tags.find(
      (t): t is [string, string] => Array.isArray(t) && t[0] === 'amount',
    );
    if (!amountTag) return 0;
    const millisats = Number(amountTag[1]);
    return Number.isFinite(millisats) ? Math.round(millisats / 1000) : 0;
  } catch {
    return 0;
  }
}

/** The pubkey that performed a notification interaction. For zaps, the sender. */
export function getNotificationActor(event: NostrEvent): string {
  if (event.kind === 9735) {
    // Zap receipts are signed by the LNURL server; the real sender is the
    // pubkey of the embedded zap request (P tag), falling back to `P`/`p`.
    const bigP = event.tags.find(([name]) => name === 'P')?.[1];
    if (bigP) return bigP;
    try {
      const description = event.tags.find(([name]) => name === 'description')?.[1];
      if (description) {
        const request: unknown = JSON.parse(description);
        if (typeof request === 'object' && request !== null && 'pubkey' in request) {
          const pk = (request as { pubkey: unknown }).pubkey;
          if (typeof pk === 'string') return pk;
        }
      }
    } catch {
      // fall through
    }
  }
  return event.pubkey;
}

/**
 * The external Nostr URL a notification should open when clicked. Mentions and
 * comments point at the interaction event itself; reactions, reposts, and zaps
 * point at the post that was acted on (when known), falling back to the actor's
 * profile. Uses `ditto.pub` so an installed Ditto app can claim the link (see
 * `useOpenUrl`); otherwise it opens in the Web Browser app.
 */
export function notificationTargetUrl(params: {
  type: NotificationKind;
  event: NostrEvent;
  actor: string;
  referencedEvent?: NostrEvent;
}): string {
  const { type, event, actor, referencedEvent } = params;
  const target = type === 'mention' || type === 'comment' ? event : referencedEvent;
  if (target) {
    try {
      return `https://ditto.pub/${nip19.neventEncode({ id: target.id, author: target.pubkey })}`;
    } catch {
      // fall through to the actor profile
    }
  }
  try {
    return `https://ditto.pub/${nip19.npubEncode(actor)}`;
  } catch {
    return 'https://ditto.pub';
  }
}
