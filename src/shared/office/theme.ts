import { at, attr, kid, kids, numAttr } from './ooxml';

/**
 * Document themes (theme1.xml): the twelve colors and two fonts every Office
 * file refers to by name ("Accent 1", "+Body"), and DrawingML's color
 * transforms (lumMod, tint, shade...) that derive the rest from them.
 */

export type ThemeColorName =
  | 'dk1' | 'lt1' | 'dk2' | 'lt2'
  | 'accent1' | 'accent2' | 'accent3' | 'accent4' | 'accent5' | 'accent6'
  | 'hlink' | 'folHlink';

export interface Theme {
  name: string;
  colors: Record<ThemeColorName, string>;
  /** Headings ("+Headings", majorFont) and body text ("+Body", minorFont). */
  majorFont: string;
  minorFont: string;
}

/** The Office theme of Office 2013–2022 (what new files get). */
export const OFFICE_THEME: Theme = {
  name: 'Office Theme',
  colors: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
    accent3: 'A5A5A5',
    accent4: 'FFC000',
    accent5: '5B9BD5',
    accent6: '70AD47',
    hlink: '0563C1',
    folHlink: '954F72',
  },
  majorFont: 'Calibri Light',
  minorFont: 'Calibri',
};

const COLOR_NAMES: ThemeColorName[] = [
  'dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink',
];

export function parseTheme(doc: Document | null): Theme {
  if (!doc) return OFFICE_THEME;
  const elements = kid(doc.documentElement, 'themeElements');
  const scheme = kid(elements, 'clrScheme');
  const colors = { ...OFFICE_THEME.colors };
  for (const name of COLOR_NAMES) {
    const el = kid(scheme, name);
    const c = el?.firstElementChild;
    if (!c) continue;
    const v = c.localName === 'sysClr' ? attr(c, 'lastClr') : attr(c, 'val');
    if (v && /^[0-9a-f]{6}$/i.test(v)) colors[name] = v.toUpperCase();
  }
  const fonts = kid(elements, 'fontScheme');
  return {
    name: attr(doc.documentElement, 'name') ?? 'Office Theme',
    colors,
    majorFont: attr(at(fonts, 'majorFont', 'latin'), 'typeface') || OFFICE_THEME.majorFont,
    minorFont: attr(at(fonts, 'minorFont', 'latin'), 'typeface') || OFFICE_THEME.minorFont,
  };
}

/** Map a scheme color name as written in files (bg1, tx1, accent1...) to the theme's. */
export function schemeName(val: string, map?: Record<string, string>): ThemeColorName | null {
  const mapped = map?.[val] ?? val;
  switch (mapped) {
    case 'bg1': case 'light1': return 'lt1';
    case 'tx1': case 'dark1': return 'dk1';
    case 'bg2': case 'light2': return 'lt2';
    case 'tx2': case 'dark2': return 'dk2';
    case 'hyperlink': return 'hlink';
    case 'followedHyperlink': return 'folHlink';
  }
  return (COLOR_NAMES as string[]).includes(mapped) ? (mapped as ThemeColorName) : null;
}

// ---- Color math ------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Lighten (tint > 0) or darken (tint < 0) by luminance, as Excel and Word's themeTint do. */
export function tintColor(hex: string, tint: number): string {
  if (!tint) return hex.toUpperCase();
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(1, nl))));
}

/** DrawingML's lumMod/lumOff: l' = l * mod + off. */
export function lumModOff(hex: string, mod: number, off: number): string {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return rgbToHex(...hslToRgb(h, s, Math.max(0, Math.min(1, l * mod + off))));
}

export interface ResolvedColor {
  hex: string;
  alpha: number;
}

/**
 * A DrawingML color element (a:srgbClr, a:schemeClr, a:sysClr, a:prstClr,
 * a:scrgbClr, a:hslClr) with its transforms applied.
 */
