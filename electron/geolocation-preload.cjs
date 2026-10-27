// @ts-check
// Session preload for web pages - browser tabs (private ones too) and
// installed web apps - answering navigator.geolocation from GeoClue (see
// electron/geolocation.mts).
//
// Chromium's own geolocation can't find anything on Linux without a Google
// API key, so its permission requests are refused and this swaps in
// getCurrentPosition, watchPosition and clearWatch that ask the main process
// instead. The user is asked in the same shell prompt Chromium's request
// would have shown, and the answer is checked again for every position.
//
// Registered with session.registerPreloadScript in main.mts, so it runs
// alongside each guest's own preload. Top documents of web pages only:
// frames keep Chromium's, which is refused.
//
// Stays plain CommonJS (.cjs): sandboxed preloads run through Electron's own
// loader, which does not support ESM or TypeScript - typed via JSDoc instead.

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {{
 *   latitude: number, longitude: number, accuracy: number,
 *   altitude: number | null, speed: number | null, heading: number | null,
 *   timestamp: number,
 * }} GeoFix
 * @typedef {{ fix: GeoFix } | { error: 1 | 2, message: string }} GeoResult
 */

/**
 * Runs in the page's world: everything it needs comes in through `bridge`.
 * @param {{
 *   request: () => Promise<boolean>,
 *   locate: () => Promise<GeoResult>,
 * }} bridge
 */
function installGeolocation(bridge) {
  const proto = window.Geolocation?.prototype;
  // Insecure pages keep Chromium's, which refuses them.
  if (!proto || !window.isSecureContext) return;

  /** How often a watch looks again for a new position. */
  const WATCH_INTERVAL_MS = 15_000;

  /**
   * A GeolocationPosition: the real interfaces can't be constructed, so these
   * are plain objects on their prototypes, with their own values shadowing
   * the native getters.
   * @param {GeoFix} fix
   */
  const position = (fix) => {
    const coords = Object.create(GeolocationCoordinates.prototype);
    const values = {
      latitude: fix.latitude,
      longitude: fix.longitude,
      altitude: fix.altitude,
      accuracy: fix.accuracy,
      altitudeAccuracy: null,
      heading: fix.heading,
      speed: fix.speed,
    };
    for (const [name, value] of Object.entries(values)) {
      Object.defineProperty(coords, name, { value, enumerable: true });
    }
    Object.defineProperty(coords, 'toJSON', { value: () => ({ ...values }) });
    const result = Object.create(GeolocationPosition.prototype);
    Object.defineProperty(result, 'coords', { value: coords, enumerable: true });
    Object.defineProperty(result, 'timestamp', { value: fix.timestamp, enumerable: true });
    Object.defineProperty(result, 'toJSON', { value: () => ({ coords: { ...values }, timestamp: fix.timestamp }) });
    return result;
  };

  /**
   * @param {1 | 2 | 3} code
   * @param {string} message
   */
  const positionError = (code, message) => {
    const error = Object.create(GeolocationPositionError.prototype);
    Object.defineProperty(error, 'code', { value: code, enumerable: true });
    Object.defineProperty(error, 'message', { value: message, enumerable: true });
    return error;
  };

  /**
   * @param {string} method
   * @param {unknown} success
   * @param {unknown} failure
   */
  const checkCallbacks = (method, success, failure) => {
    if (typeof success !== 'function') {
      throw new TypeError(`Failed to execute '${method}' on 'Geolocation': parameter 1 is not of type 'Function'.`);
    }
    if (failure !== undefined && failure !== null && typeof failure !== 'function') {
      throw new TypeError(`Failed to execute '${method}' on 'Geolocation': parameter 2 is not of type 'Function'.`);
    }
  };

  /** @param {PositionOptions | undefined} options */
  const timeoutOf = (options) => {
    const timeout = Number(options?.timeout ?? Infinity);
    return Number.isNaN(timeout) ? Infinity : Math.max(0, timeout);
  };

  /** @param {() => void} fn */
  const later = (fn) => setTimeout(fn, 0);

  /**
   * One position, as getCurrentPosition gives it; null when cancelled.
   * @param {PositionOptions | undefined} options
   * @param {() => boolean} cancelled
   * @returns {Promise<{ position: GeolocationPosition, fix: GeoFix } | { error: GeolocationPositionError } | null>}
   */
  const lookup = async (options, cancelled) => {
    const allowed = await bridge.request().catch(() => false);
    if (cancelled()) return null;
    if (!allowed) return { error: positionError(1, 'User denied Geolocation') };
    const timeout = timeoutOf(options);
    /** @type {Promise<GeoResult | 'timeout'>[]} */
    const racers = [bridge.locate().catch(() => ({ error: /** @type {2} */ (2), message: 'Location is unavailable' }))];
    if (Number.isFinite(timeout)) racers.push(new Promise((resolve) => setTimeout(() => resolve('timeout'), timeout)));
    const result = await Promise.race(racers);
    if (cancelled()) return null;
    if (result === 'timeout') return { error: positionError(3, 'Timeout expired') };
    if ('error' in result) return { error: positionError(result.error, result.message) };
    return { position: position(result.fix), fix: result.fix };
  };

  /** @type {Map<number, () => void>} */
  const watches = new Map();
  let lastWatchId = 0;

  Object.defineProperties(proto, {
    getCurrentPosition: {
      configurable: true,
      writable: true,
      /**
       * @param {PositionCallback} success
       * @param {PositionErrorCallback | null} [failure]
       * @param {PositionOptions} [options]
       */
      value: function getCurrentPosition(success, failure, options) {
        checkCallbacks('getCurrentPosition', success, failure);
        void lookup(options, () => false).then((outcome) => {
          if (!outcome) return;
          if ('position' in outcome) later(() => success(outcome.position));
          else if (failure) later(() => failure(outcome.error));
        });
      },
    },
    watchPosition: {
      configurable: true,
      writable: true,
      /**
       * @param {PositionCallback} success
       * @param {PositionErrorCallback | null} [failure]
       * @param {PositionOptions} [options]
       */
      value: function watchPosition(success, failure, options) {
        checkCallbacks('watchPosition', success, failure);
        const id = ++lastWatchId;
        let stopped = false;
        /** @type {ReturnType<typeof setTimeout> | null} */
        let timer = null;
        /** @type {GeoFix | null} */
        let last = null;
        watches.set(id, () => {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
        });
        const look = async () => {
          timer = null;
          const outcome = await lookup(options, () => stopped);
          if (!outcome) return;
          if ('position' in outcome) {
            const { fix } = outcome;
            const moved =
              !last || last.latitude !== fix.latitude || last.longitude !== fix.longitude || last.accuracy !== fix.accuracy;
            last = fix;
            if (moved) success(outcome.position);
          } else {
            failure?.(outcome.error);
            // A refusal ends the watch; anything else may come right later.
            if (outcome.error.code === 1) {
              watches.delete(id);
              return;
            }
          }
          if (!stopped) timer = setTimeout(look, WATCH_INTERVAL_MS);
        };
        later(() => void look());
        return id;
      },
    },
    clearWatch: {
      configurable: true,
      writable: true,
      /** @param {number} id */
      value: function clearWatch(id) {
        watches.get(Number(id))?.();
        watches.delete(Number(id));
      },
    },
  });
}

if (window.top === window.self && /^(https?|nsite):$/.test(location.protocol)) {
  contextBridge.executeInMainWorld({
    func: installGeolocation,
    args: [
      {
        request: () => ipcRenderer.invoke('geolocation:request'),
        locate: () => ipcRenderer.invoke('geolocation:locate'),
      },
    ],
  });
}
