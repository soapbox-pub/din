import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import { getCrxBridge, type CrxExtension } from '@/lib/crx';
import { extensionCatalog, syncExtensionCatalog } from '@/lib/extensionCatalog';
import {
  fetchThemePackage,
  installThemePackage,
  packageCoordinate,
  packageNaddr,
  parsePackageNaddr,
  publishThemePackage,
  removeTheme,
} from '@/lib/themePackages';
import { catalogAuthors, packageRow } from './looks';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din extensions`: the Web Browser's extensions, as its Settings page and
 * about:extensions have them: installed from the Chrome Web Store, loaded
 * from a folder, or got from Nostr (NIP-82 apps with a .crx, src/lib/extensionCatalog.ts).
 */

const crx = () => need(getCrxBridge(), 'Browser extensions');

const EXTENSION: Param = { name: 'extension', type: 'string', positional: true, help: 'Its id or name (din extensions list)' };

function naddrOf(coordinate: string): string {
  const [, pubkey, ...d] = coordinate.split(':');
  return packageNaddr({ type: 'extension', pubkey, identifier: d.join(':') });
}

async function installed(): Promise<CrxExtension[]> {
  return call(crx().listExtensions());
}

async function pickExtension(query: string): Promise<CrxExtension> {
  return pick(await installed(), query, (e) => [e.id, e.name], 'extension');
}

export const extensionsArea: Area = {
  name: 'extensions',
  summary: 'Web Browser extensions: list, load from a folder, reload, publish to Nostr, find and install from about:extensions, remove',
  commands: [
    command('extensions', 'list', 'The installed extensions, and where each came from', [], async () => ({
      data: (await installed()).map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        source: e.source,
        path: e.path ?? null,
        from: e.coordinate ? naddrOf(e.coordinate) : null,
      })),
    })),
    command('extensions', 'load', 'Load an extension from a folder, and keep loading it from there (asks on screen first)', [
      { name: 'folder', type: 'path', positional: true, help: 'The folder holding its manifest.json' },
    ], async (args, ctx) => {
      const folder = args.string('folder');
      const ok = await ctx.confirm({
        title: 'Load this extension?',
        description: `A command asked to load the extension in ${folder} into the Web Browser, where it runs on the sites you browse.`,
        action: 'Load',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const extension = await call(crx().loadUnpacked(folder));
      return { data: extension, text: `Loaded ${extension.name} (${extension.id})` };
    }),
    command('extensions', 'reload', 'Load an installed extension again from its files, as after editing them', [EXTENSION], async (args) => {
      const found = await pickExtension(args.string('extension'));
      await call(crx().reloadExtension(found.id));
      return { text: `Reloaded ${found.name}` };
    }),
    command('extensions', 'store', 'The extensions on about:extensions, from Din’s publishers and the people you follow', [
      { name: 'search', type: 'string', positional: true, optional: true, help: 'Words in its name or description' },
    ], async (args, ctx) => {
      const q = args.optString('search')?.toLowerCase();
      const authors = await catalogAuthors(ctx);
      await call(syncExtensionCatalog((filters) => ctx.query(filters), authors));
      const found = extensionCatalog(authors)
        .filter((pkg) => !q || `${pkg.title}\u0000${pkg.summary}\u0000${pkg.identifier}`.toLowerCase().includes(q));
      return { data: found.map((pkg) => ({ ...packageRow(pkg), version: pkg.version })) };
    }),
    command('extensions', 'install', 'Download a published extension and add it, as Get does on about:extensions (asks on screen first)', [
      { name: 'address', type: 'string', positional: true, help: 'Its naddr1… address' },
    ], async (args, ctx) => {
      const address = parsePackageNaddr(args.string('address'), 'extension');
      if (!address) throw new CommandError(`Not an extension’s address: ${args.string('address')}`, 'usage');
      const pkg = await fetchThemePackage(address, ctx.query);
      if (!pkg) throw new CommandError('No extension is published at that address on your relays');
      // Installing shows what it can do on screen and waits for the user's yes.
      const id = await call(installThemePackage(pkg, { query: ctx.query, progress: (text) => ctx.progress?.({ text }) }));
      return { data: { id, address: packageNaddr(pkg), coordinate: packageCoordinate(pkg) }, text: `Installed ${pkg.title} (${id})` };
    }),
    command('extensions', 'publish', 'Publish an installed extension to Nostr, for about:extensions (asks on screen first)', [
      EXTENSION,
      { name: 'title', type: 'string', optional: true, help: 'What to call it (default: its name)' },
      { name: 'summary', type: 'string', optional: true, help: 'A description (default: its own)' },
    ], async (args, ctx) => {
      if (!ctx.pubkey) throw new CommandError('No one is signed in');
      const found = await pickExtension(args.string('extension'));
      const title = args.optString('title') ?? found.name;
      const ok = await ctx.confirm({
        title: `Publish ${title} to Nostr?`,
        description: `A command asked to publish the extension ${found.name} to Nostr, signed by you, for anyone to get.`,
        action: 'Publish',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const servers = getEffectiveBlossomServers(ctx.config.blossomServerMetadata, ctx.config.useAppBlossomServers);
      const identifier = await call(publishThemePackage('extension', found.id, { title, summary: args.optString('summary') ?? (found.description || undefined) }, {
        upload: (file) => ctx.upload(file),
        publish: (template) => ctx.publish(template),
        servers,
        progress: (text, percent) => ctx.progress?.({ text, percent }),
        pubkey: ctx.pubkey,
        extensionKeys: ctx.extensionKeys,
      }));
      const address = packageNaddr({ type: 'extension', pubkey: ctx.pubkey, identifier });
      return { data: { address }, text: address };
    }),
    command('extensions', 'remove', 'Remove an installed extension (one loaded from a folder is only forgotten; the folder stays)', [EXTENSION], async (args) => {
      const found = await pickExtension(args.string('extension'));
      await call(removeTheme('extension', found.id));
      return { text: `Removed ${found.name}` };
    }),
  ],
};
