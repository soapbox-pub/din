/**
 * `blossom:` URIs (BUD-10): a Blossom blob by its sha256, with hints for
 * finding it, like a magnet link.
 *
 *     blossom:<sha256>.<ext>?xs=cdn.example.com&as=<pubkey>&sz=184292
 *
 * `xs` names a server that may have the blob (repeatable), `as` an author whose
 * BUD-03 server list (kind 10063) may (repeatable), and `sz` its size in bytes.
 *
 * Din serves these itself, in the Electron main process (electron/blossom.mts,
 * which has its own copy of this grammar): the Web Browser loads one like a
 * web page, and the file shows as it would from the web, a PDF in the PDF
 * viewer, a video with its controls. Every byte is checked against the hash.
 */

/** A `blossom:` URI, decoded. */
export interface ParsedBlossomUri {
  /** The URI in canonical form: lowercase hash and extension, hints in order. */
  uri: string;
  /** The blob's sha256, 64 lowercase hex characters. */
  sha256: string;
  /** Its file extension, without the dot (`bin` when unknown). */
  ext: string;
  /** Servers that may have it, as given (a domain, or an https:// URL). */
  servers: string[];
  /** Hex pubkeys of authors whose server lists may name it. */
  authors: string[];
  /** Its size in bytes, when the URI says. */
  size: number | null;
}

export const BLOSSOM_PROTOCOL = 'blossom:';

/** Longest URI accepted, and most hints of each kind kept. */
const MAX_LENGTH = 4096;
const MAX_HINTS = 8;

const URI_RE = /^blossom:(?:\/\/)?([0-9a-f]{64})\.([a-z0-9]{1,16})\/?(?:\?([^#]*))?(?:#.*)?$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/** Whether an `xs` value is a domain, or an http(s) URL of one. */
function isServerHint(value: string): boolean {
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).hostname !== '';
    } catch {
      return false;
    }
  }
  return HOST_RE.test(value) && value.includes('.');
}

/** Parse a `blossom:` URI (`blossom://` too), or null if it isn't one. */
export function parseBlossomUri(input: string): ParsedBlossomUri | null {
  const trimmed = input.trim();
  if (trimmed.length > MAX_LENGTH) return null;
  const match = URI_RE.exec(trimmed);
  if (!match) return null;

  const sha256 = match[1].toLowerCase();
  const ext = match[2].toLowerCase();
  const params = new URLSearchParams(match[3] ?? '');

  const servers = [...new Set(params.getAll('xs').map((value) => value.trim()).filter(isServerHint))].slice(0, MAX_HINTS);
  const authors = [...new Set(params.getAll('as').filter((value) => PUBKEY_RE.test(value)).map((value) => value.toLowerCase()))].slice(0, MAX_HINTS);
  const rawSize = params.get('sz');
  const size = rawSize && /^\d{1,15}$/.test(rawSize) && Number(rawSize) > 0 ? Number(rawSize) : null;

  // Written by hand rather than by URLSearchParams, which would escape an
  // `xs` URL's `://` where BUD-10's examples leave it as it is.
  const hint = (value: string) => encodeURIComponent(value).replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  const search = [
    ...servers.map((server) => `xs=${hint(server)}`),
    ...authors.map((author) => `as=${author}`),
    ...(size !== null ? [`sz=${size}`] : []),
  ].join('&');

  return {
    uri: `blossom:${sha256}.${ext}${search ? `?${search}` : ''}`,
    sha256,
    ext,
    servers,
    authors,
    size,
  };
}

/** Whether a string is a `blossom:` URI. */
export function isBlossomUri(input: string): boolean {
  return parseBlossomUri(input) !== null;
}
