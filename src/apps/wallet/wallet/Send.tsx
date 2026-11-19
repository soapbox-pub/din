import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CircleCheck, ExternalLink, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { PillButton, SegmentedControl } from '@/shared/appChrome';
import { formatBtc, formatSats, formatUsd, parseBtc, parseRecipient, planPayment, type PaymentPlan } from '@/shared/bitcoin';
import { explorerUrl, fetchUtxos } from '@/shared/esplora';
import { useFeeRates, usePrice, useRefresh } from './data';
import { sendBitcoin, type SendStage } from './send';

type Unit = 'btc' | 'sats';
type Speed = 'fast' | 'normal' | 'slow';

const SPEEDS: { value: Speed; label: string; wait: string }[] = [
  { value: 'fast', label: 'Fast', wait: 'about 10 minutes' },
  { value: 'normal', label: 'Normal', wait: 'about 30 minutes' },
  { value: 'slow', label: 'Slow', wait: 'about an hour' },
];

const STAGE_LABEL: Record<SendStage, string> = {
  preparing: 'Preparing…',
  signing: 'Waiting for you to approve…',
  sending: 'Sending…',
};

/** What someone typed as an amount, in sats, or null. */
function parseAmount(text: string, unit: Unit): number | null {
  if (unit === 'btc') return parseBtc(text);
  const t = text.replace(/[\s,_]/g, '');
  return /^\d+$/.test(t) ? Number(t) : null;
}

function showAmount(sats: number, unit: Unit): string {
  return unit === 'btc' ? formatBtc(sats) : String(sats);
}

/** Why a send failed, in words for the user. */
function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /user rejected/i.test(message) ? 'You didn’t approve it, so nothing was sent.' : message;
}

export interface SendSeed {
  to?: string;
  /** In sats. */
  amount?: number;
}

