/**
 * Wobbly windows — a port of the spring model from Compiz's
 * `plugins/wobbly.c` (© 2005 Novell, Inc., author David Reveman; spring
 * model implemented by Kristian Høgsberg).
 *
 * The model is a GRID_WIDTH × GRID_HEIGHT lattice of point masses connected
 * by horizontal and vertical springs whose rest lengths match the window
 * geometry. While a window is grabbed, the control point nearest the pointer
 * is marked immobile and dragged directly; the rest of the lattice catches up
 * through the springs, which is what produces the jelly effect. On release
 * the anchor is freed and the model settles under spring force + friction.
 *
 * Constants, integration scheme (explicit Euler in fixed 15 ms substeps) and
 * settle thresholds are taken verbatim from Compiz so the effect feels the
 * same:
 *
 *   MASS = 15, friction = 3, spring_k = 8 (wobbly.xml defaults)
 *   spring force  = k * 0.5 * (displacement - rest offset)   (springExertForces)
 *   settle        = velocitySum <= 0.5 && forceSum <= 20     (modelStep)
 *
 * Compiz renders the deformation by tessellating the window into a mesh and
 * evaluating a bicubic Bézier patch over the 16 control points. The DOM can't
 * warp live content through an arbitrary patch, so we fit the closest 2D
 * projective transform (homography) mapping the window's layout rectangle
 * onto the quad formed by the four corner control points, and apply it with
 * CSS `matrix3d()`. Corner dynamics are exact (a Bézier patch interpolates
 * its corner control points); only edge curvature is approximated.
 */

/** Lattice size, from Compiz (`GRID_WIDTH` / `GRID_HEIGHT`). */
export const GRID_WIDTH = 4;
export const GRID_HEIGHT = 4;

/** Mass of each control point (Compiz `MASS`). */
const MASS = 15;
/** Compiz `friction` option default (wobbly.xml). */
const FRICTION = 3;
/** Compiz `spring_k` option default (wobbly.xml). */
const SPRING_K = 8;
/** Compiz integrates the model in fixed 15 ms substeps (`modelStep`). */
const SUBSTEP_MS = 15;

/* Wobbly state flags, mirroring WobblyInitial / WobblyForce / WobblyVelocity. */
export const WOBBLY_INITIAL = 1 << 0;
export const WOBBLY_FORCE = 1 << 1;
export const WOBBLY_VELOCITY = 1 << 2;
/** The model needs further integration while any of these bits are set. */
export const WOBBLY_ACTIVE = WOBBLY_INITIAL | WOBBLY_VELOCITY;

/** A point mass in the lattice (Compiz `Object`). */
export interface WobblyPoint {
  forceX: number;
  forceY: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  /** Immobile points ignore forces; the grab anchor is immobile. */
  immobile: boolean;
}

/** A spring between two lattice points with a rest offset (Compiz `Spring`). */
interface WobblySpring {
  a: WobblyPoint;
  b: WobblyPoint;
  offsetX: number;
  offsetY: number;
}

/** The spring lattice for one window (Compiz `Model`). */
export interface WobblyModel {
  objects: WobblyPoint[];
  springs: WobblySpring[];
  anchor: WobblyPoint | null;
  /** Fractional substep accumulator (Compiz `model->steps`). */
  steps: number;
}

/**
 * Create a model at rest covering the rectangle (x, y, width, height) in
 * workspace coordinates (Compiz `createModel` + `modelInitObjects` +
 * `modelInitSprings`, minus the middle anchor — grabbing sets the anchor).
 */
