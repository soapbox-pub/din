// @ts-check
// Session preload giving web pages a NIP-07 window.nostr: browser tabs (not
// private ones), installed web apps and nsites. Registered with
// session.registerPreloadScript in main.mts twice, as a frame preload and as
// a service-worker preload, so their service workers get the same signer as
// self.nostr; it works out which it is.
//
// The provider holds no keys and decides nothing. Every call goes over IPC to
// the main process, which checks that it came from a tab's or app's top
// document, or a worker of such a site, and reads the origin from the frame
// or the worker's scope (never from the page), then relays it to the Din
// shell. There NostrBridgeHost asks the user, keeps what they decided per
// account and per site, and signs with the account's signer. The page only
// ever sees results.
//
// A worker has no window to click in, so it can't connect its site or ask
// for an account (requestPublicKey): it uses what the user gave the site in
// a window, and asks on screen for anything else, as its pages would.
//
// Din owns window.nostr: it is defined before any page script runs, and can't
// be replaced, so a Chrome extension that also provides one (nos2x, Alby)
// doesn't get to answer for the account the user signed in to Din with.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world: everything it needs comes in through `bridge`.
 *
 * window.nostr is NIP-07's signer, acting as the account signed in to Din,
 * as it always has, plus Din's two additions for clients that hold their
 * accounts themselves:
 *
 * - requestPublicKey(): asks the user to give the site an account (always a
 *   question, and only after a click), resolving with its key.
 * - getSigner(pubkey): a NIP-07 signer pinned to an account the site was
 *   given, which switching Din's account doesn't change; never asks. Rejects
 *   with NotFoundError if the site doesn't hold it.
 *
 * Calls reject with a DOMException: NotFoundError when the site doesn't hold
 * the account (any more), NotAllowedError when the answer was no; or with a
 * TypeError for a malformed call.
 *
 * @param {{
 *   call: (method: string, params: Record<string, unknown> | undefined, userActivated: boolean) => Promise<{ ok: boolean, result?: unknown, error?: string, errorName?: string }>,
 * }} bridge
 */
function installNostr(bridge) {
  // One call at a time, in order: a page that fires off ten signatures gets
  // ten questions in a row, not ten at once.
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();

  /** @param {string | undefined} name @param {string} message */
  const failure = (name, message) =>
    name === 'TypeError' ? new TypeError(message) : name ? new DOMException(message, name) : new Error(message);

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  const call = (method, params) => {
    // Read now, before waiting in line: whether the page was just clicked is
    // only true for a moment. Din uses it to keep pages from asking to connect
    // on their own, not as a security boundary.
    const activated = Boolean(globalThis.navigator.userActivation && globalThis.navigator.userActivation.isActive);
    // Main answers with an envelope rather than throwing, so the page sees
    // "User rejected", not Electron's "Error invoking remote method ...".
    const run = () =>
      bridge.call(method, params, activated).then((reply) => {
        if (reply.ok) return reply.result;
        throw failure(reply.errorName, reply.error || 'Request failed');
      });
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };

  /** @param {unknown} value */
  const text = (value) => String(value);

  /**
   * NIP-07's methods, as `account` (a hex key the site holds), or as Din's
   * account when there's none.
   * @param {string} [account]
   */
  const signerMethods = (account) => {
    /** @param {Record<string, unknown>} params */
    const as = (params) => (account ? { ...params, account } : params);
    return {
      signEvent: /** @param {unknown} event */ (event) => call('signEvent', as({ event })),
      getRelays: () => call('getRelays', as({})),
      nip04: Object.freeze({
        /** @param {string} pubkey @param {string} plaintext */
        encrypt: (pubkey, plaintext) => call('nip04.encrypt', as({ pubkey: text(pubkey), plaintext: text(plaintext) })),
        /** @param {string} pubkey @param {string} ciphertext */
        decrypt: (pubkey, ciphertext) => call('nip04.decrypt', as({ pubkey: text(pubkey), ciphertext: text(ciphertext) })),
      }),
      nip44: Object.freeze({
        /** @param {string} pubkey @param {string} plaintext */
        encrypt: (pubkey, plaintext) => call('nip44.encrypt', as({ pubkey: text(pubkey), plaintext: text(plaintext) })),
        /** @param {string} pubkey @param {string} ciphertext */
        decrypt: (pubkey, ciphertext) => call('nip44.decrypt', as({ pubkey: text(pubkey), ciphertext: text(ciphertext) })),
      }),
      // Spending the account's bitcoin, as Ditto's BITCOIN-SIGNING.md has it:
      // a hex PSBT in, the account's Taproot inputs signed (not finalized) out.
      /** @param {string} psbtHex */
      signPsbt: (psbtHex) => call('signPsbt', as({ psbt: text(psbtHex) })),
    };
  };

  const nostr = Object.freeze({
    getPublicKey: () => call('getPublicKey'),
    ...signerMethods(),
    requestPublicKey: () => call('requestPublicKey'),
    /** @param {string} pubkey */
    getSigner: async (pubkey) => {
      const account = await call('getSigner', { account: typeof pubkey === 'string' ? pubkey.toLowerCase() : pubkey });
      if (typeof account !== 'string') throw new Error('Request failed');
      return Object.freeze({ getPublicKey: async () => account, ...signerMethods(account) });
    },
  });

  // A worker's preload can't see its scope, so it checks here: only secure
  // sites' workers get one (main checks every call's scope anyway).
  const where = globalThis.location;
  const secure = /^(https|nsite):$/.test(where.protocol) || (where.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(where.hostname));
  if (!secure) return;
  Object.defineProperty(globalThis, 'nostr', { value: nostr, writable: false, configurable: false, enumerable: true });
}

const isWorker = typeof window === 'undefined';

/**
 * @param {string} method
 * @param {Record<string, unknown> | undefined} params
 * @param {boolean} userActivated
 */
const invoke = (method, params, userActivated) =>
  ipcRenderer.invoke('nostr-bridge:call', { method, params, userActivated });

if (isWorker) {
  // A worker that starts before main has seen it gets "no handler": once
  // more after a beat.
  contextBridge.executeInMainWorld({
    func: installNostr,
    args: [
      {
        /**
         * @param {string} method
         * @param {Record<string, unknown> | undefined} params
         */
        call: (method, params) =>
          invoke(method, params, false).catch(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return invoke(method, params, false).catch(() => ({ ok: false, error: 'Din is unavailable' }));
          }),
      },
    ],
  });
} else {
  // Top documents of secure web pages only. The browser session loads frame
  // preloads into iframes too (for extensions), and an embedded frame gets no
  // signer: main refuses its calls anyway.
  const isLocalhost = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (window.top === window.self && (/^(https|nsite):$/.test(location.protocol) || isLocalhost)) {
    contextBridge.executeInMainWorld({ func: installNostr, args: [{ call: invoke }] });
  }
}
