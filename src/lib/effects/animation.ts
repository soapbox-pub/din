/**
 * The grid effects of Compiz's animation plugin (`compiz-plugins-main`,
 * src/animation; © 2006 Erkin Bahceci, after the Minimize plugin by David
 * Reveman, GPL-2.0-or-later): each deforms the window as one mesh. Dodge
 * and Focus Fade are left out: they animate restacking, not windows
 * coming and going.
 */

import { GENIE_DURATION_MS, genieFrame, type GenieRect } from '@/lib/genie';
import type { WindowEffect } from '@/lib/effects/engine';
import { clamp, easeIn, easeInOut, grid, lerp, segment } from '@/lib/effects/geometry';

/** Where a window zooms to: its dock tile, or a point at its center. */
function zoomTarget(win: GenieRect, target: GenieRect | null): GenieRect {
  return target ?? { x: win.x + win.width / 2, y: win.y + win.height / 2, width: 0, height: 0 };
}

const magicLamp: WindowEffect = {
  id: 'magic-lamp',
  name: 'Magic Lamp',
  group: 'animation',
  duration: GENIE_DURATION_MS,
  minimizeOnly: true,
  create(setup) {
    const { win } = setup;
    const target = zoomTarget(win, setup.target);
    return (p, scene) => {
      const frame = genieFrame(win, target, p);
      // The model is linear along a row: two columns are exact.
      grid(scene, setup, 1, 64, (u, v, o) => {
        const pt = frame.point(u, v);
        o.x = pt.x;
        o.y = pt.y;
        o.alpha = frame.opacity;
      });
    };
  },
};

const magicLampWavy: WindowEffect = {
  id: 'magic-lamp-wavy',
  name: 'Magic Lamp Wavy',
  group: 'animation',
  duration: 600,
  minimizeOnly: true,
  create(setup) {
    const { win } = setup;
    const target = zoomTarget(win, setup.target);
    const funnel = Math.max(1, target.y - win.y);
    const amp = Math.min(win.width * 0.15, 80);
    return (p, scene) => {
      const frame = genieFrame(win, target, p);
      grid(scene, setup, 1, 96, (u, v, o) => {
        const pt = frame.point(u, v);
        // Up the funnel, 0 at the icon's mouth.
        const s = clamp((target.y - pt.y) / funnel);
        o.x = pt.x + amp * Math.sin(s * 3 * Math.PI - p * 4 * Math.PI) * Math.sin(Math.PI * p) * s;
        o.y = pt.y;
        o.alpha = frame.opacity;
      });
    };
  },
};

const zoom: WindowEffect = {
  id: 'zoom',
  name: 'Zoom',
  group: 'animation',
  duration: 350,
  create(setup) {
    const { win } = setup;
    const to = zoomTarget(win, setup.target);
    const toDock = setup.target !== null;
    return (p, scene) => {
      const e = easeInOut(p);
      grid(scene, setup, 1, 1, (u, v, o) => {
        o.x = lerp(win.x + u * win.width, to.x + u * to.width, e);
        o.y = lerp(win.y + v * win.height, to.y + v * to.height, e);
        o.alpha = toDock ? 1 - segment(p, 0.75, 1) : 1 - easeIn(p);
      });
    };
  },
};

const sidekick: WindowEffect = {
  id: 'sidekick',
  name: 'Sidekick',
  group: 'animation',
  duration: 450,
  create(setup) {
    const { win } = setup;
    const to = zoomTarget(win, setup.target);
    const toDock = setup.target !== null;
    return (p, scene) => {
      const e = easeInOut(p);
      const cx = lerp(win.x + win.width / 2, to.x + to.width / 2, e);
      const cy = lerp(win.y + win.height / 2, to.y + to.height / 2, e);
      const w = lerp(win.width, to.width, e);
      const h = lerp(win.height, to.height, e);
      // Compiz's default: half a turn.
      const a = e * Math.PI;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      grid(scene, setup, 1, 1, (u, v, o) => {
        const x = (u - 0.5) * w;
        const y = (v - 0.5) * h;
        o.x = cx + x * cos - y * sin;
        o.y = cy + x * sin + y * cos;
        o.alpha = toDock ? 1 - segment(p, 0.75, 1) : 1 - easeIn(p);
      });
    };
  },
};

const fade: WindowEffect = {
  id: 'fade',
  name: 'Fade',
  group: 'animation',
  duration: 250,
  create(setup) {
    return (p, scene) => {
      grid(scene, setup, 1, 1, (_u, _v, o) => {
        o.alpha = 1 - easeInOut(p);
      });
    };
  },
};

/** Tilt the window about its horizontal midline while it moves in depth. */
function glide(id: string, name: string, angle: number, depth: number): WindowEffect {
  return {
    id,
    name,
    group: 'animation',
    duration: 350,
    create(setup) {
      const { win, view } = setup;
      const cy = win.y + win.height / 2;
      return (p, scene) => {
        const e = easeIn(p);
        const a = e * angle;
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        grid(scene, setup, 1, 16, (_u, _v, o) => {
          const dy = o.y - cy;
          o.y = cy + dy * cos;
          o.z = dy * sin + e * depth * view.height;
          o.alpha = 1 - e;
          o.shade = 1 - 0.3 * Math.abs(sin);
        });
      };
    },
  };
}

const glide1 = glide('glide-1', 'Glide 1', -Math.PI / 4, -0.6);
const glide2 = glide('glide-2', 'Glide 2', Math.PI / 4, 0.4);

