import { isCfb, readCfb } from '@/lib/cfb';
import type { PubDoc } from './doc';
import { read2000 } from './read2000';
import { read2002 } from './read2002';

/**
 * Microsoft Publisher documents (.pub): a compound file whose Contents
 * stream starts with a version mark. Publisher 2002 and later (through 365)
 * share one format; 2000 and 98 have older layouts of their own.
 */

export function looksLikePub(bytes: Uint8Array): boolean {
  if (!isCfb(bytes)) return false;
  try {
    const c = readCfb(bytes).stream('Contents');
    return !!c && c[0] === 0xe8 && c[1] === 0xac;
  } catch {
    return false;
  }
}

export function readPub(bytes: Uint8Array): PubDoc {
  if (!isCfb(bytes)) throw new Error('It isn’t a Publisher document (or it’s password protected).');
  const cfb = readCfb(bytes);
  const contents = cfb.stream('Contents');
  if (!contents || contents.length < 4 || contents[0] !== 0xe8 || contents[1] !== 0xac || contents[3] !== 0) {
    throw new Error('It isn’t a Publisher document Publisher can read.');
  }
  const warnings = new Set<string>();
  switch (contents[2]) {
    case 0x2c:
      return read2002(cfb, warnings);
    case 0x22:
      return read2000(cfb, warnings);
    default:
      throw new Error('It was made by a version of Publisher this one can’t read yet.');
  }
}

export type { PubDoc };
