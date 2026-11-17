import type { PhoneMessage } from '@/lib/phone';

/**
 * Reactions to texts, as SMS and MMS carry them: not at all. A phone that
 * has reactions (Google Messages over RCS, an iPhone over iMessage) sends
 * one to someone without them as an ordinary text quoting what it's to,
 * `🤘 to “I'll be there”` or `Loved “I'll be there”`, and a phone that knows
 * the wording (Google Messages does, for both) shows it as a reaction on the
 * message whose text it quotes. Nothing else ties the two: there's no id, so
 * the match is by the quoted words, the latest message before it that says
 * them. Messages (src/apps/messages/) does the same, and sends its own
 * reactions in Google's wording.
 */

/** What the reaction texts say, before the quote. Apple's six tapbacks, and their removals. */
const APPLE: { verb: string; removal: string; emoji: string }[] = [
  { verb: 'Loved', removal: 'a heart', emoji: '❤️' },
  { verb: 'Liked', removal: 'a like', emoji: '👍' },
  { verb: 'Disliked', removal: 'a dislike', emoji: '👎' },
  { verb: 'Laughed at', removal: 'a laugh', emoji: '😂' },
  { verb: 'Emphasized', removal: 'an exclamation', emoji: '‼️' },
  { verb: 'Questioned', removal: 'a question mark', emoji: '❓' },
];

/** The reactions offered for sending, in order. */
export const QUICK_REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓'] as const;

export interface ParsedReaction {
  emoji: string;
  /** The words quoted (cut short by the sender where it ended with …), or null for a picture. */
  quote: string | null;
  /** Whether the quote was cut short, so it's matched as the start of the message. */
  truncated: boolean;
  removed: boolean;
}

const QUOTE = String.raw`[“"](.*)[”"]`;
const IMAGE = String.raw`an? (?:image|photo|picture|video|attachment|sticker|GIF)`;
/** One emoji, with its modifiers and joiners. */
const EMOJI = String.raw`(\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}|\p{Emoji_Modifier}|\p{Extended_Pictographic})*)`;

const PATTERNS: { re: RegExp; read: (m: RegExpExecArray) => Omit<ParsedReaction, 'quote' | 'truncated'> & { raw: string | null } }[] = [
  // Google Messages: `🤘 to “…”`, `Reacted 🤘 to “…”`, and `Removed 🤘 from “…”`.
  { re: new RegExp(`^(?:Reacted )?${EMOJI} to ${QUOTE}$`, 'su'), read: (m) => ({ emoji: m[1], raw: m[2], removed: false }) },
  { re: new RegExp(`^(?:Reacted )?${EMOJI} to ${IMAGE}$`, 'u'), read: (m) => ({ emoji: m[1], raw: null, removed: false }) },
  { re: new RegExp(`^Removed ${EMOJI} from ${QUOTE}$`, 'su'), read: (m) => ({ emoji: m[1], raw: m[2], removed: true }) },
  { re: new RegExp(`^Removed ${EMOJI} from ${IMAGE}$`, 'u'), read: (m) => ({ emoji: m[1], raw: null, removed: true }) },
  // Apple: `Loved “…”`, `Removed a heart from “…”`, and their pictures.
  ...APPLE.flatMap(({ verb, removal, emoji }) => [
    { re: new RegExp(`^${verb} ${QUOTE}$`, 's'), read: (m: RegExpExecArray) => ({ emoji, raw: m[1], removed: false }) },
    { re: new RegExp(`^${verb} ${IMAGE}$`), read: () => ({ emoji, raw: null, removed: false }) },
    { re: new RegExp(`^Removed ${removal} from ${QUOTE}$`, 's'), read: (m: RegExpExecArray) => ({ emoji, raw: m[1], removed: true }) },
    { re: new RegExp(`^Removed ${removal} from ${IMAGE}$`), read: () => ({ emoji, raw: null, removed: true }) },
  ]),
];

/** A text that's a reaction, read; null for an ordinary text. */
export function parseReaction(body: string): ParsedReaction | null {
  const text = body.trim();
  if (!text || text.length > 2000) return null;
  for (const { re, read } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const { emoji, raw, removed } = read(m);
    if (raw === null) return { emoji, quote: null, truncated: false, removed };
    const truncated = /(?:…|\.\.\.)$/.test(raw);
    const quote = normalize(truncated ? raw.replace(/(?:…|\.\.\.)$/, '') : raw);
    if (!quote) return null;
    return { emoji, quote, truncated, removed };
  }
  return null;
}

function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/** A reaction on a message: who (an address, or null for the user's own) and what. */
export interface Reaction {
  emoji: string;
  sender: string | null;
}

export interface ThreadReactions {
  /** Reactions by the id of the message they're on. */
  on: Map<string, Reaction[]>;
  /** The texts that were reactions and found their message: drawn on it, not on their own. */
  hidden: Set<string>;
}

/**
 * The reactions in a conversation's messages (oldest first): each to the
 * latest message before it whose text it quotes (or, for a picture, the
 * latest with one), a removal taking back that person's same reaction. One
 * whose message isn't found stays an ordinary text.
 */
export function threadReactions(messages: PhoneMessage[]): ThreadReactions {
  const on = new Map<string, Reaction[]>();
  const hidden = new Set<string>();
  const plain: PhoneMessage[] = [];
  for (const m of messages) {
    const parsed = parseReaction(m.body);
    if (!parsed || m.images.length) {
      plain.push(m);
      continue;
    }
    const target = findTarget(plain, parsed);
    if (!target) {
      plain.push(m);
      continue;
    }
    hidden.add(m.id);
    const sender = m.outgoing ? null : m.sender;
    const list = (on.get(target.id) ?? []).filter((r) => !(r.sender === sender && r.emoji === parsed.emoji));
    if (!parsed.removed) list.push({ emoji: parsed.emoji, sender });
    on.set(target.id, list);
  }
  return { on, hidden };
}

function findTarget(earlier: PhoneMessage[], r: ParsedReaction): PhoneMessage | null {
  for (let i = earlier.length - 1; i >= 0; i--) {
    const m = earlier[i];
    if (r.quote === null) {
      if (m.images.length || m.unfetched) return m;
      continue;
    }
    const body = normalize(m.body);
    if (body === r.quote || (r.truncated && body.startsWith(r.quote))) return m;
  }
  return null;
}

/** Longest quote sent: Google Messages cuts longer ones the same way, with an ellipsis. */
const QUOTE_MAX = 100;

/**
 * The text that reacts to a message, in Google Messages' wording (which it
 * shows as a reaction, and Din does too); `removed` takes the reaction back.
 */
export function reactionText(target: Pick<PhoneMessage, 'body' | 'images' | 'unfetched'>, emoji: string, removed = false): string {
  const body = target.body.replace(/\s+/g, ' ').trim();
  const what = body ? `“${body.length > QUOTE_MAX ? `${body.slice(0, QUOTE_MAX - 1).trimEnd()}…` : body}”` : 'an image';
  return removed ? `Removed ${emoji} from ${what}` : `${emoji} to ${what}`;
}

/** A reaction text in words for a preview or a notification: "Reacted 🤘 to “…”". */
export function describeReaction(body: string): string | null {
  const r = parseReaction(body);
  if (!r) return null;
  const what = r.quote === null ? 'a picture' : `“${r.quote}${r.truncated ? '…' : ''}”`;
  return r.removed ? `Removed ${r.emoji} from ${what}` : `Reacted ${r.emoji} to ${what}`;
}
