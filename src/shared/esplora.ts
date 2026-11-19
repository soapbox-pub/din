/**
 * The Bitcoin network as an Esplora REST API sees it (mempool.space, and
 * Blockstream's when that doesn't answer): an address's balance, history and
 * UTXOs, fee rates, the price, and broadcasting. Anyone running one sees
 * which address is asking, as with any light wallet.
 *
 * What comes back is checked before it's used: these numbers decide how much
 * money a transaction moves.
 */

import type { Utxo } from './bitcoin';

export const ESPLORA_SERVERS = ['https://mempool.space/api', 'https://blockstream.info/api'] as const;

const TIMEOUT_MS = 15_000;

/** Ask each server in turn until one answers; a 4xx other than 404 and 429 is an answer. */
async function esplora(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  let lastError: unknown = null;
  for (const base of ESPLORA_SERVERS) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      const response = await fetch(`${base}${path}`, { ...init, signal });
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429)) {
        return response;
      }
      lastError = new Error(`${new URL(base).host} answered ${response.status}`);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The Bitcoin network can’t be reached');
}

async function json<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await esplora(path, { signal });
  if (!response.ok) throw new Error(`The Bitcoin network answered ${response.status}`);
  return (await response.json()) as T;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

export interface Balance {
  /** Confirmed, in sats. */
  confirmed: number;
  /** Waiting in the mempool (negative while a payment out is unconfirmed). */
  pending: number;
  txCount: number;
}

export async function fetchBalance(address: string, signal?: AbortSignal): Promise<Balance> {
  type Stats = { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
  const data = await json<{ chain_stats?: Stats; mempool_stats?: Stats }>(`/address/${encodeURIComponent(address)}`, signal);
  const c = data.chain_stats ?? {};
  const m = data.mempool_stats ?? {};
  return {
    confirmed: count(c.funded_txo_sum) - count(c.spent_txo_sum),
    pending: count(m.funded_txo_sum) - count(m.spent_txo_sum),
    txCount: count(c.tx_count) + count(m.tx_count),
  };
}

/** A transaction as it touched the address. */
export interface Activity {
  txid: string;
  /** What the address gained (positive) or lost (negative), fee included. */
  net: number;
  fee: number;
  confirmed: boolean;
  /** Unix seconds, once confirmed. */
  time?: number;
  /** For a payment out: who got it (the first output not back to the address). */
  counterparty?: string;
}

interface EsploraTx {
  txid: string;
  fee?: number;
  status?: { confirmed?: boolean; block_time?: number };
  vin?: { prevout?: { scriptpubkey_address?: string; value?: number } | null }[];
  vout?: { scriptpubkey_address?: string; value?: number }[];
}

function toActivity(tx: EsploraTx, address: string): Activity {
  let out = 0;
  let back = 0;
  let from: string | undefined;
  for (const input of tx.vin ?? []) {
    if (input.prevout?.scriptpubkey_address === address) out += count(input.prevout.value);
    else from ??= input.prevout?.scriptpubkey_address;
  }
  let to: string | undefined;
  for (const output of tx.vout ?? []) {
    if (output.scriptpubkey_address === address) back += count(output.value);
    else to ??= output.scriptpubkey_address;
  }
  const net = back - out;
  return {
    txid: tx.txid,
    net,
    fee: count(tx.fee),
    confirmed: Boolean(tx.status?.confirmed),
    time: tx.status?.block_time,
    counterparty: net < 0 ? to : from,
  };
}

/** The address's transactions, newest first: the mempool's, then 25 confirmed a page (`after` the last txid seen). */
export async function fetchActivity(address: string, after?: string, signal?: AbortSignal): Promise<Activity[]> {
  const path = `/address/${encodeURIComponent(address)}/txs${after ? `/chain/${encodeURIComponent(after)}` : ''}`;
  const txs = await json<EsploraTx[]>(path, signal);
  return (Array.isArray(txs) ? txs : []).filter((tx) => typeof tx?.txid === 'string').map((tx) => toActivity(tx, address));
}

export async function fetchUtxos(address: string, signal?: AbortSignal): Promise<Utxo[]> {
  const list = await json<{ txid?: unknown; vout?: unknown; value?: unknown; status?: { confirmed?: boolean } }[]>(
    `/address/${encodeURIComponent(address)}/utxo`,
    signal,
  );
  return (Array.isArray(list) ? list : []).flatMap((u) =>
    typeof u.txid === 'string' && /^[0-9a-f]{64}$/.test(u.txid) && Number.isSafeInteger(u.vout) && Number.isSafeInteger(u.value) && (u.value as number) > 0
      ? [{ txid: u.txid, vout: u.vout as number, value: u.value as number, confirmed: Boolean(u.status?.confirmed) }]
      : [],
  );
}

export interface FeeRates {
  /** Next block, about 10 minutes. */
  fast: number;
  /** About half an hour. */
  normal: number;
  /** About an hour or more. */
  slow: number;
}

/** A rate from the server as a whole number of sat/vB, never below 1 or absurdly high. */
function rate(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(5_000, Math.max(1, Math.ceil(value))) : 1;
}

export async function fetchFeeRates(signal?: AbortSignal): Promise<FeeRates> {
  const data = await json<Record<string, unknown>>('/fee-estimates', signal);
  return { fast: rate(data['1']), normal: rate(data['3']), slow: rate(data['6']) };
}

/** Dollars a bitcoin (mempool.space's, which Blockstream's doesn't have), or null. */
export async function fetchBtcPrice(signal?: AbortSignal): Promise<number | null> {
  try {
    const data = await json<{ USD?: unknown }>('/v1/prices', signal);
    return typeof data.USD === 'number' && data.USD > 0 ? data.USD : null;
  } catch {
    return null;
  }
}

/** Send a signed raw transaction to the network; resolves with its txid. */
export async function broadcast(txHex: string, signal?: AbortSignal): Promise<string> {
  const response = await esplora('/tx', { method: 'POST', body: txHex, signal, headers: { 'content-type': 'text/plain' } });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(text ? `The network refused it: ${text}` : `The network refused it (${response.status})`);
  return text;
}

/** Where to see a transaction or address on the web. */
export function explorerUrl(kind: 'tx' | 'address', id: string): string {
  return `https://mempool.space/${kind}/${encodeURIComponent(id)}`;
}
