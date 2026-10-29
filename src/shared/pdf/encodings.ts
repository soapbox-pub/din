/**
 * The character encodings PDF fonts use (Standard, WinAnsi, MacRoman),
 * and glyph names to text, for fonts that don't say what their codes mean.
 */

const ASCII_NAMES = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright', 'parenleft', 'parenright', 'asterisk', 'plus',
  'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon',
  'less', 'equal', 'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
  'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'quoteleft', 'a', 'b', 'c', 'd',
  'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar',
  'braceright', 'asciitilde',
];

function table(entries: [number, string][], ascii: string[] = ASCII_NAMES): string[] {
  const t: string[] = new Array(256).fill('');
  ascii.forEach((n, i) => (t[32 + i] = n));
  for (const [c, n] of entries) t[c] = n;
  return t;
}

export const STANDARD = table([
  [161, 'exclamdown'], [162, 'cent'], [163, 'sterling'], [164, 'fraction'], [165, 'yen'], [166, 'florin'], [167, 'section'], [168, 'currency'],
  [169, 'quotesingle'], [170, 'quotedblleft'], [171, 'guillemotleft'], [172, 'guilsinglleft'], [173, 'guilsinglright'], [174, 'fi'], [175, 'fl'],
  [177, 'endash'], [178, 'dagger'], [179, 'daggerdbl'], [180, 'periodcentered'], [182, 'paragraph'], [183, 'bullet'], [184, 'quotesinglbase'],
  [185, 'quotedblbase'], [186, 'quotedblright'], [187, 'guillemotright'], [188, 'ellipsis'], [189, 'perthousand'], [191, 'questiondown'],
  [193, 'grave'], [194, 'acute'], [195, 'circumflex'], [196, 'tilde'], [197, 'macron'], [198, 'breve'], [199, 'dotaccent'], [200, 'dieresis'],
  [202, 'ring'], [203, 'cedilla'], [205, 'hungarumlaut'], [206, 'ogonek'], [207, 'caron'], [208, 'emdash'], [225, 'AE'], [227, 'ordfeminine'],
  [232, 'Lslash'], [233, 'Oslash'], [234, 'OE'], [235, 'ordmasculine'], [241, 'ae'], [245, 'dotlessi'], [248, 'lslash'], [249, 'oslash'],
  [250, 'oe'], [251, 'germandbls'],
]);

const LATIN1_NAMES = [
  'space', 'exclamdown', 'cent', 'sterling', 'currency', 'yen', 'brokenbar', 'section', 'dieresis', 'copyright', 'ordfeminine', 'guillemotleft',
  'logicalnot', 'hyphen', 'registered', 'macron', 'degree', 'plusminus', 'twosuperior', 'threesuperior', 'acute', 'mu', 'paragraph',
  'periodcentered', 'cedilla', 'onesuperior', 'ordmasculine', 'guillemotright', 'onequarter', 'onehalf', 'threequarters', 'questiondown',
  'Agrave', 'Aacute', 'Acircumflex', 'Atilde', 'Adieresis', 'Aring', 'AE', 'Ccedilla', 'Egrave', 'Eacute', 'Ecircumflex', 'Edieresis',
  'Igrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Eth', 'Ntilde', 'Ograve', 'Oacute', 'Ocircumflex', 'Otilde', 'Odieresis', 'multiply',
  'Oslash', 'Ugrave', 'Uacute', 'Ucircumflex', 'Udieresis', 'Yacute', 'Thorn', 'germandbls', 'agrave', 'aacute', 'acircumflex', 'atilde',
  'adieresis', 'aring', 'ae', 'ccedilla', 'egrave', 'eacute', 'ecircumflex', 'edieresis', 'igrave', 'iacute', 'icircumflex', 'idieresis', 'eth',
  'ntilde', 'ograve', 'oacute', 'ocircumflex', 'otilde', 'odieresis', 'divide', 'oslash', 'ugrave', 'uacute', 'ucircumflex', 'udieresis',
  'yacute', 'thorn', 'ydieresis',
];

const WIN_ASCII = [...ASCII_NAMES];
WIN_ASCII[39 - 32] = 'quotesingle';
WIN_ASCII[96 - 32] = 'grave';

export const WIN_ANSI = table(
  [
    [128, 'Euro'], [130, 'quotesinglbase'], [131, 'florin'], [132, 'quotedblbase'], [133, 'ellipsis'], [134, 'dagger'], [135, 'daggerdbl'],
    [136, 'circumflex'], [137, 'perthousand'], [138, 'Scaron'], [139, 'guilsinglleft'], [140, 'OE'], [142, 'Zcaron'], [145, 'quoteleft'],
    [146, 'quoteright'], [147, 'quotedblleft'], [148, 'quotedblright'], [149, 'bullet'], [150, 'endash'], [151, 'emdash'], [152, 'tilde'],
    [153, 'trademark'], [154, 'scaron'], [155, 'guilsinglright'], [156, 'oe'], [158, 'zcaron'], [159, 'Ydieresis'],
    ...LATIN1_NAMES.map((n, i) => [160 + i, n] as [number, string]),
  ],
  WIN_ASCII,
);
WIN_ANSI[160] = 'space';
WIN_ANSI[173] = 'hyphen';

