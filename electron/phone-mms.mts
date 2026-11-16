// Picture and group messages (MMS) over Bluetooth, for phone-map.mts.
//
// A phone that has them (an Android phone's MAP server lists them; an
// iPhone's doesn't) sends one as a bMessage whose body is an RFC 2822
// message: From, To and Cc headers naming everyone in the conversation, then
// a multipart body whose parts are its text and its pictures, base64. An MMS
// pushed to the outbox with every recipient in its envelope goes out as one
// message to all of them: a group text. Text only: see androidBody (phone-vcard.mts) for why
// pictures can't go that way. Android's MAP server (packages/modules/
// Bluetooth, BluetoothMapbMessage*.java) is what this speaks; it's the one
// that has MMS.
//
// Pictures are kept as data: URLs, small: a thumbnail that fits
// THUMB_PX, which is what Messages shows and what's sealed on disk.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { nativeImage } from 'electron';
import { androidBody } from './phone-vcard.mts';

/** A picture's longest side, as kept. */
const THUMB_PX = 720;
const THUMB_QUALITY = 78;
/** Pictures nativeImage can't decode (GIF, WebP) are kept whole up to this. */
const RAW_MAX = 400_000;

export interface MmsAddress {
  name: string;
  address: string;
}

export interface ParsedMms {
  from: MmsAddress[];
  to: MmsAddress[];
  cc: MmsAddress[];
  text: string;
  /** The pictures, as data: URLs. */
  images: string[];
  /** Attachments that aren't pictures (video, audio, contact cards): their MIME types. */
  others: string[];
}

/** The MSG part of a bMessage, with what MAP escapes in it put back. */
function msgPart(bmessage: string): string {
  const start = bmessage.indexOf('BEGIN:MSG');
  const end = bmessage.lastIndexOf('END:MSG');
  if (start < 0 || end < start) return '';
  return bmessage
    .slice(start + 'BEGIN:MSG'.length, end)
    .replace(/^\r?\n/, '')
    .replace(/\/END\\:MSG/g, 'END:MSG');
}

/** Split headers from body at the first blank line, and unfold the headers. */
function splitHeaders(text: string): { headers: Map<string, string>; body: string } {
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const body = m ? text.slice(m.index + m[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}; ${value}` : value);
  }
  return { headers, body };
}

/** `"Name" <+15551234567>; +15557654321;` — addresses split on ; and , outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): MmsAddress[] {
  if (!value) return [];
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const ch of value) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === '<' && !quoted) angle = true;
    else if (ch === '>' && !quoted) angle = false;
    if ((ch === ';' || ch === ',') && !quoted && !angle) {
      tokens.push(current);
      current = '';
    } else current += ch;
  }
  tokens.push(current);
  const out: MmsAddress[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token || /undisclosed-recipients/i.test(token) || token === 'insert-address-token') continue;
    const angled = /<([^>]*)>/.exec(token);
    const address = (angled ? angled[1] : token).trim().replace(/\/TYPE=PLMN$/i, '');
    if (!address) continue;
    const name = angled ? token.slice(0, angled.index).trim().replace(/^"|"$/g, '') : '';
    out.push({ name, address });
  }
  return out;
}

function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const soft = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i], 'utf8'));
  }
  return Buffer.from(bytes);
}

function decodeBody(body: string, encoding: string): Buffer {
  const e = encoding.toLowerCase();
  if (e.includes('base64')) return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (e.includes('quoted-printable')) return decodeQuotedPrintable(body);
  return Buffer.from(body, 'utf8');
}

function param(value: string, name: string): string | null {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(value);
  return m ? (m[2] ?? m[1]) : null;
}

/** A bMessage the phone sent for an MMS (Get with attachments). */
export function parseMms(bmessage: string): ParsedMms {
  const { headers, body } = splitHeaders(msgPart(bmessage));
  const result: ParsedMms = {
    from: parseAddressList(headers.get('from')),
    to: parseAddressList(headers.get('to')),
    cc: parseAddressList(headers.get('cc')),
    text: '',
    images: [],
    others: [],
  };
  const type = headers.get('content-type') ?? '';
  const boundary = param(type, 'boundary');
  const texts: string[] = [];
  if (!boundary) {
    // Without attachments asked for (or a text-only MMS), the body is the text.
    texts.push(decodeBody(body, headers.get('content-transfer-encoding') ?? '').toString('utf8'));
  } else {
    const pieces = body.split(`--${boundary}`);
    for (const piece of pieces.slice(1)) {
      if (piece.startsWith('--')) break;
      const part = splitHeaders(piece.replace(/^\r?\n/, ''));
      const partType = (part.headers.get('content-type') ?? 'text/plain').split(';')[0].trim().toLowerCase();
      const data = decodeBody(part.body.replace(/\r?\n$/, ''), part.headers.get('content-transfer-encoding') ?? '');
      if (partType === 'text/plain') texts.push(data.toString('utf8'));
      else if (partType === 'application/smil') continue;
      else if (partType.startsWith('image/')) {
        const image = thumbnail(data, partType);
        if (image) result.images.push(image);
        else result.others.push(partType);
      } else result.others.push(partType);
    }
  }
  // A text-only MMS read without attachments lists parts as <name> lines.
  result.text = texts
    .map((t) => t.replace(/\r\n/g, '\n').trim())
    .filter((t) => t && !/^(<[^>\n]*>\s*)+$/.test(t))
    .join('\n');
  return result;
}

/** A picture as a small JPEG data: URL; GIFs and WebPs, which nativeImage can't read, as they are if they're small. */
export function thumbnail(data: Buffer, mime: string): string | null {
  const image = nativeImage.createFromBuffer(data);
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    const scale = Math.min(1, THUMB_PX / Math.max(width, height));
    const small = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : image;
    return `data:image/jpeg;base64,${small.toJPEG(THUMB_QUALITY).toString('base64')}`;
  }
  if (/^image\/(gif|webp|png|jpeg)$/.test(mime) && data.length <= RAW_MAX) return `data:${mime};base64,${data.toString('base64')}`;
  return null;
}

/**
 * A bMessage pushing a group text to the outbox: an MMS with every address
 * at the envelope's top level, which Android sends as one message to all of
 * them. Its body is the text alone, which Android takes as a text-only MMS.
 */
export function bMessageGroup(addresses: string[], body: string): string {
  const tels = addresses.map((a) => a.replace(/[\r\n]/g, ''));
  const message = `BEGIN:MSG\r\n${androidBody(body)}\r\nEND:MSG\r\n`;
  return [
    'BEGIN:BMSG',
    'VERSION:1.0',
    'STATUS:READ',
    'TYPE:MMS',
    'FOLDER:TELECOM/MSG/OUTBOX',
    // The sender, which the phone fills in.
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:',
    'TEL:',
    'END:VCARD',
    'BEGIN:BENV',
    ...tels.flatMap((tel) => ['BEGIN:VCARD', 'VERSION:2.1', 'N:', `TEL:${tel}`, 'END:VCARD']),
    'BEGIN:BBODY',
    'CHARSET:UTF-8',
    `LENGTH:${Buffer.byteLength(message, 'utf8')}`,
    `${message}END:BBODY`,
    'END:BENV',
    'END:BMSG',
    '',
  ].join('\r\n');
}
