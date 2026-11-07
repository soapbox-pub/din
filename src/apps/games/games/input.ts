/**
 * Getting around Games with a controller or the arrow keys: the D-pad or
 * left stick (or arrows) move focus to the nearest thing in that direction
 * among what's marked `data-nav`, by where it is on the screen, so the grid,
 * the shelves and the sidebar need no wiring of their own. A presses what's
 * focused, B goes back, Start plays the focused game, X makes it a favorite,
 * Y searches, the shoulder buttons step through the sidebar's sections.
 *
 * Controllers are read with the Gamepad API (standard mapping: by position,
 * A the bottom face button). They're ignored while a game is being played
 * or the window isn't the one in front, since the game is reading the same
 * controller.
 */
import { useEffect, useRef, useState } from 'react';

export type NavAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'accept'
  | 'back'
  | 'play'
  | 'favorite'
  | 'search'
  | 'prevSection'
  | 'nextSection'
  | 'fullscreen';

export type Direction = 'up' | 'down' | 'left' | 'right';

/** Standard-mapping buttons, and what each does. */
const BUTTONS: Record<number, NavAction> = {
  0: 'accept',
  1: 'back',
  2: 'favorite',
  3: 'search',
  4: 'prevSection',
  5: 'nextSection',
  9: 'play',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
  16: 'fullscreen',
};
const DIRECTIONS = new Set<NavAction>(['up', 'down', 'left', 'right']);
const STICK = 0.55;
const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !el.closest('[inert],[aria-hidden="true"]');
}

/** Focus the first thing to go to, if nothing marked is focused. */
export function focusFirst(root: ParentNode = document): boolean {
  const first = [...root.querySelectorAll<HTMLElement>('[data-nav-default]'), ...root.querySelectorAll<HTMLElement>('[data-nav]')].find(visible);
  if (!first) return false;
  first.focus({ preventScroll: false });
  return true;
}

/**
 * Move focus to what's nearest in a direction from what's focused now. Things
 * in the same row (or column) are preferred well over ones closer but off
 * to the side, as a grid is read.
 */
export function moveFocus(direction: Direction, root: ParentNode = document): boolean {
  const current = document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-nav]') ? document.activeElement : null;
  if (!current) return focusFirst(root);
  const from = current.getBoundingClientRect();
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (el === current || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let along: number;
    let across: number;
    switch (direction) {
      case 'right':
        if (r.left < from.right - 4 && cx <= fx + 1) continue;
        along = cx - fx;
        across = Math.abs(cy - fy);
        // Overlapping the row counts as in it.
        if (r.bottom > from.top && r.top < from.bottom) across = 0;
        break;
      case 'left':
        if (r.right > from.left + 4 && cx >= fx - 1) continue;
        along = fx - cx;
        across = Math.abs(cy - fy);
        if (r.bottom > from.top && r.top < from.bottom) across = 0;
        break;
      case 'down':
        if (r.top < from.bottom - 4 && cy <= fy + 1) continue;
        along = cy - fy;
        across = Math.abs(cx - fx);
        if (r.right > from.left && r.left < from.right) across = Math.abs(cx - fx) / 4;
        break;
      case 'up':
        if (r.bottom > from.top + 4 && cy >= fy - 1) continue;
        along = fy - cy;
        across = Math.abs(cx - fx);
        if (r.right > from.left && r.left < from.right) across = Math.abs(cx - fx) / 4;
        break;
    }
    if (along <= 0) continue;
    const score = along + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  best.scrollIntoView({ block: 'nearest', inline: best.closest('[data-shelf]') ? 'center' : 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  return true;
}

/** The input last used, so the screen can show a controller's buttons or not. */
export type InputKind = 'pad' | 'pointer' | 'keys';

/**
 * Read controllers while `enabled`, and the arrow keys always, turning them
 * into NavActions. Returns whether a controller is connected and which kind
 * of input was used last.
 */
export function useNavInput(onAction: (action: NavAction) => void, enabled: boolean): { connected: boolean; input: InputKind } {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState<InputKind>('pointer');
  const handler = useRef(onAction);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    handler.current = onAction;
    enabledRef.current = enabled;
  });

  // Pointer and keys.
  useEffect(() => {
    const pointer = () => setInput('pointer');
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const inMenu = !!target?.closest('[role="menu"],[role="dialog"],[role="listbox"]');
      if (typing || inMenu || e.altKey || e.ctrlKey || e.metaKey) return;
      const action: NavAction | undefined = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key as 'ArrowUp'];
      if (!action) return;
      e.preventDefault();
      setInput('keys');
      handler.current(action);
    };
    window.addEventListener('pointermove', pointer, { passive: true });
    window.addEventListener('pointerdown', pointer, { passive: true });
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', pointer);
      window.removeEventListener('pointerdown', pointer);
      window.removeEventListener('keydown', key);
    };
  }, []);

  // Controllers, polled each frame while one is connected.
  useEffect(() => {
    if (!('getGamepads' in navigator)) return;
    let frame = 0;
    /** Per controller, what was held last frame, and when each direction repeats next. */
    const held = new Map<number, Set<NavAction>>();
    const repeatAt = new Map<string, number>();
    const pads = () => navigator.getGamepads().filter((p): p is Gamepad => !!p && p.connected);

    const tick = (now: number) => {
      frame = 0;
      const list = pads();
      if (!list.length) return;
      const active = enabledRef.current && document.hasFocus() && document.visibilityState === 'visible';
      for (const pad of list) {
        const now_ = new Set<NavAction>();
        pad.buttons.forEach((b, i) => {
          const action = BUTTONS[i];
          if (action && (b.pressed || b.value > 0.5)) now_.add(action);
        });
        const [x = 0, y = 0] = pad.axes;
        if (x > STICK) now_.add('right');
        if (x < -STICK) now_.add('left');
        if (y > STICK) now_.add('down');
        if (y < -STICK) now_.add('up');
        const before = held.get(pad.index) ?? new Set();
        held.set(pad.index, now_);
        if (!active) continue;
        for (const action of now_) {
          const key = `${pad.index}:${action}`;
          if (!before.has(action)) {
            setInput('pad');
            handler.current(action);
            repeatAt.set(key, now + REPEAT_DELAY);
          } else if (DIRECTIONS.has(action) && now >= (repeatAt.get(key) ?? Infinity)) {
            handler.current(action);
            repeatAt.set(key, now + REPEAT_EVERY);
          }
        }
        for (const action of before) if (!now_.has(action)) repeatAt.delete(`${pad.index}:${action}`);
      }
      frame = requestAnimationFrame(tick);
    };

    const start = () => {
      setConnected(pads().length > 0);
      if (!frame && pads().length) frame = requestAnimationFrame(tick);
    };
    window.addEventListener('gamepadconnected', start);
    window.addEventListener('gamepaddisconnected', start);
    // Coming back to the window: a controller connected meanwhile, or one held.
    window.addEventListener('focus', start);
    start();
    return () => {
      window.removeEventListener('gamepadconnected', start);
      window.removeEventListener('gamepaddisconnected', start);
      window.removeEventListener('focus', start);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return { connected, input };
}
