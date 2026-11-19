/**
 * Onchain Bitcoin with a Nostr key.
 *
 * A Nostr pubkey is a 32-byte x-only secp256k1 key, which is exactly what
 * Taproot (BIP-341) takes as an internal key: every account already owns a
 * Bitcoin address, the P2TR output for its pubkey with no script tree
 * (`bc1p…`). Spending from it is a PSBT (BIP-174) whose inputs name the
 * pubkey as their `tapInternalKey`, signed by whatever holds the key: nostrd
 * (`sign_psbt`), a NIP-07 extension (`window.nostr.signPsbt`), a NIP-46
 * bunker (`sign_psbt`), or a secret key here. That's Ditto's
 * BITCOIN-SIGNING.md, which Din follows so its wallet, Ditto and the sites
 * and apps that use Din's signer all speak the same.
 *
 * Shared by the desktop (the signer's prompt reads a PSBT to say what it
 * would send; a secret-key account signs here) and the Wallet app (which
 * builds them). Nothing here touches the network: see `esplora.ts`.
 */

import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { nip19 } from 'nostr-tools';
import { formatBtc, formatSats, parseBtc } from './bitcoinAmounts';

export { formatBtc, formatSats, formatUsd, parseBtc } from './bitcoinAmounts';

/** Outputs below this are dust, which nodes won't relay. */
export const DUST_LIMIT = 546;

/** A P2TR key-path input, signed: 57.5 vbytes (41 + a 66-byte witness / 4). */
const INPUT_VBYTES = 57.5;
/** Version, locktime, counts and the segwit marker. */
const OVERHEAD_VBYTES = 10.5;

/** The highest fee rate this will build with, in sat/vB: far above any real congestion. */
export const MAX_FEE_RATE = 5_000;

function isPubkeyHex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/** An account's Bitcoin address: the mainnet P2TR output of its pubkey. Throws on a bad key. */
export function bitcoinAddress(pubkey: string): string {
  if (!isPubkeyHex(pubkey)) throw new Error('Not a public key');
  const pay = btc.p2tr(hex.decode(pubkey.toLowerCase()), undefined, btc.NETWORK);
  if (!pay.address) throw new Error('Not a public key');
  return pay.address;
}

function ownScript(pubkey: string): Uint8Array {
  return btc.p2tr(hex.decode(pubkey.toLowerCase()), undefined, btc.NETWORK).script;
}

/** The output script an address pays to, or null for one that isn't a valid mainnet address. */
export function addressScript(address: string): Uint8Array | null {
  try {
    return btc.OutScript.encode(btc.Address(btc.NETWORK).decode(address.trim()));
  } catch {
    return null;
  }
}

export function isBitcoinAddress(address: string): boolean {
  return addressScript(address) !== null;
}

