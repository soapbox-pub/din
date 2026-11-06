/**
 * The window effects engine: Din's take on the core of Compiz's animation
 * plugin. An effect deforms, tears up or burns a *bitmap snapshot* of a
 * window, drawn in WebGL on a canvas covering the workspace for the length
 * of the animation, stacked at the window's z-index. The DOM can't push live
 * content (a <webview>, xterm, ...) through a mesh, but a snapshot is just a
 * texture, which is all Compiz ever drew either.
 *
 * An effect (src/lib/effects/*.ts) is a pure function of progress: given
 * `p` from 0 (the window at rest) to 1 (gone), it writes the frame into a
 * `Scene` - textured triangles in workspace pixels with depth, and soft
 * particles (fire, smoke, light) - and may shade the window's pixels with a
 * fragment snippet (the burn front). Being pure, every effect plays backwards
 * for free: restore runs the minimize effect from 1 down to 0, as Compiz does
 * for unminimize.
 *
 * Depth is projected like Compiz's screen: a 60° vertical field of view whose
 * z = 0 plane maps 1:1 onto the workspace, so anything not lifted off the
 * screen draws exactly where it lies. There's no depth buffer; effects that
 * overlap themselves sort their pieces back to front.
 *
 * The texture never gets mipmaps: generateMipmap fails on some drivers
 * (ANGLE's GL backend on amdgpu, see Terminal.tsx), and LINEAR filtering is
 * complete without them. A one-pixel transparent border around the snapshot
 * gives mesh edges that reach it (`EffectSetup.pad`) a smooth falloff
 * instead of a hard, aliased edge.
 */

import type { GenieRect, GenieTarget } from '@/lib/genie';

/** Floats per mesh vertex: x, y, z, u, v, alpha, shade. */
const MESH_STRIDE = 7;
/** Floats per particle vertex: x, y, corner x, corner y, r, g, b, a, additive. */
const PARTICLE_STRIDE = 9;

/** Frames the final frame stays up after the timeline ends. */
const HOLD_FRAMES = 3;

/** What an effect knows about the window it animates. */
export interface EffectSetup {
  /** The window, in workspace coordinates. */
  win: GenieRect;
  /** Where the window goes: its dock tile when minimizing, null when closing. */
  target: GenieTarget | null;
  /** The workspace size. */
  view: { width: number; height: number };
  /**
   * How far the viewer is from the screen, in pixels: something moved this
   * far toward the viewer reaches their eye, and half as far looks twice
   * the size.
   */
  eye: number;
  /**
   * One snapshot pixel, as a fraction of the window's width and height: a
   * mesh whose edges reach `-pad` and `1 + pad` gets antialiased sides from
   * the transparent border.
   */
  pad: { x: number; y: number };
  /** Seeded for this run, so a frame is the same whichever way it plays. */
  random: () => number;
}

/** Draws one frame: `p` runs from 0 (at rest) to 1 (gone). */
export type EffectPainter = (p: number, scene: Scene) => void;

export interface WindowEffect {
  id: string;
  name: string;
  /** Which Compiz plugin it comes from, to group the choices in Settings. */
  group: EffectGroup;
  /** Timeline length in milliseconds. */
  duration: number;
  /** Needs the dock tile, so it's only offered for minimizing. */
  minimizeOnly?: boolean;
  /**
   * GLSL run per window pixel before tinting. It may change `color` (a
   * premultiplied vec4) or `discard`; in scope are `pos` (the pixel in
   * window pixels from its top-left), `v_local` (the same, 0 to 1),
   * `u_size` (the window in pixels), `u_p` (progress), `u_seed`, the
   * `hash`/`noise`/`fbm` helpers and any `uniforms` the effect declares.
   */
  fragment?: string;
  /** Extra float uniforms `fragment` reads, set each frame with `scene.set`. */
  uniforms?: string[];
  create(setup: EffectSetup): EffectPainter;
}

export type EffectGroup = 'animation' | 'animationaddon' | 'animationplus' | 'animationsim';

/** One frame's geometry, refilled every frame. */
export class Scene {
  mesh = new Float32Array(MESH_STRIDE * 6 * 256);
  meshLength = 0;
  particles = new Float32Array(PARTICLE_STRIDE * 6 * 256);
  particleLength = 0;
  values = new Map<string, number>();

  reset(): void {
    this.meshLength = 0;
    this.particleLength = 0;
  }

