import { backgroundApp, getPeriodicSyncBridge, OUTCOME_LABELS, tagSummary, type BackgroundSite } from '@/lib/periodicSync';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din background`: what apps, installed nsites and installed web apps do
 * while they're closed (their periodic sync tags, electron/periodic-sync.mts),
 * as Settings → Background Activity shows them: the switch for all of them,
 * and each one paused, resumed, run now or removed. Removing asks on screen
 * first: a site has to ask the user again before it gets it back.
 */

const bridge = () => need(getPeriodicSyncBridge(), 'Background activity');
const APP: Param = { name: 'app', type: 'string', positional: true, help: 'Which app, by name or origin (as din background list shows them)' };

async function sites(ctx: CommandContext) {
  const status = await call(bridge().status());
  return { status, sites: status.sites.map((site) => ({ site, name: backgroundApp(site, ctx.apps).name })) };
}

async function find(ctx: CommandContext, query: string): Promise<{ site: BackgroundSite; name: string }> {
  const { sites: list } = await sites(ctx);
  if (!list.length) throw new CommandError('No app has anything scheduled');
  return pick(list, query, (s) => [s.site.origin, s.name], 'app');
}

export const backgroundArea: Area = {
  name: 'background',
  summary: 'What apps do on a schedule while they’re closed: list it, turn it all on or off, pause, resume, run now, remove',
  commands: [
    command('background', 'list', 'Every app with a schedule, its tags, and how their last runs went', [], async (_args, ctx) => {
      const { status, sites: list } = await sites(ctx);
      const head = status.enabled ? 'Apps may refresh in the background' : 'Background refresh is off for every app';
      return {
        data: { enabled: status.enabled, sites: list.map(({ site, name }) => ({ name, ...site })) },
        text: [
          head,
          ...list.map(({ site, name }) =>
            [
              `${name}  ${site.origin}${site.paused ? '  (paused)' : ''}${site.allowed ? '' : '  (not allowed)'}`,
              ...site.tags.map((t) => `  ${t.tag}: ${tagSummary(t, site, status.enabled)}`),
            ].join('\n'),
          ),
        ].join('\n'),
      };
    }),
    command('background', 'enabled', 'Whether apps may refresh in the background at all, as Settings’ switch says; with on or off, turn it on or off', [
      { name: 'state', type: 'string', positional: true, optional: true, help: 'on or off' },
    ], async (args) => {
      const state = args.optString('state');
      if (state !== undefined) {
        if (state !== 'on' && state !== 'off') throw new CommandError('Say on or off', 'usage');
        await call(bridge().setEnabled(state === 'on'));
      }
      const { enabled } = await call(bridge().status());
      return { data: { enabled }, text: enabled ? 'Apps may refresh in the background' : 'Background refresh is off for every app' };
    }),
    command('background', 'pause', 'Keep an app’s schedule without running it', [APP], async (args, ctx) => {
      const { site, name } = await find(ctx, args.string('app'));
      await call(bridge().setPaused(site.origin, true));
      return { data: { origin: site.origin, paused: true }, text: `Paused ${name}` };
    }),
    command('background', 'resume', 'Run a paused app’s schedule again', [APP], async (args, ctx) => {
      const { site, name } = await find(ctx, args.string('app'));
      await call(bridge().setPaused(site.origin, false));
      return { data: { origin: site.origin, paused: false }, text: `Resumed ${name}` };
    }),
    command('background', 'run', 'Wake an app’s worker now, for one tag or all of them, paused or not', [
      APP,
      { name: 'tag', type: 'string', optional: true, help: 'Just this tag' },
    ], async (args, ctx) => {
      const { site, name } = await find(ctx, args.string('app'));
      const outcomes = await call(bridge().run(site.origin, args.optString('tag')));
      return {
        data: outcomes,
        text: Object.entries(outcomes)
          .map(([tag, outcome]) => `${name} ${tag}: ${outcome ? OUTCOME_LABELS[outcome] : 'already running'}`)
          .join('\n'),
      };
    }),
    command('background', 'remove', 'Drop an app’s schedule, as Settings’ Remove does (asks on screen first)', [APP], async (args, ctx) => {
      const { site, name } = await find(ctx, args.string('app'));
      const ok = await ctx.confirm({
        title: `Remove ${name}’s schedule?`,
        description:
          site.kind === 'app'
            ? 'It stops waking up in the background. It can schedule itself again the next time it’s open.'
            : 'It stops waking up in the background, and has to ask again before it can.',
        action: 'Remove',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(bridge().remove(site.origin));
      return { data: { origin: site.origin, removed: true }, text: `Removed ${name}’s schedule` };
    }),
  ],
};
