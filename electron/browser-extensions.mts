// Browser extensions beyond the Chrome Web Store's: ones loaded from a folder
// on this computer, and ones published to Nostr (NIP.md, kind 34639) and
// installed from there.
//
// The Web Store's own installs live in Extensions/ (electron-chrome-web-store
// loads them, see setupChromeExtensions in main.mts). Folders the user loads
// are remembered by path in local-extensions.json and loaded where they are,
// so editing one and pressing Reload is the whole development loop. Ones from
// Nostr are unpacked into NostrExtensions/<dir>, with NostrExtensions/
// .nostr.json recording, by directory, the coordinate and created_at each
// came from, for Update and Remove. An unpacked extension's id comes from its
// manifest's `key` when it has one (as the Web Store's do), else from its
// path, so updating one in place keeps its id, and with it its storage.
//
// Any installed extension can be exported for publishing: its directory as a
// gzipped tarball, and its icon.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { uninstallExtension } from 'electron-chrome-web-store';
import {
  checkPackageBase,
  fetchBlobs,
  isSha256,
  PackageError,
  packTarGz,
  safeRelative,
  unpackTarGz,
  type TarEntry,
} from './themePackages.mts';

/** A published browser extension's kind (NIP.md). */
const EXTENSION_KIND = 34639;

const EXTENSION_ID = /^[a-p]{32}$/;

/** What an installed extension is, as the browser's pages list it. */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Where it came from: the Chrome Web Store, a folder here, or Nostr. */
  source: 'webstore' | 'local' | 'nostr';
  /** The folder it was loaded from, for one loaded from a folder. */
  path?: string;
  /** The `<kind>:<pubkey>:<d>` it was installed from, for one from Nostr. */
  coordinate?: string;
}

/** An installed extension made ready to publish. */
export interface ExtensionExport {
  /** What its `d` tag should be: the one it was installed under, its Web Store id, or its name made a slug. */
  identifier: string;
  name: string;
  version: string;
  description: string;
  manifestVersion: number | null;
  permissions: string[];
  hosts: string[];
  archive: Uint8Array;
  icon: { name: string; mime: string; data: Uint8Array } | null;
}

interface PublishedSource {
  coordinate: string;
  publishedAt: number;
}

type Manifest = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------

function localListFile(): string {
  return path.join(app.getPath('userData'), 'local-extensions.json');
}

function nostrBase(): string {
  return path.join(app.getPath('userData'), 'NostrExtensions');
}

function sourcesFile(): string {
  return path.join(nostrBase(), '.nostr.json');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2));
  await fsp.rename(temp, file);
}

async function localFolders(): Promise<string[]> {
  const list = await readJson<unknown>(localListFile(), []);
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
}

async function setLocalFolders(folders: string[]): Promise<void> {
  await writeJson(localListFile(), [...new Set(folders)]);
}

async function nostrSources(): Promise<Record<string, PublishedSource>> {
  const sources = await readJson<unknown>(sourcesFile(), {});
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return {};
  const out: Record<string, PublishedSource> = {};
  for (const [dir, value] of Object.entries(sources as Record<string, unknown>)) {
    const { coordinate, publishedAt } = (value ?? {}) as Record<string, unknown>;
    if (typeof coordinate === 'string' && typeof publishedAt === 'number') out[dir] = { coordinate, publishedAt };
  }
  return out;
}

