import { getKindLabel } from '@/lib/kindLabels';
import type { ProgramSignerRequest } from '@/lib/programSigner';
import type { PsbtSummary } from '@/shared/bitcoin';
import { formatBtc } from '@/shared/bitcoinAmounts';

/** The question as one sentence, plus a line under it when there's more to say. */
export function headline(request: ProgramSignerRequest, psbt: PsbtSummary | null): { title: string; detail?: string } {
  const who = `“${request.program}”`;
  switch (request.method) {
    case 'sign_event':
      return { title: `${who} wants to sign as you`, detail: request.kind !== null ? getKindLabel(request.kind) : undefined };
    case 'nip04_encrypt':
    case 'nip44_encrypt':
      return { title: `${who} wants to encrypt a message as you` };
    case 'nip04_decrypt':
    case 'nip44_decrypt':
      return { title: `${who} wants to read a message sent to you` };
    case 'sign_psbt': {
      const spent = psbt?.spent;
      return {
        title: spent !== undefined && spent > 0 ? `${who} wants to send ${formatBtc(spent)} BTC` : `${who} wants to sign a Bitcoin transaction`,
        detail: 'Once it’s sent, it can’t be taken back.',
      };
    }
    case 'set_active':
      return {
        title: `${who} wants to switch your account`,
        detail: 'Din and every program would then sign as the account below.',
      };
    case 'import_account':
      return { title: `${who} wants to add an account`, detail: 'It gave a key to keep with your others.' };
    case 'generate_account':
      return { title: `${who} wants to create an account` };
    case 'set_password':
      return {
        title: `${who} wants to set the password on your keys`,
        detail: 'You’d need it to unlock them. Allow this only if you started it.',
      };
    default:
      return { title: `${who} wants to use your account` };
  }
}
