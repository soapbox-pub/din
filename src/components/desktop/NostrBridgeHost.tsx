import { useCallback, useEffect, useRef, useState } from 'react';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
import type { NUser } from '@nostrify/react/login';
import { KeyRound } from 'lucide-react';
import { verifyEvent } from 'nostr-tools';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppContext } from '@/hooks/useAppContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getBunkerBridge } from '@/lib/bunkerBridge';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { closeNotification, notify } from '@/lib/notificationCenter';
import {
  getNostrHostBridge,
  type NostrBridgeRequest,
  type NostrBridgeResponse,
  type RememberedDecision,
  type SignerErrorName,
} from '@/lib/nostrBridge';
import {
  decide,
  isSignerMethod,
  withDecision,
  type Decision,
  type GuardedMethod,
  type SignerMethod,
  type SignerGrants,
  type SiteGrant,
} from '@/lib/signerPermissions';
import { isDinAppOrigin, setSiteIdentity, siteIdentity } from '@/lib/siteIdentities';
import { originLabel, questionTitle } from '@/lib/signerLabels';
import { APP_DATA_KIND, MAX_CLOCK_SKEW_SECONDS, isAppDataDTag } from '@/lib/appData';
import { serveAppSignerRequests } from '@/lib/appSigner';
import { canSignBitcoin } from '@/lib/bitcoinSigners';
import type { PsbtSummary } from '@/shared/bitcoin';
import { SignerPrompt, type PromptAnswer, type SignerPromptItem } from '@/components/desktop/SignerPrompt';
import { CONNECT_APP_APP_ID, connectAppParams } from '@/lib/settingsWindows';

/** At most this many questions per site in RATE_WINDOW_MS; more are refused unasked. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 30_000;

/** lastUsed is written at most this often per site, to keep sync quiet. */
const TOUCH_INTERVAL_MS = 60 * 60_000;

const REJECTED = 'User rejected the request';

/** A failure window.nostr rejects with as a DOMException of this name (or a TypeError). */
class SignerError extends Error {
  constructor(readonly errorName: SignerErrorName, message: string) {
    super(message);
  }
}

const rejected = () => new SignerError('NotAllowedError', REJECTED);
const notHeld = () => new SignerError('NotFoundError', 'This site isn’t signed in with that account');
const invalid = (message: string) => new SignerError('TypeError', message);

/** window.nostr's own methods beyond NIP-07's (nostr-preload.cjs). */
const IDENTITY_METHODS = new Set(['requestPublicKey', 'getSigner']);

/** One signed-in account and its site grants. */
interface AccountGrants {
  user: NUser;
  grants: SignerGrants;
  setGrants: (update: (prev: SignerGrants) => SignerGrants) => void;
}

/** Feeds one account's grants to the host (one per signed-in account). */
function AccountGrantsFeed({ user, onChange }: { user: NUser; onChange: (pubkey: string, entry: AccountGrants | null) => void }) {
  const { grants, setGrants } = useSignerGrants(user);
  useEffect(() => {
    onChange(user.pubkey, { user, grants, setGrants });
  }, [user, grants, setGrants, onChange]);
  useEffect(() => () => onChange(user.pubkey, null), [user.pubkey, onChange]);
  return null;
}

/** A NIP-07 event template, checked: what a page sent may be anything. */
interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

