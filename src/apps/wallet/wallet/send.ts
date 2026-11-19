import { finalizePsbt, planPayment, type PaymentPlan } from '@/shared/bitcoin';
import { broadcast, fetchUtxos } from '@/shared/esplora';
import { signer } from './data';

export type SendStage = 'preparing' | 'signing' | 'sending';

/**
 * Pay `amount` sats (or everything) to `to`: the account's UTXOs, a PSBT
 * for them, Din's signer (which shows the user where the money goes and
 * asks), then the network. Resolves with the txid once a server took it.
 */
export async function sendBitcoin(options: {
  pubkey: string;
  address: string;
  to: string;
  amount: number | 'max';
  feeRate: number;
  onStage: (stage: SendStage) => void;
}): Promise<{ txid: string; plan: PaymentPlan }> {
  const { pubkey, address, to, amount, feeRate, onStage } = options;
  onStage('preparing');
  // Fresh, not what the form showed: something may have been spent since.
  const utxos = await fetchUtxos(address);
  const plan = planPayment({ pubkey, to, amount, utxos, feeRate });
  onStage('signing');
  const signed = await signer().signPsbt(plan.psbt);
  const { tx, txid } = finalizePsbt(signed);
  onStage('sending');
  const accepted = await broadcast(tx);
  if (accepted.toLowerCase() !== txid) throw new Error('The network took a different transaction than the one signed');
  return { txid, plan };
}
