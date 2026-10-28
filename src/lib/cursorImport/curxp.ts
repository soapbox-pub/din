/**
 * CursorXP (.CurXPTheme): a ZIP of Scheme.ini, which describes each cursor
 * (frame count, interval, hotspot, animation style), and one PNG per cursor
 * with its frames side by side. CursorXP cursors have one size, their own.
 */

import { Budget, LIMITS, clamp, text, toInt } from './bytes';
import { type Tree, dirOf, listDir, resolve } from './archive';
import { type Decoder, decodePng, makeFrame, splitStrip } from './image';
import { type ConvertedTheme, type CursorSpec, WINDOWS_ROLES, animate, themeFrom } from './theme';

export type IniData = Map<string, Map<string, string>>;

/** INI sections and keys, both by lower-case name. */
export function parseIni(source: string): IniData {
  const result: IniData = new Map();
  let section = new Map<string, string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const key = header[1].trim().toLowerCase();
      section = result.get(key) ?? new Map();
      result.set(key, section);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) section.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return result;
}

/** CursorXP's animation styles: 0 loops, 1 goes back and forth, 2 plays once. */
const STYLES = ['loop', 'alternate', 'once'] as const;

export async function curxpTheme(
  tree: Tree,
  schemePath: string,
  budget: Budget,
  decoder: Decoder,
  name: string,
): Promise<ConvertedTheme | null> {
  const files = listDir(tree, dirOf(schemePath));
  const scheme = resolve(tree, schemePath);
  if (!scheme) return null;
  const ini = parseIni(text(scheme.data));

  const specs: CursorSpec[] = [];
  for (const role of WINDOWS_ROLES) {
    const section = ini.get(role.curxp.toLowerCase());
    const pngPath = files.get(`${role.curxp.toLowerCase()}.png`);
    const png = pngPath ? resolve(tree, pngPath) : null;
    if (!section || !png) continue;

    const count = clamp(toInt(section.get('frames'), 1), 1, LIMITS.framesPerCursor);
    const interval = toInt(section.get('interval'), 60);
    const style = STYLES[toInt(section.get('animation style'), 0)] ?? 'loop';
    const image = await decodePng(decoder, budget, png.data);
    const frames = splitStrip(image, count, true);
    const hotX = clamp(toInt(section.get('hot spot x'), 0), 0, frames[0].width - 1);
    const hotY = clamp(toInt(section.get('hot spot y'), 0), 0, frames[0].height - 1);
    const size = Math.max(frames[0].width, frames[0].height);
    specs.push({
      name: role.name,
      aliases: role.aliases,
      frames: animate(frames.map((frame) => makeFrame(budget, frame, { size, hotX, hotY, delay: 0 })), interval, style),
    });
  }
  return themeFrom(name, specs);
}
