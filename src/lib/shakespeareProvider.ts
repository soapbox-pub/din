/**
 * Shakespeare AI for the assistant (https://ai.shakespeare.diy): an
 * OpenAI-compatible provider whose accounts are Nostr pubkeys, paid for with
 * prepaid credits. OpenCode knows it through Din's plugin for it
 * (os/opencode/plugins/shakespeare), which takes an API key; Din makes that
 * key for the user here, with one NIP-98 request signed as the signed-in
 * account, and hands it to OpenCode. Settings → Assistant, the Add provider
 * window and `din assistant connect-shakespeare` share this.
 */

import { NIP98Client, type NostrSigner } from '@nostrify/nostrify';
import { assistantApi, credentialIDs } from '@/lib/assistant';

export const SHAKESPEARE_PROVIDER = 'shakespeare';
export const SHAKESPEARE_ORIGIN = 'https://ai.shakespeare.diy';
/** Where credits are bought: the dashboard, signed in with the same account. */
export const SHAKESPEARE_CREDITS_URL = `${SHAKESPEARE_ORIGIN}/credits`;
export const SHAKESPEARE_KEYS_URL = `${SHAKESPEARE_ORIGIN}/keys`;

/** Most the key Din makes may spend in a month, in credits (US dollars); the owner can change it on the dashboard. */
export const SHAKESPEARE_MONTHLY_LIMIT = 50;
/** How long OpenCode has to list Shakespeare's models once the key is in. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Make a Shakespeare API key for the account `signer` signs as, with a
 * monthly limit. The key is shown only in this answer.
 */
export async function createShakespeareKey(signer: NostrSigner): Promise<string> {
  const response = await new NIP98Client({ signer }).fetch(`${SHAKESPEARE_ORIGIN}/v1/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Din', limit: SHAKESPEARE_MONTHLY_LIMIT, limit_reset: 'monthly' }),
  });
  const body = (await response.json().catch(() => null)) as { key?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok || typeof body?.key !== 'string') {
    const message = typeof body?.error?.message === 'string' ? body.error.message : `Shakespeare answered ${response.status}`;
    throw new Error(message);
  }
  return body.key;
}

/**
 * Connect the assistant to Shakespeare: a new key for the signed-in account,
 * given to OpenCode in place of any it had, and wait until its models are
 * there. `key` connects one the user pasted instead.
 */
export async function connectShakespeareProvider(source: { signer: NostrSigner } | { key: string }): Promise<void> {
  const before = await assistantApi.integration(SHAKESPEARE_PROVIDER).catch(() => null);
  if (!before) throw new Error('This OpenCode doesn’t have Din’s Shakespeare plugin. It comes with DinOS.');
  const key = 'key' in source ? source.key.trim() : await createShakespeareKey(source.signer);
  await assistantApi.connectKey(SHAKESPEARE_PROVIDER, key);
  // The new key is in; the ones it replaces go.
  await Promise.allSettled(credentialIDs(before).map((id) => assistantApi.removeCredential(id)));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const models = await assistantApi.models().catch(() => []);
    if (models.some((m) => m.providerID === SHAKESPEARE_PROVIDER)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Shakespeare is connected, but OpenCode hasn’t listed its models yet. Check the connection, and try again.');
}
