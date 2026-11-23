import { useCallback } from 'react';
import type { NUser } from '@nostrify/react/login';
import { useAppData } from '@/hooks/useAppData';
import {
  DEFAULT_SIGNER_GRANTS,
  SIGNER_GRANTS_KEY,
  SignerGrantsSchema,
  withDecision,
  type GuardedMethod,
  type SignerGrants,
} from '@/lib/signerPermissions';

/**
 * An account's site grants (see signerPermissions.ts): the signed-in
 * account's, or `account`'s. Stored encrypted with the account so they roam
 * with it. Every mounted instance for one account shares one value.
 */
export function useSignerGrants(account?: NUser) {
  const [grants, setGrants] = useAppData<SignerGrants>(
    SIGNER_GRANTS_KEY,
    SignerGrantsSchema,
    DEFAULT_SIGNER_GRANTS,
    { account },
  );

  /** Forget everything about a site: it has to ask to connect again. */
  const disconnect = useCallback(
    (origin: string) => {
      setGrants((prev) => {
        const next = { ...prev };
        delete next[origin];
        return next;
      });
    },
    [setGrants],
  );

  /** Take back one remembered decision. Settings can only take away. */
  const revoke = useCallback(
    (origin: string, method: GuardedMethod, kind?: number) => {
      setGrants((prev) => {
        const grant = prev[origin];
        if (!grant) return prev;
        return { ...prev, [origin]: withDecision(grant, method, kind, null) };
      });
    },
    [setGrants],
  );

  return { grants, setGrants, disconnect, revoke };
}
