/**
 * Din's signers, able to sign Bitcoin transactions too (src/shared/bitcoin.ts):
 * a PSBT in, the same PSBT with the account's Taproot inputs signed out, as
 * Ditto's BITCOIN-SIGNING.md has it. An account in nostrd asks it
 * (`sign_psbt`, NostrdSigner); a secret key signs here; a bunker is asked
 * over NIP-46 (`sign_psbt`); an extension, by `window.nostr.signPsbt`.
 */

import type { NostrSigner } from '@nostrify/nostrify';
import { NBrowserSigner, NConnectSigner, NSecSigner } from '@nostrify/nostrify';
import { signPsbtWithKey } from '@/shared/bitcoin';

export interface BitcoinSigner extends NostrSigner {
  /** Sign the account's inputs of a hex PSBT; resolves with it, hex, unfinalized. */
  signPsbt(psbt: string): Promise<string>;
}

export function canSignBitcoin(signer: NostrSigner | undefined): signer is BitcoinSigner {
  return typeof (signer as Partial<BitcoinSigner> | undefined)?.signPsbt === 'function';
}

/** A secret key held here. NSecSigner keeps its own copy private, so this keeps one too. */
export class NSecBitcoinSigner extends NSecSigner implements BitcoinSigner {
  readonly #secretKey: Uint8Array;

  constructor(secretKey: Uint8Array) {
    super(secretKey);
    this.#secretKey = new Uint8Array(secretKey);
  }

  signPsbt(psbt: string): Promise<string> {
    return Promise.resolve().then(() => signPsbtWithKey(psbt, this.#secretKey));
  }
}

/** A NIP-46 bunker, asked with `sign_psbt`, which not every bunker knows. */
export class NConnectBitcoinSigner extends NConnectSigner implements BitcoinSigner {
  async signPsbt(psbt: string): Promise<string> {
    // `cmd` is private to TypeScript only.
    const cmd = (this as unknown as { cmd(method: string, params: string[]): Promise<string> }).cmd;
    try {
      return await cmd.call(this, 'sign_psbt', [psbt]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown|not (implemented|supported|found)|unsupported|no such method/i.test(message)) {
        throw new Error(`This account’s remote signer can’t sign Bitcoin transactions (${message})`, { cause: error });
      }
      throw error;
    }
  }
}

/** A NIP-07 extension (Din in a plain browser), when it has `signPsbt`. */
export class NBrowserBitcoinSigner extends NBrowserSigner implements BitcoinSigner {
  async signPsbt(psbt: string): Promise<string> {
    const nostr = await (this as unknown as { awaitNostr(): Promise<{ signPsbt?: (psbt: string) => Promise<string> }> }).awaitNostr();
    if (typeof nostr.signPsbt !== 'function') throw new Error('This browser extension can’t sign Bitcoin transactions');
    return nostr.signPsbt(psbt);
  }
}
