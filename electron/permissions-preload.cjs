// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - making navigator.permissions.query tell the truth
// about the capabilities Din asks the user for.
//
// Electron's permission check is a yes or no, so a camera, microphone,
// location or notifications permission the user hasn't answered yet reads as
// "denied". Pages that look before they ask (Google Meet does) then tell the
// user they've blocked it and never ask, so the prompt never shows. This
// reports each of those as Din has it: "granted", "denied", or "prompt" when
// unanswered. The state is read again each time, so it follows the user's
// answer; Chromium's own `change` events still fire on the native status.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {(name: string) => PermissionState | null} state
 */
function installPermissionsQuery(state) {
  const proto = window.Permissions?.prototype;
  if (!proto || typeof proto.query !== 'function') return;
  const nativeQuery = proto.query;
  const names = new Set(['camera', 'microphone', 'geolocation', 'notifications']);

  /**
   * @this {Permissions}
   * @param {PermissionDescriptor} descriptor
   */
  async function query(descriptor) {
    const status = await nativeQuery.call(this, descriptor);
    const name = descriptor?.name;
    if (typeof name === 'string' && names.has(name)) {
      Object.defineProperty(status, 'state', {
        configurable: true,
        enumerable: true,
        get: () => state(name) ?? 'denied',
      });
    }
    return status;
  }
  Object.defineProperty(query, 'length', { value: 1 });
  Object.defineProperty(proto, 'query', { value: query, writable: true, configurable: true, enumerable: true });
}

if (/^(https?|nsite):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installPermissionsQuery,
    args: [(/** @type {string} */ name) => ipcRenderer.sendSync('site-permissions:state', name)],
  });
}
