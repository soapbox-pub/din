import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { useSignerSite } from '@/hooks/useSignerSite';
import { ruleLabel } from '@/lib/signerLabels';
import { Button } from '@/components/ui/button';

export type SignerSite = NonNullable<ReturnType<typeof useSignerSite>>;

/**
 * What a site connected to (or blocked from) the user's Nostr account may do
 * without asking, each of which can be taken back, and Disconnect (or
 * Unblock). A page of the site's info.
 */
export function SignerSitePanel({ signer, onDone }: { signer: SignerSite; onDone: () => void }) {
  const { blocked, rules, account } = signer;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {blocked
          ? 'Din refuses everything this site asks of your Nostr account.'
          : `Connected as ${account}. It can see your public key and relays, and asks before anything else.`}
      </p>

      {!blocked && rules.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Without asking</p>
          <ul className="-mx-2 space-y-0.5">
            {rules.map((rule) => (
              <li
                key={`${rule.method}:${rule.kind ?? ''}`}
                className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-foreground/5"
              >
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                    rule.decision === 'allow' ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
                  )}
                >
                  {rule.decision === 'allow' ? 'Allow' : 'Deny'}
                </span>
                <span className="min-w-0 flex-1 truncate">{ruleLabel(rule.method, rule.kind)}</span>
                <button
                  type="button"
                  aria-label={`Forget: ${ruleLabel(rule.method, rule.kind)}`}
                  onClick={() => signer.revoke(rule.method, rule.kind)}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          signer.disconnect();
          onDone();
        }}
      >
        {blocked ? 'Unblock' : 'Disconnect'}
      </Button>
    </div>
  );
}
