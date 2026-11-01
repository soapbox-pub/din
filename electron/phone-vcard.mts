// vCards and bMessages, for phones (phone-map.mts):
// the contacts both kinds of phone send, and the Bluetooth Message Access
// Profile's message format, which is vCard-shaped too.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import type { PhoneContact } from '../src/lib/phone.ts';

/** Undo line folding: a line starting with a space or tab continues the one before. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length) lines[lines.length - 1] += raw.slice(1);
    // Quoted-printable soft breaks (vCard 2.1) end in '='.
    else if (lines.length && /;ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]) && lines[lines.length - 1].endsWith('=')) {
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + raw;
    } else lines.push(raw);
  }
  return lines;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(value[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function unescape(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** The contacts in a run of vCards; those without a number are left out. */
export function parseVCards(text: string): PhoneContact[] {
  const contacts: PhoneContact[] = [];
  let fn = '';
  let n = '';
  let numbers: string[] = [];
  for (const line of unfold(text)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const [name, ...params] = head.split(';');
    const key = name.replace(/^item\d+\./i, '').toUpperCase();
    let value = line.slice(colon + 1);
    if (params.some((p) => /^ENCODING=QUOTED-PRINTABLE$/i.test(p))) value = decodeQuotedPrintable(value);
    if (key === 'BEGIN') {
      fn = '';
      n = '';
      numbers = [];
    } else if (key === 'FN') fn = unescape(value).trim();
    else if (key === 'N') {
      const [family = '', given = ''] = value.split(';').map(unescape);
      n = [given, family].filter(Boolean).join(' ').trim();
    } else if (key === 'TEL') {
      const number = value.replace(/^tel:/i, '').trim();
      if (number && !numbers.includes(number)) numbers.push(number);
    } else if (key === 'END' && numbers.length) {
      contacts.push({ name: fn || n || numbers[0], numbers });
    }
  }
  return contacts.sort((a, b) => a.name.localeCompare(b.name));
}

/** The text of a bMessage (a message the phone sent over MAP). */
export function bMessageText(text: string): string {
  const start = text.indexOf('BEGIN:MSG');
  const end = text.lastIndexOf('END:MSG');
  if (start < 0 || end < start) return '';
  return text.slice(start + 'BEGIN:MSG'.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** A bMessage to send a text to one number (MAP's PushMessage). */
export function bMessage(address: string, body: string): string {
  const text = body.replace(/\r?\n/g, '\r\n');
  const message = `BEGIN:MSG\r\n${text}\r\nEND:MSG\r\n`;
  const tel = address.replace(/[\r\n]/g, '');
  return [
    'BEGIN:BMSG',
    'VERSION:1.0',
    'STATUS:READ',
    'TYPE:SMS_GSM',
    'FOLDER:TELECOM/MSG/OUTBOX',
    // The sender, which the phone fills in.
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:',
    'TEL:',
    'END:VCARD',
    'BEGIN:BENV',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:',
    `TEL:${tel}`,
    'END:VCARD',
    'BEGIN:BBODY',
    'CHARSET:UTF-8',
    `LENGTH:${Buffer.byteLength(message, 'utf8')}`,
    `${message}END:BBODY`,
    'END:BENV',
    'END:BMSG',
    '',
  ].join('\r\n');
}
