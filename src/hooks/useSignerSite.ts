import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { grantRules, signerOriginOf, type GuardedMethod } from '@/lib/signerPermissions';

/**
 * A site's standing with the user's Nostr account: connected (and what it
 * may do without asking), blocked, or neither (null). Null too with no one
 * signed in.
 */
export function useSignerSite(url: string) {
  const { user, metadata } = useCurrentUser();
  const { grants, disconnect, revoke } = useSignerGrants();
  const origin = signerOriginOf(url);
  const grant = origin ? grants[origin] : undefined;
  if (!user || !origin || !grant) return null;
  return {
    origin,
    blocked: grant.status === 'blocked',
    rules: grantRules(grant),
    account: metadata?.display_name?.trim() || metadata?.name?.trim() || 'your account',
    disconnect: () => disconnect(origin),
    revoke: (method: GuardedMethod, kind?: number) => revoke(origin, method, kind),
  };
}

