/**
 * Hyprcursor themes: a manifest.hl (or .toml) naming the theme and its
 * cursors directory, and in that one entry per cursor, either a .hlc (a ZIP
 * of meta.hl and the images) or a directory of the same. meta.hl gives the
 * hotspot as a fraction of the size, the other names the cursor answers to,
 * and its images by size, several at one size making an animation. SVG
 * cursors are drawn at every size Settings offers; PNG ones keep theirs.
 */

import { Budget, DAMAGED, ImportError, LIMITS, clamp, text } from './bytes';
import { type Tree, baseOf, cleanPath, dirOf, join, listDir, readZip, resolve } from './archive';
import { type Bitmap, type Decoder, type Frame, decodePng, makeFrame, renderSvg } from './image';
import { type ConvertedTheme, type CursorSpec, CURSOR_NAME, HOLD_MS, STANDARD_SIZES, themeFrom } from './theme';

/** A theme's cursors that are looked at. */
const MAX_CURSORS = 400;
/** Delay for animations that give none (Hyprland wouldn't animate them at all). */
const DEFAULT_DELAY = 33;

/**
 * hyprlang or TOML `key = value` lines, values unquoted. `define_*` keys
 * may repeat, or (in TOML) list their values separated by `;`.
 */
export function parseHyprConfig(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const raw of source.split(/\r?\n/).slice(0, 10_000)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    const values = key.startsWith('define_') ? value.split(';').map((v) => v.trim()).filter(Boolean) : [value];
    result.set(key, [...(result.get(key) ?? []), ...values]);
  }
  return result;
}

/** A cursor's meta file and images, from a .hlc or a directory. */
async function cursorFiles(tree: Tree, key: string, budget: Budget): Promise<Tree | null> {
  if (key.toLowerCase().endsWith('.hlc')) {
    const file = resolve(tree, key);
    if (!file) return null;
    const inner: Tree = new Map();
    await readZip(file.data, inner, budget);
    return inner;
  }
  const inner: Tree = new Map();
  for (const [lower, path] of listDir(tree, key)) {
    const node = resolve(tree, path);
    if (node) inner.set(lower, { data: node.data });
  }
  return inner;
}

async function hyprCursor(files: Tree, budget: Budget, decoder: Decoder): Promise<{ frames: Frame[]; overrides: string[] } | null> {
  const lower = listDir(files, '');
  const metaKey = lower.get('meta.hl') ?? lower.get('meta.toml');
  const meta = metaKey ? resolve(files, metaKey) : null;
  if (!meta) return null;
  const config = parseHyprConfig(text(meta.data));
  const hotX = clamp(Number(config.get('hotspot_x')?.[0] ?? 0) || 0, 0, 1);
  const hotY = clamp(Number(config.get('hotspot_y')?.[0] ?? 0) || 0, 0, 1);
  const overrides = config.get('define_override') ?? [];

  const images = (config.get('define_size') ?? []).slice(0, LIMITS.framesPerCursor * 8).map((entry) => {
    const [size, file, delay] = entry.split(',').map((s) => s.trim());
    return { size: Math.round(Number(size)) || 0, file: file ?? '', delay: Math.round(Number(delay)) || 0 };
  });
  if (!images.length) return null;
  const imageData = (file: string) => {
    const key = cleanPath(file);
    const found = key ? resolve(files, lower.get(key.toLowerCase()) ?? key) : null;
    if (!found) throw new ImportError(DAMAGED);
    return found.data;
  };
  const delayFor = (given: number, count: number) => (count > 1 ? Math.min(HOLD_MS, given > 0 ? given : DEFAULT_DELAY) : 0);

  const frames: Frame[] = [];
  if (images.some((i) => i.file.toLowerCase().endsWith('.svg'))) {
    // Vector: sizes are ignored, and every frame is drawn at each standard size.
    const steps = images.slice(0, LIMITS.framesPerCursor);
    const sources = steps.map((step) => imageData(step.file));
    for (const size of STANDARD_SIZES) {
      for (let i = 0; i < steps.length; i++) {
        const image = await renderSvg(decoder, budget, sources[i], size);
        frames.push(made(budget, image, size, hotX, hotY, delayFor(steps[i].delay, steps.length)));
      }
    }
  } else {
    const bySize = new Map<number, typeof images>();
    for (const image of images) bySize.set(image.size, [...(bySize.get(image.size) ?? []), image]);
    for (const steps of bySize.values()) {
      for (const step of steps.slice(0, LIMITS.framesPerCursor)) {
        const image = await decodePng(decoder, budget, imageData(step.file));
        const size = step.size > 0 ? step.size : Math.max(image.width, image.height);
        frames.push(made(budget, image, size, hotX, hotY, delayFor(step.delay, steps.length)));
      }
    }
  }
  return { frames, overrides };
}

function made(budget: Budget, image: Bitmap, size: number, hotX: number, hotY: number, delay: number): Frame {
  return makeFrame(budget, image, { size, hotX: hotX * image.width, hotY: hotY * image.height, delay });
}

export async function hyprcursorTheme(
  tree: Tree,
  manifestPath: string,
  budget: Budget,
  decoder: Decoder,
  fallbackName: string,
): Promise<ConvertedTheme | null> {
  const root = dirOf(manifestPath);
  const manifest = resolve(tree, manifestPath);
  if (!manifest) return null;
  const config = parseHyprConfig(text(manifest.data));
  const directory = cleanPath(config.get('cursors_directory')?.[0] ?? 'hyprcursors');
  if (!directory) throw new ImportError(DAMAGED);
  const base = join(root, directory);

  // Each cursor: a .hlc in the directory, or a directory with a meta file in it.
  const entries = new Set<string>();
  for (const key of tree.keys()) {
    if (!key.startsWith(`${base}/`)) continue;
    const rest = key.slice(base.length + 1);
    const first = rest.split('/')[0];
    if (rest === first ? first.toLowerCase().endsWith('.hlc') : true) entries.add(join(base, first));
  }

  const specs: CursorSpec[] = [];
  for (const key of [...entries].sort().slice(0, MAX_CURSORS)) {
    const name = baseOf(key).replace(/\.hlc$/i, '');
    if (!CURSOR_NAME.test(name)) continue;
    const files = await cursorFiles(tree, key, budget);
    const cursor = files ? await hyprCursor(files, budget, decoder) : null;
    if (cursor?.frames.length) specs.push({ name, aliases: cursor.overrides, frames: cursor.frames });
  }
  // The arrow first, so that it keeps its name over any override of it.
  specs.sort((a, b) => Number(b.name === 'left_ptr') - Number(a.name === 'left_ptr'));
  return themeFrom(config.get('name')?.[0]?.trim() || (root ? baseOf(root) : fallbackName), specs);
}
