/** Bitcoin amounts as people read and type them: BTC, sats, dollars. Small, so the desktop can show them without loading src/shared/bitcoin.ts. */

const SATS_PER_BTC = 100_000_000;

/** "0.0012345" for 123,450 sats: BTC with no trailing zeros. */
export function formatBtc(sats: number): string {
  const sign = sats < 0 ? '-' : '';
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / SATS_PER_BTC);
  const frac = String(abs % SATS_PER_BTC).padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

/** "123,450 sats". */
export function formatSats(sats: number): string {
  return `${sats.toLocaleString()} ${Math.abs(sats) === 1 ? 'sat' : 'sats'}`;
}

/** What `sats` is worth at `price` dollars a bitcoin: "$12.34". */
export function formatUsd(sats: number, price: number): string {
  return ((sats / SATS_PER_BTC) * price).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

/** Satoshis in a BTC amount someone typed ("0.001", ".5"), or null if it isn't one. */
export function parseBtc(text: string): number | null {
  const m = /^\s*(\d*)(?:\.(\d{0,8}))?\s*$/.exec(text);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] || '0') * SATS_PER_BTC + Number((m[2] ?? '').padEnd(8, '0'));
}
