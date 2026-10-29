/**
 * The effects of Compiz's Animation Add-On plugin (`compiz-plugins-extra`,
 * animationaddon; © 2006 Erkin Bahceci, with Burn, Beam Up and Airplane by
 * Kevin DuBois, Jacek Wieczorek and others, GPL-2.0-or-later): windows cut
 * into polygons, and windows set on fire. Glide 3 is left out; it's Glide 1
 * drawn as one thick polygon.
 */

import type { EffectSetup, Scene, WindowEffect } from '@/lib/effects/engine';
import {
  clamp,
  cuts,
  drawPieces,
  easeIn,
  easeInOut,
  easeOut,
  grid,
  lerp,
  rectPieces,
  segment,
} from '@/lib/effects/geometry';

const explode: WindowEffect = {
  id: 'explode',
  name: 'Explode',
  group: 'animationaddon',
  duration: 800,
  create(setup) {
    const { win, eye, random } = setup;
    const { cols, rows } = cuts(setup, 60);
    const pieces = rectPieces(setup, cols, rows);
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    const scale = Math.max(win.width, win.height);
    const motion = pieces.map((piece) => {
      const dx = piece.cx - cx;
      const dy = piece.cy - cy;
      const d = Math.hypot(dx, dy) || 1;
      const speed = scale * (0.4 + random() * 0.6);
      return {
        vx: (dx / d) * speed + (random() - 0.5) * scale * 0.3,
        vy: (dy / d) * speed + (random() - 0.5) * scale * 0.3,
        vz: eye * (0.1 + random() * 0.35),
        ax: random() - 0.5,
        ay: random() - 0.5,
        az: random() - 0.5,
        spin: (random() - 0.5) * 6 * Math.PI,
      };
    });
    return (p, scene) => {
      const e = easeOut(p);
      drawPieces(scene, pieces, (_piece, i, o) => {
        const m = motion[i];
        o.dx = m.vx * e;
        o.dy = m.vy * e;
        o.dz = m.vz * e;
        o.ax = m.ax;
        o.ay = m.ay;
        o.az = m.az;
        o.angle = m.spin * e;
        o.alpha = 1 - segment(p, 0.4, 1);
      });
    };
  },
};

const leafSpread: WindowEffect = {
  id: 'leaf-spread',
  name: 'Leaf Spread',
  group: 'animationaddon',
  duration: 900,
  create(setup) {
    const { win, eye, random } = setup;
    const { cols, rows } = cuts(setup, 40, 4, 24);
    const pieces = rectPieces(setup, cols, rows);
    const scale = Math.max(win.width, win.height);
    const motion = pieces.map(() => ({
      vx: (random() - 0.35) * scale * 0.9,
      vy: (random() - 0.75) * scale * 0.6,
      vz: (random() - 0.5) * eye * 0.4,
      phase: random() * Math.PI * 2,
      ax: random() - 0.5,
      ay: random() - 0.5,
      az: random() - 0.5,
      spin: (random() + 0.5) * 3 * Math.PI,
      delay: random() * 0.3,
    }));
    return (p, scene) => {
      drawPieces(scene, pieces, (_piece, i, o) => {
        const m = motion[i];
        const t = segment(p, m.delay, m.delay + 0.7);
        const e = easeIn(t);
        o.dx = m.vx * e + Math.sin(t * 9 + m.phase) * 20 * t;
        o.dy = m.vy * e;
        o.dz = m.vz * e;
        o.ax = m.ax;
        o.ay = m.ay;
        o.az = m.az;
        o.angle = m.spin * e;
        o.alpha = 1 - segment(t, 0.4, 1);
      });
    };
  },
};

const skewer: WindowEffect = {
  id: 'skewer',
  name: 'Skewer',
  group: 'animationaddon',
  duration: 700,
  create(setup) {
    const { win, view, random } = setup;
    const { cols, rows } = cuts(setup, 70);
    const pieces = rectPieces(setup, cols, rows);
    const motion = pieces.map((piece) => ({
      // Rows run off alternately left and right, back into the screen.
      vx: (piece.row % 2 ? 1 : -1) * (win.width * (0.6 + random() * 0.6)),
      vz: -view.height * (0.5 + random()),
      spin: (random() - 0.5) * Math.PI,
      delay: random() * 0.25,
    }));
    return (p, scene) => {
      drawPieces(scene, pieces, (_piece, i, o) => {
        const m = motion[i];
        const t = segment(p, m.delay, m.delay + 0.75);
        const e = easeIn(t);
        o.dx = m.vx * e;
        o.dz = m.vz * e;
        o.angle = m.spin * e;
        o.alpha = 1 - segment(t, 0.5, 1);
      });
    };
  },
};

