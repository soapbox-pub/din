/**
 * Messages between the Media Player (the host) and a WMP skin view's
 * sandboxed script runtime (the VM, see vm.ts).
 */

/** An element of a view, as the host prepared it: predefined elements expanded, ids assigned. */
export interface VmNode {
  /** Internal id, unique within the view. */
  iid: string;
  /** Lower-cased tag after expansion (BUTTON, SLIDER, ...). */
  tag: string;
  /** The tag as written (PLAYBUTTON), lower-cased. */
  originalTag: string;
  attrs: Record<string, string>;
  children: VmNode[];
}

/** The player as skins see it: refreshed whenever anything changes. */
export interface PlayerSnapshot {
  playState: number;
  openState: number;
  status: string;
  /** File name or stream URL of the current item (never a local path). */
  url: string;
  position: number;
  duration: number;
  name: string;
  artist: string;
  album: string;
  genre: string;
  year: string;
  trackNumber: string;
  bitrate: number;
  volume: number;
  mute: boolean;
  balance: number;
  rate: number;
  loop: boolean;
  shuffle: boolean;
  eqOn: boolean;
  bands: number[];
  eqPreset: number;
  /** Key of the current item, to notice media changes. */
  mediaKey: string;
  current: number;
  items: { name: string; artist: string; album: string; duration: number }[];
  isVideo: boolean;
}

export interface VmInit {
  type: 'init';
  view: VmNode;
  theme: Record<string, string>;
  /** JScript sources to load into the view's scope, in order. */
  scripts: string[];
  /** Image sizes by lower-cased file name (for default widths and heights). */
  images: Record<string, { w: number; h: number }>;
  prefs: Record<string, string>;
  player: PlayerSnapshot;
  eqPresets: string[];
  effects: { type: string; title: string; presets: string[] }[];
  viewWidth: number;
  viewHeight: number;
}

export type HostToVm =
  | VmInit
  | { type: 'player'; player: PlayerSnapshot }
  | { type: 'event'; iid: string; name: string; event?: Record<string, unknown>; attrs?: Record<string, unknown> }
  | { type: 'attrs'; iid: string; attrs: Record<string, unknown> };

export type VmToHost =
  | { type: 'loaded' }
  | { type: 'booted' }
  | { type: 'ready' }
  | { type: 'patch'; patch: Record<string, Record<string, unknown>> }
  | { type: 'call'; target: string; method: string; args: unknown[]; iid?: string }
  | { type: 'error'; message: string };
