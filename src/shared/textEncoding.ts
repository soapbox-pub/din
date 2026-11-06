/**
 * Text files in the encodings they come in. Most are UTF-8, but Windows
 * writes many as UTF-16 with a byte order mark (desktop.ini, .reg exports,
 * PowerShell's redirected output), and Notepad long put a BOM on UTF-8 too.
 * A file is read by its BOM and saved back the way it came.
 */

export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

/** The encoding a file's first bytes name, UTF-8 when they name none. */
export function detectEncoding(bytes: Uint8Array): TextEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

/** A file's text, without its BOM, and the encoding to save it back in. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  const encoding = detectEncoding(bytes);
  const label = encoding === 'utf-8-bom' ? 'utf-8' : encoding;
  // TextDecoder drops the BOM by itself.
  return { text: new TextDecoder(label, { fatal: false }).decode(bytes), encoding };
}

/** Whether bytes are UTF-16 by their BOM (its null bytes don't make it binary). */
export function isUtf16(bytes: Uint8Array): boolean {
  const encoding = detectEncoding(bytes);
  return encoding === 'utf-16le' || encoding === 'utf-16be';
}

/** Text as the bytes of a file in `encoding` (UTF-8 as a plain string). */
export function encodeText(text: string, encoding: TextEncoding = 'utf-8'): string | Uint8Array {
  if (encoding === 'utf-8') return text;
  if (encoding === 'utf-8-bom') {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  const little = encoding === 'utf-16le';
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), little);
  return out;
}