const domino: WindowEffect = {
  id: 'domino',
  name: 'Domino',
  group: 'animationaddon',
  duration: 800,
  create(setup) {
    const { cols, rows } = cuts(setup, 80, 3, 10);
    const pieces = rectPieces(setup, cols, rows);
    const ph = setup.win.height / rows;
    return (p, scene) => {
      drawPieces(scene, pieces, (piece, _i, o) => {
        // The top left topples first and knocks down the rest.
        const delay = (piece.row / rows) * 0.45 + (piece.col / cols) * 0.15;
        const t = segment(p, delay, delay + 0.4);
        o.ax = 1;
        o.ay = 0;
        o.az = 0;
        o.py = ph / 2;
        o.angle = -easeIn(t) * (Math.PI / 2);
        o.dy = easeIn(t) * ph * 0.5;
        o.alpha = 1 - segment(t, 0.6, 1);
      });
    };
  },
};

const razr: WindowEffect = {
  id: 'razr',
  name: 'Razr',
  group: 'animationaddon',
  duration: 700,
  create(setup) {
    const rows = Math.round(clamp(setup.win.height / 90, 3, 8));
    const pieces = rectPieces(setup, 1, rows);
    const ph = setup.win.height / rows;
    return (p, scene) => {
      drawPieces(scene, pieces, (piece, _i, o) => {
        // Strips flip up over their top edges, from the bottom one up.
        const delay = ((rows - 1 - piece.row) / rows) * 0.6;
        const t = segment(p, delay, delay + 0.4);
        o.ax = 1;
        o.ay = 0;
        o.az = 0;
        o.py = -ph / 2;
        o.angle = easeInOut(t) * Math.PI;
        o.alpha = 1 - segment(p, 0.75, 1);
      });
    };
  },
};

const fold: WindowEffect = {
  id: 'fold',
  name: 'Fold',
  group: 'animationaddon',
  duration: 800,
  create(setup) {
    const { win } = setup;
    const rows = Math.round(clamp(win.height / 110, 3, 6));
    const hinge = (i: number) => win.y + (i / rows) * win.height;
    const slot = 0.85 / (rows - 1);
    return (p, scene) => {
      // Hinge i joins row i to the one above. The bottom row folds first,
      // and each fold carries the rows already folded below it, like a map.
      const angles: number[] = [];
      for (let i = rows - 1; i >= 1; i--) {
        const k = rows - 1 - i;
        angles[i] = easeInOut(segment(p, k * slot, (k + 1) * slot)) * Math.PI * (i % 2 ? 1 : -1);
      }
      const place = (row: number, x: number, y: number): [number, number, number, number] => {
        let z = 0;
        let nz = 1;
        let ny = 0;
        for (let i = row; i >= 1; i--) {
          const a = angles[i];
          if (!a) continue;
          const cos = Math.cos(a);
          const sin = Math.sin(a);
          const hy = hinge(i);
          const dy = y - hy;
          y = hy + dy * cos - z * sin;
          z = dy * sin + z * cos;
          const ny2 = ny * cos - nz * sin;
          nz = ny * sin + nz * cos;
          ny = ny2;
        }
        return [x, y, z, nz];
      };
      const order = Array.from({ length: rows }, (_, r) => r).map((r) => ({
        r,
        z: place(r, 0, win.y + ((r + 0.5) / rows) * win.height)[2],
      }));
      order.sort((a, b) => a.z - b.z);
      for (const { r } of order) {
        const nz = place(r, 0, win.y + ((r + 0.5) / rows) * win.height)[3];
        grid(
          scene,
          setup,
          1,
          1,
          (_u, _v, o) => {
            const [x, y, z] = place(r, o.x, o.y);
            o.x = x;
            o.y = y;
            o.z = z;
            o.shade = 0.45 + 0.55 * Math.abs(nz);
            o.alpha = 1 - segment(p, 0.85, 1);
          },
          { u0: 0, u1: 1, v0: r / rows, v1: (r + 1) / rows },
        );
      }
    };
  },
};

