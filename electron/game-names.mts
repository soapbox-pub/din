// Reading games' file names (electron/games.mts), which in a collection
// like ~/roms follow No-Intro's and Redump's conventions:
//
//   Legend of Zelda, The - A Link to the Past (USA) (Rev 1).sfc
//   0004 - Legend of Zelda, The - Ocarina of Time 3D (Europe) (En,Fr) Decrypted.3ds
//   Super Mario 3D World Bowsers Fury [010028600EBDA000][v0] (2.87 GB).nsz
//
// into a title as people write it ("The Legend of Zelda: A Link to the
// Past"), what sets each copy apart (region, revision, disc), and whether a
// copy is one to show at all: BIOS files, bad dumps, demos and test
// programs never are; betas and prototypes only when they're all there is.
// Copies of one game (regions, revisions) are grouped, the best for the
// computer's language first.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

export interface ParsedName {
  /** The title as written in the name, articles and all: "Legend of Zelda, The - A Link to the Past". */
  raw: string;
  /** As people write it: "The Legend of Zelda: A Link to the Past". */
  title: string;
  /** For grouping copies and matching art: lowercase letters and digits only. */
  key: string;
  /** The (…) and […] tags, without their brackets. */
  tags: string[];
  regions: string[];
  /** A BIOS, bad dump, demo or test program: never shown. */
  junk: boolean;
  /** A beta or prototype: shown only when no released copy is there. */
  prerelease: boolean;
  /** "Rev 1", "v1.1", as a number to prefer the newest; 0 for the first. */
  revision: number;
  /** Disc number for multi-disc games, else 0. */
  disc: number;
}

const REGIONS = new Set([
  'USA', 'World', 'Europe', 'Japan', 'Australia', 'Canada', 'UK', 'United Kingdom', 'Germany', 'France', 'Spain', 'Italy', 'Netherlands',
  'Sweden', 'Denmark', 'Norway', 'Finland', 'Korea', 'China', 'Taiwan', 'Hong Kong', 'Asia', 'Brazil', 'Russia', 'Scandinavia',
  'Latin America', 'Mexico', 'Portugal', 'Greece', 'Poland', 'Belgium', 'Austria', 'Switzerland', 'Unknown',
  // GoodTools' and scene names' short forms.
  'U', 'E', 'J', 'JU', 'UE', 'JUE', 'US', 'EU', 'JP', 'JPN', 'NTSC', 'PAL', 'NTSC-U', 'NTSC-J',
]);
const SHORT_REGIONS: Record<string, string> = {
  U: 'USA', US: 'USA', 'NTSC-U': 'USA', E: 'Europe', EU: 'Europe', PAL: 'Europe', J: 'Japan', JP: 'Japan', JPN: 'Japan', 'NTSC-J': 'Japan',
  JU: 'USA', UE: 'USA', JUE: 'USA', NTSC: 'USA',
};

const JUNK_TAG = /^(bios|demo|sample|kiosk|promo|program|test program|debug|pirate|hack|trainer|overdump|b|h|o|t|p|b\d|h\d|o\d|t\d|p\d|bad|update|dlc|unl beta)\b/i;
const PRERELEASE_TAG = /^(beta|proto|prototype|alpha|preview|pre-release|possible proto|early)\b/i;
const ARTICLES = ['The', 'A', 'An', 'Les', 'Le', 'La', "L'", 'Die', 'Der', 'Das', 'El', 'Los', 'Las', 'Il', 'Lo', 'De', 'Het'];

/** A file's name without its extension, and without the wrappings some collections add. */
export function stem(name: string, numbered = false): string {
  let s = name.replace(/\.[a-z0-9]{1,5}$/i, '');
  // A numbered collection's: "0004 - Legend of … Decrypted", "0001 Electroplankton (JP)".
  s = s.replace(numbered ? /^\d{4}\s+(?:-\s+)?/ : /^\d{4} - /, '').replace(/\s+Decrypted$/i, '');
  // Scene and download names: underscores or pluses for spaces.
  if (!s.includes(' ') && /[_+]/.test(s)) s = s.replace(/[_+]+/g, ' ');
  return s.replace(/_split$/i, '').trim();
}

/**
 * Whether a folder's names are numbered ("0001 Electroplankton (JP)"), which
 * only most of them being so tells from a game whose title starts with a
 * year ("1942").
 */
export function isNumbered(names: string[]): boolean {
  const numbered = names.filter((n) => /^\d{4}\s/.test(n)).length;
  return names.length >= 5 && numbered / names.length > 0.8;
}

