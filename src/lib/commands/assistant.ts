import { getAssistantBridge } from '@/lib/assistant';
import { connectClaudeProvider } from '@/lib/claudeProvider';
import { CommandError, type Area } from './types';
import { call, command, need } from './util';

/** `din assistant`: OpenCode, the agent behind the Assistant, as Settings → Assistant shows it. */

const assistant = () => need(getAssistantBridge(), 'The assistant');

export const assistantArea: Area = {
  name: 'assistant',
  summary: 'OpenCode, the agent behind the Assistant: its status, updating it, restarting it, and Claude for it',
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
    command('assistant', 'claude', 'Claude Code, behind the assistant’s Claude provider: whether it’s installed and signed in', [], async () => {
      const claude = await call(assistant().claude());
      return {
        data: claude,
        text: [
          claude.binary ? `claude: ${claude.version ?? '?'} (${claude.binary})` : 'claude: not installed',
          `signed in: ${claude.loggedIn ? (claude.account ?? 'yes') : 'no'}`,
          claude.error ? `error: ${claude.error}` : '',
        ].filter(Boolean).join('\n'),
      };
    }),
    command(
      'assistant',
      'connect-claude',
      'Set up Claude for the assistant, as Add provider → Claude does: install Claude Code (asking on screen first), sign it in to a Claude plan in the browser, and connect OpenCode to it',
      [],
      async (_args, ctx) => {
        const bridge = assistant();
        let claude = await call(bridge.claude());
        if (!claude.binary) {
          const ok = await ctx.confirm({
            title: 'Install Claude Code?',
            description: 'The assistant’s Claude provider runs Claude Code, Anthropic’s agent, with your Claude plan. Din downloads it from Anthropic into ~/.local/bin.',
            action: 'Install',
          });
          if (!ok) throw new CommandError('You didn’t allow it');
          ctx.progress?.({ text: 'Installing Claude Code' });
          await call(bridge.claudeInstall());
          claude = await call(bridge.claude());
        }
        if (!claude.loggedIn) {
          const login = await call(bridge.claudeLogin());
          const page = login.url ?? login.codeUrl;
          if (page) ctx.openUrl(page);
          ctx.progress?.({ text: 'Waiting for you to sign in to Claude in the browser' });
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            claude = await call(bridge.claude());
            if (claude.loggedIn) break;
            if (!claude.login || claude.login.state === 'failed') {
              throw new CommandError(claude.login?.message ?? 'The sign-in was stopped');
            }
          }
        }
        await call(
          connectClaudeProvider(bridge, (step) =>
            ctx.progress?.({ text: step === 'restarting' ? 'Restarting OpenCode to find Claude Code' : 'Connecting the assistant to Claude' }),
          ),
        );
        return { data: { connected: true, account: claude.account }, text: `Claude is connected${claude.account ? ` (${claude.account})` : ''}` };
      },
    ),
    command('assistant', 'restart', 'Restart OpenCode’s server, as Restart does in Settings → Assistant, stopping whatever the agent is doing', [], async () => {
      await call(assistant().restart());
    }),
  ],
};
