/**
 * Typed access to the OS audio bridge exposed by the Electron preload
 * (`window.dinos.audio`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by wpctl (WirePlumber/PipeWire) in the main process, controlling the
 * default sink. Where wpctl is absent (no PipeWire) or in a plain browser the
 * bridge is missing or `status()` resolves with `available: false`; callers
 * must feature-detect and render nothing / a fallback.
 */

/**
 * Loudest volume the bridge will set, in percent. Above 100 is PipeWire's
 * software amplification. Keep in step with MAX_VOLUME in electron/main.mts.
 */
export const MAX_VOLUME = 150;

/** Screen-reader text for a volume level. */
export function volumeText(volume: number): string {
  return volume > 100 ? `${volume}%, amplified` : `${volume}%`;
}

export interface AudioStatus {
  /** False when wpctl/PipeWire is not present. */
  available: boolean;
  /** Default sink volume 0-MAX_VOLUME, or null if it couldn't be read. */
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
  /** Its freedesktop icon name, e.g. "audio-headset-bluetooth", when known. */
  icon?: string;
  /**
   * A Bluetooth headset on its call profile because something is using its
   * mic: both ways at call quality, back to full quality when that stops.
   */
  callQuality?: boolean;
}

/**
 * An output or input with no device yet because its sound card is on a
 * profile without it (e.g. the headphone jack while the speaker profile is
 * active). Selecting it switches the card's profile.
 */
export interface AudioPort {
  card: string;
  port: string;
  name: string;
}

export interface AudioDevices {
  /** False when wpctl/PipeWire is not present. */
  available: boolean;
  /** Output devices. */
  sinks: AudioDevice[];
  /** Input devices. */
  sources: AudioDevice[];
  /** Outputs reachable by switching a card's profile. */
  inactiveSinks: AudioPort[];
  /** Inputs reachable by switching a card's profile. */
  inactiveSources: AudioPort[];
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
  /** Set the default sink volume (0-MAX_VOLUME). Resolves to the new state. */
  setVolume(percent: number): Promise<AudioStatus>;
  /** Mute or unmute the default sink. Resolves to the new state. */
  setMuted(muted: boolean): Promise<AudioStatus>;
  /** Default source (microphone) volume/mute. `available: false` without one. */
  inputStatus(): Promise<AudioStatus>;
  /** Set the default source volume (0-MAX_VOLUME). Resolves to the new state. */
  setInputVolume(percent: number): Promise<AudioStatus>;
  /** Mute or unmute the default source. Resolves to the new state. */
  setInputMuted(muted: boolean): Promise<AudioStatus>;
  /** Output (sink) and input (source) devices. */
  devices(): Promise<AudioDevices>;
  /** Per-application playback streams. */
  streams(): Promise<AudioStreams>;
  /** Make a device the default sink/source by id. Resolves to the new list. */
  setDefault(id: number): Promise<AudioDevices>;
  /**
   * Select an output/input on a card's inactive profile, switching the card
   * to it and making it the default. Resolves to the new list.
   */
  selectPort(card: string, port: string): Promise<AudioDevices>;
  /** Set any node's volume (0-MAX_VOLUME) by id (per-app streams, per-device). */
  setNodeVolume(id: number, percent: number): Promise<void>;
  /** Mute or unmute any node by id. */
  setNodeMuted(id: number, muted: boolean): Promise<void>;
  /** Play a short test tone to a sink by id. */
  test(id: number): Promise<void>;
  /**
   * Subscribe to media-key volume changes (for the OSD). The callback receives
   * the new state, and the output's name when sound has just moved to a device
   * plugged in or connected. Returns an unsubscribe fn.
   */
  onOsd(callback: (status: AudioStatus & { device?: string }) => void): () => void;
  /**
   * Subscribe to mic-mute key presses (for the OSD). The callback receives the
   * default source's new state. Returns an unsubscribe fn.
   */
  onInputOsd(callback: (status: AudioStatus) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    audio?: AudioBridge;
  }
}

/** The audio bridge, or undefined when running outside the Electron shell. */
export function getAudioBridge(): AudioBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.audio;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanAudioError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