  /**
   * Add a mesh vertex (three make a triangle): workspace pixels, `z` toward
   * the viewer; `u`, `v` the point of the window it shows, 0 to 1; `alpha`
   * its opacity and `shade` a darkening factor (1 = unlit).
   */
  vertex(x: number, y: number, z: number, u: number, v: number, alpha: number, shade: number): void {
    if (this.meshLength + MESH_STRIDE > this.mesh.length) this.mesh = grow(this.mesh);
    const m = this.mesh;
    let i = this.meshLength;
    m[i++] = x;
    m[i++] = y;
    m[i++] = z;
    m[i++] = u;
    m[i++] = v;
    m[i++] = alpha;
    m[i++] = shade;
    this.meshLength = i;
  }

  /**
   * Add a soft round particle centered at (`x`, `y`), `w` by `h` pixels,
   * colored `r`, `g`, `b` (0 to 1) at opacity `a`. Additive particles glow
   * (fire, light); the rest are painted over what's behind them (smoke).
   */
  particle(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number, additive: boolean): void {
    if (a <= 0.002 || w <= 0 || h <= 0) return;
    if (this.particleLength + PARTICLE_STRIDE * 6 > this.particles.length) this.particles = grow(this.particles);
    const hw = w / 2;
    const hh = h / 2;
    const add = additive ? 1 : 0;
    const corner = (cx: number, cy: number) => {
      const q = this.particles;
      let i = this.particleLength;
      q[i++] = x + cx * hw;
      q[i++] = y + cy * hh;
      q[i++] = cx;
      q[i++] = cy;
      q[i++] = r;
      q[i++] = g;
      q[i++] = b;
      q[i++] = a;
      q[i++] = add;
      this.particleLength = i;
    };
    corner(-1, -1);
    corner(1, -1);
    corner(-1, 1);
    corner(-1, 1);
    corner(1, -1);
    corner(1, 1);
  }

  /** Set one of the effect's own fragment uniforms for this frame. */
  set(name: string, value: number): void {
    this.values.set(name, value);
  }
}

function grow(a: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const b = new Float32Array(a.length * 2);
  b.set(a);
  return b;
}

/** A small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MESH_VERTEX = `
attribute vec3 a_pos;
attribute vec2 a_local;
attribute vec2 a_tint;
uniform vec2 u_view;
uniform float u_eye;
uniform vec2 u_tex_size;
varying vec2 v_uv;
varying vec2 v_local;
varying vec2 v_tint;
void main() {
  vec2 c = a_pos.xy - u_view * 0.5;
  float w = max(u_eye - a_pos.z, u_eye * 0.05);
  gl_Position = vec4(c.x / (u_view.x * 0.5) * u_eye, -c.y / (u_view.y * 0.5) * u_eye, 0.0, w);
  v_local = a_local;
  v_uv = (1.0 + a_local * u_tex_size) / (u_tex_size + 2.0);
  v_tint = a_tint;
}`;

const FRAGMENT_HEADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const NOISE = `
float hash(vec2 q) {
  q = fract(q * vec2(123.34, 456.21) + u_seed);
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
float noise(vec2 q) {
  vec2 i = floor(q);
  vec2 f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 q) {
  return noise(q) * 0.5 + noise(q * 2.03 + 17.0) * 0.3 + noise(q * 4.01 + 41.0) * 0.2;
}`;

function meshFragment(effect: WindowEffect): string {
  const uniforms = (effect.uniforms ?? []).map((u) => `uniform float ${u};`).join('\n');
  return `${FRAGMENT_HEADER}
uniform sampler2D u_tex;
uniform float u_p;
uniform vec2 u_size;
uniform float u_seed;
${uniforms}
varying vec2 v_uv;
varying vec2 v_local;
varying vec2 v_tint;
${NOISE}
void main() {
  vec4 color = texture2D(u_tex, v_uv);
  vec2 pos = v_local * u_size;
  ${effect.fragment ?? ''}
  gl_FragColor = vec4(color.rgb * v_tint.y, color.a) * v_tint.x;
}`;
}

const PARTICLE_VERTEX = `
attribute vec2 a_pos;
attribute vec2 a_corner;
attribute vec4 a_color;
attribute float a_add;
uniform vec2 u_view;
varying vec2 v_corner;
varying vec4 v_color;
varying float v_add;
void main() {
  vec2 clip = a_pos / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_corner = a_corner;
  v_color = a_color;
  v_add = a_add;
}`;

// Premultiplied output, so an alpha of 0 under (ONE, ONE_MINUS_SRC_ALPHA)
// blending adds the color: additive and painted particles share one pass.
const PARTICLE_FRAGMENT = `${FRAGMENT_HEADER}
varying vec2 v_corner;
varying vec4 v_color;
varying float v_add;
void main() {
  float f = max(0.0, 1.0 - dot(v_corner, v_corner));
  f *= f;
  float a = v_color.a * f;
  gl_FragColor = vec4(v_color.rgb * a, a * (1.0 - v_add));
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function link(gl: WebGLRenderingContext, vertex: string, fragment: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/** How an effect plays: out (minimize, close) or back in (restore). */
export type EffectDirection = 'out' | 'in';

