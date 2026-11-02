/**
 * vCards (RFC 6350, and the 3.0 and 2.1 that phones, Google and Apple
 * write): reading a file's cards as contacts, and writing contacts back as
 * vCard 3.0, which everything reads. Contacts keeps one card per file
 * (src/shared/contacts.ts); `din contacts` reads them the same way.
 */

export interface Labeled {
  /** `mobile`, `home`, `work`, `other`… or the user's own. */
  label: string;
  value: string;
}

export interface PostalAddress {
  label: string;
  street: string;
  city: string;
  region: string;
  postcode: string;
  country: string;
}

export interface Contact {
  uid: string;
  prefix: string;
  given: string;
  middle: string;
  family: string;
  suffix: string;
  /** The card's FN, for a card with no name parts (a company's); empty otherwise. */
  formatted: string;
  nickname: string;
  organization: string;
  department: string;
  title: string;
  phones: Labeled[];
  emails: Labeled[];
  urls: Labeled[];
  addresses: PostalAddress[];
  /** `YYYY-MM-DD`, `--MM-DD` with no year, or empty. */
  birthday: string;
  note: string;
  /** A `data:` URL, or empty. */
  photo: string;
  /** CATEGORIES: the groups it's in. */
  groups: string[];
  /** Lines this doesn't read, kept as they came so writing the card back loses nothing. */
  extra: string[];
  /** When it last changed (ms), from REV; 0 when unknown. */
  updated: number;
}

export const PHONE_LABELS = ['mobile', 'home', 'work', 'main', 'fax', 'pager', 'other'] as const;
export const EMAIL_LABELS = ['home', 'work', 'other'] as const;
export const URL_LABELS = ['homepage', 'home', 'work', 'other'] as const;
export const ADDRESS_LABELS = ['home', 'work', 'other'] as const;

export function blankContact(uid: string = crypto.randomUUID()): Contact {
  return {
    uid, prefix: '', given: '', middle: '', family: '', suffix: '', formatted: '', nickname: '',
    organization: '', department: '', title: '',
    phones: [], emails: [], urls: [], addresses: [],
    birthday: '', note: '', photo: '', groups: [], extra: [], updated: 0,
  };
}

// ---- Reading ----

interface Property {
  group: string;
  /** Upper case. */
  name: string;
  /** Keys upper case; TYPE values lower case. */
  params: Map<string, string[]>;
  /** As written: still escaped, quoted-printable already decoded. */
  value: string;
  raw: string;
}

/** Bare 2.1 parameters (`TEL;HOME;VOICE:`) and what they're values of. */
const ENCODINGS = new Set(['BASE64', 'B', 'QUOTED-PRINTABLE', '8BIT', '7BIT']);

/** Index of the first `sep` outside double quotes, or -1. */
function unquotedIndex(s: string, sep: string, from = 0): number {
  let quoted = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === sep && !quoted) return i;
  }
  return -1;
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const i = unquotedIndex(s, sep, at);
    if (i < 0) break;
    out.push(s.slice(at, i));
    at = i + 1;
  }
  out.push(s.slice(at));
  return out;
}

const unquote = (s: string) => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

function headOf(line: string): string {
  const i = unquotedIndex(line, ':');
  return i < 0 ? line : line.slice(0, i);
}

/** The file's lines, unfolded: continuation lines joined, and quoted-printable's soft breaks. */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const last = out.length - 1;
    if (last >= 0 && (line.startsWith(' ') || line.startsWith('\t'))) out[last] += line.slice(1);
    else if (last >= 0 && out[last].endsWith('=') && /QUOTED-PRINTABLE/i.test(headOf(out[last]))) out[last] = out[last].slice(0, -1) + line;
    else if (line.trim()) out.push(line);
  }
  return out;
}

function decodeQuotedPrintable(s: string, charset: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '=' ? s.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      for (const b of new TextEncoder().encode(s[i])) bytes.push(b);
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
}