const curvedFold: WindowEffect = {
  id: 'curved-fold',
  name: 'Curved Fold',
  group: 'animation',
  duration: 400,
  create(setup) {
    const { win } = setup;
    const amp = Math.min(win.width, win.height) * 0.4;
    return (p, scene) => {
      const e = easeInOut(p);
      grid(scene, setup, 8, 32, (u, v, o) => {
        const bulge = Math.sin(Math.PI * clamp(v));
        // The window folds up into its title bar, bowing toward the viewer
        // and pinching in at the sides as it goes.
        o.y = win.y + v * win.height * (1 - e);
        o.x = win.x + win.width / 2 + (u - 0.5) * win.width * (1 - 0.3 * e * bulge);
        o.z = amp * e * bulge;
        o.shade = 1 - 0.3 * e * bulge;
        o.alpha = 1 - segment(p, 0.6, 1);
      });
    };
  },
};

const horizontalFolds: WindowEffect = {
  id: 'horizontal-folds',
  name: 'Horizontal Folds',
  group: 'animation',
  duration: 450,
  create(setup) {
    const { win } = setup;
    // Compiz's three folds, each a pair of strips meeting at a ridge.
    const strips = 6;
    const hs = win.height / strips;
    const cy = win.y + win.height / 2;
    return (p, scene) => {
      const e = easeInOut(p);
      const a = e * (Math.PI / 2) * 0.95;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const lineY = (i: number) => cy + (i * hs - win.height / 2) * cos;
      const lineZ = (i: number) => (i % 2 ? hs * sin : 0);
      for (let i = 0; i < strips; i++) {
        const shade = 1 - (i % 2 ? 0.45 : 0.1) * sin;
        grid(
          scene,
          setup,
          1,
          1,
          (_u, v, o) => {
            const f = clamp(v * strips - i);
            o.y = lerp(lineY(i), lineY(i + 1), f);
            o.z = lerp(lineZ(i), lineZ(i + 1), f);
            o.shade = shade;
            o.alpha = 1 - segment(p, 0.7, 1);
          },
          { u0: 0, u1: 1, v0: i / strips, v1: (i + 1) / strips },
        );
      }
    };
  },
};

const rollUp: WindowEffect = {
  id: 'roll-up',
  name: 'Roll Up',
  group: 'animation',
  duration: 450,
  create(setup) {
    const { win } = setup;
    const r = Math.max(8, Math.min(24, win.height / 12));
    const bottom = win.y + win.height;
    const rows = 96;
    return (p, scene) => {
      const e = easeInOut(p);
      // How much of the window, from the bottom, has rolled onto the
      // cylinder whose axis sits at `axisY`.
      const rolled = e * win.height;
      const axisY = bottom - rolled;
      const place = (v: number, o: { y: number; z: number; shade: number }) => {
        const s = rolled - (1 - v) * win.height;
        if (s <= 0) return;
        // A spiral: what rolled up first is wound inside the rest.
        const radius = r * Math.max(0.3, 1 - (0.06 * s) / (2 * Math.PI * r));
        const phi = s / radius;
        o.y = axisY + radius * Math.sin(phi);
        o.z = radius * (1 - Math.cos(phi));
        o.shade = 0.55 + 0.45 * Math.cos(phi) ** 2;
      };
      // Strips back to front, so the roll's near side covers the rest.
      const probe = { y: 0, z: 0, shade: 1 };
      const order = Array.from({ length: rows }, (_, i) => {
        probe.z = 0;
        place((i + 0.5) / rows, probe);
        return { i, z: probe.z };
      }).sort((a, b) => a.z - b.z);
      for (const { i } of order) {
        grid(
          scene,
          setup,
          1,
          1,
          (_u, v, o) => {
            place(v, o);
            o.alpha = 1 - segment(p, 0.8, 1);
          },
          { u0: 0, u1: 1, v0: i / rows, v1: (i + 1) / rows },
        );
      }
    };
  },
};

const wave: WindowEffect = {
  id: 'wave',
  name: 'Wave',
  group: 'animation',
  duration: 450,
  create(setup) {
    const { win } = setup;
    const amp = Math.min(win.height * 0.2, 80);
    return (p, scene) => {
      const center = lerp(-0.25, 1.25, p);
      grid(scene, setup, 1, 64, (_u, v, o) => {
        const d = (v - center) / 0.18;
        const bump = Math.exp(-d * d);
        o.z = amp * bump;
        o.shade = 1 - 0.15 * bump;
        o.alpha = 1 - easeIn(p);
      });
    };
  },
};

const dream: WindowEffect = {
  id: 'dream',
  name: 'Dream',
  group: 'animation',
  duration: 700,
  create(setup) {
    const { win } = setup;
    const amp = win.width * 0.08;
    return (p, scene) => {
      const e = easeInOut(p);
      grid(scene, setup, 1, 64, (_u, v, o) => {
        o.x += amp * e * Math.sin(v * Math.PI * 5 + p * Math.PI * 6);
        o.alpha = 1 - e;
      });
    };
  },
};

export const ANIMATION_EFFECTS: WindowEffect[] = [
  magicLamp,
  magicLampWavy,
  zoom,
  sidekick,
  fade,
  glide1,
  glide2,
  curvedFold,
  horizontalFolds,
  rollUp,
  wave,
  dream,
];
