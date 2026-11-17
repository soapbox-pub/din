import type { AssistantContent, SessionMessage } from '@/lib/assistant';

/**
 * A conversation's messages as the transcript shows them (Transcript.tsx):
 * the user's messages, and the agent's turns, each its work folded into
 * steps and then its reply, which Copy reply copies and Read Aloud and the
 * spoken replies (replyVoice.ts) read.
 */

export type AssistantMessage = Extract<SessionMessage, { type: 'assistant' }>;
export type UserMessage = Extract<SessionMessage, { type: 'user' }>;
export type IdleMessage = Extract<SessionMessage, { type: 'idle' }>;

/** The agent's work on one prompt: from the user's message to the session going idle. */
export interface TurnEntry {
  kind: 'turn';
  id: string;
  /** When the prompt was sent. */
  start: number;
  /** Its assistant messages, and whatever else the session recorded meanwhile. */
  items: SessionMessage[];
  /** How it ended, once it has. */
  idle?: IdleMessage;
}

/** Messages grouped as the transcript shows them. */
export type Entry = { kind: 'user'; message: UserMessage } | TurnEntry | { kind: 'note'; message: SessionMessage };

export function group(messages: SessionMessage[]): Entry[] {
  const entries: Entry[] = [];
  let turn: TurnEntry | undefined;
  // The prompt the agent is working on, until the session goes idle.
  let prompt: UserMessage | undefined;
  // A compaction partway through a prompt splits its turn; the rest is keyed by the compaction.
  let compaction: SessionMessage | undefined;
  const open = (first: SessionMessage): TurnEntry => {
    // A turn whose prompt is past the loaded window would otherwise be keyed by its
    // first visible message, which changes as the window slides and remounts it.
    const from = compaction ?? prompt;
    turn = {
      kind: 'turn',
      id: compaction ? `turn:${compaction.id}` : prompt ? `turn:${prompt.id}` : entries.length === 0 ? 'turn:earlier' : first.id,
      start: from?.time.created ?? first.time.created,
      items: [],
    };
    entries.push(turn);
    return turn;
  };
  for (const message of messages) {
    if (message.type === 'user') {
      // One sent while it works closes the turn so far; the agent's next steps start another.
      entries.push({ kind: 'user', message });
      turn = undefined;
      prompt = message;
      compaction = undefined;
    } else if (message.type === 'compaction') {
      // The summary reads as a reply of its own, not as part of the work.
      entries.push({ kind: 'note', message });
      turn = undefined;
      if (prompt) compaction = message;
    } else if (message.type === 'idle') {
      if (!turn && prompt) open(message);
      if (turn) turn.idle = message;
      else entries.push({ kind: 'note', message });
      turn = undefined;
      prompt = undefined;
      compaction = undefined;
    } else if (message.type === 'assistant' || turn || prompt || backgroundNotice(message)) {
      // Background work finishing wakes the agent as a prompt would: its
      // notice opens the turn, folded into the work with what that does.
      (turn ?? open(message)).items.push(message);
    } else entries.push({ kind: 'note', message });
  }
  return entries;
}

/** The session's notice that a command, subagent or other work it left running has finished. */
export function backgroundNotice(message: SessionMessage): boolean {
  return (message.type === 'synthetic' || message.type === 'system') && !!message.metadata?.source;
}

export type ToolPart = Extract<AssistantContent, { type: 'tool' }>;
export type ReasoningPart = Extract<AssistantContent, { type: 'reasoning' }>;
export type Step = (ToolPart | ReasoningPart) & { key: string };

/** A turn as it's shown: prose, and each unbroken run of tool calls and thinking folded into one line. */
export type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'error'; key: string; message: string }
  | { kind: 'note'; key: string; message: SessionMessage };

export function blocks(items: SessionMessage[]): Block[] {
  const out: Block[] = [];
  for (const message of items) {
    if (message.type !== 'assistant') {
      out.push({ kind: 'note', key: message.id, message });
      continue;
    }
    message.content.forEach((part, index) => {
      const key = part.type === 'tool' ? part.id : `${message.id}:${index}`;
      if (part.type === 'text') {
        if (part.text.trim()) out.push({ kind: 'text', key, text: part.text });
        return;
      }
      if (part.type === 'reasoning' && !part.text.trim()) return;
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.steps.push({ ...part, key });
      else out.push({ kind: 'steps', key, steps: [{ ...part, key }] });
    });
    if (message.error) {
      out.push({ kind: 'error', key: `${message.id}:error`, message: message.error.message ?? message.error.type ?? 'Something went wrong' });
    }
  }
  return out;
}

/** Where a turn's reply starts: after its last steps or note; everything before is the work. */
export function replyCut(list: Block[]): number {
  let cut = -1;
  list.forEach((block, index) => {
    if (block.kind === 'steps' || block.kind === 'note') cut = index;
  });
  return cut;
}

export function replyText(after: Block[]): string {
  return after.flatMap((block) => (block.kind === 'text' ? [block.text.trim()] : [])).join('\n\n');
}

/**
 * The conversation's latest reply, the prose after its last turn's work
 * (what Copy reply copies and Read Aloud reads), keyed as its turn is, and
 * when the turn ended, if it has; null while the latest thing is the user's.
 */
export function latestReply(messages: SessionMessage[]): { key: string; text: string; endedAt: number | null } | null {
  const entries = group(messages);
  const last = entries[entries.length - 1];
  if (last?.kind !== 'turn') return null;
  const list = blocks(last.items);
  return { key: last.id, text: replyText(list.slice(replyCut(list) + 1)), endedAt: last.idle?.time.created ?? null };
}