const airplane: WindowEffect = {
  id: 'airplane',
  name: 'Airplane',
  group: 'animationaddon',
  duration: 1100,
  create(setup) {
    const { win, view } = setup;
    const cx = win.x + win.width / 2;
    const cy = win.y + win.height / 2;
    return (p, scene) => {
      // Fold the sheet along its middle into a dart, its nose (the top)
      // pinched in, then throw it up and away.
      const f = easeInOut(segment(p, 0, 0.4));
      const fly = easeIn(segment(p, 0.3, 1));
      const wing = f * (Math.PI / 2) * 0.8;
      const tilt = -fly * 0.5;
      const cosT = Math.cos(tilt);
      const sinT = Math.sin(tilt);
      for (const side of [0, 1]) {
        const sign = side ? 1 : -1;
        grid(
          scene,
          setup,
          8,
          8,
          (u, v, o) => {
            const half = Math.abs(u - 0.5) * win.width;
            // The nose: the top narrows to a point as it folds.
            const span = half * (1 - f * 0.85 * (1 - v));
            let x = sign * span * Math.cos(wing);
            let z = span * Math.sin(wing);
            let y = (v - 0.5) * win.height * (1 - f * 0.3);
            // In flight it banks and climbs toward the top right.
            const rx = x * cosT - y * sinT;
            const ry = x * sinT + y * cosT;
            x = rx + fly * view.width * 0.5;
            y = ry - fly * (win.y + win.height);
            z -= fly * view.height * 1.5;
            o.x = cx + x;
            o.y = cy + y;
            o.z = z;
            o.shade = 1 - (side ? 0.35 : 0.1) * Math.sin(wing);
            o.alpha = 1 - segment(p, 0.8, 1);
          },
          side ? { u0: 0.5, u1: 1, v0: 0, v1: 1 } : { u0: 0, u1: 0.5, v0: 0, v1: 1 },
        );
      }
    };
  },
};

/** The flame colors: white-hot, through orange, to dark red. */
function flameColor(t: number): [number, number, number] {
  if (t < 0.3) {
    const s = t / 0.3;
    return [1, lerp(0.92, 0.55, s), lerp(0.6, 0.15, s)];
  }
  const s = (t - 0.3) / 0.7;
  return [lerp(1, 0.55, s), lerp(0.55, 0.08, s), lerp(0.15, 0.02, s)];
}

/**
 * Fire and smoke particles licking up from a burning front: `front(p,
 * along)` is where, at progress `p`, the point `along` (0 to 1) of the
 * front is, or null if it's off the window. Each particle is a pure
 * function of progress, born at a seeded moment with a seeded lifespan,
 * and rises from where the front was when it was born.
 */
export function fireParticles(
  setup: EffectSetup,
  count: number,
  front: (p: number, along: number) => { x: number; y: number } | null,
  lastBirth: number,
) {
  const { random } = setup;
  const make = (life: number, lifeJitter: number) => {
    const born = random() * lastBirth;
    return {
      born,
      // Dead by the end, so nothing pops out of existence.
      life: Math.min(life + random() * lifeJitter, 1 - born),
      along: random(),
      rise: random(),
      size: random(),
      phase: random() * Math.PI * 2,
    };
  };
  const fire = Array.from({ length: count }, () => make(0.08, 0.1));
  const smoke = Array.from({ length: Math.round(count / 4) }, () => make(0.2, 0.15));

  return (p: number, scene: Scene) => {
    for (const s of smoke) {
      const a = (p - s.born) / s.life;
      if (a < 0 || a > 1) continue;
      const at = front(s.born, s.along);
      if (!at) continue;
      const size = lerp(24, 70, a) * (0.6 + s.size * 0.6);
      const alpha = 0.3 * Math.min(1, a / 0.2) * (1 - a);
      const g = 0.18 + s.size * 0.1;
      scene.particle(
        at.x + Math.sin(a * 5 + s.phase) * 18,
        at.y - 30 - a * (120 + s.rise * 160),
        size,
        size,
        g,
        g,
        g,
        alpha,
        false,
      );
    }
    for (const f of fire) {
      const a = (p - f.born) / f.life;
      if (a < 0 || a > 1) continue;
      const at = front(f.born, f.along);
      if (!at) continue;
      const size = (18 + f.size * 26) * (1 - a * 0.5);
      const [r, g, b] = flameColor(a);
      const alpha = 0.85 * Math.min(1, a / 0.1) * (1 - a);
      scene.particle(
        at.x + Math.sin(a * 7 + f.phase) * 6,
        at.y - a * (30 + f.rise * 90),
        size * 0.8,
        size,
        r,
        g,
        b,
        alpha,
        true,
      );
    }
  };
}