export function createModel(
  x: number,
  y: number,
  width: number,
  height: number,
): WobblyModel {
  const objects: WobblyPoint[] = [];
  const gw = GRID_WIDTH - 1;
  const gh = GRID_HEIGHT - 1;

  for (let gridY = 0; gridY < GRID_HEIGHT; gridY++) {
    for (let gridX = 0; gridX < GRID_WIDTH; gridX++) {
      objects.push({
        forceX: 0,
        forceY: 0,
        x: x + (gridX * width) / gw,
        y: y + (gridY * height) / gh,
        velocityX: 0,
        velocityY: 0,
        immobile: false,
      });
    }
  }

  // Springs connect each point to its west and north neighbors, with rest
  // offsets equal to the undeformed cell size.
  const springs: WobblySpring[] = [];
  const hpad = width / gw;
  const vpad = height / gh;

  for (let gridY = 0; gridY < GRID_HEIGHT; gridY++) {
    for (let gridX = 0; gridX < GRID_WIDTH; gridX++) {
      const i = gridY * GRID_WIDTH + gridX;
      if (gridX > 0) {
        springs.push({ a: objects[i - 1], b: objects[i], offsetX: hpad, offsetY: 0 });
      }
      if (gridY > 0) {
        springs.push({ a: objects[i - GRID_WIDTH], b: objects[i], offsetX: 0, offsetY: vpad });
      }
    }
  }

  return { objects, springs, anchor: null, steps: 0 };
}

/**
 * Grab the model at pointer position (x, y) in workspace coordinates: the
 * nearest control point becomes the immobile anchor (Compiz
 * `wobblyWindowGrabNotify` → `modelFindNearestObject`). Returns the anchor so
 * the caller can drive it during the drag.
 */
export function grabModel(model: WobblyModel, x: number, y: number): WobblyPoint {
  if (model.anchor) model.anchor.immobile = false;

  let nearest = model.objects[0];
  let minDistance = Infinity;
  for (const object of model.objects) {
    const dx = object.x - x;
    const dy = object.y - y;
    const distance = dx * dx + dy * dy;
    if (distance < minDistance) {
      minDistance = distance;
      nearest = object;
    }
  }

  nearest.immobile = true;
  model.anchor = nearest;
  return nearest;
}

/**
 * Reposition the lattice's mobile points to span the rectangle (x, y, width,
 * height), velocities zeroed; the immobile anchor is left where it is. The
 * springs keep their existing rest lengths, so a lattice spread over a
 * larger rect contracts toward the anchor like a released rubber sheet.
 *
 * This is the inverse of Compiz's wobbly "maximize effect"
 * (`wobblyWindowResizeNotify`), which re-inits the springs at the new
 * geometry while the points still sit at the old one and lets the model pull
 * itself into shape. Used for the tear-away drag: the model is created at
 * the restored geometry, grabbed at the pointer, then spread over the
 * maximized rect so the window shrinks into the cursor's hand.
 */
export function spreadModel(
  model: WobblyModel,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const gw = GRID_WIDTH - 1;
  const gh = GRID_HEIGHT - 1;
  for (let gridY = 0; gridY < GRID_HEIGHT; gridY++) {
    for (let gridX = 0; gridX < GRID_WIDTH; gridX++) {
      const object = model.objects[gridY * GRID_WIDTH + gridX];
      if (object.immobile) continue;
      object.x = x + (gridX * width) / gw;
      object.y = y + (gridY * height) / gh;
      object.velocityX = 0;
      object.velocityY = 0;
    }
  }
}

/**
 * Release the grab; the model then settles freely (Compiz
 * `wobblyWindowUngrabNotify`).
 */
export function ungrabModel(model: WobblyModel): void {
  if (model.anchor) model.anchor.immobile = false;
  model.anchor = null;
}

/**
 * Integrate the model forward by `timeMs` milliseconds and report wobbly
 * state flags; 0 means the model has settled (Compiz `modelStep` +
 * `springExertForces` + `modelStepObject`, without the optional screen-edge
 * snapping feature).
 */
