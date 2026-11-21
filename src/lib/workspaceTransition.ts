import { useSyncExternalStore } from 'react';

import type { AppConfig } from '@/contexts/AppContext';
import type { Rect } from '@/lib/monitors';

/**
 * Going from one workspace to another, animated: the windows of the one
 * being left and of the one coming slide across their monitor together, or
 * fade into each other, as Settings → Windows says (AppConfig's
 * workspaceAnimation). The window manager plays it whenever it shows another
 * workspace (useWindows' showWorkspace), and a touchpad's three-finger swipe
 * drives it by hand, a finger's travel at a time (WorkspaceSwipeHost.tsx).
 *
 * While one plays, both workspaces' windows show (Window reads
 * useWorkspaceTransition), moved by inline `translate`, `opacity` and
 * `clip-path`, which React's styles don't touch and which sit on top of a
 * drag's or an effect's `transform`. A switch (a shortcut, the Workspaces
 * menu, `din workspace`) shows the new workspace at once and plays over it,
 * so the next command acts on where the user is going; a swipe, which may
 * yet go back, shows it only once the fingers have taken it there.
 */

export type WorkspaceAnimation = AppConfig['workspaceAnimation'];

/** What's moving: a monitor, the workspace it shows and the one coming. */
export interface WorkspaceTransitionSpec {
  areaId: string;
  from: number;
  /** The workspace coming, or null: there's none that way, and the one showing only gives a little. */
  to: number | null;
  /** 1 when the new one comes from the right (the next one), -1 from the left. */
  dir: 1 | -1;
  /** The whole monitor, in workspace coordinates: what the windows slide across. */
  bounds: Rect;
  /** Whether there are monitors beside this one, which sliding windows mustn't show on. */
  clip: boolean;
  /** Both workspaces' windows on the monitor, where they're painted. */
  windows: { id: string; workspace: number; rect: Rect }[];
}

/** The transition under way, as Window needs it. */
export interface WorkspaceTransitionState {
  areaId: string;
  from: number;
  to: number | null;
}

/** How long a whole transition takes, and the least the rest of one does. */
const DURATION_MS = 280;
const MIN_DURATION_MS = 120;
/** How far a workspace with none beside it gives, of its monitor's width. */
const GIVE = 0.1;
/** Room a window's shadow gets outside its box where nothing clips it. */
const SHADOW_PX = 200;

// Off until the desktop says (WorkspaceSwipeHost), so tests and anything
// without a desktop switch at once.
let animation: WorkspaceAnimation = 'none';

/** Settings → Windows' animation ('none' too while motion is reduced). */
export function setWorkspaceAnimation(next: WorkspaceAnimation): void {
  animation = next;
}

/** Whether going to another workspace animates. */
export function workspaceAnimates(): boolean {
  return animation !== 'none';
}

let state: WorkspaceTransitionState | null = null;
const listeners = new Set<() => void>();

function setState(next: WorkspaceTransitionState | null): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The transition under way, if any; re-renders as one starts and ends. */
export function useWorkspaceTransition(): WorkspaceTransitionState | null {
  return useSyncExternalStore(subscribe, () => state, () => null);
}

interface Part {
  el: HTMLElement;
  coming: boolean;
  rect: Rect;
}

/** The transition each element was last styled by, so an older one's end leaves a newer one's alone. */
const owners = new WeakMap<HTMLElement, WorkspaceTransition>();
let current: WorkspaceTransition | null = null;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

export class WorkspaceTransition {
  readonly spec: WorkspaceTransitionSpec;
  private readonly kind: WorkspaceAnimation = animation;
  private readonly shown: WorkspaceTransitionState;
  private readonly parts: Part[];
  private progress = 0;
  private frame = 0;
  private landing: { to: 0 | 1; done?: () => void } | null = null;
  private over = false;

