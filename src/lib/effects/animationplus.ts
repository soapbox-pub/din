/**
 * The effects of the Animation Plus plugin (`compiz-plugins-extra`,
 * animationplus; © 2008 Kevin DuBois, GPL-2.0-or-later) and the Animation
 * Sim plugin (animationsim; © 2008 Kevin DuBois and Sam Spilsbury). Sheet,
 * which drops a dialog into its parent, is left out: Din's windows have no
 * parents.
 */

import type { WindowEffect } from '@/lib/effects/engine';
import { CHAR_AND_GLOW, fireParticles } from '@/lib/effects/animationaddon';
import {
  clamp,
  cuts,
  drawPieces,
  easeIn,
  easeInOut,
  grid,
  lerp,
  rectPieces,
  segment,
  shardPieces,
} from '@/lib/effects/geometry';

const helix: WindowEffect = {
  id: 'helix',
  name: 'Helix',
  group: 'animationplus',
  duration: 900,
  create(setup) {
    const { win, view } = setup;
    const rows = Math.round(clamp(win.height / 40, 6, 20));
    const pieces = rectPieces(setup, 1, rows);
    const cx = win.x + win.width / 2;
    return (p, scene) => {
      drawPieces(scene, pieces, (piece, _i, o) => {
        // Strips spin about the window's vertical axis, each a little
        // behind the one above, while the whole helix sinks away.
        const delay = (piece.row / rows) * 0.4;
        const t = segment(p, delay, delay + 0.6);
        o.ax = 0;
        o.ay = 1;
        o.az = 0;
        o.px = cx - piece.cx;
        o.angle = easeIn(t) * Math.PI * 2;
        o.dz = -easeIn(t) * view.height * 0.5;
        o.alpha = 1 - segment(t, 0.5, 1);
      });
    };
  },
};

const blinds: WindowEffect = {
  id: 'blinds',
  name: 'Blinds',
  group: 'animationplus',
  duration: 600,
  create(setup) {
    const cols = Math.round(clamp(setup.win.width / 60, 4, 20));
    const pieces = rectPieces(setup, cols, 1);
    return (p, scene) => {
      drawPieces(scene, pieces, (piece, _i, o) => {
        const delay = (piece.col / cols) * 0.3;
        const t = segment(p, delay, delay + 0.7);
        o.ax = 0;
        o.ay = 1;
        o.az = 0;
        o.angle = easeInOut(t) * (Math.PI / 2);
        o.alpha = 1 - segment(t, 0.75, 1);
      });
    };
  },
};

const shatter: WindowEffect = {
  id: 'shatter',
  name: 'Shatter',
  group: 'animationplus',
  duration: 1000,
  create(setup) {
    const { win, view, eye, random } = setup;
    const { cols, rows } = cuts(setup, 70, 3, 14);
    const pieces = shardPieces(setup, cols, rows);
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    const reach = Math.hypot(win.width, win.height) / 2 || 1;
    // Enough to fall off the bottom of the screen.
    const fall = view.height - win.y + win.height;
    const motion = pieces.map((piece) => ({
      // Cracks spread out from the center: farther shards drop later.
      delay: (Math.hypot(piece.cx - cx, piece.cy - cy) / reach) * 0.3 + random() * 0.1,
      vx: (piece.cx - cx) * 0.3 + (random() - 0.5) * 80,
      vz: (random() - 0.3) * eye * 0.25,
      ax: random() - 0.5,
      ay: random() - 0.5,
      az: random() - 0.5,
      spin: (random() - 0.5) * 4 * Math.PI,
    }));
    return (p, scene) => {
      drawPieces(scene, pieces, (_piece, i, o) => {
        const m = motion[i];
        const t = segment(p, m.delay, m.delay + 0.6);
        o.dx = m.vx * t;
        o.dy = fall * t * t;
        o.dz = m.vz * t;
        o.ax = m.ax;
        o.ay = m.ay;
        o.az = m.az;
        o.angle = m.spin * t;
        o.alpha = 1 - segment(t, 0.6, 1);
      });
    };
  },
};

/** When Bonanza's ring of fire has burned past the corners. */
const BONANZA_END = 0.85;

const bonanza: WindowEffect = {
  id: 'bonanza',
  name: 'Bonanza',
  group: 'animationplus',
  duration: 1300,
  uniforms: ['u_radius'],
  // A ring of fire burns out from the center.
  fragment: `
  vec2 off = pos - u_size * 0.5;
  float ragged = (fbm(normalize(off + 0.001) * 3.0 + u_p * 2.0) - 0.5) * 70.0;
  float d = u_radius - length(off) + ragged;
  ${CHAR_AND_GLOW}`,
  create(setup) {
    const { win } = setup;
    const reach = Math.hypot(win.width, win.height) / 2;
    // From well inside nothing, out past the corners.
    const radius = (p: number) => lerp(-70, reach + 40, clamp(p / BONANZA_END));
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    const flames = fireParticles(
      setup,
      Math.round(clamp(reach * 2, 150, 900)),
      (p, along) => {
        const r = radius(p);
        if (r < 0) return null;
        const a = along * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        // Only where the ring is still on the window.
        if (x < win.x || x > win.x + win.width || y < win.y || y > win.y + win.height) return null;
        return { x, y };
      },
      BONANZA_END,
    );
    return (p, scene) => {
      scene.set('u_radius', radius(p));
      grid(scene, setup, 1, 1, () => {});
      flames(p, scene);
    };
  },
};

