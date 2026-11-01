import { useEffect, useState } from 'react';
import type { StudioAspect, StudioScene } from '@/lib/capture';
import { DEFAULT_BUBBLES, type Bubble, type CameraShape } from './engine/layout';

/** What Studio remembers between sessions: the last setup, as left. */
export interface StudioSettings {
  scene: StudioScene;
  aspect: StudioAspect;
  shape: CameraShape;
  bubbles: Record<StudioAspect, Bubble>;
  /** A device id, or '' for the system's default. */
  camera: string;
  mic: string;
  cameraOn: boolean;
  micOn: boolean;
  mirror: boolean;
  /** Record the computer's sound with the screen. */
  computerSound: boolean;
  /** Seconds before a take starts; 0 for none. */
  countdown: number;
  /** Minimize Studio once a take with the screen starts, so it isn't in it. */
  hideWhileRecording: boolean;
  /** The destination last streamed to. */
  destination: string;
  /** Record a take while live. */
  recordWhileLive: boolean;
}

const KEY = 'din:studio:settings';

const DEFAULTS: StudioSettings = {
  scene: 'screen-camera',
  aspect: '16:9',
  shape: 'circle',
  bubbles: DEFAULT_BUBBLES,
  camera: '',
  mic: '',
  cameraOn: true,
  micOn: true,
  mirror: false,
  computerSound: false,
  countdown: 3,
  hideWhileRecording: true,
  destination: '',
  recordWhileLive: false,
};

function load(): StudioSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<StudioSettings>;
    return { ...DEFAULTS, ...saved, bubbles: { ...DEFAULTS.bubbles, ...saved.bubbles } };
  } catch {
    return DEFAULTS;
  }
}

export function useStudioSettings(): [StudioSettings, (change: Partial<StudioSettings>) => void] {
  const [settings, setSettings] = useState(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Not kept; the setup is still right for now.
    }
  }, [settings]);
  return [settings, (change) => setSettings((s) => ({ ...s, ...change }))];
}
