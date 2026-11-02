import { extensionOf } from '@/lib/fileTypes';
import { getFsBridge, joinPath } from '@/lib/fs';
import { winampPreview } from '@/shared/skins/winamp/skin';
import { openWmz } from '@/shared/skins/wmp/wms';
import { wmpPreview } from '@/shared/skins/wmp/preview';

/**
 * Media Player skins as the desktop sees them: the files in the player's
 * skins folder (src/apps/media-player), which it publishes to Nostr and
 * installs from it (src/lib/themePackages.ts, kind 34675).
 *
 * A skin is one file, so there's no index.theme to say where one came from;
 * `.nostr.json` beside them does, by file name. The player lists only skin
 * files, so it never shows.
 */

export type SkinFormat = 'winamp' | 'wmp';

/** The most of a skin file the Media Player reads. */
export const MAX_SKIN_BYTES = 64 * 1024 * 1024;

const SOURCES = '.nostr.json';
const SKIN_FILE = /^(?!\.)[^/\\\0]+\.(wsz|wmz)$/i;

export function skinFormatOf(name: string): SkinFormat | null {
  const ext = extensionOf(name);
  return ext === 'wsz' ? 'winamp' : ext === 'wmz' ? 'wmp' : null;
}

/** Whether `name` is a skin file's name in the skins folder (never a path). */
export function isSkinFileName(name: string): boolean {
  return SKIN_FILE.test(name);
}

function fs() {
  const bridge = getFsBridge();
  if (!bridge) throw new Error('Skins are kept in the Din desktop app');
  return bridge;
}

export async function skinsFolder(): Promise<string> {
  return joinPath(await fs().homedir(), '.local/share/din/skins');
}

export interface InstalledSkin {
  /** Its file name, which is what Din calls it. */
  id: string;
  name: string;
  path: string;
  format: SkinFormat;
  source: { coordinate: string; publishedAt: number } | null;
}

type Sources = Record<string, { coordinate: string; publishedAt: number }>;

async function readSources(dir: string): Promise<Sources> {
  try {
    const { data } = await fs().readFile(joinPath(dir, SOURCES), 1024 * 1024);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const sources: Sources = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      const { coordinate, publishedAt } = (value ?? {}) as { coordinate?: unknown; publishedAt?: unknown };
      if (isSkinFileName(name) && typeof coordinate === 'string' && typeof publishedAt === 'number') {
        sources[name] = { coordinate, publishedAt };
      }
    }
    return sources;
  } catch {
    return {};
  }
}

async function writeSources(dir: string, sources: Sources): Promise<void> {
  await fs().writeFile(joinPath(dir, SOURCES), `${JSON.stringify(sources, null, 2)}\n`);
}

/** The skin files in the skins folder, with where each came from. */
export async function installedSkins(): Promise<InstalledSkin[]> {
  const dir = await skinsFolder();
  let entries: { name: string; kind: string }[];
  try {
    entries = (await fs().readdir(dir)).entries;
  } catch {
    return [];
  }
  const sources = await readSources(dir);
  return entries
    .filter((e) => e.kind === 'file' && isSkinFileName(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({
      id: e.name,
      name: e.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '),
      path: joinPath(dir, e.name),
      format: skinFormatOf(e.name) as SkinFormat,
      source: sources[e.name] ?? null,
    }));
}

/** A skin file's bytes, by its name in the skins folder. */
export async function readSkin(id: string): Promise<{ data: Uint8Array; format: SkinFormat; path: string }> {
  const format = skinFormatOf(id);
  if (!isSkinFileName(id) || !format) throw new Error('Not a skin in the Media Player’s skins');
  const path = joinPath(await skinsFolder(), id);
  const { data } = await fs().readFile(path, MAX_SKIN_BYTES);
  return { data, format, path };
}

/** A picture of a skin as the Media Player's skin chooser draws it, as a data URL. */
export function skinPreview(data: Uint8Array, format: SkinFormat): Promise<string | null> {
  return format === 'winamp' ? winampPreview(data) : wmpPreview(data);
}

/** Whether `data` is a skin of `format`: a zip for Winamp, a .wmz (or bare .wms) the player can open for WMP. */
export function checkSkin(data: Uint8Array, format: SkinFormat): boolean {
  if (format === 'winamp') return data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  try {
    openWmz(data);
    return true;
  } catch {
    return false;
  }
}

function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_.+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64) || 'skin';
}

/**
 * Save a published skin into the skins folder: over the same one installed
 * before, else as `<d>.<ext>`, numbered when another file has that name.
 * Resolves with its file name.
 */
export async function saveSkin(
  data: Uint8Array,
  format: SkinFormat,
  pkg: { identifier: string; coordinate: string; publishedAt: number },
): Promise<string> {
  const dir = await skinsFolder();
  await fs().mkdir(dir);
  const sources = await readSources(dir);
  const ext = format === 'winamp' ? 'wsz' : 'wmz';
  const taken = new Set((await installedSkins()).map((s) => s.id.toLowerCase()));
  let id = Object.entries(sources).find(([name, s]) => s.coordinate === pkg.coordinate && taken.has(name.toLowerCase()) && skinFormatOf(name) === format)?.[0];
  if (!id) {
    const stem = slug(pkg.identifier);
    id = `${stem}.${ext}`;
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${stem}-${n}.${ext}`;
  }
  // Written beside it and moved into place, so the player never reads half a skin.
  const partial = joinPath(dir, `.${id}.part`);
  await fs().writeFile(partial, data);
  await fs().rename(partial, joinPath(dir, id));
  await writeSources(dir, { ...sources, [id]: { coordinate: pkg.coordinate, publishedAt: pkg.publishedAt } });
  return id;
}

/** Move a skin to the trash, as the player's Delete Skin does, and forget where it came from. */
export async function trashSkin(id: string): Promise<void> {
  if (!isSkinFileName(id)) throw new Error('Not a skin in the Media Player’s skins');
  const dir = await skinsFolder();
  await fs().trash(joinPath(dir, id));
  const sources = await readSources(dir);
  if (id in sources) {
    delete sources[id];
    await writeSources(dir, sources);
  }
}