export function resolveColor(el: Element | null | undefined, theme: Theme, map?: Record<string, string>, phClr?: string): ResolvedColor | null {
  if (!el) return null;
  let hex: string | null;
  switch (el.localName) {
    case 'srgbClr':
      hex = attr(el, 'val');
      break;
    case 'sysClr':
      hex = attr(el, 'lastClr') ?? (attr(el, 'val') === 'window' ? 'FFFFFF' : '000000');
      break;
    case 'schemeClr': {
      const val = attr(el, 'val') ?? '';
      if (val === 'phClr') hex = phClr ?? '000000';
      else {
        const name = schemeName(val, map);
        hex = name ? theme.colors[name] : '000000';
      }
      break;
    }
    case 'prstClr':
      hex = PRESET_COLORS[attr(el, 'val') ?? ''] ?? '000000';
      break;
    case 'scrgbClr': {
      const lin = (v: number | null) => {
        const c = (v ?? 0) / 100000;
        return (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255;
      };
      hex = rgbToHex(lin(numAttr(el, 'r')), lin(numAttr(el, 'g')), lin(numAttr(el, 'b')));
      break;
    }
    case 'hslClr':
      hex = rgbToHex(...hslToRgb((numAttr(el, 'hue') ?? 0) / 21600000, (numAttr(el, 'sat') ?? 0) / 100000, (numAttr(el, 'lum') ?? 0) / 100000));
      break;
    default:
      return null;
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) hex = '000000';
  let alpha = 1;
  let [r, g, b] = hexToRgb(hex);
  let lumMod = 1;
  let lumOff = 0;
  let satMod = 1;
  for (const t of kids(el)) {
    const v = (numAttr(t, 'val') ?? 0) / 100000;
    switch (t.localName) {
      case 'alpha': alpha = v; break;
      case 'lumMod': lumMod = v; break;
      case 'lumOff': lumOff = v; break;
      case 'satMod': satMod = v; break;
      case 'tint': r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; b = 255 - (255 - b) * v; break;
      case 'shade': r *= v; g *= v; b *= v; break;
    }
  }
  hex = rgbToHex(r, g, b);
  if (lumMod !== 1 || lumOff !== 0 || satMod !== 1) {
    const [h, s, l] = rgbToHsl(...hexToRgb(hex));
    hex = rgbToHex(...hslToRgb(h, Math.min(1, s * satMod), Math.max(0, Math.min(1, l * lumMod + lumOff))));
  }
  return { hex: hex.toUpperCase(), alpha };
}

export function cssColor(c: ResolvedColor | null | undefined): string | undefined {
  if (!c) return undefined;
  if (c.alpha >= 1) return `#${c.hex}`;
  const [r, g, b] = hexToRgb(c.hex);
  return `rgba(${r}, ${g}, ${b}, ${c.alpha})`;
}

const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  cyan: '00FFFF', magenta: 'FF00FF', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3',
  orange: 'FFA500', purple: '800080', navy: '000080', teal: '008080', maroon: '800000', olive: '808000',
  silver: 'C0C0C0', lime: '00FF00', darkBlue: '00008B', darkRed: '8B0000', darkGreen: '006400',
};

// ---- The color picker's palette ----------------------------------------------------

/** The ten theme colors across the top of Office's color picker, in its order. */
export const PICKER_THEME_ORDER: ThemeColorName[] = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'];

export const PICKER_NAMES: Record<string, string> = {
  lt1: 'White, Background 1', dk1: 'Black, Text 1', lt2: 'Background 2', dk2: 'Text 2',
  accent1: 'Accent 1', accent2: 'Accent 2', accent3: 'Accent 3', accent4: 'Accent 4', accent5: 'Accent 5', accent6: 'Accent 6',
};

