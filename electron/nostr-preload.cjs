// @ts-check
// Session preload giving web pages a NIP-07 window.nostr: browser tabs (not
// private ones) and installed web apps. Registered with
// session.registerPreloadScript in main.mts, so it runs alongside each guest's
// own preload.
//
// The provider holds no keys and decides nothing. Every call goes over IPC to
// the main process, which checks that it came from a tab's or app's top
// document and reads the origin from the frame itself (never from the page),
// then relays it to the Din shell. There NostrBridgeHost decides which of the
// site's accounts acts, asks the user, keeps what they decided per account
// and per site, and signs with the account's signer. The page only ever sees
// results.
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
 * window.nostr is NIP-07's signer, acting as the account the site was given
 * first, which never changes underneath it, plus Din's two additions for
 * sites that hold more than one:
 *
 * - requestPublicKey(): asks the user to give the site one more account
 *   (always a question, and only after a click), resolving with its key.
 * - getSigner(pubkey): a NIP-07 signer pinned to one of the site's accounts;
 *   never asks. Rejects with NotFoundError if the site doesn't hold it.
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
    const activated = Boolean(navigator.userActivation && navigator.userActivation.isActive);
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
   * NIP-07's methods, as `account` (a hex key the site holds), or as the
   * site's own account when there's none.
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

  Object.defineProperty(window, 'nostr', { value: nostr, writable: false, configurable: false, enumerable: true });
}

const isLocalhost = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// Top documents of secure web pages only. The browser session loads frame
// preloads into iframes too (for extensions), and an embedded frame gets no
// signer: main refuses its calls anyway.
if (window.top === window.self && (/^(https|nsite):$/.test(location.protocol) || isLocalhost)) {
  contextBridge.executeInMainWorld({
    func: installNostr,
    args: [
      {
        /**
         * @param {string} method
         * @param {Record<string, unknown> | undefined} params
         * @param {boolean} userActivated
         */
        call: (method, params, userActivated) =>
          ipcRenderer.invoke('nostr-bridge:call', { method, params, userActivated }),
      },
    ],
  });
}