/** Paying someone: who, how much, how fast; Din's signer asks before anything leaves. */
export function SendView({ pubkey, address, seed, onDone }: { pubkey: string; address: string; seed?: SendSeed; onDone: () => void }) {
  const [to, setTo] = useState(seed?.to ?? '');
  const [unit, setUnit] = useState<Unit>('btc');
  const [amountText, setAmountText] = useState(seed?.amount ? formatBtc(seed.amount) : '');
  const [max, setMax] = useState(false);
  const [speed, setSpeed] = useState<Speed>('normal');
  const [stage, setStage] = useState<SendStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ txid: string; plan: PaymentPlan; to: string } | null>(null);

  const utxos = useQuery({
    queryKey: ['utxos', address],
    queryFn: ({ signal }) => fetchUtxos(address, signal),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const fees = useFeeRates();
  const price = usePrice().data;
  const refresh = useRefresh();

  const recipient = useMemo(() => parseRecipient(to), [to]);
  const amount = max ? 'max' : parseAmount(amountText, unit);
  const feeRate = fees.data?.[speed];
  const available = (utxos.data ?? []).reduce((n, u) => n + u.value, 0);

  const preview = useMemo((): { plan: PaymentPlan } | { error: string } | null => {
    if (!recipient || amount === null || !utxos.data || !feeRate) return null;
    try {
      return { plan: planPayment({ pubkey, to: recipient.address, amount, utxos: utxos.data, feeRate }) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [recipient, amount, utxos.data, feeRate, pubkey]);

  const busy = stage !== null;
  const ready = Boolean(preview && 'plan' in preview) && !busy;

  const changeTo = (value: string) => {
    setTo(value);
    setError(null);
    // A bitcoin: link may say how much it's asking for.
    const parsed = parseRecipient(value);
    if (parsed?.amount && !amountText) {
      setMax(false);
      setUnit('btc');
      setAmountText(formatBtc(parsed.amount));
    }
  };

  const changeUnit = (next: Unit) => {
    const sats = parseAmount(amountText, unit);
    setUnit(next);
    if (sats !== null) setAmountText(showAmount(sats, next));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !recipient || amount === null || !feeRate) return;
    setError(null);
    try {
      const result = await sendBitcoin({ pubkey, address, to: recipient.address, amount, feeRate, onStage: setStage });
      setSent({ ...result, to: recipient.address });
      void refresh();
    } catch (e) {
      setError(failure(e));
    } finally {
      setStage(null);
    }
  };

  if (sent) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 pt-16 pb-8 text-center">
          <CircleCheck className="size-14 text-ink-accent" strokeWidth={1.5} aria-hidden />
          <h2 className="mt-4 font-[family-name:var(--font-title)] text-2xl font-semibold text-foreground">Sent {formatBtc(sent.plan.amount)} BTC</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            It’s on its way to <span className="font-mono break-all">{sent.to}</span>, and confirms once a block includes it.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Network fee: {formatSats(sent.plan.fee)}</p>
          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <PillButton variant="primary" onClick={onDone}>
              Done
            </PillButton>
            <PillButton onClick={() => window.open(explorerUrl('tx', sent.txid))}>
              <ExternalLink aria-hidden />
              View on mempool.space
            </PillButton>
          </div>
        </div>
      </div>
    );
  }

  const field = 'h-11 rounded-full px-4 text-base';
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form onSubmit={submit} className="mx-auto flex w-full max-w-lg flex-col gap-6 px-6 pt-10 pb-8">
        <h2 className="font-[family-name:var(--font-title)] text-2xl font-semibold text-foreground">Send Bitcoin</h2>

        <div className="space-y-2">
          <Label htmlFor="wallet-to">To</Label>
          <Input
            id="wallet-to"
            value={to}
            onChange={(e) => changeTo(e.target.value)}
            placeholder="A Bitcoin address, bitcoin: link or npub"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            aria-invalid={to.trim() !== '' && !recipient}
            className={cn(field, 'font-mono text-sm')}
          />
          {to.trim() !== '' &&
            (recipient ? (
              recipient.pubkey ? (
                <p className="px-1 text-sm text-muted-foreground">
                  A Nostr account’s address: <span className="font-mono break-all">{recipient.address}</span>
                </p>
              ) : recipient.label ? (
                <p className="px-1 text-sm text-muted-foreground">{recipient.label}</p>
              ) : null
            ) : (
              <p className="px-1 text-sm text-destructive">That isn’t a Bitcoin address or Nostr account.</p>
            ))}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="wallet-amount">Amount</Label>
            <SegmentedControl
              label="Unit"
              value={unit}
              onValueChange={changeUnit}
              disabled={busy || max}
              options={[
                { value: 'btc', label: 'BTC' },
                { value: 'sats', label: 'sats' },
              ]}
            />
          </div>
          <div className="flex gap-2">
            <Input
              id="wallet-amount"
              inputMode="decimal"
              value={max ? (preview && 'plan' in preview ? showAmount(preview.plan.amount, unit) : 'Everything') : amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setError(null);
              }}
              placeholder={unit === 'btc' ? '0.00' : '0'}
              autoComplete="off"
              disabled={busy || max}
              aria-invalid={!max && amountText.trim() !== '' && parseAmount(amountText, unit) === null}
              className={cn(field, 'tabular-nums')}
            />
            <PillButton className="h-11" onClick={() => setMax((m) => !m)} disabled={busy || available === 0} aria-pressed={max}>
              {max ? 'Enter Amount' : 'Send All'}
            </PillButton>
          </div>
          <p className="px-1 text-sm text-muted-foreground tabular-nums">
            {(() => {
              const sats = max ? (preview && 'plan' in preview ? preview.plan.amount : null) : parseAmount(amountText, unit);
              const worth = sats && price ? `${formatUsd(sats, price)} · ` : '';
              return utxos.data ? `${worth}${formatBtc(available)} BTC available` : utxos.isError ? 'Your balance couldn’t be loaded' : 'Loading your balance…';
            })()}
          </p>
        </div>

        <div className="space-y-2">
          <span className="text-sm font-medium" id="wallet-speed">
            Speed
          </span>
          <SegmentedControl
            label="Speed"
            size="md"
            value={speed}
            onValueChange={setSpeed}
            disabled={busy}
            options={SPEEDS.map((s) => ({ value: s.value, label: s.label, title: `${s.label}: ${s.wait}` }))}
          />
          <p className="px-1 text-sm text-muted-foreground">
            {fees.data
              ? `Confirms in ${SPEEDS.find((s) => s.value === speed)!.wait}, at ${fees.data[speed]} sat/vB.`
              : fees.isError
                ? 'Fee rates couldn’t be loaded.'
                : 'Looking up fee rates…'}
          </p>
        </div>

        {preview && (
          <div className="rounded-xl bg-muted/50 px-4 py-3 text-sm" aria-live="polite">
            {'plan' in preview ? (
              <dl className="space-y-1.5 tabular-nums">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Network fee</dt>
                  <dd>{formatSats(preview.plan.fee)}{price ? ` · ${formatUsd(preview.plan.fee, price)}` : ''}</dd>
                </div>
                <div className="flex justify-between gap-4 font-medium">
                  <dt>Total</dt>
                  <dd>
                    {formatBtc(preview.plan.amount + preview.plan.fee)} BTC
                    {price ? ` · ${formatUsd(preview.plan.amount + preview.plan.fee, price)}` : ''}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-destructive">{preview.error}</p>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <PillButton type="submit" variant="primary" className="h-11 px-6 text-base" disabled={!ready}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUpRight aria-hidden />}
            {busy ? STAGE_LABEL[stage] : 'Send'}
          </PillButton>
          {!busy && <p className="text-xs text-muted-foreground">Din shows you where it goes and asks before signing.</p>}
        </div>
      </form>
    </div>
  );
}
