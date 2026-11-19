import { Copy, Link } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { middleEllipsis } from '@/lib/utils';
import { PillButton } from '@/shared/appChrome';
import { bitcoinUri } from '@/shared/bitcoin';
import { toast } from '@/shared/toast';

function copy(text: string, what: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast(`Couldn’t copy the ${what.toLowerCase()}`, { destructive: true }),
  );
}

/** The address in fours, easier to read aloud or check against another copy. */
function groups(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [address];
}

/** The account's address, to be paid at: a QR code to scan, and to copy. */
export function ReceiveView({ address, pubkey }: { address: string; pubkey: string }) {
  const npub = nip19.npubEncode(pubkey);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 pt-10 pb-8 text-center">
        <h2 className="font-[family-name:var(--font-title)] text-2xl font-semibold text-foreground">Receive Bitcoin</h2>
        <p className="mt-2 text-sm text-muted-foreground">Scan it, or copy the address and paste it where you’re sending from.</p>

        {/* A QR code reads best dark on white, whatever the theme. In capitals
            (BIP-21 allows it) it's a denser, easier code to scan. */}
        <div className="mt-8 rounded-2xl bg-white p-4 clay">
          <QRCodeCanvas value={bitcoinUri(address).toUpperCase()} size={224} level="M" className="block size-56" />
        </div>

        <p className="mt-6 flex max-w-sm flex-wrap justify-center gap-x-2.5 font-mono text-base leading-relaxed text-foreground" aria-label={`Your address: ${address}`}>
          {groups(address).map((group, i) => (
            <span key={i} aria-hidden>
              {group}
            </span>
          ))}
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <PillButton variant="primary" onClick={() => copy(address, 'Address')}>
            <Copy aria-hidden />
            Copy Address
          </PillButton>
          <PillButton onClick={() => copy(bitcoinUri(address), 'Link')}>
            <Link aria-hidden />
            Copy Link
          </PillButton>
        </div>

        <div className="mt-10 space-y-2 text-sm text-muted-foreground">
          <p>
            This is your Nostr account’s own address: anyone who knows your <span className="font-mono">{middleEllipsis(npub, 20)}</span> can
            send you bitcoin here, and only your account’s key can spend it.
          </p>
          <p>Only bitcoin sent onchain arrives here; not Lightning, and not other coins.</p>
        </div>
      </div>
    </div>
  );
}
