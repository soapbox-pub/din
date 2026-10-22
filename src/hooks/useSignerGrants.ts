import { useCallback } from 'react';
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
 * The signed-in account's site grants (see signerPermissions.ts), stored
 * encrypted with the account so they roam with it. Every mounted instance
 * shares one value.
 */
export function useSignerGrants() {
  const [grants, setGrants] = useAppData<SignerGrants>(
    SIGNER_GRANTS_KEY,
    SignerGrantsSchema,
    DEFAULT_SIGNER_GRANTS,
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
