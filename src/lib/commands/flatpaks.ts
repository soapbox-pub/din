import { nip19 } from 'nostr-tools';
import { installFlatpak, removeFlatpak } from '@/hooks/useNostrFlatpaks';
import {
  chosenFormat,
  fetchFlatpakApp,
  fetchFlatpakCatalog,
  flatpakNaddr,
  formatName,
  getFlatpaksBridge,
  installFormats,
  isOutdated,
  LINUX_FORMATS,
  parseAppNaddr,
  progressLabel,
  type FlatpaksBridge,
  type LinuxApp,
  type LinuxAppsStatus,
  type LinuxFormat,
} from '@/lib/nostrFlatpaks';
import { catalogAuthors } from './looks';
import { CommandError, type Command, type CommandContext } from './types';
import { call, command, need, pick } from './util';

/**
 * `din apps linux`, `install-linux`, `remove-linux`: the App Store's Linux
 * apps, NIP-82 apps with a Flatpak or an AppImage for this computer
 * (src/lib/nostrFlatpaks.ts), installed and removed by the same code as its
 * Get (and Get as …) and Remove.
 */

const bridge = () => need(getFlatpaksBridge(), 'Linux apps from Nostr');

async function statusOf(flatpaks: FlatpaksBridge): Promise<LinuxAppsStatus & { platform: string }> {
  const status = await call(flatpaks.status());
  if (!status.available || !status.platform) throw new CommandError('Linux apps from Nostr don’t install on this computer');
  return { ...status, platform: status.platform };
}

async function catalog(ctx: CommandContext, platform: string): Promise<LinuxApp[]> {
  return call(fetchFlatpakCatalog(await catalogAuthors(ctx), platform, (filters) => ctx.query(filters)));
}

/** An app by its address, or by its id or name among the store's. */
async function findApp(ctx: CommandContext, query: string, platform: string): Promise<LinuxApp> {
  const address = parseAppNaddr(query);
  if (address) {
    const app = await call(fetchFlatpakApp(address, platform, (filters) => ctx.query(filters)));
    if (!app) throw new CommandError('No Linux app with a Flatpak or an AppImage for this computer is published at that address on your relays');
    return app;
  }
  return pick(await catalog(ctx, platform), query, (a) => [a.identifier, a.name], 'Linux app');
}

export const flatpakCommands: Command[] = [
  command('apps', 'linux', 'The App Store’s Linux apps: NIP-82 apps on Nostr with a Flatpak or an AppImage for this computer, which are installed, and how', [
    { name: 'search', type: 'string', positional: true, optional: true, help: 'Words in its name or description' },
    { name: 'installed', type: 'boolean', optional: true, help: 'Only those installed from Nostr' },
  ], async (args, ctx) => {
    const flatpaks = bridge();
    const { platform, formats } = await statusOf(flatpaks);
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
          /** How it's installed, or would be by default. */
          as: chosenFormat(app, formats, here),
          /** Every way it installs here, the default first. */
          ways: installFormats(app, formats),
          update: !!here && isOutdated(here, app),
          size: app.assets[chosenFormat(app, formats, here)]?.size ?? null,
          address: flatpakNaddr(app),
          author: nip19.npubEncode(app.pubkey),
        };
      });
    // What's installed from an address the store doesn't list still shows under --installed.
    const listed = new Set(rows.map((row) => row.id));
    const others = installed.filter((app) => !listed.has(app.appId)).map((app) => {
      const [, pubkey, ...d] = app.coordinate.split(':');
      return {
        id: app.appId, name: app.appId, version: null, installed: app.version, as: app.format, ways: [] as LinuxFormat[], update: false, size: null,
        address: flatpakNaddr({ pubkey, identifier: d.join(':') }), author: nip19.npubEncode(pubkey),
      };
    });
    const all = [...rows, ...others];
    return { data: args.optBool('installed') ? all.filter((row) => row.installed !== null) : all };
  }),
  command('apps', 'install-linux', 'Install or update a Linux app from Nostr, as the App Store’s Get does: its Flatpak where it has one and Flatpak is here, else its AppImage, checked against its release (asks on screen first)', [
    { name: 'app', type: 'string', positional: true, help: 'Its naddr1… address, or its id or name (din apps linux)' },
    { name: 'as', type: 'string', optional: true, choices: [...LINUX_FORMATS], help: 'flatpak or appimage, as Get as … does (default: as Get does, or as it’s installed)' },
  ], async (args, ctx) => {
    const flatpaks = bridge();
    const { platform, formats } = await statusOf(flatpaks);
    const app = await findApp(ctx, args.string('app'), platform);
    const installed = (await call(flatpaks.installed())).find((a) => a.appId === app.identifier);
    const asked = args.optString('as') as LinuxFormat | undefined;
    const format = asked ?? chosenFormat(app, formats, installed);
    if (installed && installed.format !== format) {
      throw new CommandError(`${app.name} is installed as ${installed.format === 'appimage' ? 'an AppImage' : 'a Flatpak'}; remove it first (din apps remove-linux ${app.identifier})`);
    }
    if (!app.assets[format]) throw new CommandError(`${app.name} has no ${formatName(format)} for this computer`);
    if (!formats.includes(format)) throw new CommandError(`${formatName(format)}s don’t install on this computer`);
    if (installed && !isOutdated(installed, app)) return { text: `${app.name} ${installed.version} is already installed` };
    const author = nip19.npubEncode(app.pubkey);
    const ok = await ctx.confirm({
      title: installed ? `Update ${app.name}?` : `Install ${app.name}?`,
      description: `A command asked to ${installed ? 'update' : 'install'} the Linux app ${app.name} ${app.release.version} (${app.identifier}), published on Nostr by ${author.slice(0, 16)}…. It runs on this computer as ${format === 'appimage' ? 'an AppImage, outside Flatpak’s sandbox' : 'a Flatpak'}.`,
      action: installed ? 'Update' : 'Install',
    });
    if (!ok) throw new CommandError('You didn’t allow it');
    const done = await call(installFlatpak(app, format, (p) => ctx.progress?.({ text: progressLabel(p, !!installed), percent: p.percent })));
    return { data: done, text: `${installed ? 'Updated' : 'Installed'} ${app.name} ${done.version} (${done.appId})` };
  }),
  command('apps', 'remove-linux', 'Remove a Linux app installed from Nostr', [
    { name: 'app', type: 'string', positional: true, help: 'Its id (din apps linux --installed)' },
  ], async (args) => {
    const installed = await call(bridge().installed());
    const found = pick(installed, args.string('app'), (a) => [a.appId], 'Linux app installed from Nostr');
    await call(removeFlatpak(found.appId));
    return { text: `Removed ${found.appId}` };
  }),
];