/** An effect bound to a canvas and a snapshot, ready to draw any frame. */
export interface EffectRenderer {
  /** Paint the frame at progress `p`, 0 (at rest) to 1 (gone). */
  draw(p: number): void;
  /** Free the WebGL context. */
  release(): void;
}

/**
 * Set up `effect` to draw on `canvas` from `image`, a snapshot of the window
 * (decoded, if an image). The canvas shows a `view.width` × `view.height`
 * workspace at `scale` device pixels per pixel; `win` and `target` are in
 * that workspace's coordinates. Null when WebGL can't be used.
 */
export function createEffectRenderer(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement | HTMLCanvasElement,
  effect: WindowEffect,
  view: { width: number; height: number },
  scale: number,
  win: GenieRect,
  target: GenieTarget | null,
  seed: number,
): EffectRenderer | null {
  const { width: viewW, height: viewH } = view;
  const texW = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const texH = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  if (!viewW || !viewH || !texW || !texH || !win.width || !win.height) return null;

  canvas.width = Math.round(viewW * scale);
  canvas.height = Math.round(viewH * scale);

  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const release = () => gl.getExtension('WEBGL_lose_context')?.loseContext();

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const meshProgram = link(gl, MESH_VERTEX, meshFragment(effect));
  const particleProgram = link(gl, PARTICLE_VERTEX, PARTICLE_FRAGMENT);
  if (texW + 2 > maxTex || texH + 2 > maxTex || !meshProgram || !particleProgram) {
    release();
    return null;
  }

  // The snapshot inside a one-pixel transparent border.
  const padded = document.createElement('canvas');
  padded.width = texW + 2;
  padded.height = texH + 2;
  const ctx = padded.getContext('2d');
  if (!ctx) {
    release();
    return null;
  }
  ctx.drawImage(image, 1, 1);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, padded);

  // Compiz's projection: fovy 60°, the z = 0 plane at screen size.
  const eye = viewH / 2 / Math.tan(Math.PI / 6);

  const meshBuffer = gl.createBuffer();
  const particleBuffer = gl.createBuffer();
  const meshAttr = {
    pos: gl.getAttribLocation(meshProgram, 'a_pos'),
    local: gl.getAttribLocation(meshProgram, 'a_local'),
    tint: gl.getAttribLocation(meshProgram, 'a_tint'),
  };
  const particleAttr = {
    pos: gl.getAttribLocation(particleProgram, 'a_pos'),
    corner: gl.getAttribLocation(particleProgram, 'a_corner'),
    color: gl.getAttribLocation(particleProgram, 'a_color'),
    add: gl.getAttribLocation(particleProgram, 'a_add'),
  };
  const extraUniforms = new Map(
    (effect.uniforms ?? []).map((name) => [name, gl.getUniformLocation(meshProgram, name)] as const),
  );

  gl.useProgram(meshProgram);
  gl.uniform2f(gl.getUniformLocation(meshProgram, 'u_view'), viewW, viewH);
  gl.uniform1f(gl.getUniformLocation(meshProgram, 'u_eye'), eye);
  gl.uniform2f(gl.getUniformLocation(meshProgram, 'u_tex_size'), texW, texH);
  gl.uniform2f(gl.getUniformLocation(meshProgram, 'u_size'), win.width, win.height);
  gl.uniform1f(gl.getUniformLocation(meshProgram, 'u_seed'), (seed % 1000) / 1000);
  const uP = gl.getUniformLocation(meshProgram, 'u_p');
  gl.useProgram(particleProgram);
  gl.uniform2f(gl.getUniformLocation(particleProgram, 'u_view'), viewW, viewH);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const paint = effect.create({
    win,
    target,
    view: { width: viewW, height: viewH },
    eye,
    pad: { x: 1 / texW, y: 1 / texH },
    random: seededRandom(seed),
  });
  const scene = new Scene();

  const draw = (p: number) => {
    scene.reset();
    paint(p, scene);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (scene.meshLength) {
      gl.useProgram(meshProgram);
      gl.uniform1f(uP, p);
      for (const [name, loc] of extraUniforms) gl.uniform1f(loc, scene.values.get(name) ?? 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.mesh.subarray(0, scene.meshLength), gl.STREAM_DRAW);
      const s = MESH_STRIDE * 4;
      gl.enableVertexAttribArray(meshAttr.pos);
      gl.vertexAttribPointer(meshAttr.pos, 3, gl.FLOAT, false, s, 0);
      gl.enableVertexAttribArray(meshAttr.local);
      gl.vertexAttribPointer(meshAttr.local, 2, gl.FLOAT, false, s, 12);
      gl.enableVertexAttribArray(meshAttr.tint);
      gl.vertexAttribPointer(meshAttr.tint, 2, gl.FLOAT, false, s, 20);
      gl.drawArrays(gl.TRIANGLES, 0, scene.meshLength / MESH_STRIDE);
      gl.disableVertexAttribArray(meshAttr.pos);
      gl.disableVertexAttribArray(meshAttr.local);
      gl.disableVertexAttribArray(meshAttr.tint);
    }

    if (scene.particleLength) {
      gl.useProgram(particleProgram);
      gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.particles.subarray(0, scene.particleLength), gl.STREAM_DRAW);
      const s = PARTICLE_STRIDE * 4;
      gl.enableVertexAttribArray(particleAttr.pos);
      gl.vertexAttribPointer(particleAttr.pos, 2, gl.FLOAT, false, s, 0);
      gl.enableVertexAttribArray(particleAttr.corner);
      gl.vertexAttribPointer(particleAttr.corner, 2, gl.FLOAT, false, s, 8);
      gl.enableVertexAttribArray(particleAttr.color);
      gl.vertexAttribPointer(particleAttr.color, 4, gl.FLOAT, false, s, 16);
      gl.enableVertexAttribArray(particleAttr.add);
      gl.vertexAttribPointer(particleAttr.add, 1, gl.FLOAT, false, s, 32);
      gl.drawArrays(gl.TRIANGLES, 0, scene.particleLength / PARTICLE_STRIDE);
      gl.disableVertexAttribArray(particleAttr.pos);
      gl.disableVertexAttribArray(particleAttr.corner);
      gl.disableVertexAttribArray(particleAttr.color);
      gl.disableVertexAttribArray(particleAttr.add);
    }
  };

  return { draw, release };
}

