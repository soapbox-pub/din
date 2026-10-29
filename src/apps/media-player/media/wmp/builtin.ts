import { zipSync } from 'fflate';

/**
 * WMP skins that come with Din. Their files live in the source tree and are
 * zipped into a .wmz on demand, so they load (and preview) exactly as a
 * skin file from disk would. Prefs name them by a `builtin:` path.
 */
export const BUILTIN_WMP_SKINS = [
  { id: 'noggin', name: 'Noggin', path: 'builtin:noggin', description: 'A head with a screen for a mind and speakers for ears: pull them out for the equalizer and the playlist.' },
];

const texts = import.meta.glob<string>('./noggin/*.{wms,js}', { query: '?raw', import: 'default' });
const images = import.meta.glob<string>('./noggin/*.png', { query: '?url', import: 'default' });

export const isBuiltinSkin = (path: string) => path.startsWith('builtin:');

/**
 * The bytes behind an asset URL. Vite inlines small images as base64 `data:`
 * URLs in a build, and the CSP's connect-src won't let fetch() read those.
 */
async function assetBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const binary = atob(url.slice(url.indexOf(',') + 1));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

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
        files[p.slice(prefix.length)] = await assetBytes(await load());
      }),
  ]);
  if (Object.keys(files).length === 0) throw new Error(`No built-in skin “${id}”`);
  return zipSync(files, { level: 0 });
}
