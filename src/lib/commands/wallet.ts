import { formatBtc, formatSats, parseBtc } from '@/shared/bitcoinAmounts';
import { CommandError, type Area, type CommandContext } from './types';
import { command, need } from './util';
import { describeSchemeLinks, setSchemeDefault } from './links';

/**
 * `din wallet`: the signed-in account's onchain bitcoin, as the Wallet app
 * shows it (its pubkey's Taproot address, src/shared/bitcoin.ts). Sending
 * opens Wallet's Send filled in: what spends money is signed only after Din's
 * prompt shows the user where it goes, so the command hands it to the window
 * that asks.
 */

/** Loaded on first use, not with the desktop. */
const bitcoin = () => import('@/shared/bitcoin');
const esplora = () => import('@/shared/esplora');

async function address(ctx: CommandContext): Promise<string> {
  if (!ctx.pubkey) throw new CommandError('Nobody is signed in to Din');
  return (await bitcoin()).bitcoinAddress(ctx.pubkey);
}

export const walletArea: Area = {
  name: 'wallet',
  summary: 'Wallet: the signed-in account’s onchain bitcoin, at its Nostr key’s address: the address, balance and activity, and sending (in the Wallet window, which asks first)',
  commands: [
    command('wallet', 'address', 'The account’s Bitcoin address (its Nostr key’s Taproot address, bc1p…)', [], async (_args, ctx) => {
      const addr = await address(ctx);
      return { data: { address: addr }, text: addr };
    }),
    command('wallet', 'balance', 'The account’s bitcoin: confirmed, and what’s waiting to confirm', [], async (_args, ctx) => {
      const addr = await address(ctx);
      const b = await (await esplora()).fetchBalance(addr);
      const total = b.confirmed + b.pending;
      const lines = [`${formatBtc(total)} BTC (${formatSats(total)})`];
      if (b.pending) lines.push(`${formatBtc(b.pending)} BTC of it waiting to confirm`);
      return { data: { address: addr, ...b, total }, text: lines.join('\n') };
    }),
    command('wallet', 'activity', 'The account’s Bitcoin transactions, newest first', [], async (_args, ctx) => {
      const { explorerUrl, fetchActivity } = await esplora();
      const list = await fetchActivity(await address(ctx));
      return {
        data: list.map((a) => ({ ...a, url: explorerUrl('tx', a.txid) })),
        text: list.length
          ? list
              .map((a) => [a.confirmed && a.time ? new Date(a.time * 1000).toISOString() : 'pending', `${a.net > 0 ? '+' : ''}${formatBtc(a.net)} BTC`, a.txid].join('\t'))
              .join('\n')
          : 'No transactions yet',
      };
    }),
    command(
      'wallet',
      'send',
      'Open Wallet’s Send, filled in, to pay someone: Din shows where the money goes and asks before signing',
      [
        { name: 'to', type: 'string', positional: true, help: 'A Bitcoin address, bitcoin: link or npub' },
        { name: 'amount', type: 'string', positional: true, optional: true, help: 'How much, in BTC (0.001), or sats with “sats” after it (25000sats)' },
      ],
      async (args, ctx) => {
        await address(ctx);
        const to = args.string('to');
        if (!(await bitcoin()).parseRecipient(to)) throw new CommandError(`“${to}” isn’t a Bitcoin address, bitcoin: link or npub`, 'usage');
        const text = args.optString('amount');
        let amount: number | undefined;
        if (text) {
          const sats = /^\s*[\d,_]+\s*sats?\s*$/i.test(text) ? Number(text.replace(/[^\d]/g, '')) : parseBtc(text);
          if (!sats) throw new CommandError(`“${text}” isn’t an amount`, 'usage');
          amount = sats;
        }
        ctx.actions.open('wallet', { section: 'send', to, ...(amount ? { amount } : {}) });
        return { text: 'Wallet is open with it filled in; send it from there.' };
      },
    ),
    // Settings → Nostr & Storage's Other links, for bitcoin: (din links).
    command('wallet', 'links', 'Where bitcoin: links open: the apps that open them, and the one chosen to open them without asking', [], (_args, ctx) =>
      describeSchemeLinks(need(ctx.schemeLinks, 'bitcoin: links'), 'bitcoin'),
    ),
    command('wallet', 'link-default', 'Open bitcoin: links in an app without asking, as Always does; without an app, ask again', [
      { name: 'app', type: 'string', positional: true, optional: true, help: 'Its id or name, from din wallet links' },
    ], (args, ctx) => setSchemeDefault(ctx, 'bitcoin', args.optString('app'))),
    command('wallet', 'receive', 'Open Wallet showing the account’s address and its QR code', [], async (_args, ctx) => {
      const addr = await address(ctx);
      ctx.actions.open('wallet', { section: 'receive' });
      return { data: { address: addr }, text: addr };
    }),
  ],
};
