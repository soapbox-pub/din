import { getNotificationState, stopNotificationTask } from '@/lib/notificationCenter';
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

/** Apps' running tasks: their ongoing notifications, as the notification center lists them under Running. */
function runningTasks(ctx: CommandContext) {
  return getNotificationState()
    .notifications.filter((n) => n.ongoing)
    .map((n) => ({ notification: n, name: (n.source.appId && ctx.apps.getApp(n.source.appId)?.name) || n.source.name }));
}

export const backgroundArea: Area = {
  name: 'background',
  summary: 'What apps do while they’re closed: tasks running now (list, stop), and schedules (list, turn it all on or off, pause, resume, run now, remove)',
  commands: [
    command('background', 'running', 'Tasks apps are running now, each kept going by its notification', [], (_args, ctx) => {
      const tasks = runningTasks(ctx);
      return {
        data: tasks.map(({ notification: n, name }) => ({
          id: n.id, app: name, appId: n.source.appId ?? null, title: n.title, body: n.body, progress: n.progress ?? null, since: n.createdAt,
        })),
        text: tasks.length
          ? tasks
              .map(({ notification: n, name }) =>
                `${name}: ${n.title}${n.body ? ` · ${n.body}` : ''}${typeof n.progress === 'number' ? ` (${Math.round(n.progress * 100)}%)` : ''}  [${n.id}]`,
              )
              .join('\n')
          : 'No app is running a task',
      };
    }),
    command('background', 'stop', 'Stop a running task, as its Stop button does', [
      { name: 'task', type: 'string', positional: true, help: 'Which one, by its app’s name or the id din background running shows' },
    ], (args, ctx) => {
      const tasks = runningTasks(ctx);
      if (!tasks.length) throw new CommandError('No app is running a task');
      const { notification, name } = pick(tasks, args.string('task'), (t) => [t.notification.id, t.name, t.notification.source.appId ?? ''], 'task');
      stopNotificationTask(notification.id);
      return { data: { id: notification.id, stopped: true }, text: `Stopped ${name}’s ${notification.title}` };
    }),
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