/** The NostrExtensions directory an extension at `dir` is in, or null when it isn't one of them. */
function nostrDirOf(dir: string): string | null {
  const relative = path.relative(nostrBase(), dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) return null;
  return relative;
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * What an extension asks for: its API permissions, and the sites it can
 * read and change, from MV3 host_permissions, MV2 match patterns mixed into
 * permissions, and content scripts' matches.
 */
export function extensionAccess(manifest: Manifest): { permissions: string[]; hosts: string[] } {
  const isPattern = (p: string) => p === '<all_urls>' || p.includes('://');
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const hosts = new Set([
    ...strings(manifest.host_permissions),
    ...strings(manifest.permissions).filter(isPattern),
    ...contentScripts.flatMap((cs: unknown) =>
      cs && typeof cs === 'object' ? strings((cs as { matches?: unknown }).matches) : [],
    ),
  ]);
  return { permissions: [...new Set(strings(manifest.permissions).filter((p) => !isPattern(p)))], hosts: [...hosts] };
}

/**
 * A manifest string with its `__MSG_name__` placeholder filled from the
 * extension's default locale, its `_locales/<locale>/messages.json` read by
 * `read` (a path inside the extension).
 */
async function localize(read: (relative: string) => Promise<string | null>, manifest: Manifest, value: unknown): Promise<string> {
  if (typeof value !== 'string') return '';
  const match = /^__MSG_(\w+)__$/.exec(value.trim());
  if (!match) return value;
  const locale = typeof manifest.default_locale === 'string' ? manifest.default_locale.replace(/[^\w-]/g, '') : 'en';
  let messages: Record<string, { message?: unknown }> = {};
  try {
    messages = JSON.parse((await read(`_locales/${locale}/messages.json`))?.replace(/^\uFEFF/, '') ?? '{}');
  } catch {
    // No messages to fill it from.
  }
  const key = match[1].toLowerCase();
  const found = Object.entries(messages ?? {}).find(([name]) => name.toLowerCase() === key)?.[1]?.message;
  return typeof found === 'string' ? found : value;
}

/** Reads a file of the extension in `dir`, for localize. */
function readFrom(dir: string): (relative: string) => Promise<string | null> {
  return (relative) => fsp.readFile(path.join(dir, relative), 'utf8').catch(() => null);
}

async function readManifest(dir: string): Promise<Manifest> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8');
  } catch {
    throw new Error('That folder has no manifest.json, so it isn’t an extension.');
  }
  try {
    const manifest = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
    return manifest as Manifest;
  } catch {
    throw new Error('The extension’s manifest.json isn’t valid JSON.');
  }
}

/** The id Chromium gives an extension whose manifest has this `key`. */
function idFromKey(key: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hash].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/** A directory name made from a display name. */
function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_.+-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase()
      .slice(0, 64) || 'extension'
  );
}

const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