/** The tints and shades under each theme color: [label, tint] pairs, as Office picks them. */
export function pickerVariants(hex: string): [string, number][] {
  const [, , l] = rgbToHsl(...hexToRgb(hex));
  if (l >= 0.99) return [['Darker 5%', -0.05], ['Darker 15%', -0.15], ['Darker 25%', -0.25], ['Darker 35%', -0.35], ['Darker 50%', -0.5]];
  if (l <= 0.01) return [['Lighter 50%', 0.5], ['Lighter 35%', 0.35], ['Lighter 25%', 0.25], ['Lighter 15%', 0.15], ['Lighter 5%', 0.05]];
  if (l > 0.8) return [['Darker 10%', -0.1], ['Darker 25%', -0.25], ['Darker 50%', -0.5], ['Darker 75%', -0.75], ['Darker 90%', -0.9]];
  if (l < 0.2) return [['Lighter 90%', 0.9], ['Lighter 75%', 0.75], ['Lighter 50%', 0.5], ['Lighter 25%', 0.25], ['Lighter 10%', 0.1]];
  return [['Lighter 80%', 0.8], ['Lighter 60%', 0.6], ['Lighter 40%', 0.4], ['Darker 25%', -0.25], ['Darker 50%', -0.5]];
}

export const STANDARD_COLORS: [string, string][] = [
  ['C00000', 'Dark Red'], ['FF0000', 'Red'], ['FFC000', 'Orange'], ['FFFF00', 'Yellow'], ['92D050', 'Light Green'],
  ['00B050', 'Green'], ['00B0F0', 'Light Blue'], ['0070C0', 'Blue'], ['002060', 'Dark Blue'], ['7030A0', 'Purple'],
];

// ---- Writing a theme -------------------------------------------------------------

/** theme1.xml for new files: the Office theme, complete enough for every Office app. */
export function officeThemeXml(): string {
  const c = OFFICE_THEME.colors;
  const sys = (name: string, val: string, last: string) => `<a:${name}><a:sysClr val="${val}" lastClr="${last}"/></a:${name}>`;
  const rgb = (name: string, v: string) => `<a:${name}><a:srgbClr val="${v}"/></a:${name}>`;
  const fontGroup = (tag: string, latin: string) =>
    `<a:${tag}><a:latin typeface="${latin}" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
  const solid = (mods: string) => `<a:solidFill><a:schemeClr val="phClr">${mods}</a:schemeClr></a:solidFill>`;
  const grad = (stops: string[]) =>
    `<a:gradFill rotWithShape="1"><a:gsLst>${stops
      .map((s, i) => `<a:gs pos="${[0, 50000, 100000][i]}"><a:schemeClr val="phClr">${s}</a:schemeClr></a:gs>`)
      .join('')}</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
  const line = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements>' +
    '<a:clrScheme name="Office">' +
    sys('dk1', 'windowText', c.dk1) + sys('lt1', 'window', c.lt1) + rgb('dk2', c.dk2) + rgb('lt2', c.lt2) +
    rgb('accent1', c.accent1) + rgb('accent2', c.accent2) + rgb('accent3', c.accent3) + rgb('accent4', c.accent4) +
    rgb('accent5', c.accent5) + rgb('accent6', c.accent6) + rgb('hlink', c.hlink) + rgb('folHlink', c.folHlink) +
    '</a:clrScheme>' +
    '<a:fontScheme name="Office">' + fontGroup('majorFont', OFFICE_THEME.majorFont) + fontGroup('minorFont', OFFICE_THEME.minorFont) + '</a:fontScheme>' +
    '<a:fmtScheme name="Office"><a:fillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    grad(['<a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/>', '<a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/>', '<a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/>']) +
    grad(['<a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/>', '<a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/>', '<a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/>']) +
    '</a:fillStyleLst><a:lnStyleLst>' + line(6350) + line(12700) + line(19050) + '</a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' + solid('<a:tint val="95000"/><a:satMod val="170000"/>') +
    grad(['<a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/>', '<a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/>', '<a:shade val="63000"/><a:satMod val="120000"/>']) +
    '</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}
