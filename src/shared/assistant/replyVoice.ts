import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMessage } from '@/lib/assistant';
import { useAssistantHost } from '@/shared/assistant/host';
import { latestTurnProse } from '@/shared/assistant/turns';
import { speakableUpTo } from '@/shared/speakable';

/**
 * Replies read aloud by themselves, as Settings → Assistant says: never,
 * when the message they answer was spoken, or always; and on a call,
 * always. Read as they're written, a sentence at a time, not once the turn
 * is over: the notes the agent writes between its steps ("Let me check the
 * dock's settings…") and then its answer, never its thinking, commands or
 * code. Only turns that are going (or end) while the conversation is open
 * in this window, so opening one doesn't read out its last reply.
 * Stopping the voice (talking over it on a call, Interrupt, Stop reading)
 * stops the rest of the turn too.
 */

/** Conversations whose next reply is to be spoken, with when the spoken message was sent. */
const spokenNext = new Map<string, number>();

/**
 * The user spoke their message to this conversation (dictated it), so its
 * reply is read aloud under "When I speak". `since` is when it was sent:
 * a turn that started before then isn't the answer.
 */
export function speakNextReply(sessionID: string, since = Date.now()): void {
  spokenNext.set(sessionID, since);
}

/** The clocks of the server and this window a moment apart. */
const SLACK_MS = 2000;

/** Where reading the latest turn has got to. */
interface Reading {
  key: string;
  /** Being read; 'skip' until it's wanted (a call starting partway reads on from there). */
  state: 'speak' | 'skip' | 'stopped';
  /** The voice's reading, once it has one. */
  reading?: number;
  /** How much of each prose block has been read (or passed over). */
  spoken: Map<string, number>;
}

/** Speaks the conversation's replies as they're written, when they should be. */
export function useReplyVoice({ sessionID, messages, call }: { sessionID: string; messages: SessionMessage[] | undefined; call: boolean }) {
  const host = useAssistantHost();
  const voice = host.useVoice();
  const turn = useMemo(() => (messages ? latestTurnProse(messages) : null), [messages]);
  const [openedAt] = useState(() => Date.now() - SLACK_MS);
  const current = useRef<Reading | null>(null);
  /** Turns over by the time they were first seen here, which aren't read. */
  const seenOver = useRef(new Set<string>());
  const latest = useRef({ call, mode: host.speakReplies, voice });
  useEffect(() => {
    latest.current = { call, mode: host.speakReplies, voice };
  });

  useEffect(() => {
    if (!turn) return;
    const { call, mode, voice } = latest.current;
    let r = current.current;
    if (r?.key !== turn.key) {
      const flagged = spokenNext.get(sessionID);
      const answersSpoken = flagged !== undefined && turn.start >= flagged - SLACK_MS;
      if (answersSpoken) spokenNext.delete(sessionID);
      // Going when it's first seen, or ended since this opened, or answering a spoken message.
      const live = turn.endedAt === null || turn.endedAt >= openedAt || answersSpoken;
      if (!live) seenOver.current.add(turn.key);
      const wanted = live && (call || mode === 'always' || (mode === 'dictated' && answersSpoken));
      r = { key: turn.key, state: wanted ? 'speak' : 'skip', spoken: new Map() };
      current.current = r;
    }
    // A call started partway through: read on from what's written now.
    if (r.state === 'skip' && call && !seenOver.current.has(turn.key)) {
      for (const part of turn.parts) r.spoken.set(part.id, part.text.length);
      r.state = 'speak';
    }
    if (r.state !== 'speak' || !voice.available) return;

    for (const part of turn.parts) {
      const from = r.spoken.get(part.id) ?? 0;
      const to = speakableUpTo(part.text, from, part.done);
      if (to > from) {
        const next = voice.append(part.text.slice(from, to), turn.key, r.reading);
        if (next === null) {
          // The voice was stopped: so is the rest of this turn.
          r.state = 'stopped';
          return;
        }
        r.reading = next;
        r.spoken.set(part.id, to);
      }
      // Blocks come in order: one still being written is the last.
      if (!part.done) break;
    }
  }, [turn, sessionID, openedAt, call]);
}
