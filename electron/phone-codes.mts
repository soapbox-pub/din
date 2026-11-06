// Verification codes in the user's texts (electron/phone.mts), for the Web
// Browser's autofill (electron/passwords.mts) to offer in a page's code
// field, as a Mac offers the codes from Messages, and for a text's
// notification to copy.
//
// Codes are kept here in memory only, for CODE_TTL_MS after the text was
// sent, and are handed to a page only when the user picks one from the
// suggestions below its field (passwords.mts).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

/** A code from a text, as the autofill offers it. */
export interface PhoneCode {
  /** The phone's and the message's ids. */
  id: string;
  code: string;
  /** Who sent it: the conversation's name, a contact or a number. */
  from: string;
  /** When the text was sent (ms). */
  time: number;
}

/** How long a code is offered after its text was sent. */
const CODE_TTL_MS = 10 * 60_000;
const MAX_CODES = 10;

let codes: PhoneCode[] = [];
const listeners = new Set<(code: PhoneCode) => void>();

/** Words a text with a code has in it, in the languages most of them come in. */
const KEYWORD =
  /\b(?:codes?|verification|verify|verifying|otp|passcode|pass code|pin|one[- ]time|2fa|mfa|two[- ]factor|two[- ]step|security|authenticat\w*|log ?in|sign[- ]?in|confirm\w*|token|password|código|codigo|kode|kod|codice|wachtwoord)\b|код|验证码|驗證碼|認証|인증/i;

/** Right before a code: "code is 123456", "code: 123456", "PIN 1234". */
const LEAD_IN =
  /(?:codes?|otp|passcode|pass code|pin|password|token|código|codigo|kode|kod|codice|код|验证码|驗證碼|認証番号|인증번호)(?:\s+(?:for|to|from)(?:\s+[\w.'’-]+){1,3})?\W{0,3}(?:(?:is|was|are|es|est|ist|é|è)\W{0,3})?(?:[:#=]\s*)?$/i;

/** Right after one: "123456 is your code". */
const LEAD_OUT = /^\s*(?:is|was|est|es|ist|é|è)\s+(?:your|the|tu|su|votre|ihr|seu|il)\b/i;

/** Digits that aren't a code: a card's last four, an amount, an order or a phone number. */
const NOT_A_CODE_BEFORE = /(?:ending(?: in)?|ends in|last \d|card|acct|account|order|ref(?:erence)?|no\.?|number|tel|call|phone|\$|€|£|¥|USD|EUR)\W{0,3}$/i;

interface Candidate {
  code: string;
  start: number;
  end: number;
  /** Next to the words that say it's the code. */
  marked: boolean;
}

/**
 * The verification code in a text, if it has one: four to eight digits (or
 * two groups of three, or Google's G-123456), or letters and digits mixed
 * where the text says "code: …", in a text that talks about codes.
 */
export function extractCode(body: string): string | null {
  const text = body.slice(0, 1000);
  if (!KEYWORD.test(text)) return null;
  const candidates: Candidate[] = [];
  const add = (code: string, start: number, end: number, strict: boolean) => {
    const before = text.slice(Math.max(0, start - 40), start);
    const after = text.slice(end, end + 40);
    const marked = LEAD_IN.test(before) || LEAD_OUT.test(after);
    if (strict && !marked) return;
    if (!marked && NOT_A_CODE_BEFORE.test(before)) return;
    candidates.push({ code, start, end, marked });
  };

  // Digits, alone or after a short prefix (G-123456): not part of a longer
  // number, a decimal, a time, a date or a phone number.
  for (const m of text.matchAll(/(?:\b[A-Z]{1,3}-)?(\d{4,8})(?!\d)/g)) {
    const start = m.index;
    const end = start + m[0].length;
    const digitsAt = end - m[1].length;
    const prev = text[digitsAt - 1] ?? '';
    const prefixed = digitsAt !== start;
    if (!prefixed && (/[\d.,:/\-+$€£#]/.test(prev) || /\d[ .]$/.test(text.slice(0, digitsAt)))) continue;
    if (/^[.,:/]\d|^-\d|^%|^\s?(?:%|am|pm|AM|PM)\b/.test(text.slice(end, end + 3))) continue;
    const year = m[1].length === 4 && /^(?:19|20)\d\d$/.test(m[1]);
    add(m[1], start, end, year);
  }
  // 123 456 and 123-456.
  for (const m of text.matchAll(/(?<![\d.,:/\-+$€£#])\b(\d{3})[- ](\d{3})\b(?![- ]?\d)/g)) {
    add(m[1] + m[2], m.index, m.index + m[0].length, false);
  }
  // Letters and digits (AB12CD), only where the text says it's the code.
  for (const m of text.matchAll(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8}\b/g)) {
    add(m[0], m.index, m.index + m[0].length, true);
  }
  if (candidates.length === 0) return null;
  const marked = candidates.filter((c) => c.marked);
  if (marked.length) return marked[0].code;
  // Otherwise the one nearest the words about codes, if they're all the same.
  const distinct = new Set(candidates.map((c) => c.code));
  if (distinct.size === 1) return candidates[0].code;
  const keywords = [...text.matchAll(new RegExp(KEYWORD.source, 'gi'))].map((k) => k.index);
  const distance = (c: Candidate) => Math.min(...keywords.map((k) => (k < c.start ? c.start - k : k - c.end)));
  return [...candidates].sort((a, b) => distance(a) - distance(b))[0].code;
}

function prune(now = Date.now()): void {
  codes = codes.filter((c) => now - c.time < CODE_TTL_MS);
}

/** Note a new text's code, if it has one, to offer in pages' code fields. */
export function noteCode(id: string, body: string, from: string, time: number): void {
  const code = extractCode(body);
  if (!code) return;
  const now = Date.now();
  // A phone's clock may run ahead of this computer's.
  const entry: PhoneCode = { id, code, from, time: Math.min(time, now) };
  if (now - entry.time >= CODE_TTL_MS) return;
  codes = [entry, ...codes.filter((c) => c.id !== id)].slice(0, MAX_CODES);
  prune(now);
  for (const listener of listeners) listener(entry);
}

/** The codes from texts lately, newest first. */
export function recentCodes(): PhoneCode[] {
  prune();
  return [...codes].sort((a, b) => b.time - a.time);
}

/** Forget a phone's codes (it was forgotten, or stopped filling them). */
export function forgetCodes(phoneId: string): void {
  codes = codes.filter((c) => !c.id.startsWith(`${phoneId}:`));
}

/** Hear of each new code as it arrives. */
export function onCode(listener: (code: PhoneCode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
