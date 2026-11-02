import { nip19 } from 'nostr-tools';
import { getEffectiveBlossomServers } from '@/lib/appBlossom';
import { getIconThemeBridge } from '@/lib/iconTheme';
import { NSITE_CATALOG_PUBKEYS } from '@/lib/nsiteCatalog';
import { installedSkins } from '@/lib/skinPackages';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import {
  applyTheme,
  fetchPackageCatalog,
  fetchThemePackage,
  installThemePackage,
  packageCoordinate,
  packageNaddr,
  parsePackageNaddr,
  publishThemePackage,
  removeTheme,
  type PackageType,
  type ThemePackage,
} from '@/lib/themePackages';
import { CommandError, type Area, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din cursors`, `din icons` and `din skins`: Settings → Cursors' and Icons'
 * themes, the Media Player's skins, and the App Store's Cursors, Icons and
 * Skins, where they're published to Nostr and got from it
 * (src/lib/themePackages.ts).
 */

const cursors = () => need(getSystemCursorBridge(), 'Cursor themes');
const icons = () => need(getIconThemeBridge(), 'Icon themes');

const THEME: Param = { name: 'theme', type: 'string', positional: true, help: 'Its id or name (din {area} list)' };
const ADDRESS: Param = { name: 'address', type: 'string', positional: true, help: 'Its naddr1… address' };

/** The installed themes of a type: id, name, whether in use, removable, and where from. */
interface InstalledRow {
  id: string;
  name: string;
  removable: boolean;
  from: string | null;
  inUse?: boolean;
  format?: string;
}

async function installed(type: PackageType): Promise<InstalledRow[]> {
  if (type === 'skin') {
    // Which skin the Media Player wears is its own; Din's built-in skins aren't files.
    return (await call(installedSkins())).map((skin) => ({
      id: skin.id,
      name: skin.name,
      format: skin.format,
      removable: true,
      from: skin.source ? naddrOf(type, skin.source.coordinate) : null,
    }));
  }
  const [published, rows] = type === 'cursor'
    ? await Promise.all([
        call(cursors().published()),
        call(Promise.all([cursors().themes(), cursors().status()])).then(([themes, status]) =>
          themes.map((t) => ({ id: t.id, name: t.name, inUse: t.id === status.theme, removable: t.imported }))),
      ])
    : await Promise.all([
        call(icons().published()),
        call(Promise.all([icons().themes(), icons().status()])).then(([themes, status]) =>
          themes.map((t) => ({ id: t.id, name: t.name, inUse: t.id === status.theme, removable: t.imported }))),
      ]);
  // Settings leaves out icon themes that don't restyle Din's apps; one got from Nostr is still listed.
  for (const { id } of published) {
    if (!rows.some((row) => row.id === id)) rows.push({ id, name: id, inUse: false, removable: true });
  }
  return rows.map((row) => {
    const source = published.find((p) => p.id === row.id)?.source;
    return { ...row, from: source ? naddrOf(type, source.coordinate) : null };
  });
}

function naddrOf(type: PackageType, coordinate: string): string {
  const [, pubkey, ...d] = coordinate.split(':');
  return packageNaddr({ type, pubkey, identifier: d.join(':') });
}

const NOUN: Record<PackageType, string> = { cursor: 'cursor theme', icon: 'icon theme', skin: 'Media Player skin' };

/** Who the App Store lists themes by: Din's publishers, the user, and the people they follow. */
async function catalogAuthors(ctx: CommandContext): Promise<string[]> {
  const authors = new Set(NSITE_CATALOG_PUBKEYS);
  if (ctx.pubkey) {
    authors.add(ctx.pubkey);
    const [follows] = (await ctx.query([{ kinds: [3], authors: [ctx.pubkey], limit: 1 }])).filter((e) => e.pubkey === ctx.pubkey);
    for (const [name, value] of follows?.tags ?? []) if (name === 'p' && value) authors.add(value);
  }
  return [...authors];
}

function packageRow(pkg: ThemePackage) {
  return { address: packageNaddr(pkg), title: pkg.title, summary: pkg.summary, author: nip19.npubEncode(pkg.pubkey), size: pkg.size, updated: pkg.createdAt };
}

function looksArea(type: PackageType, name: 'cursors' | 'icons' | 'skins'): Area {
  const noun = NOUN[type];
  const theme: Param = { ...THEME, help: THEME.help.replace('{area}', name) };
  const pickTheme = async (query: string) => pick(await installed(type), query, (t) => [t.id, t.name], noun);

  return {
    name,
    summary: `${type === 'cursor' ? 'Cursor themes' : type === 'icon' ? 'Icon themes' : 'Media Player skins'}: list, use, publish to Nostr, find and install from the App Store, remove`,
    commands: [
      command(name, 'list', `The installed ${noun}s`, [], async () => ({ data: await installed(type) })),
      command(name, 'use', type === 'skin' ? 'Open the Media Player wearing a skin' : `Use an installed ${noun}`, [
        theme,
        ...(type === 'cursor' ? [{ name: 'size', type: 'integer', optional: true, help: 'The size, in pixels (24, 32, 40, 48, 64 or 96)' } satisfies Param] : []),
      ], async (args, ctx) => {
        const found = await pickTheme(args.string('theme'));
        await call(applyTheme(type, found.id, { size: args.optNumber('size'), open: (app, params) => ctx.actions.open(app, params) }));
        return { text: `Using ${found.name}` };
      }),
      command(name, 'store', `The ${noun}s in the App Store, from Din’s publishers and the people you follow`, [
        { name: 'search', type: 'string', positional: true, optional: true, help: 'Words in its name or description' },
      ], async (args, ctx) => {
        const q = args.optString('search')?.toLowerCase();
        const found = (await fetchPackageCatalog(type, await catalogAuthors(ctx), ctx.query))
          .filter((pkg) => !q || `${pkg.title}\u0000${pkg.summary}\u0000${pkg.identifier}`.toLowerCase().includes(q));
        return { data: found.map(packageRow) };
      }),
      command(name, 'install', `Download a published ${noun} and use it, as Get does in the App Store`, [ADDRESS], async (args, ctx) => {
        const address = parsePackageNaddr(args.string('address'), type);
        if (!address) throw new CommandError(`Not a ${noun}’s address: ${args.string('address')}`, 'usage');
        const pkg = await fetchThemePackage(address, ctx.query);
        if (!pkg) throw new CommandError(`No ${noun} is published at that address on your relays`);
        const id = await call(installThemePackage(pkg, { query: ctx.query, progress: (text) => ctx.progress?.({ text }) }));
        await call(applyTheme(type, id, { open: (app, params) => ctx.actions.open(app, params) }));
        return { data: { id, address: packageNaddr(pkg), coordinate: packageCoordinate(pkg) }, text: `Installed ${pkg.title} as ${id}, and using it` };
      }),
      command(name, 'publish', `Publish an installed ${noun} to Nostr, for the App Store (asks on screen first)`, [
        theme,
        { name: 'title', type: 'string', optional: true, help: 'What to call it (default: its name)' },
        { name: 'summary', type: 'string', optional: true, help: 'A description' },
      ], async (args, ctx) => {
        if (!ctx.pubkey) throw new CommandError('No one is signed in');
        const found = await pickTheme(args.string('theme'));
        const title = args.optString('title') ?? found.name;
        const ok = await ctx.confirm({
          title: `Publish ${title} to Nostr?`,
          description: `A command asked to publish your ${noun} ${found.name} to Nostr, signed by you, for anyone to get.`,
          action: 'Publish',
        });
        if (!ok) throw new CommandError('You didn’t allow it');
        const servers = getEffectiveBlossomServers(ctx.config.blossomServerMetadata, ctx.config.useAppBlossomServers);
        const identifier = await call(publishThemePackage(type, found.id, { title, summary: args.optString('summary') }, {
          upload: (file) => ctx.upload(file),
          publish: (template) => ctx.publish(template),
          servers,
          progress: (text, percent) => ctx.progress?.({ text, percent }),
        }));
        const address = packageNaddr({ type, pubkey: ctx.pubkey, identifier });
        return { data: { address }, text: address };
      }),
      command(name, 'remove', type === 'skin' ? 'Move a skin to the trash, as the Media Player’s Delete Skin does' : `Delete a ${noun} Din installed`, [theme], async (args) => {
        const found = await pickTheme(args.string('theme'));
        if (!found.removable) throw new CommandError(`${found.name} wasn’t installed by Din, so it stays`);
        await call(removeTheme(type, found.id));
        return { text: `Removed ${found.name}` };
      }),
    ],
  };
}

export const cursorsArea = looksArea('cursor', 'cursors');
export const iconsArea = looksArea('icon', 'icons');
export const skinsArea = looksArea('skin', 'skins');