const flyOut: WindowEffect = {
  id: 'fly-out',
  name: 'Fly Out',
  group: 'animationsim',
  duration: 450,
  create(setup) {
    const { win, view } = setup;
    const distance = view.height - win.y;
    return (p, scene) => {
      const e = easeIn(p);
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.y += distance * e;
        o.alpha = 1 - segment(p, 0.5, 1);
      });
    };
  },
};

const rotateOut: WindowEffect = {
  id: 'rotate-out',
  name: 'Rotate Out',
  group: 'animationsim',
  duration: 500,
  create(setup) {
    const { win } = setup;
    return (p, scene) => {
      // Swings away on its left edge, like a door.
      const a = easeIn(p) * (Math.PI / 2);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      grid(scene, setup, 16, 1, (u, _v, o) => {
        const dx = u * win.width;
        o.x = win.x + dx * cos;
        o.z = -dx * sin;
        o.shade = 1 - 0.4 * sin;
        o.alpha = 1 - segment(p, 0.6, 1);
      });
    };
  },
};

const expand: WindowEffect = {
  id: 'expand',
  name: 'Expand Piecewise',
  group: 'animationsim',
  duration: 450,
  create(setup) {
    const { win } = setup;
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    return (p, scene) => {
      // Down to a line, then to a point.
      const sy = 1 - easeInOut(segment(p, 0, 0.5)) * 0.99;
      const sx = 1 - easeInOut(segment(p, 0.5, 1));
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.x = cx + (o.x - cx) * sx;
        o.y = cy + (o.y - cy) * sy;
        o.alpha = 1 - segment(p, 0.85, 1);
      });
    };
  },
};

const bounce: WindowEffect = {
  id: 'bounce',
  name: 'Bounce',
  group: 'animationsim',
  duration: 450,
  create(setup) {
    const { win } = setup;
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    return (p, scene) => {
      const s =
        p < 0.3 ? 1 + 0.08 * Math.sin((p / 0.3) * (Math.PI / 2)) : 1.08 * (1 - easeIn(segment(p, 0.3, 1)));
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.x = cx + (o.x - cx) * s;
        o.y = cy + (o.y - cy) * s;
        o.alpha = 1 - segment(p, 0.6, 1);
      });
    };
  },
};

const pulse: WindowEffect = {
  id: 'pulse',
  name: 'Pulse',
  group: 'animationsim',
  duration: 500,
  create(setup) {
    const { win } = setup;
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    return (p, scene) => {
      const e = easeInOut(p);
      // A ghost swells out of the window as the window itself shrinks away.
      const ghost = 1 + 0.3 * e;
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.x = cx + (o.x - cx) * ghost;
        o.y = cy + (o.y - cy) * ghost;
        o.alpha = 0.5 * Math.sin(Math.PI * Math.min(1, p * 1.5)) * (1 - e);
      });
      const s = 1 - 0.2 * e;
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.x = cx + (o.x - cx) * s;
        o.y = cy + (o.y - cy) * s;
        o.alpha = 1 - e;
      });
    };
  },
};

const fan: WindowEffect = {
  id: 'fan',
  name: 'Fan',
  group: 'animationsim',
  duration: 600,
  create(setup) {
    const { win } = setup;
    const cols = Math.round(clamp(win.width / 70, 5, 14));
    const pieces = rectPieces(setup, cols, 1);
    const pivotX = win.x + win.width / 2;
    const pivotY = win.y + win.height;
    return (p, scene) => {
      const e = easeInOut(p);
      drawPieces(scene, pieces, (piece, _i, o) => {
        // Blades spread from the bottom center, like a hand fan.
        const spread = (piece.col + 0.5) / cols - 0.5;
        o.px = pivotX - piece.cx;
        o.py = pivotY - piece.cy;
        o.angle = spread * e * Math.PI * 1.2;
        o.alpha = 1 - segment(p, 0.5, 1);
      });
    };
  },
};

export const ANIMATIONPLUS_EFFECTS: WindowEffect[] = [blinds, bonanza, helix, shatter];

export const ANIMATIONSIM_EFFECTS: WindowEffect[] = [bounce, expand, fan, flyOut, pulse, rotateOut];