/** The manifest's biggest icon, as a path inside the extension. */
function largestIcon(manifest: Manifest): string | null {
  const sets = [manifest.icons, (manifest.action as Manifest | undefined)?.default_icon, (manifest.browser_action as Manifest | undefined)?.default_icon];
  for (const set of sets) {
    if (typeof set === 'string') return set;
    if (!set || typeof set !== 'object') continue;
    const best = Object.entries(set as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([a], [b]) => Number(b) - Number(a))[0];
    if (best) return best[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

export function registerBrowserExtensionHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  session: () => Electron.Session;
  /** Where the Chrome Web Store installs. */
  webStorePath: () => string;
  /** Extensions Din runs itself (the ad blocker's), never listed. */
  hidden: (id: string) => boolean;
  /** Ask the user to add an extension, showing what it can do; null when nobody answered. */
  askToAdd: (name: string, access: { permissions: string[]; hosts: string[] }) => Promise<boolean | null>;
}): { loadSaved: () => Promise<void> } {
  const { assertShellSender } = options;
  const extensions = () => options.session().extensions;

  const load = async (dir: string): Promise<Electron.Extension> => {
    const extension = await extensions().loadExtension(dir);
    if (extension.manifest?.manifest_version === 3 && extension.manifest.background?.service_worker) {
      await options
        .session()
        .serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`)
        .catch(() => console.error(`Failed to start worker for extension ${extension.id}`));
    }
    return extension;
  };

  const info = async (extension: Electron.Extension): Promise<ExtensionInfo> => {
    const base = {
      id: extension.id,
      name: extension.manifest?.name ?? extension.name,
      version: extension.version,
      description: extension.manifest?.description ?? '',
    };
    const dir = nostrDirOf(extension.path);
    if (dir) return { ...base, source: 'nostr', coordinate: (await nostrSources())[dir]?.coordinate };
    if ((await localFolders()).includes(extension.path)) return { ...base, source: 'local', path: extension.path };
    return { ...base, source: 'webstore' };
  };

  const find = (id: unknown): Electron.Extension => {
    if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension id');
    const extension = extensions().getExtension(id);
    if (!extension) throw new Error('That extension isn’t installed');
    return extension;
  };

  /** Take an installed extension away, wherever it came from; a folder of the user's own is only forgotten. */
  const remove = async (id: string): Promise<void> => {
    const extension = extensions().getExtension(id);
    const dir = extension && nostrDirOf(extension.path);
    if (extension && dir) {
      extensions().removeExtension(id);
      await fsp.rm(path.join(nostrBase(), dir), { recursive: true, force: true });
      const sources = await nostrSources();
      delete sources[dir];
      await writeJson(sourcesFile(), sources);
      return;
    }
    const folders = await localFolders();
    if (extension && folders.includes(extension.path)) {
      extensions().removeExtension(id);
      await setLocalFolders(folders.filter((f) => f !== extension.path));
      return;
    }
    await uninstallExtension(id, { session: options.session(), extensionsPath: options.webStorePath() });
  };

  const exportExtension = async (extension: Electron.Extension): Promise<ExtensionExport> => {
    const root = extension.path;
    const manifest = await readManifest(root);
    const entries: TarEntry[] = [];
    const walk = async (dir: string, inside: string, seen: Set<string>) => {
      const real = await fsp.realpath(dir);
      if (seen.has(real)) return;
      const inner = new Set(seen).add(real);
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        // The Web Store's signatures over its files, and version control, aren't the extension.
        if (!inside && entry.name === '_metadata') continue;
        if (entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        const relative = inside ? `${inside}/${entry.name}` : entry.name;
        let stat;
        try {
          stat = await fsp.stat(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) await walk(full, relative, inner);
        else if (stat.isFile()) entries.push({ path: relative, type: 'file', data: await fsp.readFile(full) });
      }
    };
    await walk(root, '', new Set());

    const sources = await nostrSources();
    const dir = nostrDirOf(root);
    const installedAs = dir ? sources[dir]?.coordinate.split(':').slice(2).join(':') : undefined;
    const name = extension.name || (await localize(readFrom(root), manifest, manifest.name));
    const isLocal = (await localFolders()).includes(root);
    const identifier = installedAs || (!dir && !isLocal ? extension.id : slug(name));

    const iconPath = largestIcon(manifest);
    const iconRelative = iconPath ? safeRelative(iconPath.replace(/^\/+/, '')) : null;
    let icon: ExtensionExport['icon'] = null;
    if (iconRelative) {
      const mime = ICON_MIME[path.extname(iconRelative).toLowerCase()];
      const data = mime ? await fsp.readFile(path.join(root, iconRelative)).catch(() => null) : null;
      if (mime && data) icon = { name: path.basename(iconRelative), mime, data };
    }

    const access = extensionAccess(manifest);
    return {
      identifier,
      name,
      version: extension.version,
      description: extension.manifest?.description ?? (await localize(readFrom(root), manifest, manifest.description)),
      manifestVersion: typeof manifest.manifest_version === 'number' ? manifest.manifest_version : null,
      permissions: access.permissions,
      hosts: access.hosts,
      archive: await packTarGz(entries),
      icon,
    };
  };

  const installPublished = async (value: unknown): Promise<{ id: string; name: string }> => {
    const pkg = checkPackageBase(value, EXTENSION_KIND, /^$/);
    const archive = (pkg.archive ?? {}) as { sha256?: unknown };
    if (!isSha256(archive.sha256)) throw new PackageError('Not an extension');
    const data = (await fetchBlobs([archive.sha256], pkg.servers)).get(archive.sha256);
    if (!data) throw new PackageError('The extension couldn’t be downloaded.');

    const files = new Map<string, Buffer>();
    for (const entry of await unpackTarGz(data)) {
      const relative = safeRelative(entry.path);
      if (relative && entry.type === 'file') files.set(relative, Buffer.from(entry.data));
    }
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) throw new PackageError('The extension’s archive has no manifest.json.');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')) as Manifest;
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
    } catch {
      throw new PackageError('The extension’s manifest.json isn’t valid JSON.');
    }

    const base = nostrBase();
    const sources = await nostrSources();
    const existing = Object.entries(sources).find(([, s]) => s.coordinate === pkg.coordinate)?.[0];
    const dir = existing ?? (await (async () => {
      const stem = slug(pkg.identifier);
      let name = stem;
      for (let n = 2; await fsp.access(path.join(base, name)).then(() => true, () => false); n++) name = `${stem}-${n}`;
      return name;
    })());
    const dest = path.join(base, dir);

    // The user says yes to what it can do, as for the Web Store; an update
    // asks again only when it wants more than the version installed.
    const access = extensionAccess(manifest);
    const before = existing ? extensionAccess(await readManifest(dest).catch(() => ({}))) : null;
    const more = !before
      || access.permissions.some((p) => !before.permissions.includes(p))
      || access.hosts.some((h) => !before.hosts.includes(h));
    if (more) {
      // The prompt names it as the extension does, which may be in its locale files.
      const localized = await localize(async (relative) => files.get(relative)?.toString('utf8') ?? null, manifest, manifest.name);
      const name = localized && !localized.startsWith('__MSG_') ? localized : pkg.name;
      const allow = await options.askToAdd(name, access);
      if (allow !== true) throw new PackageError('You didn’t add it.');
    }

    // Whatever has its id now (another copy of the same extension) makes way.
    const id = typeof manifest.key === 'string' ? idFromKey(manifest.key) : null;
    const clash = id ? extensions().getExtension(id) : undefined;
    if (clash && clash.path !== dest) await remove(clash.id);
    const current = extensions().getAllExtensions().find((e) => e.path === dest);
    if (current) extensions().removeExtension(current.id);

    await fsp.mkdir(base, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(base, '.din-extension-'));
    try {
      for (const [relative, bytes] of files) {
        const file = path.join(staging, relative);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, bytes, { flag: 'wx' }).catch(() => {
          throw new PackageError('The extension’s archive is damaged.');
        });
      }
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(staging, dest);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw error;
    }
    await writeJson(sourcesFile(), { ...(await nostrSources()), [dir]: { coordinate: pkg.coordinate, publishedAt: pkg.publishedAt } });

    const extension = await load(dest);
    return { id: extension.id, name: extension.name };
  };

  ipcMain.handle('crx:listExtensions', async (event) => {
    assertShellSender(event);
    const all = extensions().getAllExtensions().filter((extension) => !options.hidden(extension.id));
    return Promise.all(all.map(info));
  });

  ipcMain.handle('crx:uninstallExtension', async (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id !== 'string' || !EXTENSION_ID.test(id)) throw new Error('Invalid extension id');
    if (options.hidden(id)) throw new Error('That extension is Din’s own');
    await remove(id);
  });

  // Load an extension from a folder, and keep loading it from there.
  ipcMain.handle('crx:loadUnpacked', async (event, dir: unknown) => {
    assertShellSender(event);
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Not a folder');
    const folder = path.resolve(dir);
    await readManifest(folder);
    const already = extensions().getAllExtensions().find((e) => e.path === folder);
    if (already) extensions().removeExtension(already.id);
    const extension = await load(folder);
    await setLocalFolders([...(await localFolders()), folder]);
    return info(extension);
  });

  // Load an extension again from its files, as after editing them.
  ipcMain.handle('crx:reloadExtension', async (event, id: unknown) => {
    assertShellSender(event);
    const extension = find(id);
    if (options.hidden(extension.id)) throw new Error('That extension is Din’s own');
    extensions().removeExtension(extension.id);
    return info(await load(extension.path));
  });

  // An installed extension's files and icon, for publishing it.
  ipcMain.handle('crx:exportExtension', async (event, id: unknown) => {
    assertShellSender(event);
    const extension = find(id);
    if (options.hidden(extension.id)) throw new Error('That extension is Din’s own');
    return exportExtension(extension);
  });

  // The extensions installed from Nostr, with where each was published.
  ipcMain.handle('crx:published', async (event) => {
    assertShellSender(event);
    const sources = await nostrSources();
    return extensions()
      .getAllExtensions()
      .flatMap((extension) => {
        const dir = nostrDirOf(extension.path);
        const source = dir ? sources[dir] : undefined;
        return source ? [{ id: extension.id, source }] : [];
      });
  });

  // Install (or update) an extension someone published.
  ipcMain.handle('crx:installPublished', async (event, manifest: unknown) => {
    assertShellSender(event);
    return installPublished(manifest);
  });

  /** Load the folders and Nostr installs from last time. */
  const loadSaved = async () => {
    const dirs = [
      ...(await localFolders()),
      ...Object.keys(await nostrSources()).map((dir) => path.join(nostrBase(), dir)),
    ];
    for (const dir of dirs) {
      try {
        await load(dir);
      } catch (error) {
        console.error(`Failed to load extension from ${dir}:`, error);
      }
    }
  };

  return { loadSaved };
}
