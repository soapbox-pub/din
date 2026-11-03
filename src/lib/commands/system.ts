import { nip19 } from 'nostr-tools';
import { getEraseBridge } from '@/lib/erase';
import { getFirmwareBridge } from '@/lib/firmware';
import { getLockBridge } from '@/lib/lock';
import { blossomListTags, normalizeBlossomUrl, normalizeRelayUrl, relayListTags } from '@/lib/relayLists';
import { getUpdaterBridge, shortRevision, UPDATE_STEP_LABELS } from '@/lib/updater';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { bare, call, command, need } from './util';

/** `din update`, `din firmware`, `din lock`, `din nostr`: Settings → About, Password and Nostr & Storage. */

const updater = () => need(getUpdaterBridge(), 'DinOS updates');
const firmware = () => need(getFirmwareBridge(), 'Firmware updates');
const ON: Param = { name: 'on', type: 'boolean', positional: true, help: 'on or off' };
/** How long a command waits after answering before Din restarts. */
const RESTART_DELAY_MS = 1_000;

/** Restart Din once the answer's on its way: the restart ends whatever ran the command. */
function restartDinSoon(bridge = updater()) {
  setTimeout(() => void bridge.restartDin().catch(() => {}), RESTART_DELAY_MS);
}

export const updateArea: Area = {
  name: 'update',
  summary: 'DinOS updates: status, check, apply, your own builds, restarting Din, where they come from, erasing the computer',
  commands: [
    command('update', 'status', 'The running system, and any update in the works', [], async () => {
      const state = await call(updater().state());
      if (!state.available) return { data: state, text: 'Updates aren’t available here' };
      return {
        data: state,
        text: [
          `version: ${state.version ?? '?'} (${state.current ? shortRevision(state.current) : '?'})`,
          `source: ${state.url} ${state.branch}${state.custom ? `, with ${state.changes ?? 'some'} changes of yours` : ''}`,
          `automatic: ${state.auto ? 'on' : 'off'}`,
          state.phase === 'updating' ? `updating to ${shortRevision(state.updatingTo ?? '')}: ${state.step ? UPDATE_STEP_LABELS[state.step] : ''} ${state.percent}%` : `state: ${state.phase}`,
          state.staged ? `staged: ${shortRevision(state.staged)}${state.stagedNeeds ? ` (needs ${state.stagedNeeds === 'din' ? 'Din to restart' : 'the computer to restart'})` : ''}` : '',
          state.restart ? `waiting on: ${state.restart === 'din' ? 'Restart Din' : 'a restart'}` : '',
          state.error ? `error: ${state.error}` : '',
        ].filter(Boolean).join('\n'),
      };
    }),
    command('update', 'check', 'Look for an update now, and build and stage it', [], async () => {
      await call(updater().check());
    }),
    command('update', 'apply', 'Switch to the staged update now, where that needs no restart', [], async () => {
      await call(updater().apply());
    }),
    command('update', 'local', 'Build your own commits in ~/DinOS and switch to them, restarting Din if it changed (sudo asks you first)', [
      { name: 'ref', type: 'string', positional: true, optional: true, help: 'The branch or commit (default: main)' },
      { name: 'restart', type: 'boolean', optional: true, help: 'Restart Din if it changed (default: on; --no-restart leaves that to din update restart)' },
    ], async (args, ctx) => {
      const bridge = updater();
      const ref = args.optString('ref') ?? 'main';
      ctx.progress?.({ text: `Starting ${ref}` });
      // The build's own steps, then the switch to it once the service is done.
      let built = false;
      const stop = bridge.onProgress((state) => {
        if (state.phase === 'updating' && state.step) {
          built = true;
          const what = `${UPDATE_STEP_LABELS[state.step]} ${state.updatingTo ? shortRevision(state.updatingTo) : ref}`;
          ctx.progress?.(state.step === 'build' ? { text: what, percent: state.percent } : { text: what });
        } else if (built && state.phase === 'idle') {
          ctx.progress?.({ text: 'Switching to it' });
        }
      });
      const { commit, restart } = await call(bridge.buildLocal(ref, ctx.session)).finally(stop);
      const done = `Built commit ${shortRevision(commit)}`;
      const data = { commit, restart };
      if (restart === 'reboot') return { data, text: `${done}. It starts when the computer restarts.` };
      if (restart !== 'din') return { data, text: `${done}. It's live.` };
      if (args.optBool('restart') === false) return { data, text: `${done}. It starts when Din restarts (din update restart).` };
      restartDinSoon(bridge);
      return { data, text: `${done}. Din is restarting.` };
    }),
    command('update', 'restart', 'Restart Din, closing every app, as Restart Din does (asks on screen first)', [], async (_args, ctx) => {
      const bridge = updater();
      if (!(await ctx.confirm({ title: 'Restart Din?', description: 'A command asked to restart Din. Every app closes.', action: 'Restart Din', destructive: true }))) {
        throw new CommandError('You didn’t allow it');
      }
      restartDinSoon(bridge);
      return { text: 'Din is restarting.' };
    }),
    command('update', 'auto', 'Whether DinOS updates by itself', [ON], async (args) => {
      await call(updater().setAuto(args.bool('on')));
    }),
    command('update', 'source', 'Build updates from another repository or branch (sudo asks you first)', [
      { name: 'url', type: 'string', positional: true, help: 'The repository' },
      { name: 'branch', type: 'string', positional: true, optional: true, help: 'Its branch (default: main)' },
    ], async (args) => {
      await call(updater().setSource(args.string('url'), args.optString('branch') ?? 'main'));
    }),
    command('update', 'erase', 'Erase all data and settings, back to official DinOS: opens Settings → About to confirm, with the password', [], async (_args, ctx) => {
      const status = await call(need(getEraseBridge(), 'Erasing').status());
      if (!status.available) throw new CommandError('This computer can’t be erased from Din');
      ctx.actions.open('settings', { section: 'about', erase: Date.now() });
      return { text: 'Settings asks you to confirm.' };
    }),
  ],
};