/** The address a script pays to, when it's one an address can name. */
export function scriptAddress(script: Uint8Array): string | undefined {
  try {
    const decoded = btc.OutScript.decode(script);
    return btc.Address(btc.NETWORK).encode(decoded as Parameters<ReturnType<typeof btc.Address>['encode']>[0]);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface Recipient {
  /** The address to pay. */
  address: string;
  /** The Nostr account it's for, when it was given as one. */
  pubkey?: string;
  /** From a `bitcoin:` link: what it asks for, in sats. */
  amount?: number;
  /** From a `bitcoin:` link. */
  label?: string;
  message?: string;
}

/**
 * Who to pay, from what someone typed or pasted: an address, a `bitcoin:`
 * link (BIP-21) with its amount and label, or a Nostr account (npub,
 * nprofile, `nostr:` link), whose address is its key's. Null if it's none.
 */
export function parseRecipient(input: string): Recipient | null {
  const text = input.trim();
  if (!text) return null;
  if (/^bitcoin:/i.test(text)) {
    const body = text.slice('bitcoin:'.length);
    const q = body.indexOf('?');
    const address = (q === -1 ? body : body.slice(0, q)).trim();
    if (!isBitcoinAddress(address)) return null;
    const params = new URLSearchParams(q === -1 ? '' : body.slice(q + 1));
    const amount = params.get('amount') ? parseBtc(params.get('amount')!) : null;
    return {
      address,
      ...(amount ? { amount } : {}),
      ...(params.get('label') ? { label: params.get('label')! } : {}),
      ...(params.get('message') ? { message: params.get('message')! } : {}),
    };
  }
  const bech = text.replace(/^nostr:/i, '');
  if (/^(npub1|nprofile1)/i.test(bech)) {
    try {
      const decoded = nip19.decode(bech);
      const pubkey = decoded.type === 'npub' ? decoded.data : decoded.type === 'nprofile' ? decoded.data.pubkey : null;
      if (pubkey) return { address: bitcoinAddress(pubkey), pubkey };
    } catch {
      return null;
    }
    return null;
  }
  return isBitcoinAddress(text) ? { address: text } : null;
}

/** A `bitcoin:` link (BIP-21) for an address, as a QR code carries it. */
export function bitcoinUri(address: string, amount?: number): string {
  return `bitcoin:${address}${amount ? `?amount=${formatBtc(amount)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Building a transaction
// ---------------------------------------------------------------------------

/** An unspent output of the account's address. */
export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
}

/** What an output adds to a transaction: its value, script and length. */
function outputVbytes(script: Uint8Array): number {
  return 8 + 1 + script.length;
}

function vsize(inputs: number, outputScripts: Uint8Array[]): number {
  return OVERHEAD_VBYTES + inputs * INPUT_VBYTES + outputScripts.reduce((n, s) => n + outputVbytes(s), 0);
}

export interface PaymentPlan {
  /** The unsigned PSBT, hex. */
  psbt: string;
  /** What the recipient gets. */
  amount: number;
  fee: number;
  /** Back to the account's own address; 0 when it would have been dust. */
  change: number;
  /** The UTXOs it spends. */
  inputs: number;
}

/**
 * The PSBT that pays `amount` sats (or everything, `'max'`) to `to` from the
 * account's UTXOs at `feeRate` sat/vB, change back to its own address.
 * Spends the largest UTXOs first, as few as cover it; change that would be
 * dust goes to the fee instead. Throws, saying why, when it can't be paid.
 */
export function planPayment(options: {
  pubkey: string;
  to: string;
  amount: number | 'max';
  utxos: readonly Utxo[];
  feeRate: number;
}): PaymentPlan {
  const { pubkey, to, utxos } = options;
  const feeRate = options.feeRate;
  // Every guard below is a comparison, and NaN fails them all quietly: a NaN
  // fee rate would build a transaction that gives the balance to miners.
  if (!Number.isFinite(feeRate) || feeRate < 1 || feeRate > MAX_FEE_RATE) throw new Error(`Invalid fee rate: ${feeRate} sat/vB`);
  const recipientScript = addressScript(to);
  if (!recipientScript) throw new Error('That isn’t a Bitcoin address');
  const changeScript = ownScript(pubkey);
  if (utxos.length === 0) throw new Error('There’s nothing to send');

  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const total = (list: readonly Utxo[]) => list.reduce((n, u) => n + u.value, 0);
  const feeFor = (inputs: number, scripts: Uint8Array[]) => Math.ceil(vsize(inputs, scripts) * feeRate);

  let chosen: Utxo[];
  let amount: number;
  let fee: number;
  let change = 0;
  if (options.amount === 'max') {
    chosen = sorted;
    fee = feeFor(chosen.length, [recipientScript]);
    amount = total(chosen) - fee;
    if (amount < DUST_LIMIT) throw new Error('The balance doesn’t cover the network fee');
  } else {
    amount = options.amount;
    if (!Number.isInteger(amount) || amount < DUST_LIMIT) throw new Error(`The least you can send is ${formatSats(DUST_LIMIT)}`);
    chosen = [];
    fee = 0;
    let covered = false;
    for (const utxo of sorted) {
      chosen.push(utxo);
      const have = total(chosen);
      const withChange = feeFor(chosen.length, [recipientScript, changeScript]);
      if (have - amount - withChange >= DUST_LIMIT) {
        fee = withChange;
        change = have - amount - withChange;
        covered = true;
        break;
      }
      const without = feeFor(chosen.length, [recipientScript]);
      if (have - amount - without >= 0) {
        // What's left over is less than an output is worth: the miners get it.
        fee = have - amount;
        covered = true;
        break;
      }
    }
    if (!covered) {
      const need = amount + feeFor(sorted.length, [recipientScript]);
      throw new Error(`Not enough bitcoin: that needs ${formatSats(need)} with the fee, and there’s ${formatSats(total(sorted))}`);
    }
  }

  const tx = new btc.Transaction();
  const internalKey = hex.decode(pubkey.toLowerCase());
  for (const utxo of chosen) {
    tx.addInput({
      txid: hex.decode(utxo.txid),
      index: utxo.vout,
      witnessUtxo: { script: changeScript, amount: BigInt(utxo.value) },
      tapInternalKey: internalKey,
      // Replaceable (BIP-125), so a stuck payment can be sped up.
      sequence: 0xfffffffd,
    });
  }
  tx.addOutput({ script: recipientScript, amount: BigInt(amount) });
  if (change > 0) tx.addOutput({ script: changeScript, amount: BigInt(change) });
  return { psbt: hex.encode(tx.toPSBT()), amount, fee, change, inputs: chosen.length };
}

// ---------------------------------------------------------------------------
// Reading a PSBT (what the signer's prompt shows)
// ---------------------------------------------------------------------------

export interface PsbtOutput {
  address?: string;
  value: number;
  /** Back to the signing account's own address. */
  change: boolean;
}

export interface PsbtSummary {
  /** The unsigned transaction's id: what it will be once signed (segwit ids don't cover signatures). */
  txid: string;
  outputs: PsbtOutput[];
  /** How many inputs the account would sign, and how many are someone else's. */
  ownInputs: number;
  otherInputs: number;
  /** In sats, when every input says what it spends. */
  fee?: number;
  /** What leaves the account: its inputs less what comes back to it. */
  spent?: number;
  /** The fee rate, sat/vB, estimated for the signed transaction. */
  feeRate?: number;
}

function decodePsbt(psbtHex: string): btc.Transaction {
  const text = psbtHex.trim();
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2) throw new Error('The PSBT isn’t hex');
  try {
    return btc.Transaction.fromPSBT(hex.decode(text.toLowerCase()));
  } catch (error) {
    throw new Error(`That isn’t a transaction Din can read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * What a PSBT would do with the account's money: where it pays, what comes
 * back, the fee. Throws when there's nothing in it for the account to sign,
 * so a prompt is never shown for a PSBT that can't be signed.
 */
export function summarizePsbt(psbtHex: string, pubkey: string): PsbtSummary {
  const tx = decodePsbt(psbtHex);
  const ours = hex.encode(ownScript(pubkey));
  const key = pubkey.toLowerCase();
  let ownInputs = 0;
  let otherInputs = 0;
  let totalIn = 0;
  let ownIn = 0;
  let known = true;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const isOurs = input.tapInternalKey ? hex.encode(input.tapInternalKey) === key : false;
    if (isOurs) ownInputs++;
    else otherInputs++;
    const utxo = input.witnessUtxo;
    if (!utxo) {
      known = false;
      continue;
    }
    const value = Number(utxo.amount);
    totalIn += value;
    if (isOurs) {
      if (hex.encode(utxo.script) !== ours) throw new Error(`Input ${i} names your key but doesn’t spend your address`);
      ownIn += value;
    }
  }
  if (ownInputs === 0) throw new Error('Nothing in this transaction is yours to sign');

  const outputs: PsbtOutput[] = [];
  let totalOut = 0;
  let back = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const value = Number(out.amount ?? 0n);
    const script = out.script ? hex.encode(out.script) : '';
    const change = script === ours;
    totalOut += value;
    if (change) back += value;
    outputs.push({ address: out.script ? scriptAddress(out.script) : undefined, value, change });
  }
  const fee = known ? totalIn - totalOut : undefined;
  // Unsigned, so estimated: the inputs' signatures aren't there yet.
  const size = OVERHEAD_VBYTES + tx.inputsLength * INPUT_VBYTES + outputs.reduce((n, _, i) => n + outputVbytes(tx.getOutput(i).script ?? new Uint8Array()), 0);
  return {
    txid: tx.id,
    outputs,
    ownInputs,
    otherInputs,
    ...(fee !== undefined ? { fee, feeRate: Math.round((fee / size) * 10) / 10 } : {}),
    ...(known && otherInputs === 0 ? { spent: ownIn - back } : {}),
  };
}

/** The unsigned transaction's id, to check a signer gave back the same transaction it was asked to sign. */
export function psbtTxid(psbtHex: string): string {
  return decodePsbt(psbtHex).id;
}

// ---------------------------------------------------------------------------
// Signing and sending
// ---------------------------------------------------------------------------

/**
 * Sign, with a secret key held here, every input whose `tapInternalKey` is
 * its pubkey, as nostrd's `sign_psbt` does (and refusing what it refuses).
 * Returns the PSBT, hex, unfinalized.
 */
export function signPsbtWithKey(psbtHex: string, secretKey: Uint8Array): string {
  const tx = decodePsbt(psbtHex);
  const pubkey = hex.encode(btc.utils.pubSchnorr(secretKey));
  const ours = hex.encode(ownScript(pubkey));
  let signed = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (!input.tapInternalKey || hex.encode(input.tapInternalKey) !== pubkey) continue;
    if (!input.witnessUtxo || hex.encode(input.witnessUtxo.script) !== ours) {
      throw new Error(`Input ${i} names your key but doesn’t spend your address`);
    }
    // DEFAULT and ALL only: the others let the transaction change after signing.
    if (tx.signIdx(secretKey, i, [btc.SigHash.DEFAULT, btc.SigHash.ALL])) signed++;
  }
  if (!signed) throw new Error('Nothing in this transaction is yours to sign');
  return hex.encode(tx.toPSBT());
}

/** A signed PSBT, finalized: the raw transaction to broadcast, and its id. */
export function finalizePsbt(psbtHex: string): { tx: string; txid: string } {
  const tx = decodePsbt(psbtHex);
  tx.finalize();
  return { tx: hex.encode(tx.extract()), txid: tx.id };
}
