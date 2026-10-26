// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - telling Din what the page is playing, so the volume
// menu can show it and pause it (see electron/media.mts).
//
// Chromium knows when a page is audible but not what it's playing, and has
// no way for Din to pause it. This watches the page's audio and video
// elements and its Media Session (the title, artist and artwork a page like
// YouTube publishes, and its play/pause/next/previous handlers), and reports
// a summary whenever it changes. Commands come back here: the page's own
// handlers when it set them, the elements themselves otherwise. Pause also
// suspends the page's Web Audio, so a page playing only through that stops
// too.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload, in every frame of web pages.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Runs in the page's world.
 * @param {(state: unknown) => void} report
 * @param {(callback: (action: string) => void) => void} onCommand
 */
function installMediaTracking(report, onCommand) {
  /** Elements that have played, and may again. */
  /** @type {Set<HTMLMediaElement>} */
  const elements = new Set();
  /** Elements Din paused, which Play resumes. */
  /** @type {WeakSet<HTMLMediaElement>} */
  const pausedByDin = new WeakSet();
  /** @type {Set<BaseAudioContext>} */
  const contexts = new Set();
  /** @type {Set<BaseAudioContext>} */
  const suspendedByDin = new Set();
  /** @type {Map<string, MediaSessionActionHandler>} */
  const handlers = new Map();
  let last = '';
  let pending = false;

  /** Something the user would call playing: heard, not a muted backdrop. */
  /** @param {HTMLMediaElement} el */
  const audible = (el) => !el.muted && el.volume > 0;

  const summarize = () => {
    let playing = false;
    let resumable = false;
    for (const el of elements) {
      if ((el.paused && !el.isConnected) || el.ended || !el.currentSrc) {
        elements.delete(el);
        continue;
      }
      if (!audible(el)) continue;
      if (el.paused) resumable = true;
      else playing = true;
    }
    const session = navigator.mediaSession;
    const metadata = session?.metadata;
    const artwork = metadata?.artwork?.length ? metadata.artwork[metadata.artwork.length - 1].src : null;
    return {
      playing,
      resumable,
      sessionState: session?.playbackState ?? 'none',
      title: metadata?.title ?? '',
      artist: metadata?.artist ?? '',
      album: metadata?.album ?? '',
      artwork: artwork ? new URL(artwork, location.href).href : null,
      actions: [...handlers.keys()],
    };
  };

  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const state = summarize();
      const json = JSON.stringify(state);
      if (json === last) return;
      last = json;
      report(state);
    }, 50);
  };

  /** @param {Event} event */
  const onMediaEvent = (event) => {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement)) return;
    if (event.type === 'play' || event.type === 'playing') elements.add(el);
    if (event.type === 'play') pausedByDin.delete(el);
    if (elements.has(el)) schedule();
  };
  for (const type of ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange']) {
    window.addEventListener(type, onMediaEvent, true);
  }

  // Elements outside the document (new Audio()) or in shadow roots don't
  // send their events past themselves.
  const play = HTMLMediaElement.prototype.play;
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: function () {
      if (!elements.has(this)) {
        elements.add(this);
        for (const type of ['play', 'pause', 'ended', 'emptied', 'volumechange']) {
          this.addEventListener(type, schedule);
        }
      }
      pausedByDin.delete(this);
      schedule();
      return play.call(this);
    },
  });

  /** @param {typeof AudioContext} Context */
  const trackContexts = (Context) =>
    new Proxy(Context, {
      construct(target, args, newTarget) {
        const context = Reflect.construct(target, args, newTarget);
        contexts.add(context);
        context.addEventListener('statechange', () => {
          if (context.state === 'closed') {
            contexts.delete(context);
            suspendedByDin.delete(context);
          } else if (context.state === 'running') {
            suspendedByDin.delete(context);
          }
        });
        return context;
      },
    });
  if (typeof AudioContext === 'function') {
    window.AudioContext = trackContexts(AudioContext);
    /** @type {{ webkitAudioContext?: typeof AudioContext }} */ (/** @type {unknown} */ (window)).webkitAudioContext = window.AudioContext;
  }

  if (typeof MediaSession !== 'undefined') {
    const proto = MediaSession.prototype;
    const setActionHandler = proto.setActionHandler;
    Object.defineProperty(proto, 'setActionHandler', {
      configurable: true,
      writable: true,
      /**
       * @param {MediaSessionAction} action
       * @param {MediaSessionActionHandler | null} handler
       */
      value: function (action, handler) {
        setActionHandler.call(this, action, handler);
        if (handler) handlers.set(action, handler);
        else handlers.delete(action);
        schedule();
      },
    });
    for (const name of ['metadata', 'playbackState']) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor?.set) continue;
      const set = descriptor.set;
      Object.defineProperty(proto, name, {
        ...descriptor,
        /** @param {unknown} value */
        set(value) {
          set.call(this, value);
          schedule();
        },
      });
    }
  }

  /** @param {string} action */
  const callHandler = (action) => {
    const handler = handlers.get(action);
    if (!handler) return false;
    try {
      handler({ action: /** @type {MediaSessionAction} */ (action) });
    } catch {
      // The page's own handler failed; the fallbacks below still apply.
    }
    return true;
  };

  onCommand((action) => {
    if (action === 'pause') {
      callHandler('pause');
      for (const el of elements) {
        if (el.paused) continue;
        el.pause();
        pausedByDin.add(el);
      }
      for (const context of contexts) {
        if (context.state !== 'running' || !(context instanceof AudioContext)) continue;
        suspendedByDin.add(context);
        void context.suspend().catch(() => {});
      }
    } else if (action === 'play') {
      if (!callHandler('play')) {
        let resumed = false;
        for (const el of elements) {
          if (!pausedByDin.has(el)) continue;
          void play.call(el).catch(() => {});
          resumed = true;
        }
        if (!resumed) {
          const el = [...elements].reverse().find((candidate) => candidate.paused && audible(candidate));
          if (el) void play.call(el).catch(() => {});
        }
      }
      for (const context of suspendedByDin) {
        if (context instanceof AudioContext) void context.resume().catch(() => {});
      }
      suspendedByDin.clear();
    } else if (action === 'nexttrack' || action === 'previoustrack') {
      callHandler(action);
    }
    schedule();
  });
}

if (/^(https?|nsite|file):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installMediaTracking,
    args: [
      /** @param {unknown} state */
      (state) => ipcRenderer.send('media:frame', state),
      /** @param {(action: string) => void} callback */
      (callback) => {
        ipcRenderer.on('media:command', (_event, action) => callback(action));
      },
    ],
  });
}
