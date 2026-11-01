import { useEffect, useState } from 'react';

/** The cameras and microphones there are, kept current as they're plugged in. */
export interface Devices {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
  /** The computer's own sound, where it's offered as an input (PulseAudio's monitors). */
  monitors: MediaDeviceInfo[];
  loaded: boolean;
}

const isMonitor = (d: MediaDeviceInfo) => /^monitor of /i.test(d.label);

export function useDevices(): Devices {
  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [], monitors: [], loaded: false });
  useEffect(() => {
    let live = true;
    const load = () =>
      navigator.mediaDevices.enumerateDevices().then((all) => {
        if (!live) return;
        const real = all.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
        setDevices({
          cameras: real.filter((d) => d.kind === 'videoinput'),
          mics: real.filter((d) => d.kind === 'audioinput' && !isMonitor(d)),
          monitors: real.filter((d) => d.kind === 'audioinput' && isMonitor(d)),
          loaded: true,
        });
      }, () => live && setDevices((d) => ({ ...d, loaded: true })));
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      live = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, []);
  return devices;
}

/** A device's name without the USB ids Linux adds ("HD Pro Webcam C920 (046d:082d)"). */
export function deviceName(device: MediaDeviceInfo | undefined, fallback: string): string {
  return device?.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim() || fallback;
}

export interface StreamState {
  stream: MediaStream | null;
  error: string | null;
}

function stopAll(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** Why a capture couldn't start, in words. */
function captureError(error: unknown, what: string): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return `Studio isn’t allowed to use the ${what}`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${what} was found`;
  if (name === 'NotReadableError') return `The ${what} is in use by something else`;
  return `Couldn’t start the ${what}`;
}

/**
 * A capture that runs while `key` is non-null and restarts when it changes;
 * its tracks are stopped when it's no longer wanted. A track that ends on
 * its own (a camera unplugged) clears it.
 */
export function useCapture(key: string | null, open: () => Promise<MediaStream>, what: string): StreamState {
  const [state, setState] = useState<StreamState & { key: string | null }>({ key: null, stream: null, error: null });
  useEffect(() => {
    if (key === null) return;
    let live = true;
    let stream: MediaStream | null = null;
    open().then(
      (s) => {
        if (!live) {
          stopAll(s);
          return;
        }
        stream = s;
        for (const track of s.getTracks()) {
          track.addEventListener('ended', () => live && setState({ key, stream: null, error: `The ${what} stopped` }), { once: true });
        }
        setState({ key, stream: s, error: null });
      },
      (error: unknown) => live && setState({ key, stream: null, error: captureError(error, what) }),
    );
    return () => {
      live = false;
      stopAll(stream);
    };
    // `open` is rebuilt every render; `key` says when it asks for something else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, what]);
  // What a capture no longer wanted (or not yet started) left behind doesn't count.
  return state.key === key && key !== null ? { stream: state.stream, error: state.error } : { stream: null, error: null };
}
