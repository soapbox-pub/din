import { z } from 'zod';

/**
 * What sites and apps may do with the user's Nostr account through Din's
 * signer, without asking (see NostrBridgeHost).
 *
 * Kept per account (through useAppData, so it roams encrypted with the
 * account) and per origin: a browser tab and an installed app on the same
 * origin are the same site and share one grant. Bunker clients keep theirs
 * with their connection, on this device (electron/bunker.mts), in the same
 * shape.
 *
 * - A site is **connected** once the user agreed to let it see who they are.
 *   That covers getPublicKey and getRelays; everything else is still asked.
 * - **Blocked** answers every request from the site with a no.
 * - signEvent is decided per kind, the others per method. A remembered "no"
 *   is honored like a remembered "yes".
 * - Nothing expires, as in Tenna: a permission that lapses is asked about
 *   again at a moment the user has no context for.
 */

export type SignerMethod =
  | 'getPublicKey'
  | 'getRelays'
  | 'signEvent'
  | 'nip04.encrypt'
  | 'nip04.decrypt'
  | 'nip44.encrypt'
  | 'nip44.decrypt';

/** Methods that are asked about one at a time (all but the identity ones). */
export type GuardedMethod = Exclude<SignerMethod, 'getPublicKey' | 'getRelays'>;

export const SIGNER_METHODS: readonly SignerMethod[] = [
  'getPublicKey',
  'getRelays',
  'signEvent',
  'nip04.encrypt',
  'nip04.decrypt',
  'nip44.encrypt',
  'nip44.decrypt',
];

export function isSignerMethod(method: string): method is SignerMethod {
  return (SIGNER_METHODS as readonly string[]).includes(method);
}

/** NIP-42 relay authentication: signed without asking, for connected sites. */
export const AUTH_KIND = 22242;

const DecisionSchema = z.enum(['allow', 'deny']);
export type Decision = z.infer<typeof DecisionSchema>;

const SiteGrantSchema = z.object({
  status: z.enum(['connected', 'blocked']),
  /** What the site was called when it connected (display only). */
  name: z.string().max(200).optional(),
  /** nip04/nip44 encrypt/decrypt. */
  methods: z.record(z.string(), DecisionSchema).default({}),
  /** signEvent, keyed by kind. */
  kinds: z.record(z.string(), DecisionSchema).default({}),
  /** Unix ms. */
  createdAt: z.number(),
  /** Unix ms. */
  lastUsed: z.number(),
});
export type SiteGrant = z.infer<typeof SiteGrantSchema>;

export const SignerGrantsSchema = z.record(z.string(), SiteGrantSchema);
export type SignerGrants = z.infer<typeof SignerGrantsSchema>;

export const DEFAULT_SIGNER_GRANTS: SignerGrants = {};

/** App-data key (becomes `computer.din.signer-permissions`). */
export const SIGNER_GRANTS_KEY = 'signer-permissions';

/**
 * What the grant says about a request: allowed, refused, or a question for
 * the user. `kind` is the event kind, for signEvent.
 */
export function decide(
  grant: Pick<SiteGrant, 'methods' | 'kinds'> & { status?: SiteGrant['status'] } | undefined,
  method: SignerMethod,
  kind?: number,
): Decision | 'ask' {
  if (grant?.status === 'blocked') return 'deny';
  if (method === 'getPublicKey' || method === 'getRelays') {
    return grant?.status === 'connected' ? 'allow' : 'ask';
  }
  if (!grant) return 'ask';
  if (method === 'signEvent') {
    if (kind === AUTH_KIND) return 'allow';
    return kind === undefined ? 'ask' : (grant.kinds[String(kind)] ?? 'ask');
  }
  return grant.methods[method] ?? 'ask';
}

/** A copy of `grant` with one decision written into it. */
export function withDecision<G extends Pick<SiteGrant, 'methods' | 'kinds'>>(
  grant: G,
  method: GuardedMethod,
  kind: number | undefined,
  decision: Decision | null,
): G {
  if (method === 'signEvent') {
    if (kind === undefined) return grant;
    const kinds = { ...grant.kinds };
    if (decision) kinds[String(kind)] = decision;
    else delete kinds[String(kind)];
    return { ...grant, kinds };
  }
  const methods = { ...grant.methods };
  if (decision) methods[method] = decision;
  else delete methods[method];
  return { ...grant, methods };
}

/** Every remembered decision in a grant, for listing. */
export function grantRules(grant: Pick<SiteGrant, 'methods' | 'kinds'>): {
  method: GuardedMethod;
  kind?: number;
  decision: Decision;
}[] {
  const rules: { method: GuardedMethod; kind?: number; decision: Decision }[] = [];
  for (const [kind, decision] of Object.entries(grant.kinds)) {
    rules.push({ method: 'signEvent', kind: Number(kind), decision });
  }
  for (const [method, decision] of Object.entries(grant.methods)) {
    if (isSignerMethod(method) && method !== 'getPublicKey' && method !== 'getRelays' && method !== 'signEvent') {
      rules.push({ method, decision });
    }
  }
  return rules.sort((a, b) => a.method.localeCompare(b.method) || (a.kind ?? 0) - (b.kind ?? 0));
}

/** Whether an origin is an nsite (NIP-5A), whose host is a key, not a name. */
export function isNsiteOrigin(origin: string): boolean {
  return origin.startsWith('nsite://');
}

/** A tab URL's origin as main reports it for window.nostr (`https://host`, `nsite://host`). */
export function signerOriginOf(url: string): string | null {
  try {
    const { protocol, host } = new URL(url);
    return /^(https?|nsite):$/.test(protocol) && host ? `${protocol}//${host}` : null;
  } catch {
    return null;
  }
}
