import { useMemo } from 'react';
import { SECRET_NAME, type SessionMessage } from '@/lib/assistant';

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
