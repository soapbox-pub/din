import { useState } from 'react';
import { Ban, KeyRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolButtonClass } from '@/shared/appChromeStyles';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { grantRules, signerOriginOf } from '@/lib/signerPermissions';
import { ruleLabel } from '@/lib/signerLabels';
import { useSiteIdentity } from '@/hooks/useSiteIdentity';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Shown in the toolbar for a site that is connected to (or blocked from) the
 * user's Nostr account: what it may do without asking, each of which can be
 * taken back, and Disconnect. Renders nothing for other sites.
 */
export function SignerSiteButton({ url }: { url: string }) {
  const { user, metadata } = useCurrentUser();
  const { grants, disconnect, revoke } = useSignerGrants();
  const [open, setOpen] = useState(false);

  const origin = signerOriginOf(url);
  const grant = origin ? grants[origin] : undefined;
  const site = useSiteIdentity(origin ?? '').name;
  if (!user || !origin || !grant) return null;

  const blocked = grant.status === 'blocked';
  const rules = grantRules(grant);
  const label = blocked ? `${site} is blocked from your Nostr account` : `${site} is connected to your Nostr account`;
  const account = metadata?.display_name?.trim() || metadata?.name?.trim() || 'your account';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={cn(
            toolButtonClass,
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          {blocked ? <Ban className="size-4.5" strokeWidth={1.75} aria-hidden /> : <KeyRound className="size-4.5" strokeWidth={1.75} aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 space-y-4">
        <div className="space-y-1">
          <p className="truncate text-sm font-semibold">{site}</p>
          <p className="text-xs text-muted-foreground">
            {blocked
              ? 'Din refuses everything this site asks of your Nostr account.'
              : `Connected as ${account}. It can see your public key and relays, and asks before anything else.`}
          </p>
        </div>

        {!blocked && rules.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Without asking</p>
            <ul className="space-y-1">
              {rules.map((rule) => (
                <li
                  key={`${rule.method}:${rule.kind ?? ''}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-foreground/5"
                >
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                      rule.decision === 'allow'
                        ? 'bg-success/15 text-success'
                        : 'bg-destructive/15 text-destructive',
                    )}
                  >
                    {rule.decision === 'allow' ? 'Allow' : 'Deny'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{ruleLabel(rule.method, rule.kind)}</span>
                  <button
                    type="button"
                    aria-label={`Forget: ${ruleLabel(rule.method, rule.kind)}`}
                    onClick={() => revoke(origin, rule.method, rule.kind)}
                    className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-border/60 pt-4">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              disconnect(origin);
              setOpen(false);
            }}
          >
            {blocked ? 'Unblock' : 'Disconnect'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
