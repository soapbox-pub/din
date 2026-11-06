import { useCallback, useEffect, useRef, useState } from 'react';
import type { NostrEvent, NostrSigner } from '@nostrify/nostrify';
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
} from '@/lib/nostrBridge';
import {
  decide,
  isSignerMethod,
  withDecision,
  type Decision,
  type GuardedMethod,
  type SignerMethod,
  type SiteGrant,
} from '@/lib/signerPermissions';
import { originLabel, questionTitle } from '@/lib/signerLabels';
import { APP_DATA_KIND, MAX_CLOCK_SKEW_SECONDS, isAppDataDTag } from '@/lib/appData';
import { serveAppSignerRequests } from '@/lib/appSigner';
import { SignerPrompt, type PromptAnswer, type SignerPromptItem } from '@/components/desktop/SignerPrompt';
import { CONNECT_APP_APP_ID, connectAppParams } from '@/lib/settingsWindows';

/** At most this many questions per site in RATE_WINDOW_MS; more are refused unasked. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 30_000;

/** lastUsed is written at most this often per site, to keep sync quiet. */
const TOUCH_INTERVAL_MS = 60 * 60_000;

const REJECTED = 'User rejected the request';

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
    throw new Error('Invalid event: kind');
  }
  const content = e.content ?? '';
  if (typeof content !== 'string') throw new Error('Invalid event: content');
  const tags = e.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string'))) {
    throw new Error('Invalid event: tags');
  }
  const now = Math.floor(Date.now() / 1000);
  const createdAt = e.created_at ?? now;
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new Error('Invalid event: created_at');
  }
  // An event from the future would outrank every later one of its kind.
  if (createdAt > now + MAX_CLOCK_SKEW_SECONDS) throw new Error('Invalid event: created_at is in the future');
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
  if (typeof value !== 'string') throw new Error(`Invalid ${name}`);
  return value;
}

/**
 * Desktop-lifetime host for Din's signer as other software sees it: NIP-07
 * window.nostr in browser tabs and installed web apps (electron/nostr-preload.cjs),
 * Din's own app windows with the nostr permission (din.account.nostr, by way
 * of src/lib/appSigner.ts), and apps connected over NIP-46 (electron/bunker.mts).
 * Main, or the app's window, establishes who is asking; this decides, asks
 * the user when it has to, and signs with the account's signer.
 *
 * - A browser tab has to be **connected** before it learns who the user is,
 *   and asking to connect needs a click on the page, so sites can't pop the
 *   question on load. Installed apps are connected by being installed, and
 *   Din's apps by holding the nostr permission.
 * - Signing (per kind) and encrypting or decrypting (per method) are asked
 *   about, unless the user remembered an answer for that site. NIP-42 relay
 *   AUTH is signed without asking once a site is connected.
 * - Closing the prompt is a no, never remembered, and that tab can't ask again
 *   until it navigates or the user clicks in it.
 * - One question at a time; queued ones that a remembered answer has since
 *   settled are answered without being shown.
 *
 * Renders the prompt. Outside the Electron shell only Din's apps ask.
 */
