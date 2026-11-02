import { getAssistantBridge } from '@/lib/assistant';
import type { Area } from './types';
import { call, command, need } from './util';

/** `din assistant`: OpenCode, the agent behind the Assistant, as Settings → Assistant shows it. */

const assistant = () => need(getAssistantBridge(), 'The assistant');

export const assistantArea: Area = {
  name: 'assistant',
  summary: 'OpenCode, the agent behind the Assistant: its status, updating it, restarting it',
  commands: [
    command('assistant', 'status', 'OpenCode’s version, whether its server runs, and any newer release', [], async () => {
      const status = await call(assistant().status());
      return {
        data: status,
        text: [
          status.binary ? `opencode: ${status.version ?? '?'} (${status.binary})` : `opencode: ${status.version ? `${status.version}, too old` : 'not installed'}`,
          `server: ${status.updating ? 'updating' : status.running ? (status.connected ? 'running' : 'running, connecting') : 'not running'}`,
          status.update ? `update: ${status.update} is out` : '',
          status.error ? `error: ${status.error}` : '',
        ].filter(Boolean).join('\n'),
      };
    }),
    command('assistant', 'check', 'Ask OpenCode’s update service for a newer release now', [], async () => {
      const update = await call(assistant().checkUpdate());
      return { data: { update }, text: update ? `OpenCode ${update} is out (din assistant update)` : 'OpenCode is up to date' };
    }),
    command(
      'assistant',
      'update',
      'Update OpenCode to its newest release, as Update does in Settings → Assistant; restarting its server stops whatever the agent is doing, this command’s caller included',
      [],
      async (_args, ctx) => {
        const bridge = assistant();
        const { update } = await call(bridge.status());
        ctx.progress?.({ text: update ? `Updating OpenCode to ${update}` : 'Updating OpenCode' });
        await call(bridge.upgrade());
        const status = await call(bridge.status());
        return { data: status, text: `OpenCode is ${status.version ?? 'updated'}` };
      },
    ),
    command('assistant', 'restart', 'Restart OpenCode’s server, as Restart does in Settings → Assistant, stopping whatever the agent is doing', [], async () => {
      await call(assistant().restart());
    }),
  ],
};
