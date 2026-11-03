/**
 * Typed access to the optional features bridge exposed by the Electron preload
 * (`window.dinos.features`, see electron/preload.cjs + electron/features.mts).
 *
 * DinOS's optional features are parts of the system that aren't on the disk
 * until someone wants them: Wine for Windows apps, QEMU for virtual machines,
 * Whisper for dictation, WebKitGTK for some Linux apps, and Podman for
 * containers. Settings → Optional Features and `din features` install and
 * remove them. Absent in a plain browser; callers feature-detect via
 * `getFeaturesBridge()`.
 */

export type FeatureAction = 'install' | 'remove';
export type FeaturePhase = 'waiting' | 'downloading' | 'building' | 'removing';

export interface FeatureState {
  id: string;
  title: string;
  description: string;
  /** About what installing it takes, in bytes. */
  size: number;
  installed: boolean;
  /** Installed, and this system's version of it (not one from before an update). */
  current: boolean;
  busy: { action: FeatureAction; phase: FeaturePhase; progress: number | null } | null;
  /** Why its last action failed, until the next one. */
  error: string | null;
}

export interface FeaturesState {
  /** False off DinOS, where there's nothing to install this way. */
  available: boolean;
  features: FeatureState[];
}

export interface FeaturesBridge {
  state(): Promise<FeaturesState>;
  install(id: string): Promise<void>;
  installAll(): Promise<void>;
  remove(id: string): Promise<void>;
  onChanged(callback: (state: FeaturesState) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    features?: FeaturesBridge;
  }
}

/** The optional features bridge, or undefined outside the Electron shell. */
export function getFeaturesBridge(): FeaturesBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.features;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanFeaturesError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** A size in bytes the way Settings shows it: "850 MB", "1.2 GB". */
export function formatFeatureSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** What stops working when a feature goes, for the question Remove asks. */
export function removalConsequence(feature: Pick<FeatureState, 'id' | 'title'>): string {
  switch (feature.id) {
    case 'windows':
      return 'Windows programs you’ve installed stay on this computer, but won’t open until you install it again.';
    case 'vms':
      return 'Your virtual machines and their disks stay on this computer, but won’t start until you install it again.';
    case 'dictation':
      return 'Dictation and Studio’s captions stop working until you install it again.';
    case 'webkit':
      return 'Linux apps that need it won’t open until you install it again.';
    case 'containers':
      return 'Your containers and their files stay on this computer, but won’t run until you install it again.';
    default:
      return `What uses ${feature.title} stops working until you install it again.`;
  }
}

/** What a feature is doing, or whether it's there, in a few words. */
export function describeFeature(feature: FeatureState): string {
  const busy = feature.busy;
  if (busy) {
    if (busy.phase === 'waiting') return busy.action === 'remove' ? 'Waiting to remove…' : 'Waiting to install…';
    if (busy.phase === 'removing') return 'Removing…';
    if (busy.phase === 'building') return feature.installed ? 'Updating…' : 'Installing…';
    const percent = busy.progress !== null ? ` ${Math.round(busy.progress * 100)}%` : '';
    return `${feature.installed ? 'Updating' : 'Downloading'}…${percent}`;
  }
  if (feature.installed && !feature.current) return 'Installed · an update is waiting';
  if (feature.installed) return 'Installed';
  return `Not installed · about ${formatFeatureSize(feature.size)}`;
}
