/**
 * Typed access to the OS audio bridge exposed by the Electron preload
 * (`window.audio`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by wpctl (WirePlumber/PipeWire) in the main process, controlling the
 * default sink. Where wpctl is absent (no PipeWire) or in a plain browser the
 * bridge is missing or `status()` resolves with `available: false`; callers
 * must feature-detect and render nothing / a fallback.
 */

export interface AudioStatus {
  /** False when wpctl/PipeWire is not present. */
  available: boolean;
  /** Default sink volume 0-100, or null if it couldn't be read. */
  volume: number | null;
  muted: boolean;
}

export interface AudioBridge {
  /** Default sink volume/mute. `available: false` when wpctl is absent. */
  status(): Promise<AudioStatus>;
  /** Set the default sink volume (0-100). Resolves to the new state. */
  setVolume(percent: number): Promise<AudioStatus>;
  /** Mute or unmute the default sink. Resolves to the new state. */
  setMuted(muted: boolean): Promise<AudioStatus>;
  /**
   * Subscribe to media-key volume changes (for the OSD). The callback receives
   * the new state. Returns an unsubscribe fn.
   */
  onOsd(callback: (status: AudioStatus) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    audio?: AudioBridge;
  }
}

/** The audio bridge, or undefined when running outside the Electron shell. */
export function getAudioBridge(): AudioBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.audio;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanAudioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
