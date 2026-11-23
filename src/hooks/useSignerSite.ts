import { useSyncExternalStore } from 'react';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { grantRules, signerOriginOf, type GuardedMethod } from '@/lib/signerPermissions';
import { siteIdentitiesSnapshot, subscribeSiteIdentities } from '@/lib/siteIdentities';

/**
 * A site's standing with the account its window.nostr acts as (or, for one
 * that hasn't been given one, the desktop's): connected (and what it may do
 * without asking), blocked, or neither (null). Null too with no one signed in.
 */
export function useSignerSite(url: string) {
  const { user, users } = useCurrentUser();
  const origin = signerOriginOf(url);
  const identities = useSyncExternalStore(subscribeSiteIdentities, siteIdentitiesSnapshot);
  const recorded = origin ? identities[origin] : undefined;
  const account = users.find((u) => u.pubkey === recorded) ?? user;
  const { grants, disconnect, revoke } = useSignerGrants(account);
  const metadata = useAuthor(account?.pubkey).data?.metadata;
  const grant = origin ? grants[origin] : undefined;
  if (!account || !origin || !grant) return null;
  return {
    origin,
    blocked: grant.status === 'blocked',
    rules: grantRules(grant),
    account: metadata?.display_name?.trim() || metadata?.name?.trim() || 'your account',
    disconnect: () => disconnect(origin),
    revoke: (method: GuardedMethod, kind?: number) => revoke(origin, method, kind),
  };
}