export function stepModel(model: WobblyModel, timeMs: number): number {
  model.steps += timeMs / SUBSTEP_MS;
  const steps = Math.floor(model.steps);
  model.steps -= steps;

  // Not enough time accumulated for a substep; keep the animation alive
  // (Compiz returns TRUE, i.e. WobblyInitial, here).
  if (!steps) return WOBBLY_INITIAL;

  let velocitySum = 0;
  let forceSum = 0;

  for (let j = 0; j < steps; j++) {
    for (const spring of model.springs) {
      // F = k * 0.5 * (displacement from rest), applied equal-and-opposite.
      const dax = 0.5 * (spring.b.x - spring.a.x - spring.offsetX);
      const day = 0.5 * (spring.b.y - spring.a.y - spring.offsetY);
      spring.a.forceX += SPRING_K * dax;
      spring.a.forceY += SPRING_K * day;
      spring.b.forceX -= SPRING_K * dax;
      spring.b.forceY -= SPRING_K * day;
    }

    for (const object of model.objects) {
      if (object.immobile) {
        object.velocityX = 0;
        object.velocityY = 0;
        object.forceX = 0;
        object.forceY = 0;
        continue;
      }

      object.forceX -= FRICTION * object.velocityX;
      object.forceY -= FRICTION * object.velocityY;

      object.velocityX += object.forceX / MASS;
      object.velocityY += object.forceY / MASS;

      object.x += object.velocityX;
      object.y += object.velocityY;

      velocitySum += Math.abs(object.velocityX) + Math.abs(object.velocityY);
      forceSum += Math.abs(object.forceX) + Math.abs(object.forceY);

      object.forceX = 0;
      object.forceY = 0;
    }
  }

  let wobbly = 0;
  if (velocitySum > 0.5) wobbly |= WOBBLY_VELOCITY;
  if (forceSum > 20) wobbly |= WOBBLY_FORCE;
  return wobbly;
}

/**
 * Top-left corner of the model's bounding box in workspace coordinates
 * (Compiz `modelCalcBounds`). When the wobble finishes, Compiz moves the
 * window here (`wobblyPreparePaintScreen`).
 */
export function modelTopLeft(model: WobblyModel): { x: number; y: number } {
  let x = Infinity;
  let y = Infinity;
  for (const object of model.objects) {
    if (object.x < x) x = object.x;
    if (object.y < y) y = object.y;
  }
  return { x, y };
}

/* -------------------------------------------------------------------------
 * Rendering: fit a projective transform (homography) mapping the window's
 * layout rectangle to the deformed corner quad, expressed as CSS matrix3d().
 * Math follows the standard adjugate construction for the 2D projective map
 * through four point correspondences.
 * ---------------------------------------------------------------------- */

/** Row-major 3×3 matrix. */
type Mat3 = [number, number, number, number, number, number, number, number, number];

function adjugate(m: Mat3): Mat3 {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}

