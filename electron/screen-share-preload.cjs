// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - telling Din when the page is sharing the screen (see
// electron/screen-share.mts).
//
// Electron says nothing about a getDisplayMedia() stream once it's granted,
// so this wraps getDisplayMedia in the page's world: a stream that starts is
// reported, and so is the moment its last video track ends, whether the page
// stopped it or the shared window closed. Din's "Stop sharing" comes back
// here and ends the tracks, firing `ended` on them as Chrome's own Stop does,
// so the page's call UI notices. A cancelled picker reaches the page as the
// NotAllowedError Chrome gives, not Chromium's complaint about constraints.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {(event: 'started' | 'ended', id: number) => void} report
 * @param {(callback: (id: number) => void) => void} onStop
 */
function installScreenShareTracking(report, onStop) {
  if (typeof MediaDevices === 'undefined' || typeof MediaDevices.prototype.getDisplayMedia !== 'function') return;
  const originalGetDisplayMedia = MediaDevices.prototype.getDisplayMedia;
  const stop = MediaStreamTrack.prototype.stop;
  const clone = MediaStreamTrack.prototype.clone;
  /** @type {Map<number, Set<MediaStreamTrack>>} */
  const shares = new Map();
  /** @type {WeakMap<MediaStreamTrack, number>} */
  const owners = new WeakMap();
  let nextId = 1;

  /** @param {number} id */
  const check = (id) => {
    const tracks = shares.get(id);
    if (!tracks) return;
    for (const track of tracks) if (track.readyState !== 'ended') return;
    shares.delete(id);
    report('ended', id);
  };

  /**
   * @param {MediaStreamTrack} track
   * @param {number} id
   */
  const own = (track, id) => {
    owners.set(track, id);
    shares.get(id)?.add(track);
    track.addEventListener('ended', () => check(id));
  };

  Object.defineProperty(MediaStreamTrack.prototype, 'stop', {
    configurable: true,
    writable: true,
    value: function () {
      stop.call(this);
      const id = owners.get(this);
      if (id !== undefined) check(id);
    },
  });

  Object.defineProperty(MediaStreamTrack.prototype, 'clone', {
    configurable: true,
    writable: true,
    value: function () {
      const copy = clone.call(this);
      const id = owners.get(this);
      if (id !== undefined) own(copy, id);
      return copy;
    },
  });

  Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', {
    configurable: true,
    writable: true,
    /** @param {DisplayMediaStreamOptions} [constraints] */
    value: function getDisplayMedia(constraints) {
      return originalGetDisplayMedia.call(this, constraints).then((stream) => {
        const tracks = stream.getTracks();
        if (tracks.length === 0) return stream;
        const id = nextId++;
        shares.set(id, new Set());
        for (const track of tracks) own(track, id);
        report('started', id);
        return stream;
      }, (error) => {
        // Din refusing (the picker cancelled) reaches Chromium as no stream
        // at all, which it reports as bad constraints. Pages tell a user's
        // Cancel by NotAllowedError, as Chrome gives it.
        if (error instanceof DOMException && error.name === 'AbortError' && error.message === 'Invalid capture constraints') {
          throw new DOMException('Permission denied', 'NotAllowedError');
        }
        throw error;
      });
    },
  });

  onStop((id) => {
    const tracks = shares.get(id);
    if (!tracks) return;
    shares.delete(id);
    for (const track of tracks) {
      if (track.readyState === 'ended') continue;
      stop.call(track);
      track.dispatchEvent(new Event('ended'));
    }
  });
}

if (/^(https?|nsite|file):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installScreenShareTracking,
    args: [
      /**
       * @param {'started' | 'ended'} event
       * @param {number} id
       */
      (event, id) => ipcRenderer.send(event === 'started' ? 'screen-share:started' : 'screen-share:ended', id),
      /** @param {(id: number) => void} callback */
      (callback) => {
        ipcRenderer.on('screen-share:stop', (_event, id) => callback(id));
      },
    ],
  });
}