export function NostrBridgeHost() {
  const { user, users } = useCurrentUser();
  const { config } = useAppContext();
  const { grants, setGrants } = useSignerGrants();

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
  const latest = useRef({ user, users, grants, relays: config.relayMetadata.relays });
  useEffect(() => {
    latest.current = { user, users, grants, relays: config.relayMetadata.relays };
  }, [user, users, grants, config.relayMetadata.relays]);

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

  // Pages hear about account switches, and questions asked for the previous
  // account are dropped.
  const pubkey = user?.pubkey;
  const previousPubkey = useRef(pubkey);
  useEffect(() => {
    if (previousPubkey.current === pubkey) return;
    previousPubkey.current = pubkey;
    for (const item of queueRef.current) {
      if (item.request.source !== 'bunker') settle(item, { choice: 'dismiss', remember: false });
    }
    getNostrHostBridge()?.accountChanged();
  }, [pubkey, settle]);

  useEffect(() => {
    const bridge = getNostrHostBridge();

    const updateGrant = (origin: string, update: (grant: SiteGrant | undefined) => SiteGrant | undefined) => {
      setGrants((prev) => {
        const next = { ...prev };
        const grant = update(prev[origin]);
        if (grant) next[origin] = grant;
        else delete next[origin];
        return next;
      });
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
      }
    }

    /** A web page's or installed app's request. */
    async function handlePage(request: NostrBridgeRequest, method: SignerMethod): Promise<unknown> {
      const { user } = latest.current;
      if (!user) throw new Error('Not signed in to Din');
      const { origin } = request;
      const params = (request.params ?? {}) as Record<string, unknown>;
      const tabKey = `${request.wcId}|${origin}`;
      if (request.userActivated) suppressed.current.delete(tabKey);

      const name = originLabel(origin);
      let grant = latest.current.grants[origin];
      if (grant?.status === 'blocked') throw new Error(REJECTED);

      if (!grant) {
        if (request.source === 'tab') {
          if (suppressed.current.has(tabKey)) throw new Error(REJECTED);
          if (!request.userActivated) {
            throw new Error('Din asks to connect a site only after a click on the page');
          }
          const answer = await ask({
            request,
            question: 'connect',
            name,
            account: user.pubkey,
            signer: user.signer,
            recheck: () => {
              const g = latest.current.grants[origin];
              return g ? (g.status === 'blocked' ? 'deny' : 'allow') : 'ask';
            },
          });
          if (latest.current.user?.pubkey !== user.pubkey) throw new Error(REJECTED);
          if (answer.choice === 'block') {
            updateGrant(origin, () => ({ status: 'blocked', name, methods: {}, kinds: {}, createdAt: Date.now(), lastUsed: Date.now() }));
            throw new Error(REJECTED);
          }
          if (answer.choice !== 'allow') {
            if (answer.choice === 'dismiss') suppressed.current.add(tabKey);
            throw new Error(REJECTED);
          }
        }
        // Connecting a site (or installing an app) lets it see who you are.
        const now = Date.now();
        grant = latest.current.grants[origin] ?? { status: 'connected', name, methods: {}, kinds: {}, createdAt: now, lastUsed: now };
        const connected = grant;
        updateGrant(origin, (g) => g ?? connected);
      } else if (Date.now() - grant.lastUsed > TOUCH_INTERVAL_MS) {
        updateGrant(origin, (g) => (g ? { ...g, lastUsed: Date.now() } : g));
      }

      const kind = method === 'signEvent' ? parseTemplate(params.event).kind : undefined;
      let preview: string | undefined;
      const decision = decide(latest.current.grants[origin] ?? grant, method, kind);
      if (decision === 'deny') throw new Error(REJECTED);
      if (decision === 'ask') {
        if (suppressed.current.has(tabKey)) throw new Error(REJECTED);
        if (rateLimited(origin)) throw new Error('Too many requests; try again in a moment');
        const answer = await ask({
          request,
          question: method,
          kind,
          name,
          account: user.pubkey,
          signer: user.signer,
          recheck: () => decide(latest.current.grants[origin], method, kind),
        });
        if (latest.current.user?.pubkey !== user.pubkey) throw new Error(REJECTED);
        if (answer.remember && (answer.choice === 'allow' || answer.choice === 'deny')) {
          const remembered: Decision = answer.choice;
          updateGrant(origin, (g) => (g ? withDecision(g, method as GuardedMethod, kind, remembered) : g));
        }
        if (answer.choice !== 'allow') {
          if (answer.choice === 'dismiss' && request.source === 'tab') suppressed.current.add(tabKey);
          throw new Error(REJECTED);
        }
        preview = answer.preview;
      }

      return fulfill(user.signer, user.pubkey, method, params, preview);
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
    const offApps = serveAppSignerRequests((request) => {
      if (!isSignerMethod(request.method)) return Promise.reject(new Error(`Unsupported method: ${request.method}`));
      return handlePage(request, request.method);
    });
    if (!bridge) return offApps;

    const offRequest = bridge.onRequest(async (request) => {
      const response: NostrBridgeResponse = { requestId: request.requestId, ok: false };
      try {
        if (!isSignerMethod(request.method)) throw new Error(`Unsupported method: ${request.method}`);
        if (request.source === 'bunker') {
          const { result, remember } = await handleBunker(request, request.method);
          Object.assign(response, { ok: true, result, remember });
        } else {
          Object.assign(response, { ok: true, result: await handlePage(request, request.method) });
        }
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error);
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
  }, [ask, setGrants, settle]);

  return head ? <SignerPrompt key={head.id} item={head} onAnswer={(answer) => settle(head, answer)} /> : null;
}
