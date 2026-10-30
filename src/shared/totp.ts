/**
 * Time-based one-time passwords (RFC 6238), the verification codes of
 * authenticator apps, from an otpauth:// URI or a bare base32 secret as
 * KeePassXC stores them. electron/passwords.mts does the same in main, for
 * copying a code.
 */

export interface TotpParams {
  secret: Uint8Array;
  digits: number;
  /** Seconds each code lasts. */
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

function base32(text: string): Uint8Array | null {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[\s=-]/g, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length > 0 ? new Uint8Array(out) : null;
}

/** The parameters of an otpauth:// URI or bare secret, or null if it isn't one. */
export function parseTotp(uri: string): TotpParams | null {
  let secret = uri.trim();
  let digits = 6;
  let period = 30;
  let algorithm: TotpParams['algorithm'] = 'SHA-1';
  if (secret.startsWith('otpauth://')) {
    let params: URLSearchParams;
    try {
      params = new URL(secret).searchParams;
    } catch {
      return null;
    }
    secret = params.get('secret') ?? '';
    digits = Number(params.get('digits')) || 6;
    period = Number(params.get('period')) || 30;
    const name = (params.get('algorithm') ?? 'SHA1').toUpperCase();
    algorithm = name === 'SHA256' ? 'SHA-256' : name === 'SHA512' ? 'SHA-512' : 'SHA-1';
  }
  const bytes = base32(secret);
  if (!bytes || digits < 6 || digits > 10 || period < 1) return null;
  return { secret: bytes, digits, period, algorithm };
}

/** The code at `now` (ms). */
export async function totpCode(params: TotpParams, now = Date.now()): Promise<string> {
  const counter = new DataView(new ArrayBuffer(8));
  counter.setBigUint64(0, BigInt(Math.floor(now / 1000 / params.period)));
  const key = await crypto.subtle.importKey(
    'raw',
    params.secret as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: params.algorithm },
    false,
    ['sign'],
  );
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter.buffer));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (new DataView(hmac.buffer).getUint32(offset) & 0x7fffffff) % 10 ** params.digits;
  return String(code).padStart(params.digits, '0');
}