/**
 * The paper-burning look, shared by Burn and Bonanza: pixels past the
 * front (`d > 0`) are gone, and the paper chars and glows near it.
 */
export const CHAR_AND_GLOW = `
  if (d > 0.0) discard;
  float charred = smoothstep(-28.0, 0.0, d);
  color.rgb = mix(color.rgb, vec3(0.07, 0.035, 0.015) * color.a, charred * 0.92);
  float glow = smoothstep(-7.0, 0.0, d);
  color.rgb = min(vec3(color.a), color.rgb + vec3(1.0, 0.5, 0.12) * glow * color.a);
`;

/** When the burn front has crossed the window, leaving time for the flames to die. */
const BURN_END = 0.85;

const burn: WindowEffect = {
  id: 'burn',
  name: 'Burn',
  group: 'animationaddon',
  duration: 1300,
  uniforms: ['u_front'],
  // The front rises from below the bottom edge to above the top one; noise
  // makes it ragged.
  fragment: `
  float ragged = (fbm(pos / 55.0 + vec2(0.0, u_p * 3.0)) - 0.5) * 70.0;
  float d = pos.y - u_front + ragged;
  ${CHAR_AND_GLOW}`,
  create(setup) {
    const { win } = setup;
    // Starts and ends far enough past the edges that the window at rest
    // shows no char, and none of it outlives the front.
    const frontY = (p: number) => lerp(win.height + 70, -40, clamp(p / BURN_END));
    const flames = fireParticles(
      setup,
      Math.round(clamp(win.width / 1.5, 150, 900)),
      (p, along) => {
        const y = frontY(p);
        if (y < -20 || y > win.height + 20) return null;
        return { x: win.x + along * win.width, y: win.y + clamp(y, 0, win.height) };
      },
      BURN_END,
    );
    return (p, scene) => {
      scene.set('u_front', frontY(p));
      grid(scene, setup, 1, 1, () => {});
      flames(p, scene);
    };
  },
};

const beamUp: WindowEffect = {
  id: 'beam-up',
  name: 'Beam Up',
  group: 'animationaddon',
  duration: 1000,
  // Each column of light dissolves on its own schedule: brightening to
  // white, then fading out.
  fragment: `
  float col = floor(pos.x / 5.0);
  float start = hash(vec2(col, 7.0)) * 0.45;
  float t = clamp((u_p - start) / 0.45, 0.0, 1.0);
  color.rgb = mix(color.rgb, vec3(0.85, 0.92, 1.0) * color.a, smoothstep(0.0, 0.5, t));
  color *= 1.0 - smoothstep(0.35, 1.0, t);
  `,
  create(setup) {
    const { win, random } = setup;
    const beams = Array.from({ length: Math.round(clamp(win.width / 4, 60, 400)) }, () => {
      const born = random() * 0.75;
      return {
        x: win.x + random() * win.width,
        y: win.y + random() * win.height,
        born,
        life: Math.min(0.15 + random() * 0.15, 1 - born),
        rise: 150 + random() * 250,
        w: 3 + random() * 5,
      };
    });
    return (p, scene) => {
      const e = easeIn(p);
      grid(scene, setup, 1, 1, (_u, v, o) => {
        // A slight stretch upward, as if pulled into the beam.
        o.y -= (1 - v) * win.height * 0.25 * e;
      });
      for (const b of beams) {
        const a = (p - b.born) / b.life;
        if (a < 0 || a > 1) continue;
        const alpha = Math.sin(Math.PI * a) * 0.8;
        scene.particle(b.x, b.y - a * b.rise, b.w, b.w * 9, 0.6, 0.8, 1, alpha, true);
      }
    };
  },
};

export const ANIMATIONADDON_EFFECTS: WindowEffect[] = [
  airplane,
  beamUp,
  burn,
  domino,
  explode,
  fold,
  leafSpread,
  razr,
  skewer,
];
