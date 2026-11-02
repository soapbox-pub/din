// Browser extensions beyond the Chrome Web Store's: ones loaded from a folder
// on this computer, ones installed from a .crx file, and ones published to Nostr as NIP-82 software (an app,
// kind 32267, whose releases carry a .crx asset; NIP.md) and installed from
// there.
//
// The Web Store's own installs live in Extensions/ (electron-chrome-web-store
// loads them, see setupChromeExtensions in main.mts). Folders the user loads
// are remembered by path in local-extensions.json and loaded where they are,
// so editing one and pressing Reload is the whole development loop. A .crx
// file is checked and unpacked into PackedExtensions/<id>, the file kept in
// PackedExtensions/.crx/ to publish as it is. Ones from
// Nostr are unpacked into NostrExtensions/<dir>, with NostrExtensions/
// .nostr.json recording, by directory, the app's coordinate, the release's
// created_at and the asset's hash each came from, for Update and Remove, and
// the .crx itself kept in NostrExtensions/.crx/, to publish again as it is.
// An unpacked extension's id comes from its manifest's `key`, which Din sets
// to the key the .crx was signed with, as Chrome does when it installs one,
// so an extension from Nostr has the id it was published with, and keeps it,
// and its storage, through updates.
//
// Any installed extension can be exported for publishing as a .crx: the Web
// Store's own copy for one from there (which keeps Google's signature and its
// id), the one it came in for one from Nostr or a file, and for a folder its files
// signed with a key of its own, which the desktop keeps (roaming it with the
// user's encrypted app data) so it always gets the same id.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, ipcMain, net } from 'electron';
import { uninstallExtension } from 'electron-chrome-web-store';
import { CrxError, extensionIdOfKey, newSigningKey, readCrx, writeCrx } from './crx.mts';
import { checkPackageBase, fetchBlobs, isSha256, PackageError, safeRelative } from './themePackages.mts';

/** A NIP-82 software application's kind, which a published extension is. */
const APP_KIND = 32267;

const EXTENSION_ID = /^[a-p]{32}$/;

/** What an installed extension is, as the browser's pages list it. */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Where it came from: the Chrome Web Store, a folder here, or Nostr. */
  source: 'webstore' | 'local' | 'file' | 'nostr';
  /** The folder it was loaded from, for one loaded from a folder. */
  path?: string;
  /** The app's `32267:<pubkey>:<d>` it was installed from, for one from Nostr. */
  coordinate?: string;
}

/** An installed extension made ready to publish. */
export interface ExtensionExport {
  /** What its `d` tag should be: the one it was installed under, its Web Store id, or its name made a slug. */
  identifier: string;
  /** The id it has once installed from the package. */
  extensionId: string;
  name: string;
  version: string;
  description: string;
  manifestVersion: number | null;
  /** Its manifest's `minimum_chrome_version`. */
  minimumChrome: string | null;
  permissions: string[];
  hosts: string[];
  /** The .crx. */
  crx: Uint8Array;
  icon: { name: string; mime: string; data: Uint8Array } | null;
  /** The signing key made for it, when it had none yet, for the desktop to keep. */
  newKey: string | null;
}

interface PublishedSource {
  coordinate: string;
  publishedAt: number;
  /** The asset's hash. */
  sha256?: string;
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
    const { coordinate, publishedAt, sha256 } = (value ?? {}) as Record<string, unknown>;
    if (typeof coordinate === 'string' && typeof publishedAt === 'number') {
      out[dir] = { coordinate, publishedAt, ...(isSha256(sha256) ? { sha256 } : {}) };
    }
  }
  return out;
}

/** Where extensions installed from a .crx file are unpacked, each under its id. */
function packedBase(): string {
  return path.join(app.getPath('userData'), 'PackedExtensions');
}

/** Where the .crx an extension was installed from a file is kept. */
function packedCrxFile(id: string): string {
  return path.join(packedBase(), '.crx', `${id}.crx`);
}

/** The PackedExtensions directory (its id) an extension at `dir` is in, or null. */
function packedIdOf(dir: string): string | null {
  const relative = path.relative(packedBase(), dir);
  return EXTENSION_ID.test(relative) ? relative : null;
}

/** Where the .crx an extension from Nostr came in is kept. */
function crxFile(dir: string): string {
  return path.join(nostrBase(), '.crx', `${dir}.crx`);
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

/** Google's own .crx of a Web Store extension, at its current version. */
async function webStoreCrx(id: string): Promise<Buffer> {
  const url = new URL('https://clients2.google.com/service/update2/crx');
  url.searchParams.set('response', 'redirect');
  url.searchParams.set('acceptformat', 'crx3');
  url.searchParams.set('prodversion', process.versions.chrome);
  url.searchParams.set('x', new URLSearchParams({ id, installsource: 'ondemand', uc: '' }).toString());
  const response = await net.fetch(url.toString(), { signal: AbortSignal.timeout(5 * 60_000) });
  // 204 for one the store no longer has.
  if (response.status !== 200) throw new Error('The Chrome Web Store doesn’t have this extension.');
  return Buffer.from(await response.arrayBuffer());
}

/** An extension's files as they go in a package: everything but version control and the Web Store's signatures. */
async function packageFiles(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string, inside: string, seen: Set<string>) => {
    const real = await fsp.realpath(dir);
    if (seen.has(real)) return;
    const inner = new Set(seen).add(real);
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
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
      else if (stat.isFile()) files.set(relative, await fsp.readFile(full));
    }
  };
  await walk(root, '', new Set());
  return files;
}