function parseLine(line: string): Property | null {
  const colon = unquotedIndex(line, ':');
  if (colon <= 0) return null;
  const [namepart, ...paramParts] = splitUnquoted(line.slice(0, colon), ';');
  const dot = namepart.lastIndexOf('.');
  const group = dot > 0 ? namepart.slice(0, dot) : '';
  const name = namepart.slice(dot + 1).trim().toUpperCase();
  const params = new Map<string, string[]>();
  const add = (key: string, values: string[]) => params.set(key, [...(params.get(key) ?? []), ...values]);
  for (const p of paramParts) {
    const eq = p.indexOf('=');
    if (eq < 0) {
      const bare = p.trim().toUpperCase();
      if (ENCODINGS.has(bare)) add('ENCODING', [bare]);
      else if (bare) add('TYPE', [bare.toLowerCase()]);
      continue;
    }
    const key = p.slice(0, eq).trim().toUpperCase();
    const values = splitUnquoted(p.slice(eq + 1), ',').flatMap((v) => {
      const value = unquote(v.trim());
      // 4.0 quotes a list: TYPE="voice,work".
      return key === 'TYPE' ? value.split(',').map((t) => t.trim()) : [value];
    });
    add(key, key === 'TYPE' ? values.map((v) => v.toLowerCase()) : values);
  }
  let value = line.slice(colon + 1);
  if (params.get('ENCODING')?.some((e) => e.toUpperCase() === 'QUOTED-PRINTABLE')) {
    value = decodeQuotedPrintable(value, params.get('CHARSET')?.[0] ?? '');
  }
  return { group, name, params, value, raw: line };
}

/** A value split on an unescaped separator, each part unescaped. */
function splitValue(value: string, sep: string): string[] {
  const out = [''];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) out[out.length - 1] += c + value[++i];
    else if (c === sep) out.push('');
    else out[out.length - 1] += c;
  }
  return out.map(unescapeText);
}

function unescapeText(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Apple's `_$!<Mobile>!$_` as `mobile`; anything else as written. */
function abLabel(value: string): string {
  const m = /^_\$!<(.+)>!\$_$/.exec(value.trim());
  return m ? m[1].toLowerCase() : unescapeText(value.trim());
}

function phoneLabel(types: Set<string>): string {
  if (types.has('cell') || types.has('iphone') || types.has('mobile')) return 'mobile';
  if (types.has('fax')) return 'fax';
  if (types.has('pager')) return 'pager';
  if (types.has('main') || types.has('x-main')) return 'main';
  if (types.has('work')) return 'work';
  if (types.has('home')) return 'home';
  return 'other';
}

function placeLabel(types: Set<string>, fallback = 'other'): string {
  if (types.has('work')) return 'work';
  if (types.has('home')) return 'home';
  return fallback;
}

function birthdayOf(value: string, omitYear: string | undefined): string {
  const s = value.trim();
  const full = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (full) return full[1] === omitYear ? `--${full[2]}-${full[3]}` : `${full[1]}-${full[2]}-${full[3]}`;
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(s);
  return noYear ? `--${noYear[1]}-${noYear[2]}` : '';
}

function revOf(value: string): number {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2}):?(\d{2}))?/.exec(value.trim());
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isFinite(t) ? t : 0;
}

function photoOf(p: Property): string {
  const encoding = p.params.get('ENCODING')?.[0]?.toUpperCase();
  const value = p.value.trim();
  if (encoding === 'B' || encoding === 'BASE64') {
    const type = (p.params.get('TYPE') ?? []).find((t) => /^(image\/)?(jpe?g|png|gif|webp)$/.test(t))?.replace('image/', '') ?? 'jpeg';
    return `data:image/${type === 'jpg' ? 'jpeg' : type};base64,${value.replace(/\s+/g, '')}`;
  }
  const uri = value.replace(/\\,/g, ',');
  return /^data:image\/[a-z+.-]+;base64,/i.test(uri) ? uri : '';
}

/** Entries marked preferred first, in the card's order otherwise. */
function preferredFirst<T>(list: { item: T; pref: boolean }[]): T[] {
  return [...list.filter((x) => x.pref), ...list.filter((x) => !x.pref)].map((x) => x.item);
}

const isPref = (p: Property) => (p.params.get('TYPE') ?? []).includes('pref') || p.params.has('PREF');

/** Properties every card has that aren't the contact's. */
const STRUCTURAL = new Set(['BEGIN', 'END', 'VERSION', 'PRODID']);

