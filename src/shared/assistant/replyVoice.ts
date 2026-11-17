import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMessage } from '@/lib/assistant';
import { useAssistantHost } from '@/shared/assistant/host';
import { latestReply } from '@/shared/assistant/turns';

/**
 * Replies read aloud by themselves, as Settings → Assistant says: never,
 * when the message they answer was spoken, or always; and on a call,
 * always. Only replies that finish while their conversation is open in
 * this window, so opening one doesn't read out its last reply.
 */

/** Conversations whose next reply is to be spoken, with when the spoken message was sent. */
const spokenNext = new Map<string, number>();

/**
 * The user spoke their message to this conversation (dictated it), so its
 * reply is read aloud under "When I speak". `since` is when it was sent:
 * a reply that ended before then isn't the answer.
 */
export function speakNextReply(sessionID: string, since = Date.now()): void {
  spokenNext.set(sessionID, since);
}

/** Speaks the conversation's replies as they finish, when they should be. */
export function useReplyVoice({ sessionID, messages, call }: { sessionID: string; messages: SessionMessage[] | undefined; call: boolean }) {
  const host = useAssistantHost();
  const voice = host.useVoice();
  const reply = useMemo(() => (messages ? latestReply(messages) : null), [messages]);
  // A little before it opened, for the server's clock and this one a moment apart.
  const [openedAt] = useState(() => Date.now() - 2000);
  const spoken = useRef(new Set<string>());
  const latest = useRef({ call, mode: host.speakReplies, voice });
  useEffect(() => {
    latest.current = { call, mode: host.speakReplies, voice };
  });

  const key = reply?.key;
  const endedAt = reply?.endedAt ?? null;
  const text = reply?.text ?? '';
  useEffect(() => {
    if (!key || endedAt === null || spoken.current.has(key)) return;
    spoken.current.add(key);
    const flagged = spokenNext.get(sessionID);
    // Only a reply that ended while it was open here, or that answers a spoken message.
    const fresh = endedAt >= openedAt || (flagged !== undefined && endedAt >= flagged);
    if (!fresh) return;
    const { call, mode, voice } = latest.current;
    const wanted = call || mode === 'always' || (mode === 'dictated' && flagged !== undefined && endedAt >= flagged);
    if (flagged !== undefined && endedAt >= flagged) spokenNext.delete(sessionID);
    if (wanted && text && voice.available) voice.speak(text, key);
  }, [key, endedAt, text, sessionID, openedAt]);
}