function parseManifest(bytes: Uint8Array | undefined): Manifest {
  if (!bytes) throw new PackageError('The extension has no manifest.json.');
  try {
    const manifest = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error();
    return manifest as Manifest;
  } catch {
    throw new PackageError('The extension’s manifest.json isn’t valid JSON.');
  }
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
    if (packedIdOf(extension.path)) return { ...base, source: 'file' };
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
      await fsp.rm(crxFile(dir), { force: true });
      const sources = await nostrSources();
      delete sources[dir];
      await writeJson(sourcesFile(), sources);
      return;
    }
    const packed = extension && packedIdOf(extension.path);
    if (extension && packed) {
      extensions().removeExtension(id);
      await fsp.rm(path.join(packedBase(), packed), { recursive: true, force: true });
      await fsp.rm(packedCrxFile(packed), { force: true });
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

  const exportExtension = async (extension: Electron.Extension, keys: Record<string, string>): Promise<ExtensionExport> => {
    const root = extension.path;
    const sources = await nostrSources();
    const dir = nostrDirOf(root);
    const packed = packedIdOf(root);
    const isLocal = (await localFolders()).includes(root);

    let crx: Buffer | null;
    let newKey: string | null = null;
    let identifier: string;
    let files: Map<string, Uint8Array>;
    const name = extension.name;
    if (dir) {
      // As it came, so it keeps its signature and its id.
      crx = await fsp.readFile(crxFile(dir));
      files = readCrx(crx).files;
      identifier = sources[dir]?.coordinate.split(':').slice(2).join(':') || slug(name);
    } else if (packed) {
      crx = await fsp.readFile(packedCrxFile(packed));
      files = readCrx(crx).files;
      identifier = slug(name);
    } else if (!isLocal && (crx = await webStoreCrx(extension.id).then((data) => {
      const store = readCrx(data);
      return store.id === extension.id ? data : null;
    }, () => null))) {
      files = readCrx(crx).files;
      identifier = extension.id;
    } else {
      // A folder's, or one the Web Store no longer has, signed by a key of
      // its own (which gives the latter a new id).
      files = await packageFiles(root);
      identifier = isLocal ? slug(name) : extension.id;
      let pem: string | null = typeof keys[identifier] === 'string' ? keys[identifier] : null;
      try {
        if (pem) extensionIdOfKey(pem);
      } catch {
        pem = null;
      }
      if (!pem) pem = newKey = newSigningKey();
      crx = writeCrx(files, pem);
    }
    const parsed = readCrx(crx);
    const manifest = parseManifest(files.get('manifest.json'));
    const read = async (relative: string) => {
      const bytes = files.get(relative);
      return bytes ? Buffer.from(bytes).toString('utf8') : null;
    };

    const iconPath = largestIcon(manifest);
    const iconRelative = iconPath ? safeRelative(iconPath.replace(/^\/+/, '')) : null;
    let icon: ExtensionExport['icon'] = null;
    if (iconRelative) {
      const mime = ICON_MIME[path.extname(iconRelative).toLowerCase()];
      const data = files.get(iconRelative);
      if (mime && data) icon = { name: path.basename(iconRelative), mime, data };
    }

    const access = extensionAccess(manifest);
    return {
      identifier,
      extensionId: parsed.id,
      name: name || (await localize(read, manifest, manifest.name)),
      version: typeof manifest.version === 'string' ? manifest.version : extension.version,
      description: extension.manifest?.description ?? (await localize(read, manifest, manifest.description)),
      manifestVersion: typeof manifest.manifest_version === 'number' ? manifest.manifest_version : null,
      minimumChrome: typeof manifest.minimum_chrome_version === 'string' ? manifest.minimum_chrome_version : null,
      permissions: access.permissions,
      hosts: access.hosts,
      crx,
      icon,
      newKey,
    };
  };

  /**
   * Check a .crx, ask the user to add it (an update only when it wants more
   * than what's at `dest` now), and unpack it there with its key as the
   * manifest's `key`, as Chrome does, so it has the id it was signed with.
   */
  const unpackCrx = async (data: Buffer, dest: string, fallbackName: string): Promise<string> => {
    let parsed;
    try {
      parsed = readCrx(data);
    } catch (error) {
      throw new PackageError(error instanceof CrxError ? error.message : 'The extension’s package is damaged.');
    }
    const files = new Map<string, Uint8Array>();
    for (const [name, bytes] of parsed.files) {
      const relative = safeRelative(name);
      if (relative) files.set(relative, bytes);
    }
    const manifest = parseManifest(files.get('manifest.json'));
    files.set('manifest.json', Buffer.from(JSON.stringify({ ...manifest, key: parsed.key }, null, 2)));

    const access = extensionAccess(manifest);
    const installed = await fsp.access(dest).then(() => true, () => false);
    const before = installed ? extensionAccess(await readManifest(dest).catch(() => ({}))) : null;
    const more = !before
      || access.permissions.some((p) => !before.permissions.includes(p))
      || access.hosts.some((h) => !before.hosts.includes(h));
    if (more) {
      // The prompt names it as the extension does, which may be in its locale files.
      const read = async (relative: string) => {
        const bytes = files.get(relative);
        return bytes ? Buffer.from(bytes).toString('utf8') : null;
      };
      const localized = await localize(read, manifest, manifest.name);
      const name = localized && !localized.startsWith('__MSG_') ? localized : fallbackName;
      const allow = await options.askToAdd(name, access);
      if (allow !== true) throw new PackageError('You didn’t add it.');
    }

    // Whatever has its id now (another copy of the same extension) makes way.
    const clash = extensions().getExtension(parsed.id);
    if (clash && clash.path !== dest) await remove(clash.id);
    const current = extensions().getAllExtensions().find((e) => e.path === dest);
    if (current) extensions().removeExtension(current.id);

    const base = path.dirname(dest);
    await fsp.mkdir(base, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(base, '.din-extension-'));
    try {
      for (const [relative, bytes] of files) {
        const file = path.join(staging, relative);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, bytes, { flag: 'wx' }).catch(() => {
          throw new PackageError('The extension’s package is damaged.');
        });
      }
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(staging, dest);
    } catch (error) {
      await fsp.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return parsed.id;
  };

  const installPublished = async (value: unknown): Promise<{ id: string; name: string }> => {
    const pkg = checkPackageBase(value, APP_KIND, /^$/);
    const asset = (pkg.asset ?? {}) as { sha256?: unknown };
    if (!isSha256(asset.sha256)) throw new PackageError('Not an extension');
    const data = (await fetchBlobs([asset.sha256], pkg.servers)).get(asset.sha256);
    if (!data) throw new PackageError('The extension couldn’t be downloaded.');

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
    await unpackCrx(data, dest, pkg.name);
    await fsp.mkdir(path.dirname(crxFile(dir)), { recursive: true });
    await fsp.writeFile(crxFile(dir), data);
    await writeJson(sourcesFile(), {
      ...(await nostrSources()),
      [dir]: { coordinate: pkg.coordinate, publishedAt: pkg.publishedAt, sha256: asset.sha256 },
    });

    const extension = await load(dest);
    return { id: extension.id, name: extension.name };
  };

  /** Install an extension from a .crx file, into PackedExtensions/<id>. */
  const installFile = async (file: string): Promise<ExtensionInfo> => {
    let data: Buffer;
    try {
      data = await fsp.readFile(file);
    } catch {
      throw new PackageError('That file couldn’t be read.');
    }
    let id: string;
    try {
      id = readCrx(data).id;
    } catch (error) {
      throw new PackageError(error instanceof CrxError ? error.message : 'That isn’t a Chrome extension package.');
    }
    const dest = path.join(packedBase(), id);
    await unpackCrx(data, dest, path.basename(file, path.extname(file)));
    await fsp.mkdir(path.dirname(packedCrxFile(id)), { recursive: true });
    await fsp.writeFile(packedCrxFile(id), data);
    return info(await load(dest));
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

  // Install an extension from a .crx file.
  ipcMain.handle('crx:installFile', async (event, file: unknown) => {
    assertShellSender(event);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Not a file');
    return installFile(file);
  });

  // Load an extension again from its files, as after editing them.
  ipcMain.handle('crx:reloadExtension', async (event, id: unknown) => {
    assertShellSender(event);
    const extension = find(id);
    if (options.hidden(extension.id)) throw new Error('That extension is Din’s own');
    extensions().removeExtension(extension.id);
    return info(await load(extension.path));
  });

  // An installed extension as a .crx, and its icon, for publishing it. A
  // folder's is signed with its key in `keys` (PKCS#8 PEM, by `d`), or a new
  // key when that has none.
  ipcMain.handle('crx:exportExtension', async (event, id: unknown, keys: unknown) => {
    assertShellSender(event);
    const extension = find(id);
    if (options.hidden(extension.id)) throw new Error('That extension is Din’s own');
    const valid = keys && typeof keys === 'object' && !Array.isArray(keys) ? (keys as Record<string, string>) : {};
    return exportExtension(extension, valid);
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

  /** Load the folders, .crx files and Nostr installs from last time. */
  const loadSaved = async () => {
    const dirs = [
      ...(await localFolders()),
      ...Object.keys(await nostrSources()).map((dir) => path.join(nostrBase(), dir)),
      ...(await fsp.readdir(packedBase()).catch(() => [] as string[]))
        .filter((id) => EXTENSION_ID.test(id))
        .map((id) => path.join(packedBase(), id)),
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
