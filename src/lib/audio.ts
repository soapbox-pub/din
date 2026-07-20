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

/** A sink (output) or source (input) device. */
export interface AudioDevice {
  /** wpctl node id, used to select/control this device. */
  id: number;
  name: string;
  /** Volume 0-100 (may read above 100 where PipeWire is boosted), or null. */
  volume: number | null;
  muted: boolean;
  /** True for the current default sink/source. */
  isDefault: boolean;
}

export interface AudioDevices {
  /** False when wpctl/PipeWire is not present. */
  available: boolean;
  /** Output devices. */
  sinks: AudioDevice[];
  /** Input devices. */
  sources: AudioDevice[];
}

/** A per-application playback stream. */
export interface AudioStream {
  /** wpctl node id, used to control this stream. */
  id: number;
  name: string;
  volume: number;
  muted: boolean;
}

export interface AudioStreams {
  available: boolean;
  streams: AudioStream[];
}

export interface AudioBridge {
  /** Default sink volume/mute. `available: false` when wpctl is absent. */
  status(): Promise<AudioStatus>;
  /** Set the default sink volume (0-100). Resolves to the new state. */
  setVolume(percent: number): Promise<AudioStatus>;
  /** Mute or unmute the default sink. Resolves to the new state. */
  setMuted(muted: boolean): Promise<AudioStatus>;
  /** Output (sink) and input (source) devices. */
  devices(): Promise<AudioDevices>;
  /** Per-application playback streams. */
  streams(): Promise<AudioStreams>;
  /** Make a device the default sink/source by id. Resolves to the new list. */
  setDefault(id: number): Promise<AudioDevices>;
  /** Set any node's volume (0-100) by id (per-app streams, per-device). */
  setNodeVolume(id: number, percent: number): Promise<void>;
  /** Mute or unmute any node by id. */
  setNodeMuted(id: number, muted: boolean): Promise<void>;
  /** Play a short test tone to a sink by id. */
  test(id: number): Promise<void>;
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