/**
 * Play `effect` on a snapshot of the window. `image` must already be
 * decoded; `win` and `target` are in workspace coordinates (`parent`'s).
 * The first frame is painted synchronously, `onDone` fires once when the
 * timeline completes (never on cancel), and the returned function cancels.
 * Returns null, having drawn nothing, when WebGL can't be used - the caller
 * falls back. A window reaching above `parent` (a maximized window's strip
 * behind the menu bar) gets a canvas reaching up as far.
 */
export function runWindowEffect(
  parent: HTMLElement,
  image: HTMLImageElement | HTMLCanvasElement,
  effect: WindowEffect,
  win: GenieRect,
  target: GenieTarget | null,
  direction: EffectDirection,
  zIndex: number,
  seed: number,
  onDone: () => void,
): (() => void) | null {
  const above = Math.max(0, Math.ceil(-win.y));
  const viewW = parent.clientWidth;
  const viewH = parent.clientHeight + above;

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = `${-above}px`;
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = String(zIndex);
  // Waited for, or hidden, by a screenshot (captureDesktop).
  canvas.dataset.windowEffect = '';

  const view = { width: viewW, height: viewH };
  const shifted = above ? { ...win, y: win.y + above } : win;
  const aim = above && target ? { ...target, y: target.y + above } : target;
  const renderer = createEffectRenderer(canvas, image, effect, view, window.devicePixelRatio || 1, shifted, aim, seed);
  if (!renderer) return null;
  const { draw, release } = renderer;

  parent.appendChild(canvas);
  let raf = 0;
  const teardown = () => {
    cancelAnimationFrame(raf);
    canvas.remove();
    release();
  };
  // The final frame outlives the timeline by a few frames. After a restore
  // it is the whole window, covering the live one while Chromium rasterizes
  // it again: a window hidden for a while comes back as blank tiles for a
  // frame. (After a minimize or close it's gone, so holding it is invisible.)
  let hold = HOLD_FRAMES;
  const holdFrame = () => {
    if (--hold > 0) raf = requestAnimationFrame(holdFrame);
    else teardown();
  };
  const start = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / effect.duration);
    draw(direction === 'out' ? t : 1 - t);
    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      onDone();
      raf = requestAnimationFrame(holdFrame);
    }
  };
  frame(start);
  return teardown;
}