function parseTemplate(input: unknown): EventTemplate {
  const e = (input ?? {}) as Record<string, unknown>;
  if (typeof e.kind !== 'number' || !Number.isInteger(e.kind) || e.kind < 0 || e.kind > 65535) {
    throw invalid('Invalid event: kind');
  }
  const content = e.content ?? '';
  if (typeof content !== 'string') throw invalid('Invalid event: content');
  const tags = e.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
    throw invalid('Invalid event: tags');
  }
  const now = Math.floor(Date.now() / 1000);
  const createdAt = e.created_at ?? now;
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) {
    throw invalid('Invalid event: created_at');
  }
  // An event from the future would outrank every later one of its kind.
  if (createdAt > now + MAX_CLOCK_SKEW_SECONDS) throw invalid('Invalid event: created_at is in the future');
  // Din's own app data (which sites may use the signer, installed apps) is
  // Din's to write: a site that may keep its settings in kind 30078 mustn't
  // keep them under Din's names.
  if (e.kind === APP_DATA_KIND && (tags as string[][]).some(([name, value]) => name === 'd' && isAppDataDTag(value))) {
    throw new Error("Din's own settings can only be written by Din");
  }
  return { kind: e.kind, content, tags: tags as string[][], created_at: createdAt };
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') throw invalid(`Invalid ${name}`);
  return value;
}

/** Loaded when something first asks to sign a Bitcoin transaction. */
const loadBitcoin = () => import('@/shared/bitcoin');

/**
 * What a signPsbt request would do with `account`'s bitcoin, for its prompt.
 * Throws, before anything is asked, for a PSBT that isn't one or has nothing
 * of the account's to sign.
 */
async function readPsbt(params: Record<string, unknown>, account: string): Promise<PsbtSummary> {
  const psbt = stringParam(params, 'psbt');
  if (psbt.length > 400_000) throw new Error('That transaction is too big');
  return (await loadBitcoin()).summarizePsbt(psbt, account);
}

/**
 * Desktop-lifetime host for Din's signer as other software sees it: NIP-07
 * window.nostr in browser tabs and installed web apps (electron/nostr-preload.cjs),
 * Din's own app windows with the nostr permission (din.account.nostr, by way
 * of src/lib/appSigner.ts), and apps connected over NIP-46 (electron/bunker.mts).
 * Main, or the app's window, establishes who is asking; this decides, asks
 * the user when it has to, and signs with the account's signer.
 *
 * - A site holds the identities the user gave it, one at a time, and acts
 *   as no other: window.nostr as the first (src/lib/siteIdentities.ts),
 *   which never changes underneath it, and window.nostr.getSigner(pubkey)
 *   as any other it holds. requestPublicKey() asks the user to give it one
 *   more. Switching Din's account changes none of them; Din's own apps act
 *   as the desktop's account.
 * - A browser tab has to be **connected** before it learns who the user is,
 *   and asking to connect needs a click on the page, so sites can't pop the
 *   question on load. With more than one account signed in, connecting is
 *   choosing which. Installed apps are connected by being installed (asked
 *   which account, when there's more than one), and Din's apps by holding
 *   the nostr permission.
 * - Signing (per kind) and encrypting or decrypting (per method) are asked
 *   about, unless the user remembered an answer for that site and that
 *   account. NIP-42 relay AUTH is signed without asking once a site is
 *   connected.
 * - Signing a Bitcoin transaction (signPsbt) is asked about every time, with
 *   where the money goes and the fee, as the PSBT itself says.
 * - Closing the prompt is a no, never remembered, and that tab can't ask again
 *   until it navigates or the user clicks in it.
 * - One question at a time; queued ones that a remembered answer has since
 *   settled are answered without being shown.
 * - A page's promise rejects with a DOMException it can tell apart
 *   (SignerError): NotFoundError when the site doesn't hold the account,
 *   NotAllowedError when the answer was no, TypeError for a malformed call.
 *
 * Renders the prompt. Outside the Electron shell only Din's apps ask.
 */
