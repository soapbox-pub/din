// Payment cards in Passwords' vault (electron/passwords.mts).
//
// KeePass has no card type, so a card is an item tagged "Card" with fields
// of these names, which KeePassXC and the rest show as they are. A card
// brought in from another app (Bitwarden's "Number", "Exp Month", "Code";
// NordPass's "cardnumber", "expirydate", "cvc") is read as one too, by its
// fields' names, when its number is a card's; saving it in Passwords writes
// it the way Passwords does.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

export const CARD_TAG = 'Card';

/** The fields Passwords writes a card's details to. */
export const CARD_FIELDS = {
  holder: 'Cardholder',
  number: 'Card Number',
  expiry: 'Expiry',
  code: 'Security Code',
} as const;

export interface CardDetails {
  holder: string;
  /** Digits only. */
  number: string;
  /** "01" to "12", or empty. */
  expMonth: string;
  /** Four digits, or empty. */
  expYear: string;
  code: string;
}

/** What may be shown of a card without opening it: never its number or code. */
export interface CardSummary {
  brand: string;
  last4: string;
  /** "MM/YY", or empty. */
  expiry: string;
}

const NAMES = {
  number: /^(card[ _-]?)?number$|^cc[ _-]?number$|^card[ _-]?no$|^pan$/i,
  holder: /^(card[ _-]?holder([ _-]?name)?|name[ _-]?on[ _-]?card|cc[ _-]?name)$/i,
  expiry: /^(exp(iry|iration)?([ _-]?date)?|expirydate|valid[ _-]?(thru|until))$/i,
  month: /^(exp(iry|iration)?[ _-]?month|expmonth|cc[ _-]?exp[ _-]?month)$/i,
  year: /^(exp(iry|iration)?[ _-]?year|expyear|cc[ _-]?exp[ _-]?year)$/i,
  code: /^(security[ _-]?code|code|cvv2?|cvc2?|csc|card[ _-]?code|verification[ _-]?code)$/i,
};

export function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

/** The Luhn checksum every card number ends with. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function looksLikeCardNumber(text: string): boolean {
  const digits = digitsOf(text);
  return /^[\d\s-]+$/.test(text.trim()) && digits.length >= 12 && digits.length <= 19 && luhn(digits);
}

/** The network a number belongs to, by its first digits. */
export function cardBrand(number: string): string {
  const n = digitsOf(number);
  if (/^4/.test(n)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(n)) return 'Mastercard';
  if (/^3[47]/.test(n)) return 'American Express';
  if (/^(6011|65|64[4-9])/.test(n)) return 'Discover';
  if (/^3(0[0-5]|[689])/.test(n)) return 'Diners Club';
  if (/^35(2[89]|[3-8])/.test(n)) return 'JCB';
  if (/^62/.test(n)) return 'UnionPay';
  return 'Card';
}

function month(text: string): string {
  const m = Number.parseInt(digitsOf(text), 10);
  return m >= 1 && m <= 12 ? String(m).padStart(2, '0') : '';
}

function year(text: string): string {
  const d = digitsOf(text);
  if (d.length === 4) return d;
  if (d.length === 2) return `20${d}`;
  return '';
}

/** "12/29", "12 / 2029", "2029-12": month and year. */
function parseExpiry(text: string): { expMonth: string; expYear: string } {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{1,2})/.exec(t);
  if (iso) return { expMonth: month(iso[2]), expYear: year(iso[1]) };
  const parts = /^(\d{1,2})\s*[/.\- ]\s*(\d{2}|\d{4})$/.exec(t);
  if (parts) return { expMonth: month(parts[1]), expYear: year(parts[2]) };
  const packed = /^(\d{2})(\d{2})$/.exec(t);
  if (packed) return { expMonth: month(packed[1]), expYear: year(packed[2]) };
  return { expMonth: '', expYear: '' };
}

export function formatExpiry(card: Pick<CardDetails, 'expMonth' | 'expYear'>, fullYear = false): string {
  if (!card.expMonth && !card.expYear) return '';
  return `${card.expMonth || '--'}/${fullYear ? card.expYear : card.expYear.slice(-2)}`;
}

/**
 * The card in an item's fields, if it holds one, and which fields it read.
 * An untagged item counts only when its number is a card's.
 */
export function readCard(fields: Map<string, string>, tagged: boolean): { card: CardDetails; used: Set<string> } | null {
  const used = new Set<string>();
  const find = (pattern: RegExp): string => {
    for (const [name, value] of fields) {
      if (pattern.test(name.trim()) && !used.has(name)) {
        used.add(name);
        return value;
      }
    }
    return '';
  };
  const number = fields.get(CARD_FIELDS.number) ?? find(NAMES.number);
  if (fields.has(CARD_FIELDS.number)) used.add(CARD_FIELDS.number);
  if (!tagged && !looksLikeCardNumber(number)) return null;
  const holder = fields.get(CARD_FIELDS.holder) ?? find(NAMES.holder);
  if (fields.has(CARD_FIELDS.holder)) used.add(CARD_FIELDS.holder);
  let expiry = parseExpiry(fields.get(CARD_FIELDS.expiry) ?? find(NAMES.expiry));
  if (fields.has(CARD_FIELDS.expiry)) used.add(CARD_FIELDS.expiry);
  if (!expiry.expMonth && !expiry.expYear) {
    const m = find(NAMES.month);
    const y = find(NAMES.year);
    expiry = { expMonth: month(m), expYear: year(y) };
  }
  const code = fields.get(CARD_FIELDS.code) ?? find(NAMES.code);
  if (fields.has(CARD_FIELDS.code)) used.add(CARD_FIELDS.code);
  return {
    card: { holder: holder.trim(), number: digitsOf(number), ...expiry, code: code.trim() },
    used,
  };
}

export function cardSummary(card: CardDetails): CardSummary {
  return { brand: cardBrand(card.number), last4: card.number.slice(-4), expiry: formatExpiry(card) };
}

/** A card as the vault takes it from an app: checked, and tidied. */
export function parseCard(raw: unknown): CardDetails {
  if (!raw || typeof raw !== 'object') throw new Error('Not a card');
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, name: string, max: number) => {
    if (typeof v !== 'string' || v.length > max) throw new Error(`Not a usable ${name}`);
    return v.trim();
  };
  const number = digitsOf(str(r.number, 'card number', 64));
  if (number && (number.length < 12 || number.length > 19)) throw new Error('A card number has 12 to 19 digits');
  const expMonth = str(r.expMonth, 'expiry month', 2);
  const expYear = str(r.expYear, 'expiry year', 4);
  if (expMonth && !month(expMonth)) throw new Error('Not a month');
  if (expYear && !/^\d{4}$/.test(expYear)) throw new Error('Not a year');
  const code = str(r.code, 'security code', 8);
  if (code && !/^\d{3,4}$/.test(code)) throw new Error('A security code is 3 or 4 digits');
  return { holder: str(r.holder, 'cardholder name', 200), number, expMonth: expMonth ? month(expMonth) : '', expYear, code };
}