function multiply(a: Mat3, b: Mat3): Mat3 {
  const result = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      result[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  return result as Mat3;
}

/**
 * Projective basis through four points: maps the projective basis vectors to
 * p1..p3 with p4 as the unit point.
 */
function basisToPoints(
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  x4: number, y4: number,
): Mat3 {
  const m: Mat3 = [x1, x2, x3, y1, y2, y3, 1, 1, 1];
  const a = adjugate(m);
  const v = [
    a[0] * x4 + a[1] * y4 + a[2],
    a[3] * x4 + a[4] * y4 + a[5],
    a[6] * x4 + a[7] * y4 + a[8],
  ];
  return multiply(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}

/** A 2D point used as a quad corner. */
export interface QuadPoint {
  x: number;
  y: number;
}

/** The projective map from the (0,0)-(width,height) box onto the quad. */
function homography(
  width: number,
  height: number,
  tl: QuadPoint,
  tr: QuadPoint,
  bl: QuadPoint,
  br: QuadPoint,
): Mat3 {
  const source = basisToPoints(0, 0, width, 0, 0, height, width, height);
  const destination = basisToPoints(tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y);
  return multiply(destination, adjugate(source));
}

/**
 * CSS transform warping an element's untransformed (0,0)-(width,height) box
 * onto the quad given by four corner positions, all relative to the
 * element's layout position. Apply with `transform-origin: 0 0`. Shared by
 * the wobbly deformation and the genie minimize effect (src/lib/genie.ts).
 */
export function quadTransform(
  width: number,
  height: number,
  tl: QuadPoint,
  tr: QuadPoint,
  bl: QuadPoint,
  br: QuadPoint,
): string {
  const h = homography(width, height, tl, tr, bl, br);

  // Degenerate quads (never expected from sane inputs) fall back to a plain
  // translation so the element at least stays visible.
  if (!h.every(Number.isFinite) || Math.abs(h[8]) < 1e-6) {
    return `translate3d(${tl.x}px, ${tl.y}px, 0)`;
  }

  const m = h.map((value) => value / h[8]);
  return `matrix3d(${m[0]}, ${m[3]}, 0, ${m[6]}, ${m[1]}, ${m[4]}, 0, ${m[7]}, 0, 0, 1, 0, ${m[2]}, ${m[5]}, 0, 1)`;
}

/*
 * Limits on the painted quad. The lattice itself may fold (a fast flick can
 * carry the top edge past the bottom one), but a homography onto a folded
 * quad passes through infinity, and one onto a nearly-degenerate quad
 * magnifies one corner enormously: either way the window blows up across
 * the screen. Ordinary wobbles stay far inside both limits.
 */
/** Smallest sine allowed for any corner angle. */
const MIN_CORNER_SIN = 0.2;
/** Largest ratio between the projective weights at two corners. */
const MAX_PERSPECTIVE = 3;

/**
 * Whether the quad tl→tr→br→bl is convex, clockwise, no corner is too flat,
 * and the map onto it from the width × height box isn't too steep.
 */
function quadIsSafe(width: number, height: number, quad: QuadPoint[]): boolean {
  const h = homography(width, height, quad[0], quad[1], quad[3], quad[2]);
  const weights = [
    h[8],
    h[6] * width + h[8],
    h[7] * height + h[8],
    h[6] * width + h[7] * height + h[8],
  ];
  const minWeight = Math.min(...weights.map(Math.abs));
  const maxWeight = Math.max(...weights.map(Math.abs));
  if (!(minWeight > 0) || maxWeight > MAX_PERSPECTIVE * minWeight) return false;
  if (!weights.every((w) => Math.sign(w) === Math.sign(h[8]))) return false;

  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    const r = quad[(i + 2) % 4];
    const ax = q.x - p.x;
    const ay = q.y - p.y;
    const bx = r.x - q.x;
    const by = r.y - q.y;
    const cross = ax * by - ay * bx;
    if (!(cross >= MIN_CORNER_SIN * Math.hypot(ax, ay) * Math.hypot(bx, by))) return false;
  }
  return true;
}

/**
 * CSS transform warping the window from its layout rectangle (x, y, width,
 * height in workspace coordinates) onto the model's current corner quad.
 * Apply with `transform-origin: 0 0`.
 *
 * When the corners fold over or flatten (see quadIsSafe), the painted
 * quad is eased toward the undeformed rectangle at the corners' centroid,
 * just far enough to be safe. The model itself is untouched, so the wobble
 * carries on and unfolds naturally.
 */
export function modelTransform(
  model: WobblyModel,
  x: number,
  y: number,
  width: number,
  height: number,
): string {
  const o = model.objects;
  // Clockwise order: tl, tr, br, bl.
  const deformed = [
    o[0],
    o[GRID_WIDTH - 1],
    o[GRID_WIDTH * GRID_HEIGHT - 1],
    o[GRID_WIDTH * (GRID_HEIGHT - 1)],
  ].map((p) => ({ x: p.x - x, y: p.y - y }));

  let quad = deformed;
  if (!quadIsSafe(width, height, quad)) {
    const cx = (deformed[0].x + deformed[1].x + deformed[2].x + deformed[3].x) / 4;
    const cy = (deformed[0].y + deformed[1].y + deformed[2].y + deformed[3].y) / 4;
    const left = cx - width / 2;
    const top = cy - height / 2;
    const rigid = [
      { x: left, y: top },
      { x: left + width, y: top },
      { x: left + width, y: top + height },
      { x: left, y: top + height },
    ];
    const blend = (t: number) =>
      rigid.map((r, i) => ({
        x: r.x + t * (deformed[i].x - r.x),
        y: r.y + t * (deformed[i].y - r.y),
      }));
    // Binary-search the largest share of the deformation that stays safe.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (quadIsSafe(width, height, blend(mid))) lo = mid;
      else hi = mid;
    }
    quad = blend(lo);
  }

  return quadTransform(width, height, quad[0], quad[1], quad[3], quad[2]);
}
