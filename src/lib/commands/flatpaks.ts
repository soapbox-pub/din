import { nip19 } from 'nostr-tools';
import { installFlatpak, removeFlatpak } from '@/hooks/useNostrFlatpaks';
import {
  fetchFlatpakApp,
  fetchFlatpakCatalog,
  flatpakNaddr,
  getFlatpaksBridge,
  isOutdated,
  parseAppNaddr,
  progressLabel,
  type FlatpakApp,
  type FlatpaksBridge,
} from '@/lib/nostrFlatpaks';
import { catalogAuthors } from './looks';
import { CommandError, type Command, type CommandContext } from './types';
import { call, command, need, pick } from './util';

/**
 * `din apps linux`, `install-linux`, `remove-linux`: the App Store's Linux
 * apps, NIP-82 apps with a Flatpak for this computer (src/lib/nostrFlatpaks.ts),
 * installed and removed by the same code as its Get and Remove.
 */

const bridge = () => need(getFlatpaksBridge(), 'Linux apps from Nostr');

async function platformOf(flatpaks: FlatpaksBridge): Promise<string> {
  const status = await call(flatpaks.status());
  if (!status.available || !status.platform) throw new CommandError('Flatpak isn’t available on this computer');
  return status.platform;
}

async function catalog(ctx: CommandContext, platform: string): Promise<FlatpakApp[]> {
  return call(fetchFlatpakCatalog(await catalogAuthors(ctx), platform, (filters) => ctx.query(filters)));
}

/** An app by its address, or by its id or name among the store's. */
async function findApp(ctx: CommandContext, query: string, platform: string): Promise<FlatpakApp> {
  const address = parseAppNaddr(query);
  if (address) {
    const app = await call(fetchFlatpakApp(address, platform, (filters) => ctx.query(filters)));
    if (!app) throw new CommandError('No Linux app with a Flatpak for this computer is published at that address on your relays');
    return app;
  }
  return pick(await catalog(ctx, platform), query, (a) => [a.identifier, a.name], 'Linux app');
}

export const flatpakCommands: Command[] = [
  command('apps', 'linux', 'The App Store’s Linux apps: NIP-82 apps on Nostr with a Flatpak for this computer, and which are installed', [
    { name: 'search', type: 'string', positional: true, optional: true, help: 'Words in its name or description' },
    { name: 'installed', type: 'boolean', optional: true, help: 'Only those installed from Nostr' },
  ], async (args, ctx) => {
    const flatpaks = bridge();
    const platform = await platformOf(flatpaks);
    const [apps, installed] = await Promise.all([catalog(ctx, platform), call(flatpaks.installed())]);
    const byId = new Map(installed.map((app) => [app.appId, app]));
    const q = args.optString('search')?.toLowerCase();
    const rows = apps
      .filter((app) => !q || `${app.name}\u0000${app.summary}\u0000${app.identifier}`.toLowerCase().includes(q))
      .map((app) => {
        const here = byId.get(app.identifier);
        return {
          id: app.identifier,
          name: app.name,
          version: app.release.version,
          installed: here?.version ?? null,
          update: !!here && isOutdated(here, app),
          size: app.asset.size,
          address: flatpakNaddr(app),
          author: nip19.npubEncode(app.pubkey),
        };
      });
    // What's installed from an address the store doesn't list still shows under --installed.
    const listed = new Set(rows.map((row) => row.id));
    const others = installed.filter((app) => !listed.has(app.appId)).map((app) => {
      const [, pubkey, ...d] = app.coordinate.split(':');
      return {
        id: app.appId, name: app.appId, version: null, installed: app.version, update: false, size: null,
        address: flatpakNaddr({ pubkey, identifier: d.join(':') }), author: nip19.npubEncode(pubkey),
      };
    });
    const all = [...rows, ...others];
    return { data: args.optBool('installed') ? all.filter((row) => row.installed !== null) : all };
  }),
  command('apps', 'install-linux', 'Install or update a Linux app from Nostr, as the App Store’s Get does: its Flatpak, checked against its release (asks on screen first)', [
    { name: 'app', type: 'string', positional: true, help: 'Its naddr1… address, or its Flatpak id or name (din apps linux)' },
  ], async (args, ctx) => {
    const flatpaks = bridge();
    const platform = await platformOf(flatpaks);
    const app = await findApp(ctx, args.string('app'), platform);
    const installed = (await call(flatpaks.installed())).find((a) => a.appId === app.identifier);
    if (installed && !isOutdated(installed, app)) return { text: `${app.name} ${installed.version} is already installed` };
    const author = nip19.npubEncode(app.pubkey);
    const ok = await ctx.confirm({
      title: installed ? `Update ${app.name}?` : `Install ${app.name}?`,
      description: `A command asked to ${installed ? 'update' : 'install'} the Linux app ${app.name} ${app.release.version} (${app.identifier}), published on Nostr by ${author.slice(0, 16)}…. It runs on this computer as a Flatpak.`,
      action: installed ? 'Update' : 'Install',
    });
    if (!ok) throw new CommandError('You didn’t allow it');
    const done = await call(installFlatpak(app, (p) => ctx.progress?.({ text: progressLabel(p, !!installed), percent: p.percent })));
    return { data: done, text: `${installed ? 'Updated' : 'Installed'} ${app.name} ${done.version} (${done.appId})` };
  }),
  command('apps', 'remove-linux', 'Remove a Linux app installed from Nostr', [
    { name: 'app', type: 'string', positional: true, help: 'Its Flatpak id (din apps linux --installed)' },
  ], async (args) => {
    const installed = await call(bridge().installed());
    const found = pick(installed, args.string('app'), (a) => [a.appId], 'Linux app installed from Nostr');
    await call(removeFlatpak(found.appId));
    return { text: `Removed ${found.appId}` };
  }),
];
