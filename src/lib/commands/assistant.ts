import { getAssistantBridge, type SkillInfo, type SkillSettings } from '@/lib/assistant';
import { isRemovableSource, removeSourceWording, skillSourceDetail, skillSourceName } from '@/lib/assistantSkills';
import { connectClaudeProvider } from '@/lib/claudeProvider';
import { getFsBridge } from '@/lib/fs';
import { usageText } from '@/shared/assistant/claudeUsage';
import { CommandError, type Area } from './types';
import { call, command, need, pick } from './util';

/** `din assistant`: OpenCode, the agent behind the Assistant, as Settings → Assistant shows it. */

const assistant = () => need(getAssistantBridge(), 'The assistant');

/** The skills named, each by its id or a name that's only its. */
function pickSkills(settings: SkillSettings, names: string[]): SkillInfo[] {
  if (names.length === 0) throw new CommandError('Missing skill', 'usage');
  const all = settings.sources.flatMap((source) => source.skills);
  return names.map((name) => pick(all, name, (skill) => [skill.id, skill.name], 'skill'));
}

async function setSkillsEnabled(names: string[], enabled: boolean) {
  const bridge = assistant();
  const skills = pickSkills(await call(bridge.skills()), names);
  const settings = await call(bridge.changeSkills({ op: 'setEnabled', ids: skills.map((skill) => skill.id), enabled }));
  return {
    data: settings,
    text: `${skills.map((skill) => skill.id).join(', ')}: ${enabled ? 'on' : 'off'}`,
  };
}

export const assistantArea: Area = {
  name: 'assistant',
  summary: 'OpenCode, the agent behind the Assistant: its status, updating it, restarting it, Claude for it, and its skills and their folders',
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
      'claude-usage',
      'How much of the Claude plan is used, as Settings → Assistant shows under Claude: its session and weekly limits and when each resets',
      [],
      async () => {
        const usage = await call(assistant().claudeUsage(true));
        return { data: usage, text: usageText(usage) };
      },
    ),
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
    command('assistant', 'skills', 'The assistant’s skills, as Settings → Assistant lists them: the folders OpenCode finds them in, the skills in each, and which are off', [], async () => {
      const settings = await call(assistant().skills());
      const home = await getFsBridge()?.homedir().catch(() => undefined);
      return {
        data: settings,
        text: [
          settings.error ? `error: ${settings.error}` : '',
          ...settings.sources.flatMap((source) => [
            `${skillSourceName(source, home)}${isRemovableSource(source) ? '' : ' (always there)'}: ${skillSourceDetail(source)}`,
            ...source.skills.map((skill) => `  ${skill.enabled ? 'on ' : 'off'}  ${skill.id}`),
          ]),
        ].filter(Boolean).join('\n'),
      };
    }),
    command(
      'assistant',
      'add-skill-folder',
      'Have OpenCode look for skills in a folder too, as Add folder does in Settings → Assistant (it’s added to “skills” in OpenCode’s config)',
      [{ name: 'folder', type: 'path', positional: true, help: 'The folder, which holds a folder with a SKILL.md for each skill' }],
      async (args, ctx) => {
        const path = args.string('folder');
        const ok = await ctx.confirm({
          title: 'Add this skills folder?',
          description: `OpenCode can load instructions from ${path}. Only add folders you trust.`,
          action: 'Add folder',
        });
        if (!ok) throw new CommandError('You didn’t allow it');
        const settings = await call(assistant().changeSkills({ op: 'addFolder', path }));
        return { data: settings };
      },
    ),
    command(
      'assistant',
      'remove-skill-folder',
      'Stop OpenCode looking for skills in a folder that was added, as Stop Using This Folder does in Settings → Assistant (asks on screen first); the folder and its skills stay where they are',
      [{ name: 'folder', type: 'string', positional: true, help: 'The folder, as din assistant skills names it or by its path' }],
      async (args, ctx) => {
        const bridge = assistant();
        const home = await getFsBridge()?.homedir().catch(() => undefined);
        const sources = (await call(bridge.skills())).sources.filter(isRemovableSource);
        const query = args.string('folder').replace(/(.)\/+$/, '$1');
        const source = pick(sources, query, (s) => [s.entry, s.path, skillSourceName(s, home)], 'added folder');
        const wording = removeSourceWording(source, home);
        const ok = await ctx.confirm({ title: wording.title, description: wording.description, action: wording.action, destructive: true });
        if (!ok) throw new CommandError('You didn’t allow it');
        const settings = await call(bridge.changeSkills({ op: 'removeFolder', entry: source.entry! }));
        return { data: settings };
      },
    ),
    command(
      'assistant',
      'enable-skill',
      'Turn skills back on, as their switches do in Settings → Assistant',
      [{ name: 'skill', type: 'string', positional: true, rest: true, help: 'Their ids (din assistant skills)' }],
      (args) => setSkillsEnabled(args.list('skill'), true),
    ),
    command(
      'assistant',
      'disable-skill',
      'Turn skills off: hidden from the agent, which can’t load them, in Din and in a Terminal’s opencode alike (a rule in OpenCode’s config; the files stay)',
      [{ name: 'skill', type: 'string', positional: true, rest: true, help: 'Their ids (din assistant skills)' }],
      (args) => setSkillsEnabled(args.list('skill'), false),
    ),
    command('assistant', 'restart', 'Restart OpenCode’s server, as Restart does in Settings → Assistant, stopping whatever the agent is doing', [], async () => {
      await call(assistant().restart());
    }),
  ],
};
