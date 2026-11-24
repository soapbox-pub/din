import { useMemo } from 'react';
import { SECRET_NAME, type SessionMessage } from '@/lib/assistant';
import { splitAttachedPaths } from '@/shared/assistant/attachedFiles';

/** A call of the agent's `ask_secret` tool (os/opencode/plugins/din/secrets.ts) waiting on the user. */
export interface SecretRequest {
  sessionID: string;
  callID: string;
  name: string;
  description?: string;
}

const isAskSecret = (name: string) => name === 'ask_secret' || name.endsWith('__ask_secret');

/** The `ask_secret` calls in a conversation still waiting on the user (`SecretRequestCard`). */
export function useSecretRequests(sessionID: string | null, messages: readonly SessionMessage[] | undefined): SecretRequest[] {
  return useMemo(() => {
    if (!sessionID || !messages) return [];
    const out: SecretRequest[] = [];
    for (const message of messages) {
      if (message.type !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'tool' || !isAskSecret(part.name) || part.state.status !== 'running') continue;
        const { input } = part.state;
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!SECRET_NAME.test(name)) continue;
        out.push({
          sessionID,
          callID: part.id,
          name,
          description: typeof input.description === 'string' ? input.description.trim().slice(0, 500) : undefined,
        });
      }
    }
    return out;
  }, [sessionID, messages]);
}

/** The first of SECRET_1, SECRET_2, … not in `taken`. */
export function nextSecretName(taken: readonly string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`SECRET_${n}`)) return `SECRET_${n}`;
}

/**
 * The secrets a conversation has been given, by name: attached to the
 * user's messages and asked for with `ask_secret`. A new one is named after
 * them, so it doesn't replace one of them.
 */
export function useGivenSecretNames(messages: readonly SessionMessage[] | undefined): string[] {
  return useMemo(() => {
    const names = new Set<string>();
    for (const message of messages ?? []) {
      if (message.type === 'user') for (const name of splitAttachedPaths(message.text).secrets) names.add(name);
      if (message.type !== 'assistant') continue;
      for (const part of message.content) {
        if (part.type !== 'tool' || !isAskSecret(part.name) || part.state.status === 'streaming') continue;
        const name = part.state.input.name;
        if (typeof name === 'string' && SECRET_NAME.test(name.trim())) names.add(name.trim());
      }
    }
    return [...names];
  }, [messages]);
}
