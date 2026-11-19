import { useEffect, useRef } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import type { WorkspaceSteps } from '@/hooks/useWindows';
import { useReducedMotion } from '@/shared/reducedMotion';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { finishWorkspaceTransition, setWorkspaceAnimation, workspaceAnimates, type WorkspaceTransition } from '@/lib/workspaceTransition';

/**
 * How far three fingers go, in libinput's pointer units (what din-shell
 * tells), to take a monitor from one workspace to the next.
 */
const SWIPE_UNITS = 400;
/** Let go past this much of the way, the swipe goes on to the workspace coming. */
const COMMIT_AT = 0.5;
/** Or flicked: this fast, in units a millisecond, having gone at least this far. */
const FLICK_SPEED = 0.35;
const FLICK_AT = 0.06;
/** How far back the swipe's speed is measured over, in ms. */
const SPEED_WINDOW_MS = 90;
/** Without an animation, how far to the first workspace and to each after. */
const STEP_FIRST = 0.2;
const STEP_NEXT = 0.8;

/** A swipe under way. */
interface Swipe {
  steps: WorkspaceSteps;
  /** The swipe's travel (units) at which the workspace showing sits still. */
  origin: number;
  /** The way it's going from there, once it has: 1 to the next workspace. */
  dir: 1 | -1 | 0;
  to: number | null;
  transition: WorkspaceTransition | null;
  /** Where it was lately, for its speed as the fingers lift. */
  samples: { at: number; dx: number }[];
  /** Without an animation: how far the next step is. */
  stepAt: number;
}

/**
 * The workspace animation's settings, and a touchpad's three-finger swipe,
 * which din-shell tells a finger's travel at a time (electron/mouse.mts).
 * Renders nothing.
 *
 * The swipe moves the workspace showing and the one beside it with the
 * fingers (src/lib/workspaceTransition.ts): let go past halfway, or flicked,
 * it goes on to the new one, else back; kept going, it carries on to the one
 * after. With the animation off (or motion reduced) it steps instead.
 */
export function WorkspaceSwipeHost() {
  const { config } = useAppContext();
  const actions = useWindowActions();
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const reduced = useReducedMotion();
  const animation = reduced || config.reduceMotion ? 'none' : config.workspaceAnimation;
  useEffect(() => {
    setWorkspaceAnimation(animation);
    return () => setWorkspaceAnimation('none');
  }, [animation]);

  useEffect(() => {
    let swipe: Swipe | null = null;

    /** The workspace DIR of the one showing, or null with no other to go to. */
    const beside = (steps: WorkspaceSteps, dir: 1 | -1): number | null => {
      const { list, current } = steps;
      if (list.length < 2) return null;
      return list[(list.indexOf(current) + dir + list.length) % list.length];
    };

    /** The swipe is going DIR from the workspace showing: start moving that way. */
    const head = (s: Swipe, dir: 1 | -1) => {
      s.transition?.finish();
      s.dir = dir;
      s.to = beside(s.steps, dir);
      s.transition = actionsRef.current.beginWorkspaceSwipe(s.steps.areaId, s.to, dir);
    };

    /** The swipe reached the workspace it was heading for, which shows from here. */
    const arrive = (s: Swipe) => {
      const to = s.to;
      if (to === null) return;
      const { areaId } = s.steps;
      s.transition?.land(1, () => actionsRef.current.showWorkspace(to, areaId, { instant: true }));
      s.transition?.finish();
      s.transition = null;
      s.steps = { ...s.steps, current: to };
      s.origin -= s.dir * SWIPE_UNITS;
      s.dir = 0;
      s.to = null;
    };

    const move = (s: Swipe, dx: number) => {
      // Fingers going left bring the next workspace in from the right.
      let p = -(dx - s.origin) / SWIPE_UNITS;
      if (!workspaceAnimates()) {
        if (Math.abs(p) < s.stepAt) return;
        actionsRef.current.stepWorkspace(p > 0 ? 1 : -1);
        s.origin = dx;
        s.stepAt = STEP_NEXT;
        return;
      }
      // A long swipe goes through one workspace after another.
      for (let i = 0; i < 10 && s.dir !== 0 && s.to !== null && p * s.dir >= 1; i++) {
        arrive(s);
        p = -(dx - s.origin) / SWIPE_UNITS;
      }
      if (p === 0) {
        s.transition?.set(0);
        return;
      }
      const dir = p > 0 ? 1 : -1;
      if (dir !== s.dir) head(s, dir);
      s.transition?.set(Math.abs(p));
    };

    const end = (s: Swipe, cancelled: boolean) => {
      const transition = s.transition;
      if (!transition) return;
      const last = s.samples[s.samples.length - 1];
      const first = s.samples[0];
      // Units a millisecond, the way the swipe is heading.
      const speed = last && first && last.at > first.at ? (-(last.dx - first.dx) / (last.at - first.at)) * s.dir : 0;
      const p = transition.at;
      const go = !cancelled && s.to !== null && (p >= COMMIT_AT || (speed >= FLICK_SPEED && p >= FLICK_AT));
      const { to } = s;
      const { areaId } = s.steps;
      if (go && to !== null) {
        transition.land(1, () => actionsRef.current.showWorkspace(to, areaId, { instant: true }));
      } else {
        transition.land(0);
      }
    };

    return getShellShortcuts()?.onShortcut((shortcut) => {
      if (shortcut.action !== 'workspace-swipe') return;
      if (shortcut.phase === 'begin') {
        // One still settling ends where it was going, and this starts from there.
        finishWorkspaceTransition();
        const steps = actionsRef.current.workspaceSteps();
        swipe = steps && { steps, origin: 0, dir: 0, to: null, transition: null, samples: [], stepAt: STEP_FIRST };
      } else if (!swipe) {
        return;
      } else if (shortcut.phase === 'update') {
        const now = performance.now();
        swipe.samples.push({ at: now, dx: shortcut.dx });
        while (swipe.samples.length > 2 && now - swipe.samples[0].at > SPEED_WINDOW_MS) swipe.samples.shift();
        move(swipe, shortcut.dx);
      } else {
        end(swipe, shortcut.phase === 'cancel');
        swipe = null;
      }
    });
  }, []);

  return null;
}
