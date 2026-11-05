import { useCallback, useState } from 'react';
import { effectById } from '@/shared/cameraEffects';

export type CameraMode = 'photo' | 'four-up' | 'video';

export interface CameraSettings {
  effect: string;
  mode: CameraMode;
  /** Show and save the picture as a mirror shows you. */
  mirror: boolean;
  /** Count 3, 2, 1 before taking. */
  countdown: boolean;
  /** Light the screen white as the photo's taken. */
  flash: boolean;
  /** The shutter's sound and the countdown's beeps. */
  sound: boolean;
  /** The camera and microphone chosen, by device id; null for the first. */
  cameraId: string | null;
  micId: string | null;
}

const KEY = 'camera:settings';

const DEFAULTS: CameraSettings = {
  effect: 'normal',
  mode: 'photo',
  mirror: true,
  countdown: true,
  flash: true,
  sound: true,
  cameraId: null,
  micId: null,
};

function load(): CameraSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<CameraSettings>;
    const s = { ...DEFAULTS, ...saved };
    return {
      effect: effectById(s.effect).id,
      mode: s.mode === 'four-up' || s.mode === 'video' ? s.mode : 'photo',
      mirror: s.mirror !== false,
      countdown: s.countdown !== false,
      flash: s.flash !== false,
      sound: s.sound !== false,
      cameraId: typeof s.cameraId === 'string' ? s.cameraId : null,
      micId: typeof s.micId === 'string' ? s.micId : null,
    };
  } catch {
    return DEFAULTS;
  }
}

export function useCameraSettings(): [CameraSettings, (change: Partial<CameraSettings>) => void] {
  const [settings, setSettings] = useState(load);
  const update = useCallback((change: Partial<CameraSettings>) => {
    setSettings((s) => {
      const next = { ...s, ...change };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Full or unavailable: it lasts the session.
      }
      return next;
    });
  }, []);
  return [settings, update];
}
