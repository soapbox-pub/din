// @ts-check
// Session preload giving web pages a NIP-07 window.nostr: browser tabs (not
// private ones) and installed web apps. Registered with
// session.registerPreloadScript in main.mts, so it runs alongside each guest's
// own preload.
//
// The provider holds no keys and decides nothing. Every call goes over IPC to
// the main process, which checks that it came from a tab's or app's top
// document and reads the origin from the frame itself (never from the page),
// then relays it to the Din shell. There NostrBridgeHost asks the user, keeps
// what they decided per account and per site, and signs with the account's
// signer. The page only ever sees results.
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
 * @param {{
 *   call: (method: string, params: Record<string, unknown> | undefined, userActivated: boolean) => Promise<{ ok: boolean, result?: unknown, error?: string }>,
 *   onAccountChanged: (callback: () => void) => void,
 * }} bridge
 */
function installNostr(bridge) {
  // One call at a time, in order: a page that fires off ten signatures gets
  // ten questions in a row, not ten at once.
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();

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
        throw new Error(reply.error || 'Request failed');
      });
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };

  /** @param {unknown} value */
  const text = (value) => String(value);

  const nostr = Object.freeze({
    getPublicKey: () => call('getPublicKey'),
    /** @param {unknown} event */
    signEvent: (event) => call('signEvent', { event }),
    getRelays: () => call('getRelays'),
    nip04: Object.freeze({
      /** @param {string} pubkey @param {string} plaintext */
      encrypt: (pubkey, plaintext) => call('nip04.encrypt', { pubkey: text(pubkey), plaintext: text(plaintext) }),
      /** @param {string} pubkey @param {string} ciphertext */
      decrypt: (pubkey, ciphertext) => call('nip04.decrypt', { pubkey: text(pubkey), ciphertext: text(ciphertext) }),
    }),
    nip44: Object.freeze({
      /** @param {string} pubkey @param {string} plaintext */
      encrypt: (pubkey, plaintext) => call('nip44.encrypt', { pubkey: text(pubkey), plaintext: text(plaintext) }),
      /** @param {string} pubkey @param {string} ciphertext */
      decrypt: (pubkey, ciphertext) => call('nip44.decrypt', { pubkey: text(pubkey), ciphertext: text(ciphertext) }),
    }),
  });

  Object.defineProperty(window, 'nostr', { value: nostr, writable: false, configurable: false, enumerable: true });

  // The convention nostr-login and the Ditto extension use: the page should
  // ask for the public key again.
  bridge.onAccountChanged(() => {
    window.dispatchEvent(new CustomEvent('nlAuth', { detail: { type: 'accountChanged' } }));
  });
}

const isLocalhost = location.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// Top documents of secure web pages only. The browser session loads frame
// preloads into iframes too (for extensions), and an embedded frame gets no
// signer: main refuses its calls anyway.
if (window.top === window.self && (/^(https|nsite):$/.test(location.protocol) || isLocalhost)) {
  /** @type {(() => void) | null} */
  let accountListener = null;
  ipcRenderer.on('nostr-bridge:account-changed', () => accountListener?.());

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
        /** @param {() => void} callback */
        onAccountChanged: (callback) => {
          accountListener = callback;
        },
      },
    ],
  });
}