function contactOf(props: Property[]): Contact {
  const c = blankContact('');
  const labels = new Map<string, string>();
  for (const p of props) if (p.name === 'X-ABLABEL' && p.group) labels.set(p.group, abLabel(p.value));
  const consumed = new Set<string>();
  const phones: { item: Labeled; pref: boolean }[] = [];
  const emails: { item: Labeled; pref: boolean }[] = [];
  const urls: { item: Labeled; pref: boolean }[] = [];
  const addresses: { item: PostalAddress; pref: boolean }[] = [];
  const notes: string[] = [];
  const label = (p: Property, fallback: string) => {
    if (p.group && labels.has(p.group)) {
      consumed.add(p.group);
      return labels.get(p.group)!;
    }
    return fallback;
  };

  for (const p of props) {
    const types = new Set(p.params.get('TYPE') ?? []);
    let used = true;
    switch (p.name) {
      case 'FN':
        c.formatted = unescapeText(p.value).trim();
        break;
      case 'N': {
        const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitValue(p.value, ';').map((s) => s.trim());
        Object.assign(c, { family, given, middle, prefix, suffix });
        break;
      }
      case 'NICKNAME':
        if (!c.nickname) c.nickname = splitValue(p.value, ',')[0]?.trim() ?? '';
        else used = false;
        break;
      case 'ORG':
        if (!c.organization) {
          const [organization = '', department = ''] = splitValue(p.value, ';').map((s) => s.trim());
          Object.assign(c, { organization, department });
        } else used = false;
        break;
      case 'TITLE':
        if (!c.title) c.title = unescapeText(p.value).trim();
        else used = false;
        break;
      case 'TEL': {
        const value = unescapeText(p.value).trim().replace(/^tel:/i, '');
        if (value) phones.push({ item: { label: label(p, phoneLabel(types)), value }, pref: isPref(p) });
        break;
      }
      case 'EMAIL': {
        const value = unescapeText(p.value).trim().replace(/^mailto:/i, '');
        if (value) emails.push({ item: { label: label(p, placeLabel(types)), value }, pref: isPref(p) });
        break;
      }
      case 'URL': {
        const value = unescapeText(p.value.replace(/\\:/g, ':')).trim();
        if (value) urls.push({ item: { label: label(p, placeLabel(types, 'homepage')), value }, pref: isPref(p) });
        break;
      }
      case 'ADR': {
        const [pobox = '', ext = '', street = '', city = '', region = '', postcode = '', country = ''] = splitValue(p.value, ';').map((s) => s.trim());
        const lines = [pobox && `PO Box ${pobox}`, ext, street].filter(Boolean).join('\n');
        if (lines || city || region || postcode || country) addresses.push({ item: { label: label(p, placeLabel(types)), street: lines, city, region, postcode, country }, pref: isPref(p) });
        break;
      }
      case 'BDAY': {
        const birthday = birthdayOf(p.value, p.params.get('X-APPLE-OMIT-YEAR')?.[0]);
        if (birthday && !c.birthday) c.birthday = birthday;
        else used = false;
        break;
      }
      case 'NOTE': {
        const note = unescapeText(p.value).trim();
        if (note) notes.push(note);
        break;
      }
      case 'PHOTO': {
        const photo = c.photo ? '' : photoOf(p);
        if (photo) c.photo = photo;
        else used = false;
        break;
      }
      case 'CATEGORIES':
        for (const g of splitValue(p.value, ',').map((s) => s.trim())) if (g && !c.groups.includes(g)) c.groups.push(g);
        break;
      case 'UID':
        c.uid = unescapeText(p.value).trim();
        break;
      case 'REV':
        c.updated = revOf(p.value);
        break;
      default:
        used = STRUCTURAL.has(p.name) || p.name === 'X-ABLABEL';
    }
    if (!used) c.extra.push(p.raw);
  }
  // A label kept for something this doesn't read stays with it.
  for (const p of props) if (p.name === 'X-ABLABEL' && p.group && !consumed.has(p.group)) c.extra.push(p.raw);

  c.phones = preferredFirst(phones);
  c.emails = preferredFirst(emails);
  c.urls = preferredFirst(urls);
  c.addresses = preferredFirst(addresses);
  c.note = notes.join('\n\n');
  if ([c.prefix, c.given, c.middle, c.family, c.suffix].some(Boolean)) c.formatted = '';
  // A card without a UID gets one from what it says, so it's the same card each time it's read.
  if (!c.uid) c.uid = `card-${hash(props.map((p) => p.raw).join('\n'))}`;
  return c;
}

/** FNV-1a, twice over, as 16 hex digits. */
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = Math.imul(b ^ ch, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Every card in a file (a .vcf may hold any number), in order. */
export function parseVCards(text: string): Contact[] {
  const out: Contact[] = [];
  let card: Property[] | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    const begins = p.name === 'BEGIN' && p.value.trim().toUpperCase() === 'VCARD';
    const ends = p.name === 'END' && p.value.trim().toUpperCase() === 'VCARD';
    if (begins) {
      depth++;
      if (depth === 1) card = [];
      continue;
    }
    if (ends) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && card) {
        out.push(contactOf(card));
        card = null;
      }
      continue;
    }
    // A card inside a card (2.1's AGENT) isn't read.
    if (card && depth === 1) card.push(p);
  }
  return out;
}

