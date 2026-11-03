// Saving files other devices send (phone-receive.mts and quickshare.mts)
// into Downloads, under names of their own.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';

/** A file name from another device, made safe to put in Downloads. */
export function safeFileName(name: string): string {
  const cleaned = path
    .basename(name.replace(/\\/g, '/'))
    // Control characters, and the ones that reorder text, which would show
    // "photo\u202Egpj.exe" as "photoexe.jpg".
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!cleaned) return 'file';
  // Linux allows 255 bytes; leave room for " (12)".
  let out = cleaned;
  while (Buffer.byteLength(out) > 240) {
    const ext = path.extname(out);
    const stem = out.slice(0, out.length - ext.length);
    out = stem.length > 1 ? stem.slice(0, -1) + ext : out.slice(0, -1);
  }
  return out;
}

/** Claim a name in `dir` no file has, creating it empty so a second share can't take it too. */
export function claim(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'file';
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n ? `${stem} (${n})${ext}` : name);
    try {
      fs.closeSync(fs.openSync(candidate, 'wx', 0o644));
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export function freeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}
