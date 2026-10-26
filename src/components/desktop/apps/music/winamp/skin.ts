import { unzipSync } from 'fflate';
import { makeDefaultSheets } from './defaultSkin';

/**
 * A classic Winamp 2.x skin (.wsz, a renamed zip of bitmaps and a few text
 * files), unpacked into sprite sheets the renderer draws from with CSS
 * background positions. Sheets a skin leaves out come from Din Classic, the
 * built-in skin drawn in defaultSkin.ts.
 */

export const SHEETS = [
  'main', 'cbuttons', 'titlebar', 'shufrep', 'text', 'volume', 'balance', 'monoster', 'playpaus', 'numbers', 'nums_ex',
  'posbar', 'eqmain', 'eq_ex', 'pledit',
] as const;
export type SheetName = (typeof SHEETS)[number];

export interface Sheet {
  url: string;
  width: number;
  height: number;
}

export interface PlaylistColors {
  normal: string;
  current: string;
  normalBg: string;
  selectedBg: string;
  font: string;
}

export interface WinampSkin {
  name: string;
  sheets: Record<SheetName, Sheet | null>;
  /** viscolor.txt: 24 colors (background, dots, 16 spectrum rows top-down, 5 scope, peaks). */
  visColors: string[];
  playlist: PlaylistColors;
  /** region.txt: polygons (in window pixels) per window state. */
  regions: { normal?: number[][]; equalizer?: number[][]; windowshade?: number[][]; equalizerws?: number[][] };
  /** EQ_GRAPH_LINE_COLORS, top to bottom. */
  graphColors: string[];
  /** Release object URLs. */
  dispose(): void;
}

export const DEFAULT_VIS_COLORS = [
  'rgb(0,0,0)', 'rgb(24,33,41)',
  'rgb(239,49,16)', 'rgb(206,41,16)', 'rgb(214,90,0)', 'rgb(214,102,0)', 'rgb(214,115,0)', 'rgb(198,123,8)', 'rgb(222,165,24)', 'rgb(214,181,33)',
  'rgb(189,222,41)', 'rgb(148,222,33)', 'rgb(41,206,16)', 'rgb(50,190,16)', 'rgb(57,181,16)', 'rgb(49,156,8)', 'rgb(41,148,0)', 'rgb(24,132,8)',
  'rgb(255,255,255)', 'rgb(214,214,222)', 'rgb(181,189,189)', 'rgb(160,170,175)', 'rgb(148,156,165)',
  'rgb(150,150,150)',
];

const DEFAULT_PLAYLIST: PlaylistColors = {
  normal: '#00FF00',
  current: '#FFFFFF',
  normalBg: '#000000',
  selectedBg: '#0000C6',
  font: 'Arial',
};

/** Case-insensitive lookup of a file anywhere in the zip (skins often nest a folder). */
function finder(files: Record<string, Uint8Array>) {
  const byName = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/') || path.startsWith('__MACOSX')) continue;
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (!byName.has(name)) byName.set(name, data);
  }
  return (name: string) => byName.get(name.toLowerCase());
}

/** Decode text files, which are usually Windows-1252. */
const decodeText = (data: Uint8Array) => new TextDecoder('windows-1252').decode(data);

/** An INI file's sections, lower-cased, with their key/value pairs (lower-cased keys). */
export function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) (out[section] ??= {})[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return out;
}

function parseVisColors(text: string): string[] {
  const colors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(line);
    if (m) colors.push(`rgb(${m[1]},${m[2]},${m[3]})`);
    if (colors.length === 24) break;
  }
  return colors.length === 24 ? colors : DEFAULT_VIS_COLORS.map((c, i) => colors[i] ?? c);
}