export function NostrBridgeHost() {
  const { user, users } = useCurrentUser();
  const { config } = useAppContext();

  const { open } = useWindowActions();
  const [queue, setQueue] = useState<SignerPromptItem[]>([]);

  // A nostrconnect:// link opened in a page goes to Settings' Connect an App
  // window, which shows the app it's for and connects it only if the user
  // says so.
  useEffect(() => {
    return getBunkerBridge()?.onLink((uri) => {
      open(CONNECT_APP_APP_ID, connectAppParams(uri));
    });
  }, [open]);

  // The request handler is subscribed once; it reads the latest of these.
  const latest = useRef({ user, users, relays: config.relayMetadata.relays });
  useEffect(() => {
    latest.current = { user, users, relays: config.relayMetadata.relays };
  }, [user, users, config.relayMetadata.relays]);

  /** Every signed-in account's site grants, as each one's feed reports them. */
  const accounts = useRef(new Map<string, AccountGrants>());
  const onAccountGrants = useCallback((pubkey: string, entry: AccountGrants | null) => {
    if (entry) accounts.current.set(pubkey, entry);
    else accounts.current.delete(pubkey);
  }, []);

  const queueRef = useRef<SignerPromptItem[]>([]);
  const nextItemId = useRef(1);
  /** `${wcId}|${origin}`: tabs whose prompt was dismissed. */
  const suppressed = useRef(new Set<string>());
  const asked = useRef(new Map<string, number[]>());
  /**
   * Bunker answers remembered while their questions were queued. Main keeps
   * the real grants; this only lets the questions behind one be settled by it.
   */
  const bunkerAnswers = useRef(new Map<string, Pick<SiteGrant, 'methods' | 'kinds'>>());

  const updateQueue = useCallback((update: (q: SignerPromptItem[]) => SignerPromptItem[]) => {
    queueRef.current = update(queueRef.current);
    setQueue(queueRef.current);
  }, []);

  const settle = useCallback(
    (item: SignerPromptItem, answer: PromptAnswer) => {
      updateQueue((q) => q.filter((i) => i.id !== item.id));
      if (queueRef.current.length === 0) bunkerAnswers.current.clear();
      if (item.request.source === 'bunker') closeNotification(`signer:${item.id}`, 'closed');
      item.resolve(answer);
    },
    [updateQueue],
  );

  /** Put a question to the user; resolves with their answer. */
  const ask = useCallback(
    (item: Omit<SignerPromptItem, 'id' | 'resolve'>): Promise<PromptAnswer> =>
      new Promise((resolve) => {
        const full: SignerPromptItem = { ...item, id: nextItemId.current++, resolve };
        updateQueue((q) => [...q, full]);
        // A remote app's question may come while nobody is looking at Din.
        // Like Tenna's lock-screen notice, it says what kind of thing is
        // asked, never what's in it.
        if (item.request.source === 'bunker') {
          notify({
            id: `signer:${full.id}`,
            source: { name: 'Din', icon: KeyRound },
            title: `${item.name} is asking`,
            body: questionTitle(item.question, item.kind),
            badge: KeyRound,
            history: false,
            timeout: 0,
          });
        }
      }),
    [updateQueue],
  );

  // The question at the front may have been settled by an answer the user
  // just remembered for an earlier one: answer it without showing it.
  const head = queue[0];
  useEffect(() => {
    if (!head) return;
    const decision = head.recheck();
    if (decision !== 'ask') settle(head, { choice: decision, remember: false });
  }, [head, settle]);

  // Din's own apps act as the desktop's account: their questions asked for
  // the previous one are dropped. Sites keep theirs, which switching doesn't
  // touch.
  const pubkey = user?.pubkey;
  const previousPubkey = useRef(pubkey);
  useEffect(() => {
    if (previousPubkey.current === pubkey) return;
    previousPubkey.current = pubkey;
    for (const item of queueRef.current) {
      if (item.request.source !== 'bunker' && isDinAppOrigin(item.request.origin)) {
        settle(item, { choice: 'dismiss', remember: false });
      }
    }
  }, [pubkey, settle]);

  useEffect(() => {
    const bridge = getNostrHostBridge();

    const userOf = (account: string) => latest.current.users.find((u) => u.pubkey === account);
    const grantOf = (account: string, origin: string) => accounts.current.get(account)?.grants[origin];
    /** Whether a site holds a signed-in account. */
    const holds = (origin: string, account: string | undefined) =>
      account !== undefined && Boolean(userOf(account)) && grantOf(account, origin)?.status === 'connected';
    /** Whether a site is refused everything (by any signed-in account's grant). */
    const blockedFor = (origin: string) =>
      [...accounts.current.values()].some((entry) => entry.grants[origin]?.status === 'blocked');

    /** Change one account's grant for a site; what's read next sees it at once. */
    const updateGrant = (
      account: string,
      origin: string,
      update: (grant: SiteGrant | undefined) => SiteGrant | undefined,
    ) => {
      const entry = accounts.current.get(account);
      if (!entry) return;
      const apply = (prev: SignerGrants): SignerGrants => {
        const next = { ...prev };
        const grant = update(prev[origin]);
        if (grant) next[origin] = grant;
        else delete next[origin];
        return next;
      };
      entry.grants = apply(entry.grants);
      entry.setGrants(apply);
    };

    /**
     * The account a site's window.nostr acts as: the one it was given first.
     * A site connected before Din kept that gets the first signed-in account
     * that holds it. undefined: it has none yet. null: it had one, and no
     * longer holds it (disconnected, or signed out of Din).
     */
    const primaryOf = (origin: string): string | null | undefined => {
      const recorded = siteIdentity(origin);
      if (recorded) return holds(origin, recorded) ? recorded : null;
      const found = latest.current.users.find((u) => holds(origin, u.pubkey));
      if (found) setSiteIdentity(origin, found.pubkey);
      return found?.pubkey;
    };

    const rateLimited = (origin: string): boolean => {
      const now = Date.now();
      const recent = (asked.current.get(origin) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
      if (recent.length >= RATE_LIMIT) return true;
      asked.current.set(origin, [...recent, now]);
      return false;
    };

    async function fulfill(
      signer: NostrSigner,
      account: string,
      method: SignerMethod,
      params: Record<string, unknown>,
      preview: string | undefined,
    ): Promise<unknown> {
      switch (method) {
        case 'getPublicKey':
          return account;
        case 'getRelays': {
          const map: Record<string, { read: boolean; write: boolean }> = {};
          for (const relay of latest.current.relays) map[relay.url] = { read: relay.read, write: relay.write };
          return map;
        }
        case 'signEvent': {
          const template = parseTemplate(params.event);
          const signed: NostrEvent = await signer.signEvent(template);
          // Check what the signer gave back rather than trusting it.
          if (
            signed.pubkey !== account ||
            signed.kind !== template.kind ||
            signed.content !== template.content ||
            signed.created_at !== template.created_at ||
            JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
            !verifyEvent(signed)
          ) {
            throw new Error('The signer returned a different event');
          }
          return signed;
        }
        case 'nip04.encrypt':
        case 'nip04.decrypt':
        case 'nip44.encrypt':
        case 'nip44.decrypt': {
          const [nip, op] = method.split('.') as ['nip04' | 'nip44', 'encrypt' | 'decrypt'];
          if (op === 'decrypt' && preview !== undefined) return preview;
          const impl = signer[nip];
          if (!impl) throw new Error(`This account can't use ${nip.toUpperCase()}`);
          const peer = stringParam(params, 'pubkey');
          return op === 'encrypt'
            ? impl.encrypt(peer, stringParam(params, 'plaintext'))
            : impl.decrypt(peer, stringParam(params, 'ciphertext'));
        }
        case 'signPsbt': {
          const psbt = stringParam(params, 'psbt');
          if (!canSignBitcoin(signer)) throw new Error('This account can’t sign Bitcoin transactions');
          const signed: unknown = await signer.signPsbt(psbt);
          // Check what the signer gave back rather than trusting it.
          const { psbtTxid } = await loadBitcoin();
          if (typeof signed !== 'string' || psbtTxid(signed) !== psbtTxid(psbt)) {
            throw new Error('The signer returned a different transaction');
          }
          return signed;
        }
      }
    }

    /**
     * Give a site one of the signed-in accounts (asking which, and whether,
     * when there's a question to ask), and resolve with it. `another`: the
     * site asked for one more (requestPublicKey), so the user is always asked.
     */
    async function connect(request: NostrBridgeRequest, name: string, tabKey: string, another: boolean): Promise<string> {
      const { origin } = request;
      const { users } = latest.current;
      if (blockedFor(origin)) throw rejected();
      if (another && request.wcId === null) throw new SignerError('NotAllowedError', 'Only a page can ask for another account');
      const choices = users
        .filter((u) => grantOf(u.pubkey, origin)?.status !== 'blocked')
        .map((u) => ({ pubkey: u.pubkey, held: holds(origin, u.pubkey) }));
      const first = choices.find((c) => !c.held) ?? choices[0];
      if (!first) throw rejected();

      let chosen = first.pubkey;
      // An installed app is connected by being installed, when there's only
      // one account it could be.
      if (request.source === 'tab' || another || choices.length > 1) {
        if (suppressed.current.has(tabKey)) throw rejected();
        if ((request.source === 'tab' || another) && !request.userActivated) {
          throw new SignerError('NotAllowedError', 'Din asks to connect a site only after a click on the page');
        }
        const answer = await ask({
          request,
          question: request.source === 'tab' ? 'connect' : 'getPublicKey',
          name,
          account: first.pubkey,
          signer: userOf(first.pubkey)?.signer ?? users[0].signer,
          choices,
          another,
          recheck: () => (blockedFor(origin) ? 'deny' : !another && primaryOf(origin) ? 'allow' : 'ask'),
        });
        if (answer.choice === 'block') {
          // Kept with the desktop's account, where Settings shows it.
          const desktop = latest.current.user?.pubkey;
          if (desktop) {
            updateGrant(desktop, origin, () => ({ status: 'blocked', name, methods: {}, kinds: {}, createdAt: Date.now(), lastUsed: Date.now() }));
          }
          throw rejected();
        }
        if (answer.choice !== 'allow') {
          if (answer.choice === 'dismiss') suppressed.current.add(tabKey);
          throw rejected();
        }
        if (!answer.account) {
          // Settled unasked: the site was given an account meanwhile.
          const primary = primaryOf(origin);
          if (primary) return primary;
          throw rejected();
        }
        chosen = answer.account;
        if (!userOf(chosen)) throw rejected();
      }

      // Connecting a site (or installing an app) lets it see who you are.
      const now = Date.now();
      updateGrant(chosen, origin, (g) =>
        g?.status === 'connected' ? g : { status: 'connected', name, methods: {}, kinds: {}, createdAt: now, lastUsed: now },
      );
      // The first account a site holds is window.nostr's, until it no longer
      // holds it.
      if (!holds(origin, siteIdentity(origin))) setSiteIdentity(origin, chosen);
      return chosen;
    }

    /** Decide on a request as `account`, which the asker holds, asking if need be, and fulfil it. */
    async function decideAndFulfill(
      request: NostrBridgeRequest,
      method: SignerMethod,
      account: string,
      name: string,
      tabKey: string,
    ): Promise<unknown> {
      const { origin } = request;
      const params = (request.params ?? {}) as Record<string, unknown>;
      const signerUser = userOf(account);
      const grant = grantOf(account, origin);
      if (!signerUser || !grant) throw notHeld();
      if (Date.now() - grant.lastUsed > TOUCH_INTERVAL_MS) {
        updateGrant(account, origin, (g) => (g ? { ...g, lastUsed: Date.now() } : g));
      }

      if (method === 'signEvent') {
        const claimed = (params.event as { pubkey?: unknown } | undefined)?.pubkey;
        if (claimed !== undefined && claimed !== account) throw invalid('That event is for a different account');
      }
      const kind = method === 'signEvent' ? parseTemplate(params.event).kind : undefined;
      const psbt = method === 'signPsbt' ? await readPsbt(params, account) : undefined;
      let preview: string | undefined;
      const decision = decide(grantOf(account, origin), method, kind);
      if (decision === 'deny') throw rejected();
      if (decision === 'ask') {
        if (suppressed.current.has(tabKey)) throw rejected();
        if (rateLimited(origin)) throw new SignerError('NotAllowedError', 'Too many requests; try again in a moment');
        const answer = await ask({
          request,
          question: method,
          kind,
          psbt,
          name,
          account,
          signer: signerUser.signer,
          recheck: () => decide(grantOf(account, origin), method, kind),
        });
        // Disconnected, or signed out of Din, while the question waited.
        if (!userOf(account) || grantOf(account, origin)?.status !== 'connected') throw notHeld();
        if (answer.remember && (answer.choice === 'allow' || answer.choice === 'deny')) {
          const remembered: Decision = answer.choice;
          updateGrant(account, origin, (g) => (g ? withDecision(g, method as GuardedMethod, kind, remembered) : g));
        }
        if (answer.choice !== 'allow') {
          if (answer.choice === 'dismiss' && request.source === 'tab') suppressed.current.add(tabKey);
          throw rejected();
        }
        preview = answer.preview;
      }

      return fulfill(signerUser.signer, account, method, params, preview);
    }

    /** A request from one of Din's own apps: it acts as the desktop's account. */
    async function handleDinApp(request: NostrBridgeRequest, method: string): Promise<unknown> {
      const { user } = latest.current;
      if (!user) throw new SignerError('NotAllowedError', 'Not signed in to Din');
      if (!isSignerMethod(method)) throw invalid(`Unsupported method: ${method}`);
      const { origin } = request;
      const name = originLabel(origin);
      if (grantOf(user.pubkey, origin)?.status === 'blocked') throw rejected();
      // Holding the nostr permission connects an app.
      const now = Date.now();
      updateGrant(user.pubkey, origin, (g) => g ?? { status: 'connected', name, methods: {}, kinds: {}, createdAt: now, lastUsed: now });
      return decideAndFulfill(request, method, user.pubkey, name, `${request.wcId}|${origin}`);
    }

    /** A web page's or installed app's request. */
    async function handlePage(request: NostrBridgeRequest): Promise<unknown> {
      const { origin, method } = request;
      if (isDinAppOrigin(origin)) return handleDinApp(request, method);
      if (latest.current.users.length === 0) throw new SignerError('NotAllowedError', 'Not signed in to Din');
      if (!isSignerMethod(method) && !IDENTITY_METHODS.has(method)) throw invalid(`Unsupported method: ${method}`);
      const params = (request.params ?? {}) as Record<string, unknown>;
      const tabKey = `${request.wcId}|${origin}`;
      if (request.userActivated) suppressed.current.delete(tabKey);
      const name = originLabel(origin);
      if (blockedFor(origin)) throw rejected();

      if (method === 'requestPublicKey') return connect(request, name, tabKey, true);

      // Pinned to one of the site's accounts (getSigner), or the site's own.
      let account: string;
      if (params.account !== undefined) {
        const pinned = params.account;
        if (typeof pinned !== 'string' || !/^[0-9a-f]{64}$/.test(pinned)) throw invalid('Invalid public key');
        if (!holds(origin, pinned)) throw notHeld();
        account = pinned;
      } else {
        if (method === 'getSigner') throw invalid('Invalid public key');
        const primary = primaryOf(origin);
        if (primary) account = primary;
        // The site's own account is gone: only asking who the user is gives
        // it another, so nothing it does is done as an account it didn't ask for.
        else if (primary === null && method !== 'getPublicKey') throw notHeld();
        else account = await connect(request, name, tabKey, false);
      }

      if (method === 'getSigner') return account;
      if (!isSignerMethod(method)) throw invalid(`Unsupported method: ${method}`);
      return decideAndFulfill(request, method, account, name, tabKey);
    }
    /** An app connected over NIP-46. Its grants live with the connection, in main. */
    async function handleBunker(
      request: NostrBridgeRequest,
      method: SignerMethod,
    ): Promise<{ result: unknown; remember?: RememberedDecision }> {
      const client = request.client;
      const account = request.account;
      if (!client || !account) throw new Error('Invalid request');
      const params = (request.params ?? {}) as Record<string, unknown>;
      const signerUser = latest.current.users.find((u) => u.pubkey === account);
      if (!signerUser) throw new Error("Din isn't signed in to the account this app is connected to");

      const kind = method === 'signEvent' ? parseTemplate(params.event).kind : undefined;
      const psbt = method === 'signPsbt' ? await readPsbt(params, account) : undefined;
      if (method === 'signEvent') {
        const claimed = (params.event as { pubkey?: unknown } | undefined)?.pubkey;
        if (claimed !== undefined && claimed !== account) throw new Error('That event is for a different account');
      }

      const current = () => {
        const answered = bunkerAnswers.current.get(request.origin);
        return {
          status: 'connected' as const,
          methods: { ...client.grants.methods, ...answered?.methods },
          kinds: { ...client.grants.kinds, ...answered?.kinds },
        };
      };
      const decision = decide(current(), method, kind);
      if (decision === 'deny') throw new Error(REJECTED);
      let remember: RememberedDecision | undefined;
      let preview: string | undefined;
      if (decision === 'ask') {
        if (rateLimited(request.origin)) throw new Error('Too many requests; try again in a moment');
        const answer = await ask({
          request,
          question: method,
          kind,
          psbt,
          name: client.name || 'An app',
          account,
          signer: signerUser.signer,
          recheck: () => decide(current(), method, kind),
        });
        if (answer.remember && (answer.choice === 'allow' || answer.choice === 'deny')) {
          remember = { method, kind, decision: answer.choice };
          bunkerAnswers.current.set(
            request.origin,
            withDecision(bunkerAnswers.current.get(request.origin) ?? { methods: {}, kinds: {} }, method as GuardedMethod, kind, answer.choice),
          );
        }
        if (answer.choice !== 'allow') {
          const error = new Error(REJECTED) as Error & { remember?: RememberedDecision };
          error.remember = remember;
          throw error;
        }
        preview = answer.preview;
      }
      return { result: await fulfill(signerUser.signer, account, method, params, preview), remember };
    }

    // Din's own app windows, with the nostr permission (DinAppFrame).
    const offApps = serveAppSignerRequests((request) => handleDinApp(request, request.method));
    if (!bridge) return offApps;

    const offRequest = bridge.onRequest(async (request) => {
      const response: NostrBridgeResponse = { requestId: request.requestId, ok: false };
      try {
        if (request.source === 'bunker') {
          if (!isSignerMethod(request.method)) throw new Error(`Unsupported method: ${request.method}`);
          const { result, remember } = await handleBunker(request, request.method);
          Object.assign(response, { ok: true, result, remember });
        } else {
          Object.assign(response, { ok: true, result: await handlePage(request) });
        }
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error);
        if (error instanceof SignerError) response.errorName = error.errorName;
        const remember = (error as { remember?: RememberedDecision }).remember;
        if (remember) response.remember = remember;
      }
      bridge.respond(response);
    });

    const offCancel = bridge.onCancel((requestId) => {
      for (const item of queueRef.current) {
        if (item.request.requestId === requestId) settle(item, { choice: 'deny', remember: false });
      }
    });

    const offPage = bridge.onPageChanged((wcId) => {
      for (const key of suppressed.current) {
        if (key.startsWith(`${wcId}|`)) suppressed.current.delete(key);
      }
    });

    return () => {
      offApps();
      offRequest();
      offCancel();
      offPage();
    };
  }, [ask, settle]);

  return (
    <>
      {users.map((u) => (
        <AccountGrantsFeed key={u.pubkey} user={u} onChange={onAccountGrants} />
      ))}
      {head && <SignerPrompt key={head.id} item={head} onAnswer={(answer) => settle(head, answer)} />}
    </>
  );
}