export function parseName(fileName: string, numbered = false): ParsedName {
  const s = stem(fileName, numbered);
  const tags: string[] = [];
  for (const m of s.matchAll(/\(([^()]*)\)|\[([^[\]]*)\]/g)) tags.push((m[1] ?? m[2] ?? '').trim());
  const cut = s.search(/\s*[([]/);
  let raw = (cut > 0 ? s.slice(0, cut) : s).trim();
  // "[BIOS] Nintendo Game Boy Boot ROM (World)": the tag comes first.
  const leadingBios = /^\[bios\]/i.test(s);
  let junk = leadingBios;
  if (leadingBios || cut === 0) raw = s.replace(/\([^()]*\)|\[[^[\]]*\]/g, '').trim();
  // Trailing system names some collections append: "1080 Avalanche GameCube".
  raw = raw.replace(/\s*(GameCube|\bWii|\bNSP|\bNSZ|\bXCI)$/i, '').replace(/\s+/g, ' ');
  // An update packaged as a game: "Ever Oasis USA Update 1.1".
  if (/\b(update|dlc)\b\s*v?\d/i.test(raw)) junk = true;

  const regions: string[] = [];
  let revision = 0;
  let disc = 0;
  let prerelease = false;
  for (const tag of tags) {
    const parts = tag.split(/\s*,\s*/);
    if (parts.length && parts.every((p) => REGIONS.has(p))) {
      for (const p of parts) regions.push(SHORT_REGIONS[p] ?? p);
      continue;
    }
    const rev = /^(?:rev\s*([0-9a-z.]+)|v\s*(\d+(?:\.\d+)*))$/i.exec(tag);
    if (rev) {
      const value = rev[1] ?? rev[2] ?? '0';
      revision = /^[a-z]$/i.test(value) ? value.toLowerCase().charCodeAt(0) - 96 : parseFloat(value) || 0;
      continue;
    }
    const d = /^(?:disc|disk|cd)\s*(\d+)/i.exec(tag);
    if (d) {
      disc = Number(d[1]);
      continue;
    }
    if (JUNK_TAG.test(tag)) junk = true;
    else if (PRERELEASE_TAG.test(tag)) prerelease = true;
  }
  // A Switch title id ([0100…800]) that isn't the base game's (…000) is an update or DLC.
  if (tags.some((t) => /^0100[0-9A-F]{12}$/i.test(t) && !/000$/.test(t))) junk = true;
  if (tags.some((t) => /^v\d{4,}$/.test(t))) junk = true;

  const title = displayTitle(raw);
  return { raw, title, key: titleKey(title), tags, regions, junk, prerelease, revision, disc };
}

/** "Legend of Zelda, The - A Link to the Past" → "The Legend of Zelda: A Link to the Past". */
export function displayTitle(raw: string): string {
  let t = raw;
  for (const article of ARTICLES) {
    // "Legend of Zelda, The - A Link to the Past" and "Addams Family, The".
    const re = new RegExp(`^(.+?), ${article.replace("'", "\\'")}(\\s+-\\s+.*|$)`);
    const m = re.exec(t);
    if (m) {
      t = `${article}${article.endsWith("'") ? '' : ' '}${m[1]}${m[2]}`;
      break;
    }
  }
  // No-Intro writes a subtitle's colon as " - ".
  t = t.replace(/\s+-\s+/, ': ');
  return t.trim() || raw;
}

/** What two copies of one game share, whatever their punctuation: "thelegendofzeldaalinktothepast". */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[&+]/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

/** For sorting: without a leading article. */
export function sortKey(title: string): string {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, '');
}

/**
 * The regions this computer's language prefers, best first: a game's copies
 * are ranked by them. English outside the UK and Commonwealth plays USA
 * copies first (60 Hz, English); elsewhere in Europe, European ones.
 */
export function regionPreference(locale: string): string[] {
  const [lang, country = ''] = locale.split(/[-_]/);
  const l = lang.toLowerCase();
  const c = country.toUpperCase();
  if (l === 'ja') return ['Japan', 'World', 'USA', 'Asia', 'Europe'];
  if (l === 'ko') return ['Korea', 'Asia', 'World', 'USA', 'Japan', 'Europe'];
  if (l === 'zh') return ['China', 'Taiwan', 'Hong Kong', 'Asia', 'World', 'USA', 'Japan', 'Europe'];
  const european: Record<string, string> = { de: 'Germany', fr: 'France', es: 'Spain', it: 'Italy', nl: 'Netherlands', sv: 'Sweden', pt: 'Portugal', ru: 'Russia' };
  if (l === 'en' && ['GB', 'IE', 'AU', 'NZ'].includes(c)) return ['Europe', c === 'AU' || c === 'NZ' ? 'Australia' : 'UK', 'World', 'USA', 'Canada', 'Japan'];
  if (l === 'pt' && c === 'BR') return ['Brazil', 'USA', 'World', 'Europe', 'Japan'];
  if (european[l]) return [european[l], 'Europe', 'World', 'USA', 'Japan'];
  return ['USA', 'World', 'Canada', 'Europe', 'Australia', 'UK', 'Japan'];
}

/** How good a copy is to play, higher first. */
export function versionScore(parsed: ParsedName, preference: string[], extension: string): number {
  let score = 0;
  const ranks = parsed.regions.map((r) => preference.indexOf(r)).filter((i) => i >= 0);
  score += ranks.length ? (preference.length - Math.min(...ranks)) * 100 : parsed.regions.length ? 10 : 50;
  // Has English, when that's what the computer speaks.
  if (parsed.tags.some((t) => /(^|,)En(,|$)/.test(t))) score += 20;
  score += Math.min(parsed.revision, 9) * 2;
  if (parsed.prerelease) score -= 2000;
  // Rereleases inside other games, and unlicensed copies, after the real thing.
  if (parsed.tags.some((t) => /virtual console|switch online|gamecube|collection|classic mini|aftermarket|unl|alt|proto/i.test(t))) score -= 30;
  // A playlist of every disc is the way to play a multi-disc game.
  if (extension === 'm3u') score += 500;
  if (parsed.disc > 1) score -= parsed.disc;
  return score;
}

/** What sets one copy apart from another of the same game: "USA, Rev 1". */
export function versionLabel(parsed: ParsedName): string {
  const parts = parsed.tags.filter(
    (t) =>
      t &&
      !/^(!|0100[0-9A-F]{12}|v0|\d+(\.\d+)? [GM]B|M\d+|CHD|compressed)$/i.test(t) &&
      !/^[A-Z][a-z](,[A-Z][a-z])+$/.test(t) &&
      !/\.(com|net|org|io)$/i.test(t),
  );
  return parts.join(', ') || 'Original';
}
