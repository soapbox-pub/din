// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - that answers navigator.credentials' public-key
// requests with Din's passkeys (see electron/passkeys.mts).
//
// Swaps in a CredentialsContainer create() and get() that send a
// publicKey request to main, which asks the user and makes or signs with a
// passkey from Passwords, and turn what comes back into the
// PublicKeyCredential the page expects. Anything else (passwords, federated
// sign-in, a conditional request) and anything main hands back - a
// security key, a frame from another site - goes to Chromium's own.
//
// Only options cross to main, as base64url: never the page's word for
// where it is, which main takes from the frame.
//
// Registered with session.registerPreloadScript in main.mts, so it runs in
// every frame of web pages, each on its own.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {{ credential: Record<string, any> } | { error: { name: string, message: string } } | { native: true }} PageResult
 */

/**
 * Runs in the page's world: everything it needs comes in through `bridge`.
 * @param {{
 *   create: (token: string, options: unknown) => Promise<PageResult>,
 *   get: (token: string, options: unknown) => Promise<PageResult>,
 *   cancel: (token: string) => void,
 * }} bridge
 */
function installPasskeys(bridge) {
  const Container = window.CredentialsContainer;
  const PKC = window.PublicKeyCredential;
  if (!Container || !PKC || !window.isSecureContext) return;
  const nativeCreate = Container.prototype.create;
  const nativeGet = Container.prototype.get;
  const nativeCapabilities = /** @type {any} */ (PKC).getClientCapabilities;

  /** @param {ArrayBuffer | Uint8Array} buffer */
  const toBase64Url = (buffer) => {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  /** @param {string} text @returns {ArrayBuffer} */
  const fromBase64Url = (text) => {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  };

  /**
   * A BufferSource's bytes, as base64url.
   * @param {unknown} value @param {string} what
   */
  const bufferSource = (value, what) => {
    if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
      return toBase64Url(new Uint8Array(/** @type {ArrayBuffer} */ (value)));
    }
    if (ArrayBuffer.isView(value)) return toBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    throw new TypeError(`Failed to read the '${what}' property: The provided value is not of type '(ArrayBuffer or ArrayBufferView)'.`);
  };

  /** @param {unknown} list @param {string} what */
  const descriptors = (list, what) =>
    list === undefined || list === null
      ? []
      : Array.from(/** @type {Iterable<any>} */ (list), (c) => ({ type: String(c?.type), id: bufferSource(c?.id, what) }));

  /** @param {any} pk */
  const creationOptions = (pk) => {
    if (!pk.rp || !pk.user || pk.challenge === undefined || !pk.pubKeyCredParams) {
      throw new TypeError("Failed to execute 'create' on 'CredentialsContainer': required member is undefined.");
    }
    const selection = pk.authenticatorSelection ?? {};
    return {
      challenge: bufferSource(pk.challenge, 'challenge'),
      rp: { id: pk.rp.id === undefined ? undefined : String(pk.rp.id), name: String(pk.rp.name ?? '') },
      user: {
        id: bufferSource(pk.user.id, 'id'),
        name: String(pk.user.name ?? ''),
        displayName: String(pk.user.displayName ?? ''),
      },
      pubKeyCredParams: Array.from(/** @type {Iterable<any>} */ (pk.pubKeyCredParams), (p) => ({ type: String(p?.type), alg: Number(p?.alg) })),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      excludeCredentials: descriptors(pk.excludeCredentials, 'id'),
      authenticatorSelection: {
        authenticatorAttachment: selection.authenticatorAttachment === undefined ? undefined : String(selection.authenticatorAttachment),
      },
      extensions: { credProps: pk.extensions?.credProps === true },
    };
  };

  /** @param {any} pk */
  const requestOptions = (pk) => {
    if (pk.challenge === undefined) {
      throw new TypeError("Failed to execute 'get' on 'CredentialsContainer': required member challenge is undefined.");
    }
    return {
      challenge: bufferSource(pk.challenge, 'challenge'),
      rpId: pk.rpId === undefined ? undefined : String(pk.rpId),
      timeout: pk.timeout === undefined ? undefined : Number(pk.timeout),
      allowCredentials: descriptors(pk.allowCredentials, 'id'),
    };
  };

  /**
   * Own read-only properties shadowing the real interfaces' getters: they
   * can't be constructed, so these are plain objects on their prototypes.
   * @param {object} target @param {Record<string, unknown>} values @param {Record<string, Function>} [methods]
   */
  const define = (target, values, methods = {}) => {
    for (const [key, value] of Object.entries(values)) Object.defineProperty(target, key, { value, enumerable: true, configurable: true });
    for (const [key, value] of Object.entries(methods)) Object.defineProperty(target, key, { value, configurable: true, writable: true });
    return target;
  };

  /**
   * @param {Record<string, any>} c
   * @param {'create' | 'get'} kind
   */
  const credential = (c, kind) => {
    const r = c.response;
    /** @type {object} */
    let response;
    if (kind === 'create') {
      const clientDataJSON = fromBase64Url(r.clientDataJSON);
      const attestationObject = fromBase64Url(r.attestationObject);
      response = define(Object.create(AuthenticatorAttestationResponse.prototype), { clientDataJSON, attestationObject }, {
        getTransports: () => [...r.transports],
        getAuthenticatorData: () => fromBase64Url(r.authenticatorData),
        getPublicKey: () => fromBase64Url(r.publicKey),
        getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
        toJSON: () => ({
          clientDataJSON: r.clientDataJSON,
          attestationObject: r.attestationObject,
          authenticatorData: r.authenticatorData,
          publicKey: r.publicKey,
          publicKeyAlgorithm: r.publicKeyAlgorithm,
          transports: [...r.transports],
        }),
      });
    } else {
      response = define(Object.create(AuthenticatorAssertionResponse.prototype), {
        clientDataJSON: fromBase64Url(r.clientDataJSON),
        authenticatorData: fromBase64Url(r.authenticatorData),
        signature: fromBase64Url(r.signature),
        userHandle: r.userHandle ? fromBase64Url(r.userHandle) : null,
      }, {
        toJSON: () => ({
          clientDataJSON: r.clientDataJSON,
          authenticatorData: r.authenticatorData,
          signature: r.signature,
          ...(r.userHandle ? { userHandle: r.userHandle } : {}),
        }),
      });
    }
    const extensions = c.clientExtensionResults ?? {};
    return define(Object.create(PKC.prototype), {
      id: c.id,
      rawId: fromBase64Url(c.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response,
    }, {
      getClientExtensionResults: () => structuredClone(extensions),
      toJSON: () => ({
        id: c.id,
        rawId: c.id,
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response: /** @type {any} */ (response).toJSON(),
        clientExtensionResults: structuredClone(extensions),
      }),
    });
  };

  /** @param {AbortSignal | undefined} signal */
  const abortReason = (signal) => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');

  /**
   * @param {'create' | 'get'} kind
   * @param {any} options
   * @param {unknown} serialized
   * @param {() => Promise<Credential | null>} fallback
   */
  const run = async (kind, options, serialized, fallback) => {
    /** @type {AbortSignal | undefined} */
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    const token = crypto.randomUUID();
    /** @type {PageResult} */
    const answer = await new Promise((resolve, reject) => {
      const onAbort = () => {
        bridge.cancel(token);
        reject(abortReason(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      bridge[kind](token, serialized).then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
    });
    if ('native' in answer) return fallback();
    if ('error' in answer) {
      throw answer.error.name === 'TypeError' ? new TypeError(answer.error.message) : new DOMException(answer.error.message, answer.error.name);
    }
    return credential(answer.credential, kind);
  };

  Object.defineProperties(Container.prototype, {
    create: {
      configurable: true,
      writable: true,
      /** @param {CredentialCreationOptions} [options] */
      value: function create(options) {
        const pk = /** @type {any} */ (options)?.publicKey;
        if (!pk) return nativeCreate.call(this, options);
        try {
          return run('create', options, creationOptions(pk), () => nativeCreate.call(this, options));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
    get: {
      configurable: true,
      writable: true,
      /** @param {CredentialRequestOptions} [options] */
      value: function get(options) {
        const pk = /** @type {any} */ (options)?.publicKey;
        // Passkeys in the autofill aren't offered yet (isConditionalMediationAvailable says so).
        if (!pk || options?.mediation === 'conditional') return nativeGet.call(this, options);
        try {
          return run('get', options, requestOptions(pk), () => nativeGet.call(this, options));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    },
  });

  const statics = /** @type {Record<string, PropertyDescriptor>} */ ({
    isUserVerifyingPlatformAuthenticatorAvailable: {
      configurable: true,
      writable: true,
      value: function isUserVerifyingPlatformAuthenticatorAvailable() {
        return Promise.resolve(true);
      },
    },
    isConditionalMediationAvailable: {
      configurable: true,
      writable: true,
      value: function isConditionalMediationAvailable() {
        return Promise.resolve(false);
      },
    },
  });
  if (typeof nativeCapabilities === 'function') {
    statics.getClientCapabilities = {
      configurable: true,
      writable: true,
      value: async function getClientCapabilities() {
        const capabilities = await nativeCapabilities.call(PKC);
        return {
          ...capabilities,
          conditionalCreate: false,
          conditionalGet: false,
          // Chromium says so whenever there's Bluetooth, but Electron can't show the QR code.
          hybridTransport: false,
          passkeyPlatformAuthenticator: true,
          userVerifyingPlatformAuthenticator: true,
        };
      },
    };
  }
  Object.defineProperties(PKC, statics);
}

if (/^https?:$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installPasskeys,
    args: [
      {
        /** @param {string} token @param {unknown} options */
        create: (token, options) => ipcRenderer.invoke('passkeys:create', token, options),
        /** @param {string} token @param {unknown} options */
        get: (token, options) => ipcRenderer.invoke('passkeys:get', token, options),
        /** @param {string} token */
        cancel: (token) => ipcRenderer.send('passkeys:cancel', token),
      },
    ],
  });
}