  constructor(spec: WorkspaceTransitionSpec) {
    this.spec = spec;
    this.shown = { areaId: spec.areaId, from: spec.from, to: spec.to };
    this.parts = spec.windows.flatMap((w) => {
      const el = document.querySelector<HTMLElement>(`[data-window-id="${CSS.escape(w.id)}"]`);
      return el ? [{ el, coming: w.workspace !== spec.from, rect: w.rect }] : [];
    });
    for (const part of this.parts) owners.set(part.el, this);
    // The windows coming are styled where they start before they show.
    this.set(0);
    setState(this.shown);
  }

  /** How far along it is: 0 the workspace it began on, 1 the one coming. */
  get at(): number {
    return this.progress;
  }

  /** Put it at PROGRESS, 0 to 1 (with no workspace coming, how hard it's pulled). */
  set(progress: number): void {
    if (this.over) return;
    const p = Math.max(0, Math.min(1, progress));
    this.progress = p;
    const { dir, bounds, clip, to } = this.spec;
    for (const { el, coming, rect } of this.parts) {
      if (owners.get(el) !== this) continue;
      if (to === null) {
        if (this.kind === 'slide') el.style.translate = `${-dir * bounds.width * GIVE * (1 - Math.exp(-2 * p))}px 0`;
      } else if (this.kind === 'slide') {
        const x = (coming ? dir * (1 - p) : -dir * p) * bounds.width;
        el.style.translate = `${x}px 0`;
        if (clip) {
          const left = Math.max(-SHADOW_PX, bounds.x - (rect.x + x));
          const right = Math.max(-SHADOW_PX, rect.x + x + rect.width - (bounds.x + bounds.width));
          el.style.clipPath = `inset(${-SHADOW_PX}px ${right}px ${-SHADOW_PX}px ${left}px)`;
        }
      } else {
        el.style.opacity = String(coming ? p : 1 - p);
      }
    }
  }

  /**
   * Go on from where it is to the workspace coming (1) or back to the one
   * it began on (0), then end. DONE, which shows the new workspace, runs as
   * it gets there, or at once if something cuts it short.
   */
  land(to: 0 | 1, done?: () => void): void {
    if (this.over) return;
    cancelAnimationFrame(this.frame);
    this.landing = { to, done };
    // Nothing to move (both workspaces empty): there's nothing to wait for.
    if (this.parts.length === 0) return this.finish();
    const from = this.progress;
    const duration = Math.max(MIN_DURATION_MS, DURATION_MS * Math.abs(to - from));
    let began: number | null = null;
    const step = (now: number) => {
      began ??= now;
      const t = Math.min(1, (now - began) / duration);
      this.set(from + (to - from) * easeOut(t));
      if (t < 1) this.frame = requestAnimationFrame(step);
      else this.finish();
    };
    this.frame = requestAnimationFrame(step);
  }

  /** End it now: where it was landing, or back where it began. */
  finish(): void {
    if (this.over) return;
    cancelAnimationFrame(this.frame);
    const landing = this.landing ?? { to: 0 as const };
    this.set(landing.to);
    this.over = true;
    if (current === this) current = null;
    landing.done?.();
    if (landing.to === 0) return this.clear();
    // The window manager's change is on its way to the screen; until it's
    // there, the windows stay as the animation left them, which is how
    // they'll be.
    requestAnimationFrame(() => requestAnimationFrame(() => this.clear()));
  }

  private clear(): void {
    if (state === this.shown) setState(null);
    for (const { el } of this.parts) {
      if (owners.get(el) !== this) continue;
      owners.delete(el);
      el.style.translate = '';
      el.style.clipPath = '';
      el.style.opacity = '';
    }
  }
}

/** Start a transition, ending any under way where it was going. */
export function beginWorkspaceTransition(spec: WorkspaceTransitionSpec): WorkspaceTransition {
  current?.finish();
  current = new WorkspaceTransition(spec);
  return current;
}

/** End the transition under way, if any, where it was going. */
export function finishWorkspaceTransition(): void {
  current?.finish();
}