// ---- Writing ----

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** A line folded at 75 octets, as the RFC asks, never inside a character. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (octets + size > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const PHONE_TYPES: Record<string, string> = { mobile: 'CELL', home: 'HOME,VOICE', work: 'WORK,VOICE', main: 'MAIN', fax: 'FAX', pager: 'PAGER', other: 'OTHER' };
const PLACE_TYPES: Record<string, string> = { home: 'HOME', work: 'WORK', other: 'OTHER' };

/** The name as people say it: given, middle and family, or what stands in for one. */
export function displayName(c: Contact): string {
  const name = [c.prefix, c.given, c.middle, c.family].filter(Boolean).join(' ') + (c.suffix ? `, ${c.suffix}` : '');
  return name || c.formatted || c.nickname || c.organization || c.emails[0]?.value || c.phones[0]?.value || '';
}

function revStamp(ms: number): string {
  return new Date(ms || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A contact as a vCard 3.0, CRLF line ends, folded. */
export function serializeVCard(c: Contact): string {
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Din//Contacts//EN'];
  let item = 0;
  /** A property with a type, or with a label of the user's own as Apple and Google write it. */
  const labeled = (name: string, label: string, known: Record<string, string>, value: string, extraTypes = '') => {
    const type = known[label];
    if (type || !label) {
      lines.push(`${name}${type || extraTypes ? `;TYPE=${[extraTypes, type].filter(Boolean).join(',')}` : ''}:${value}`);
    } else {
      item++;
      lines.push(`item${item}.${name}${extraTypes ? `;TYPE=${extraTypes}` : ''}:${value}`, `item${item}.X-ABLabel:${escapeText(label)}`);
    }
  };

  lines.push(`UID:${escapeText(c.uid)}`);
  lines.push(`FN:${escapeText(displayName(c) || 'No Name')}`);
  lines.push(`N:${[c.family, c.given, c.middle, c.prefix, c.suffix].map(escapeText).join(';')}`);
  if (c.nickname) lines.push(`NICKNAME:${escapeText(c.nickname)}`);
  if (c.organization || c.department) lines.push(`ORG:${(c.department ? [c.organization, c.department] : [c.organization]).map(escapeText).join(';')}`);
  if (c.title) lines.push(`TITLE:${escapeText(c.title)}`);
  for (const p of c.phones) labeled('TEL', p.label, PHONE_TYPES, escapeText(p.value));
  for (const e of c.emails) labeled('EMAIL', e.label, PLACE_TYPES, escapeText(e.value), 'INTERNET');
  for (const a of c.addresses) {
    labeled('ADR', a.label, PLACE_TYPES, ['', '', a.street, a.city, a.region, a.postcode, a.country].map(escapeText).join(';'));
  }
  for (const u of c.urls) labeled('URL', u.label === 'homepage' ? '' : u.label, PLACE_TYPES, u.value.replace(/\s+/g, ''));
  if (c.birthday) lines.push(`BDAY:${c.birthday}`);
  if (c.note) lines.push(`NOTE:${escapeText(c.note)}`);
  const photo = /^data:image\/([a-z+.-]+);base64,(.*)$/is.exec(c.photo);
  if (photo) lines.push(`PHOTO;ENCODING=b;TYPE=${photo[1].toUpperCase()}:${photo[2]}`);
  if (c.groups.length) lines.push(`CATEGORIES:${c.groups.map(escapeText).join(',')}`);
  lines.push(`REV:${revStamp(c.updated)}`);
  // Labels of extra lines were numbered by another app: keep them clear of this card's own.
  const used = new Set(Array.from({ length: item }, (_, i) => `item${i + 1}`));
  const renamed = new Map<string, string>();
  for (const raw of c.extra) {
    const m = /^([^.:;]+)\.(.*)$/s.exec(raw);
    if (m && used.has(m[1])) {
      if (!renamed.has(m[1])) renamed.set(m[1], `item${++item}`);
      lines.push(`${renamed.get(m[1])}.${m[2]}`);
    } else lines.push(raw);
  }
  lines.push('END:VCARD');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function serializeVCards(contacts: readonly Contact[]): string {
  return contacts.map(serializeVCard).join('');
}

// ---- Comparing, sorting, searching ----

export type SortBy = 'family' | 'given';

/** What a list sorts and files the contact under. */
export function sortKey(c: Contact, by: SortBy): string {
  const parts = by === 'family' ? [c.family, c.given, c.middle] : [c.given, c.middle, c.family];
  const name = parts.filter(Boolean).join(' ');
  return (name || displayName(c)).toLocaleLowerCase();
}

export function compareContacts(a: Contact, b: Contact, by: SortBy): number {
  return sortKey(a, by).localeCompare(sortKey(b, by), undefined, { sensitivity: 'base', numeric: true });
}

/** Letters that don't come apart into a letter and an accent, filed where they sort. */
const LETTERS: Record<string, string> = { Ø: 'O', Æ: 'A', Œ: 'O', Ł: 'L', Đ: 'D', Þ: 'T', ẞ: 'S' };

/** The letter a list files it under: A–Z, or # for anything else. */
export function indexLetter(c: Contact, by: SortBy): string {
  const first = sortKey(c, by).normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
  const letter = LETTERS[first] ?? first;
  return /[A-Z]/.test(letter) ? letter : '#';
}

export function initials(c: Contact): string {
  const fromName = [c.given, c.family].filter(Boolean).map((s) => [...s][0]).join('');
  if (fromName) return fromName.toUpperCase();
  const words = displayName(c).split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return words.slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
}

/** The digits of a phone number, for matching (`+1 (555) 010-2000` and `5550102000` match). */
export function numberDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Whether a search finds it: by name, nickname, company, email, number, address or note. */
export function contactMatches(c: Contact, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3 && c.phones.some((p) => p.value.replace(/\D/g, '').includes(digits))) return true;
  const text = [
    displayName(c), c.nickname, c.organization, c.department, c.title,
    ...c.emails.map((e) => e.value), ...c.urls.map((u) => u.value),
    ...c.addresses.flatMap((a) => [a.street, a.city, a.region, a.country]),
    c.note, ...c.groups,
  ].join('\n').toLocaleLowerCase();
  return q.split(/\s+/).every((word) => text.includes(word));
}

/** Two cards for the same person: the same name, and an email or number in common (or neither has any). */
export function samePerson(a: Contact, b: Contact): boolean {
  if (displayName(a).toLocaleLowerCase() !== displayName(b).toLocaleLowerCase() || !displayName(a)) return false;
  const emails = new Set(a.emails.map((e) => e.value.toLowerCase()));
  const numbers = new Set(a.phones.map((p) => numberDigits(p.value)));
  const shares = b.emails.some((e) => emails.has(e.value.toLowerCase())) || b.phones.some((p) => numbers.has(numberDigits(p.value)));
  const bare = (c: Contact) => !c.emails.length && !c.phones.length;
  return shares || (bare(a) && bare(b));
}

/** `into` with what `from` adds: its numbers, emails, links, addresses and groups, and what `into` leaves blank. */
export function mergeContacts(into: Contact, from: Contact): Contact {
  const union = <T>(a: T[], b: T[], key: (x: T) => string) => {
    const seen = new Set(a.map(key));
    return [...a, ...b.filter((x) => !seen.has(key(x)))];
  };
  const out: Contact = { ...into };
  for (const k of ['prefix', 'given', 'middle', 'family', 'suffix', 'formatted', 'nickname', 'organization', 'department', 'title', 'birthday', 'photo'] as const) {
    if (!out[k] && from[k]) out[k] = from[k];
  }
  if ([out.prefix, out.given, out.middle, out.family, out.suffix].some(Boolean)) out.formatted = '';
  if (from.note && !out.note.includes(from.note)) out.note = out.note ? `${out.note}\n\n${from.note}` : from.note;
  out.phones = union(into.phones, from.phones, (p) => numberDigits(p.value) || p.value);
  out.emails = union(into.emails, from.emails, (e) => e.value.toLowerCase());
  out.urls = union(into.urls, from.urls, (u) => u.value);
  out.addresses = union(into.addresses, from.addresses, (a) => [a.street, a.city, a.postcode].join('|').toLowerCase());
  out.groups = union(into.groups, from.groups, (g) => g);
  out.extra = union(into.extra, from.extra, (x) => x);
  return out;
}

/** Whether two contacts say the same thing, whenever each was last changed. */
export function sameContent(a: Contact, b: Contact): boolean {
  return serializeVCard({ ...a, updated: 1 }) === serializeVCard({ ...b, updated: 1 });
}