export const firmwareArea: Area = {
  name: 'firmware',
  summary: 'Firmware updates for this computer’s devices',
  commands: [
    command('firmware', 'status', 'Updates found, and any being installed', [], async () => ({ data: await call(firmware().state()) })),
    command('firmware', 'check', 'Look for firmware updates', [], async () => {
      await call(firmware().check());
      return { data: (await call(firmware().state())).updates };
    }),
    command('firmware', 'install', 'Install a device’s newest firmware (asks on screen first)', [
      { name: 'device', type: 'string', positional: true, help: 'Its device id, from din firmware status' },
    ], async (args, ctx) => {
      const state = await call(firmware().state());
      const update = state.updates.find((u) => u.deviceId === args.string('device'));
      if (!update) throw new CommandError(`No update for ${args.string('device')}`);
      const ok = await ctx.confirm({
        title: `Update ${update.name}?`,
        description: `A command asked to install ${update.name} ${update.version}${update.needsRestart ? ', applied when the computer restarts' : ''}.`,
        action: 'Install',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(firmware().install(update.deviceId));
    }),
  ],
};

export const lockArea: Area = {
  name: 'lock',
  summary: 'Lock the screen',
  commands: [
    bare(command('lock', 'now', 'Lock the screen', [], async () => {
      const bridge = need(getLockBridge(), 'Locking');
      if (!(await call(bridge.available()))) throw new CommandError('The screen can’t lock here');
      await call(bridge.lock());
    })),
  ],
};

function requireUser(ctx: CommandContext): string {
  if (!ctx.pubkey) throw new CommandError('No one is signed in');
  return ctx.pubkey;
}

const URL_PARAM: Param = { name: 'url', type: 'string', positional: true, help: 'Its URL' };

function saveRelays(ctx: CommandContext, relays: CommandContext['config']['relayMetadata']['relays']) {
  ctx.updateConfig((current) => ({ ...current, relayMetadata: { relays, updatedAt: Math.floor(Date.now() / 1000) } }));
  if (ctx.pubkey) return ctx.publish({ kind: 10002, content: '', tags: relayListTags(relays) });
}

function saveServers(ctx: CommandContext, servers: string[]) {
  ctx.updateConfig((current) => ({ ...current, blossomServerMetadata: { servers, updatedAt: Math.floor(Date.now() / 1000) } }));
  if (ctx.pubkey) return ctx.publish({ kind: 10063, content: '', tags: blossomListTags(servers) });
}

export const nostrArea: Area = {
  name: 'nostr',
  summary: 'Your Nostr account, relays and Blossom servers',
  commands: [
    command('nostr', 'whoami', 'Who is signed in', [], (_args, ctx) => {
      const pubkey = requireUser(ctx);
      const npub = nip19.npubEncode(pubkey);
      return { data: { pubkey, npub }, text: npub };
    }),
    command('nostr', 'relays', 'Your relays (NIP-65)', [], (_args, ctx) => ({ data: ctx.config.relayMetadata.relays })),
    command('nostr', 'relay-add', 'Add a relay, and publish the list', [
      URL_PARAM,
      { name: 'read', type: 'boolean', optional: true, help: 'Read from it (default: on)' },
      { name: 'write', type: 'boolean', optional: true, help: 'Write to it (default: on)' },
    ], async (args, ctx) => {
      const url = normalizeRelayUrl(args.string('url'));
      if (!/^wss?:\/\//.test(url)) throw new CommandError(`Not a relay URL: ${args.string('url')}`, 'usage');
      const relays = ctx.config.relayMetadata.relays.filter((r) => r.url !== url);
      await saveRelays(ctx, [...relays, { url, read: args.optBool('read') ?? true, write: args.optBool('write') ?? true }]);
    }),
    command('nostr', 'relay-remove', 'Remove a relay, and publish the list', [URL_PARAM], async (args, ctx) => {
      const url = normalizeRelayUrl(args.string('url'));
      const relays = ctx.config.relayMetadata.relays;
      if (!relays.some((r) => r.url === url)) throw new CommandError(`${url} isn’t one of your relays`);
      await saveRelays(ctx, relays.filter((r) => r.url !== url));
    }),
    command('nostr', 'blossom', 'Your Blossom servers (BUD-03)', [], (_args, ctx) => ({ data: ctx.config.blossomServerMetadata.servers })),
    command('nostr', 'blossom-add', 'Add a Blossom server, and publish the list', [URL_PARAM], async (args, ctx) => {
      const url = normalizeBlossomUrl(args.string('url'));
      if (!url) throw new CommandError(`Not a server URL: ${args.string('url')}`, 'usage');
      const servers = ctx.config.blossomServerMetadata.servers.filter((s) => s !== url);
      await saveServers(ctx, [...servers, url]);
    }),
    command('nostr', 'blossom-remove', 'Remove a Blossom server, and publish the list', [URL_PARAM], async (args, ctx) => {
      const url = normalizeBlossomUrl(args.string('url'));
      const servers = ctx.config.blossomServerMetadata.servers;
      if (!url || !servers.includes(url)) throw new CommandError(`${args.string('url')} isn’t one of your servers`);
      await saveServers(ctx, servers.filter((s) => s !== url));
    }),
  ],
};
