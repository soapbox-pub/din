// Preload for installed web-app <webview>s (the WebAppFrame surface).
//
// Unlike the shell preload (preload.cjs), this one IS attached to a guest -
// but only to installed web apps, never to the ad-hoc Web Browser's tabs.
// main.cjs decides that in its will-attach-webview handler, keyed on the
// app-webview session partition (see APP_WEBVIEW_PARTITION), so remote sites
// the user merely browses to never receive any of this.
//
// It injects a NIP-07 provider (window.nostr) so a Nostr web app running
// inside Din inherits the identity the user is already signed in with. The
// provider holds no keys: every call is proxied over IPC to the main process,
// which relays it to the Din shell renderer, where the active account's signer
// actually runs (see the nostr-bridge:* handlers in main.cjs and
// NostrBridgeHost in the renderer). Installing an app is the trust boundary -
// calls are auto-approved, so there is no per-request prompt.

const { contextBridge, ipcRenderer } = require('electron');

/** Proxy a single NIP-07 call to the shell's active signer, awaiting a reply. */
function call(method, params) {
  return ipcRenderer.invoke('nostr-bridge:call', { method, params });
}

contextBridge.exposeInMainWorld('nostr', {
  /** The signed-in account's public key (hex). */
  getPublicKey: () => call('getPublicKey'),

  /** Sign an event template with the active account; resolves to the full event. */
  signEvent: (event) => call('signEvent', { event }),

  /** The user's configured relays as { [url]: { read, write } } (NIP-07). */
  getRelays: () => call('getRelays'),

  /** Legacy NIP-04 encryption (rejects if the signer lacks it). */
  nip04: {
    encrypt: (pubkey, plaintext) => call('nip04.encrypt', { pubkey, plaintext }),
    decrypt: (pubkey, ciphertext) => call('nip04.decrypt', { pubkey, ciphertext }),
  },

  /** NIP-44 encryption (rejects if the signer lacks it). */
  nip44: {
    encrypt: (pubkey, plaintext) => call('nip44.encrypt', { pubkey, plaintext }),
    decrypt: (pubkey, ciphertext) => call('nip44.decrypt', { pubkey, ciphertext }),
  },
});