function color(value: string | undefined, fallback: string): string {
  const v = value?.trim().replace(/^#?/, '#') ?? '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

function parsePlaylistColors(text: string): PlaylistColors {
  const s = parseIni(text).text ?? {};
  const font = (s.font ?? '').replace(/[^\w\s-]/g, '').trim();
  return {
    normal: color(s.normal, DEFAULT_PLAYLIST.normal),
    current: color(s.current, DEFAULT_PLAYLIST.current),
    normalBg: color(s.normalbg, DEFAULT_PLAYLIST.normalBg),
    selectedBg: color(s.selectedbg, DEFAULT_PLAYLIST.selectedBg),
    font: font || DEFAULT_PLAYLIST.font,
  };
}

function parseRegions(text: string): WinampSkin['regions'] {
  const ini = parseIni(text);
  const regions: WinampSkin['regions'] = {};
  for (const name of ['normal', 'equalizer', 'windowshade', 'equalizerws'] as const) {
    const s = ini[name];
    if (!s?.numpoints || !s.pointlist) continue;
    const counts = s.numpoints.split(/[\s,]+/).filter(Boolean).map(Number);
    const points = s.pointlist.split(/[\s,]+/).filter(Boolean).map(Number);
    const polys: number[][] = [];
    let p = 0;
    for (const n of counts) {
      polys.push(points.slice(p, p + n * 2));
      p += n * 2;
    }
    if (polys.every((poly) => poly.length >= 6 && poly.every(Number.isFinite))) regions[name] = polys;
  }
  return regions;
}

/** A CSS clip-path for a region's polygons, or undefined for none. */
export function regionClip(polys: number[][] | undefined): string | undefined {
  if (!polys || polys.length === 0) return undefined;
  const d = polys.map((poly) => {
    const pts: string[] = [];
    for (let i = 0; i < poly.length; i += 2) pts.push(`${poly[i]} ${poly[i + 1]}`);
    return `M${pts.join(' L')} Z`;
  });
  return `path(evenodd, '${d.join(' ')}')`;
}

async function decodeBitmap(data: Uint8Array, name: string): Promise<{ canvas: HTMLCanvasElement } | null> {
  const type = name.endsWith('.png') ? 'image/png' : 'image/bmp';
  try {
    const bitmap = await createImageBitmap(new Blob([data.slice()], { type }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { canvas };
  } catch {
    return null;
  }
}

async function canvasSheet(canvas: HTMLCanvasElement, urls: string[]): Promise<Sheet> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  const url = blob ? URL.createObjectURL(blob) : canvas.toDataURL();
  if (blob) urls.push(url);
  return { url, width: canvas.width, height: canvas.height };
}

/** The colors down EQ_GRAPH_LINE_COLORS (eqmain.bmp at 115,294, 1×19). */
function graphColors(canvas: HTMLCanvasElement | null): string[] {
  if (!canvas || canvas.width < 116 || canvas.height < 313) return Array.from({ length: 19 }, (_, i) => `hsl(${120 - i * 6} 80% 50%)`);
  const data = canvas.getContext('2d')!.getImageData(115, 294, 1, 19).data;
  return Array.from({ length: 19 }, (_, i) => `rgb(${data[i * 4]},${data[i * 4 + 1]},${data[i * 4 + 2]})`);
}

/** Unpack a .wsz (or an already-unpacked file map). */
export async function loadWinampSkin(bytes: Uint8Array | null, name: string): Promise<WinampSkin> {
  const files = bytes ? unzipSync(bytes) : {};
  const find = finder(files);
  const urls: string[] = [];
  const defaults = makeDefaultSheets();
  const sheets = {} as Record<SheetName, Sheet | null>;
  let eqCanvas: HTMLCanvasElement | null = null;
  for (const sheet of SHEETS) {
    const data = find(`${sheet}.bmp`) ?? find(`${sheet}.png`);
    const decoded = data ? await decodeBitmap(data, find(`${sheet}.bmp`) ? `${sheet}.bmp` : `${sheet}.png`) : null;
    let canvas = decoded?.canvas ?? null;
    // Old skins lack these; the built-in skin fills in.
    if (!canvas && sheet !== 'nums_ex') canvas = defaults[sheet] ?? null;
    // An undersized eqmain lacks the slider/graph area: pad from the default.
    if (sheet === 'eqmain' && canvas && canvas.height < 315 && defaults.eqmain) {
      const padded = document.createElement('canvas');
      padded.width = Math.max(canvas.width, defaults.eqmain.width);
      padded.height = defaults.eqmain.height;
      const ctx = padded.getContext('2d')!;
      ctx.drawImage(defaults.eqmain, 0, 0);
      ctx.drawImage(canvas, 0, 0);
      canvas = padded;
    }
    if (sheet === 'eqmain') eqCanvas = canvas;
    sheets[sheet] = canvas ? await canvasSheet(canvas, urls) : null;
  }
  const vis = find('viscolor.txt');
  const pledit = find('pledit.txt');
  const region = find('region.txt');
  return {
    name,
    sheets,
    visColors: vis ? parseVisColors(decodeText(vis)) : DEFAULT_VIS_COLORS,
    playlist: pledit ? parsePlaylistColors(decodeText(pledit)) : DEFAULT_PLAYLIST,
    regions: region ? parseRegions(decodeText(region)) : {},
    graphColors: graphColors(eqCanvas),
    dispose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  };
}

/** The main window's background, as a URL (for the skin chooser's preview). */
export async function winampPreview(bytes: Uint8Array): Promise<string | null> {
  const find = finder(unzipSync(bytes));
  const data = find('main.bmp') ?? find('main.png');
  if (!data) return null;
  const decoded = await decodeBitmap(data, 'main.bmp');
  if (!decoded) return null;
  // Draw the title bar over it, as Winamp shows it.
  const title = find('titlebar.bmp');
  const titleCanvas = title ? (await decodeBitmap(title, 'titlebar.bmp'))?.canvas : null;
  if (titleCanvas) decoded.canvas.getContext('2d')!.drawImage(titleCanvas, 27, 0, 275, 14, 0, 0, 275, 14);
  return decoded.canvas.toDataURL();
}