export const MAC_ROMAN = table(
  [
    ...[
      'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex', 'adieresis', 'atilde',
      'aring', 'ccedilla', 'eacute', 'egrave', 'ecircumflex', 'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde', 'oacute',
      'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex', 'udieresis', 'dagger', 'degree', 'cent', 'sterling',
      'section', 'bullet', 'paragraph', 'germandbls', 'registered', 'copyright', 'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash',
      'infinity', 'plusminus', 'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product', 'pi', 'integral', 'ordfeminine',
      'ordmasculine', 'Omega', 'ae', 'oslash', 'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal', 'Delta',
      'guillemotleft', 'guillemotright', 'ellipsis', 'space', 'Agrave', 'Atilde', 'Otilde', 'OE', 'oe', 'endash', 'emdash', 'quotedblleft',
      'quotedblright', 'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis', 'Ydieresis', 'fraction', 'currency', 'guilsinglleft',
      'guilsinglright', 'fi', 'fl', 'daggerdbl', 'periodcentered', 'quotesinglbase', 'quotedblbase', 'perthousand', 'Acircumflex', 'Ecircumflex',
      'Aacute', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave', 'Oacute', 'Ocircumflex', 'apple', 'Ograve', 'Uacute',
      'Ucircumflex', 'Ugrave', 'dotlessi', 'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut', 'ogonek',
      'caron',
    ].map((n, i) => [128 + i, n] as [number, string]),
  ],
  WIN_ASCII.map((n, i) => (i === 39 - 32 ? 'quotesingle' : i === 96 - 32 ? 'grave' : n)),
);

export const ENCODINGS: Record<string, string[]> = {
  StandardEncoding: STANDARD,
  WinAnsiEncoding: WIN_ANSI,
  MacRomanEncoding: MAC_ROMAN,
  MacExpertEncoding: STANDARD,
  PDFDocEncoding: WIN_ANSI,
};

/** cp1252's 128–159, for names to text. */
const CP1252: Record<number, number> = {
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160,
  139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014,
  152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178,
};

const NAME_TO_CHAR = new Map<string, string>();
for (let c = 32; c < 256; c++) {
  const n = WIN_ANSI[c];
  if (!n || NAME_TO_CHAR.has(n)) continue;
  NAME_TO_CHAR.set(n, String.fromCharCode(CP1252[c] ?? c));
}
NAME_TO_CHAR.set('quotesingle', "'");
NAME_TO_CHAR.set('grave', '`');
NAME_TO_CHAR.set('quoteright', '\u2019');
NAME_TO_CHAR.set('quoteleft', '\u2018');
const EXTRA: [string, number][] = [
  ['fi', 0xfb01], ['fl', 0xfb02], ['ff', 0xfb00], ['ffi', 0xfb03], ['ffl', 0xfb04], ['fraction', 0x2044], ['dotlessi', 0x131], ['Lslash', 0x141],
  ['lslash', 0x142], ['breve', 0x2d8], ['dotaccent', 0x2d9], ['ring', 0x2da], ['ogonek', 0x2db], ['caron', 0x2c7], ['hungarumlaut', 0x2dd],
  ['minus', 0x2212], ['notequal', 0x2260], ['infinity', 0x221e], ['lessequal', 0x2264], ['greaterequal', 0x2265], ['partialdiff', 0x2202],
  ['summation', 0x2211], ['product', 0x220f], ['pi', 0x3c0], ['integral', 0x222b], ['Omega', 0x3a9], ['radical', 0x221a],
  ['approxequal', 0x2248], ['Delta', 0x2206], ['lozenge', 0x25ca], ['apple', 0xf8ff], ['nbspace', 0xa0], ['sfthyphen', 0xad],
  ['uni00A0', 0xa0], ['Euro', 0x20ac], ['Scaron', 0x160], ['scaron', 0x161], ['Zcaron', 0x17d], ['zcaron', 0x17e], ['Ydieresis', 0x178],
  ['periodcentered', 0xb7], ['bullet', 0x2022], ['endash', 0x2013], ['emdash', 0x2014], ['ellipsis', 0x2026], ['trademark', 0x2122],
  ['arrowright', 0x2192], ['arrowleft', 0x2190], ['arrowup', 0x2191], ['arrowdown', 0x2193], ['checkmark', 0x2713], ['ampersand', 0x26],
];
for (const [n, c] of EXTRA) NAME_TO_CHAR.set(n, String.fromCodePoint(c));

/** A glyph name's text: standard names, uniXXXX, uXXXX[XX], and ligature/suffix forms like "f_f" and "a.sc". */
export function glyphNameToText(name: string): string {
  const direct = NAME_TO_CHAR.get(name);
  if (direct !== undefined) return direct;
  const base = name.split('.')[0];
  if (base !== name && base) return glyphNameToText(base);
  if (name.includes('_')) return name.split('_').map(glyphNameToText).join('');
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^(?:g|glyph|cid|c)(\d+)$/.exec(name);
  if (m) return '';
  if (name.length === 1) return name;
  return '';
}

const CHAR_TO_WIN = new Map<number, number>();
for (let c = 255; c >= 32; c--) {
  const t = glyphNameToText(WIN_ANSI[c]);
  if (t && t.length === 1) CHAR_TO_WIN.set(t.charCodeAt(0), c);
}
CHAR_TO_WIN.set(32, 32);
CHAR_TO_WIN.set(45, 45);

/** A character's WinAnsiEncoding code, or null if it has none. */
export function winAnsiCode(ch: string): number | null {
  return CHAR_TO_WIN.get(ch.charCodeAt(0)) ?? null;
}
