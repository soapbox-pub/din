import { useCallback, useEffect, useState } from 'react';
import {
  getNetworkMonitorBridge,
  type NetworkEvents,
  type NetworkRequest,
  type WebSocketFrame,
} from '@/lib/networkMonitor';

/** Requests kept; the oldest go first. */
export const REQUEST_LIMIT = 3000;
/** Frames kept for each WebSocket; the oldest go first. */
export const FRAME_LIMIT = 1000;

interface Recording {
  /** In the order they started. */
  requests: Map<string, NetworkRequest>;
  frames: Map<string, WebSocketFrame[]>;
  /** Frames the main process left out for coming too fast. */
  framesDropped: number;
}

const EMPTY: Recording = { requests: new Map(), frames: new Map(), framesDropped: 0 };

function merge(prev: Recording, events: NetworkEvents): Recording {
  const requests = new Map(prev.requests);
  for (const request of events.requests) requests.set(request.id, request);
  let frames = prev.frames;
  if (events.frames.length > 0) {
    frames = new Map(prev.frames);
    for (const frame of events.frames) {
      const list = frames.get(frame.requestId);
      const next = list && list === prev.frames.get(frame.requestId) ? [...list] : (list ?? []);
      next.push(frame);
      if (next.length > FRAME_LIMIT) next.splice(0, next.length - FRAME_LIMIT);
      frames.set(frame.requestId, next);
    }
  }
  if (requests.size > REQUEST_LIMIT) {
    if (frames === prev.frames) frames = new Map(prev.frames);
    for (const id of [...requests.keys()].slice(0, requests.size - REQUEST_LIMIT)) {
      requests.delete(id);
      frames.delete(id);
    }
  }
  return { requests, frames, framesDropped: prev.framesDropped + events.framesDropped };
}

/**
 * Every page's requests, recorded while `active` (the System Monitor's
 * Network view is showing and not paused). What's recorded stays until
 * `clear`, across pauses. `available` is false outside the Electron shell.
 */
export function useNetworkRecording(active: boolean) {
  const bridge = getNetworkMonitorBridge();
  const [recording, setRecording] = useState<Recording>(EMPTY);

  useEffect(() => {
    if (!bridge || !active) return;
    return bridge.record((events) => setRecording((prev) => merge(prev, events)));
  }, [bridge, active]);

  const clear = useCallback(() => setRecording(EMPTY), []);

  return { available: bridge !== undefined, ...recording, clear };
}
