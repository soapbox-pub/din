import { zipSync } from 'fflate';

/**
 * WMP skins that come with Din. Their files live in the source tree and are
 * zipped into a .wmz on demand, so they load (and preview) exactly as a
 * skin file from disk would. Prefs name them by a `builtin:` path.
 */
export const BUILTIN_WMP_SKINS = [
  { id: 'headspace', name: 'Headspace', path: 'builtin:headspace', description: 'A head with a screen for a mind and speakers for ears: pull them out for the equalizer and the playlist.' },
];

const texts = import.meta.glob<string>('./headspace/*.{wms,js}', { query: '?raw', import: 'default' });
const images = import.meta.glob<string>('./headspace/*.png', { query: '?url', import: 'default' });

export const isBuiltinSkin = (path: string) => path.startsWith('builtin:');

/** The .wmz bytes of a built-in skin. */
export async function builtinSkinBytes(path: string): Promise<Uint8Array> {
  const id = path.slice('builtin:'.length);
  const prefix = `./${id}/`;
  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  await Promise.all([
    ...Object.entries(texts)
      .filter(([p]) => p.startsWith(prefix))
      .map(async ([p, load]) => {
        files[p.slice(prefix.length)] = encoder.encode(await load());
      }),
    ...Object.entries(images)
      .filter(([p]) => p.startsWith(prefix))
      .map(async ([p, load]) => {
        const response = await fetch(await load());
        files[p.slice(prefix.length)] = new Uint8Array(await response.arrayBuffer());
      }),
  ]);
  if (Object.keys(files).length === 0) throw new Error(`No built-in skin “${id}”`);
  return zipSync(files, { level: 0 });
}
