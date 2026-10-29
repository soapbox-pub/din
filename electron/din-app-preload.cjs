// @ts-check
// Preload for built-in apps (din://<id>/, the persist:din-apps session; see
// electron/din-apps.mts and docs/security-model.md).
//
// It does one thing: connect the page to the desktop, and for apps granted
// fs or pty, to main. It keeps the ports itself and gives the page functions
// over them (window.__dinTransport), so page script never holds a port it
// could hand elsewhere. src/sdk/ turns this into window.din.
//
// Plain CommonJS: sandboxed preloads can't be ESM or TypeScript.

const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && location.protocol === 'din:') {
  /** @type {MessagePort | null} */
  let desktop = null;
  /** @type {unknown[]} */
  const outbox = [];
  /** @type {unknown[]} */
  const inbox = [];
  /** @type {Set<(message: unknown) => void>} */
  const listeners = new Set();

  ipcRenderer.on('din-app:port', (event) => {
    desktop = event.ports[0];
    desktop.onmessage = (e) => {
      if (listeners.size === 0) inbox.push(e.data);
      for (const listener of listeners) listener(e.data);
    };
    for (const message of outbox.splice(0)) desktop.postMessage(message);
  });

  /**
   * Bridge ports by permission, with their pending calls and listeners.
   * @type {Map<string, { port: MessagePort | null, waiting: Array<() => void>, next: number, calls: Map<number, { resolve: (v: unknown) => void }>, listeners: Map<string, Set<(...args: unknown[]) => void>> }>}
   */
  const bridges = new Map();
  /** @param {string} permission */
  const bridge = (permission) => {
    let b = bridges.get(permission);
    if (!b) {
      b = { port: null, waiting: [], next: 1, calls: new Map(), listeners: new Map() };
      bridges.set(permission, b);
    }
    return b;
  };

  ipcRenderer.on('din-app:system', (event, info) => {
    const permission = info && typeof info.permission === 'string' ? info.permission : null;
    if (!permission) return;
    const b = bridge(permission);
    const port = event.ports[0];
    b.port = port;
    port.onmessage = (e) => {
      const data = e.data || {};
      if (typeof data.push === 'string') {
        for (const listener of b.listeners.get(data.push) || []) listener(...(data.args || []));
        return;
      }
      const call = b.calls.get(data.id);
      if (!call) return;
      b.calls.delete(data.id);
      // Errors travel as data: a rejection crossing contextBridge loses its
      // name, which the SDK rethrows with.
      call.resolve(data.error ? { error: { name: String(data.error.name), message: String(data.error.message) } } : { result: data.result });
    };
    for (const resume of b.waiting.splice(0)) resume();
  });

  /** @param {string} permission */
  const ready = (permission) => {
    const b = bridge(permission);
    return b.port ? Promise.resolve() : new Promise((resolve) => b.waiting.push(() => resolve(undefined)));
  };

  ipcRenderer.send('din-app:connect');

  contextBridge.exposeInMainWorld('__dinTransport', {
    /** Send the desktop a message (structured-cloneable). */
    post(/** @type {unknown} */ message) {
      if (desktop) desktop.postMessage(message);
      else outbox.push(message);
    },
    /** Hear the desktop. Messages that came before the first listener are delivered to it. */
    onMessage(/** @type {(message: unknown) => void} */ listener) {
      listeners.add(listener);
      for (const message of inbox.splice(0)) listener(message);
      return () => listeners.delete(listener);
    },
    system: {
      /** Resolves once the desktop has granted the permission and its port has arrived. */
      ready,
      /** Call a bridge method (an invoke channel), resolving with `{ result }` or `{ error }`. */
      call(/** @type {string} */ permission, /** @type {string} */ channel, /** @type {unknown[]} */ args) {
        return ready(permission).then(
          () =>
            new Promise((resolve) => {
              const b = bridge(permission);
              const id = b.next++;
              b.calls.set(id, { resolve });
              b.port?.postMessage({ id, channel, args });
            }),
        );
      },
      /** Fire a bridge message (a send channel), with no answer. */
      send(/** @type {string} */ permission, /** @type {string} */ channel, /** @type {unknown[]} */ args) {
        void ready(permission).then(() => bridge(permission).port?.postMessage({ channel, args }));
      },
      /** Hear a bridge's pushes on a channel. */
      on(/** @type {string} */ permission, /** @type {string} */ channel, /** @type {(...args: unknown[]) => void} */ listener) {
        const b = bridge(permission);
        let set = b.listeners.get(channel);
        if (!set) b.listeners.set(channel, (set = new Set()));
        set.add(listener);
        return () => set.delete(listener);
      },
    },
  });
}
