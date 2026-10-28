/**
 * Apple's XML property lists, as much as Mousecape capes use: dict, array,
 * key, string, integer, real, true, false, data, date.
 *
 * A small parser of its own rather than an XML library: it knows only the
 * five predefined entities and numeric character references, skips any
 * DOCTYPE without reading it (so no entity can be defined, let alone
 * expanded), and caps nesting and the number of values.
 */

import { DAMAGED, ImportError, LIMITS, TOO_BIG } from './bytes';

export type PlistValue = string | number | boolean | Uint8Array | PlistValue[] | { [key: string]: PlistValue };

const MAX_VALUES = 200_000;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescape(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const value = ENTITIES[name];
    if (value === undefined) throw new ImportError(DAMAGED);
    return value;
  });
}

const BASE64 = new Uint8Array(128).fill(255);
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, i) => {
  BASE64[c.charCodeAt(0)] = i;
});

/** Base64 to bytes, whitespace ignored. */
export function decodeBase64(source: string): Uint8Array {
  const out = new Uint8Array(Math.floor((source.length * 3) / 4) + 3);
  let length = 0;
  let bits = 0;
  let count = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 61) break;
    if (c === 32 || c === 9 || c === 10 || c === 13) continue;
    const value = c < 128 ? BASE64[c] : 255;
    if (value === 255) throw new ImportError(DAMAGED);
    bits = (bits << 6) | value;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[length++] = (bits >> count) & 0xff;
    }
  }
  return out.slice(0, length);
}

/** Parse an XML plist's top-level value. */
export function parsePlist(source: string): PlistValue {
  let p = 0;
  let values = 0;

  const fail = (): never => {
    throw new ImportError(DAMAGED);
  };

  /** Skip whitespace, the XML declaration, comments and any DOCTYPE. */
  const skipMisc = () => {
    for (;;) {
      while (p < source.length && /\s/.test(source[p])) p++;
      if (source.startsWith('<?', p)) {
        const end = source.indexOf('?>', p);
        if (end < 0) fail();
        p = end + 2;
      } else if (source.startsWith('<!--', p)) {
        const end = source.indexOf('-->', p);
        if (end < 0) fail();
        p = end + 3;
      } else if (source.startsWith('<!DOCTYPE', p)) {
        // An internal subset ([...]) is skipped whole; nothing in it is used.
        const bracket = source.indexOf('[', p);
        const close = source.indexOf('>', p);
        if (close < 0) fail();
        if (bracket >= 0 && bracket < close) {
          const end = source.indexOf(']>', bracket);
          if (end < 0) fail();
          p = end + 2;
        } else {
          p = close + 1;
        }
      } else {
        return;
      }
    }
  };

  /** The next tag: its name, and whether it closes or is empty. */
  const tag = (): { name: string; closing: boolean; empty: boolean } => {
    skipMisc();
    if (source[p] !== '<') fail();
    const end = source.indexOf('>', p);
    if (end < 0) fail();
    const inner = source.slice(p + 1, end).trim();
    p = end + 1;
    const closing = inner.startsWith('/');
    const empty = inner.endsWith('/');
    const name = /^\/?([A-Za-z]+)/.exec(inner)?.[1] ?? fail();
    return { name, closing, empty };
  };

  // Where the next CDATA section starts (-1: none left), found once per
  // section rather than searched for from every value.
  let cdataAt = -2;
  const nextCdata = () => {
    if (cdataAt !== -1 && cdataAt < p) cdataAt = source.indexOf('<![CDATA[', p);
    return cdataAt;
  };

  /** Text up to `</name>`, with CDATA sections taken as they are. */
  const content = (name: string): string => {
    const close = `</${name}>`;
    let result = '';
    for (;;) {
      const cdata = nextCdata();
      const end = source.indexOf(close, p);
      if (end < 0) fail();
      if (cdata >= 0 && cdata < end) {
        result += unescape(source.slice(p, cdata));
        const cdataEnd = source.indexOf(']]>', cdata);
        if (cdataEnd < 0) fail();
        result += source.slice(cdata + 9, cdataEnd);
        p = cdataEnd + 3;
        continue;
      }
      result += unescape(source.slice(p, end));
      p = end + close.length;
      return result;
    }
  };

  const value = (opened: { name: string; closing: boolean; empty: boolean }, depth: number): PlistValue => {
    if (depth > LIMITS.depth) fail();
    if (++values > MAX_VALUES) throw new ImportError(TOO_BIG);
    const { name, closing, empty } = opened;
    if (closing) fail();
    switch (name) {
      case 'true':
      case 'false':
        if (!empty) content(name);
        return name === 'true';
      case 'string':
      case 'date':
        return empty ? '' : content(name);
      case 'integer':
      case 'real': {
        const n = Number(empty ? '' : content(name).trim());
        return Number.isFinite(n) ? n : fail();
      }
      case 'data':
        return empty ? new Uint8Array() : decodeBase64(content(name));
      case 'array': {
        const items: PlistValue[] = [];
        if (empty) return items;
        for (;;) {
          const next = tag();
          if (next.closing) {
            if (next.name !== 'array') fail();
            return items;
          }
          items.push(value(next, depth + 1));
        }
      }
      case 'dict': {
        const dict: { [key: string]: PlistValue } = Object.create(null);
        if (empty) return dict;
        for (;;) {
          const next = tag();
          if (next.closing) {
            if (next.name !== 'dict') fail();
            return dict;
          }
          if (next.name !== 'key' || next.empty) fail();
          const key = content('key');
          dict[key] = value(tag(), depth + 1);
        }
      }
      default:
        return fail();
    }
  };

  const root = tag();
  if (root.name === 'plist' && !root.closing) {
    const result = value(tag(), 1);
    const end = tag();
    if (!end.closing || end.name !== 'plist') fail();
    return result;
  }
  return value(root, 0);
}
