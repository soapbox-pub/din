/**
 * The camera's picture with an effect on it, drawn by one WebGL2 shader: the
 * live view, a photo, or the effects grid (nine cells, each its own effect)
 * in a single pass. The canvas is the camera's own size, so what's taken is
 * what's shown, at full resolution. Without WebGL 2 (no GPU, a broken
 * driver) it draws the plain picture with a 2D canvas, and has no effects.
 */

const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform int u_grid;
uniform int u_effects[9];
uniform int u_effect;
uniform float u_mirror;
uniform vec2 u_center;
uniform float u_aspect;
uniform vec2 u_res;
uniform float u_time;

const float PI = 3.14159265;

vec3 cam(vec2 p) {
  p = clamp(p, 0.0, 1.0);
  if (u_mirror > 0.5) p.x = 1.0 - p.x;
  return texture(u_tex, p).rgb;
}

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

vec3 hue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}

/** One pixel of the cell being drawn, in its 0..1 coordinates. */
vec2 px() {
  float cells = u_grid == 1 ? 3.0 : 1.0;
  return vec2(cells / u_res.x, cells / u_res.y);
}

float edge(vec2 p) {
  vec2 d = px() * 1.5;
  float tl = luma(cam(p + d * vec2(-1.0, -1.0)));
  float t = luma(cam(p + d * vec2(0.0, -1.0)));
  float tr = luma(cam(p + d * vec2(1.0, -1.0)));
  float l = luma(cam(p + d * vec2(-1.0, 0.0)));
  float r = luma(cam(p + d * vec2(1.0, 0.0)));
  float bl = luma(cam(p + d * vec2(-1.0, 1.0)));
  float b = luma(cam(p + d * vec2(0.0, 1.0)));
  float br = luma(cam(p + d * vec2(1.0, 1.0)));
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
  return length(vec2(gx, gy));
}

vec3 blur(vec2 p, float radius) {
  vec2 d = px() * radius;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * PI / 6.0;
    sum += cam(p + d * vec2(cos(a), sin(a)));
  }
  return sum / 12.0;
}

vec3 thermal(float t) {
  vec3 a = vec3(0.05, 0.0, 0.35), b = vec3(0.55, 0.0, 0.75), c = vec3(1.0, 0.1, 0.1), d = vec3(1.0, 0.85, 0.0), e = vec3(1.0);
  if (t < 0.25) return mix(a, b, t / 0.25);
  if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c, d, (t - 0.5) / 0.25);
  return mix(d, e, (t - 0.75) / 0.25);
}

/** Bend the picture: where in the camera's picture this point comes from. */
vec2 warp(int e, vec2 p, out bool outside) {
  outside = false;
  vec2 k = vec2(u_aspect, 1.0);
  vec2 c = u_center;
  vec2 q = (p - c) * k;
  float r = length(q);
  if (e == 10) { // bulge
    float R = 0.45;
    if (r < R) q *= mix(0.35, 1.0, smoothstep(0.0, 1.0, r / R));
  } else if (e == 11) { // pinch
    float R = 0.45;
    if (r < R) q *= mix(1.9, 1.0, smoothstep(0.0, 1.0, r / R));
  } else if (e == 12) { // twirl
    float R = 0.5;
    float a = pow(max(0.0, 1.0 - r / R), 2.0) * 4.0;
    q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
  } else if (e == 13) { // squeeze
    q.x *= 1.0 + 1.1 * exp(-q.x * q.x * 14.0);
  } else if (e == 14) { // mirror
    if (q.x > 0.0) q.x = -q.x;
  } else if (e == 15) { // light tunnel
    float R = 0.28;
    if (r > R) q = q / r * R;
  } else if (e == 16) { // fish eye
    float R = 0.5;
    if (r > R) outside = true;
    // The middle magnified nearly twice, the rim taking in more than is there.
    else q *= 0.55 + 0.8 * (r / R) * (r / R);
  } else if (e == 17) { // stretch
    q.y *= 1.0 - 0.55 * exp(-q.y * q.y * 10.0);
  } else if (e == 20) { // kaleidoscope
    float seg = PI / 3.0;
    float a = mod(atan(q.y, q.x), 2.0 * seg);
    // The wedge it repeats points up and aside from the middle, at an eye.
    a = abs(a - seg) - 0.75 * PI - seg / 2.0;
    q = r * vec2(cos(a), sin(a)) * 0.8;
  } else if (e == 21) { // pixels
    vec2 n = vec2(48.0 * u_aspect, 48.0);
    return (floor(p * n) + 0.5) / n;
  } else if (e == 25) { // ripple
    if (r > 0.0) q += q / r * sin(r * 60.0 - u_time * 5.0) * 0.008;
  } else {
    return p;
  }
  return c + q / k;
}

vec3 shade(int e, vec2 p, vec2 quad) {
  vec3 c = cam(p);
  float y = luma(c);
  if (e == 1) { // sepia
    return clamp(vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131))), 0.0, 1.0);
  } else if (e == 2) { // black & white
    return vec3(smoothstep(0.03, 0.97, y));
  } else if (e == 3) { // glow
    vec3 b = blur(p, 6.0);
    return clamp(c * 0.55 + b * 0.55 + b * b * 0.35, 0.0, 1.0);
  } else if (e == 4) { // comic
    vec3 s = mix(vec3(y), c, 1.6);
    s = floor(clamp(s, 0.0, 1.0) * 4.0 + 0.5) / 4.0;
    return s * (1.0 - smoothstep(0.3, 0.6, edge(p)));
  } else if (e == 5) { // vintage
    vec3 v = c * vec3(1.05, 0.95, 0.78) * 0.85 + vec3(0.1, 0.07, 0.03);
    vec2 d = (p - 0.5) * vec2(u_aspect, 1.0);
    return v * (1.0 - dot(d, d) * 0.9);
  } else if (e == 6) { // thermal
    return thermal(y);
  } else if (e == 7) { // x-ray
    float v = pow(1.0 - y, 1.3);
    return vec3(v * 0.72, v * 0.88, v * 1.05);
  } else if (e == 8) { // pop art
    float v = floor(smoothstep(0.1, 0.9, y) * 3.0 + 0.5) / 3.0;
    int i = int(quad.y * 2.0 + quad.x);
    vec3 ink = i == 0 ? vec3(0.95, 0.2, 0.55) : i == 1 ? vec3(0.1, 0.65, 0.95) : i == 2 ? vec3(1.0, 0.85, 0.1) : vec3(0.35, 0.85, 0.3);
    vec3 paper = i == 0 ? vec3(1.0, 0.92, 0.3) : i == 1 ? vec3(1.0, 0.45, 0.2) : i == 2 ? vec3(0.55, 0.25, 0.85) : vec3(0.95, 0.3, 0.3);
    return mix(ink * 0.25, mix(ink, paper, v), step(0.01, v));
  } else if (e == 22) { // neon
    float g = smoothstep(0.08, 0.5, edge(p));
    return hue(p.y * 0.8 + u_time * 0.1) * g * 1.4;
  } else if (e == 23) { // duotone
    return mix(vec3(0.12, 0.08, 0.4), vec3(1.0, 0.55, 0.45), smoothstep(0.05, 0.95, y));
  } else if (e == 24) { // halftone
    vec2 n = vec2(70.0 * u_aspect, 70.0);
    vec2 g = p * n;
    vec2 cell = floor(g) + 0.5;
    vec3 cc = cam(cell / n);
    float radius = sqrt(1.0 - luma(cc)) * 0.62;
    float dot_ = 1.0 - smoothstep(radius - 0.08, radius + 0.08, length(g - cell));
    return mix(vec3(0.98, 0.96, 0.9), mix(vec3(luma(cc)), cc, 1.5) * 0.85, dot_);
  } else if (e == 26) { // sketch
    float g = edge(p);
    float shade_ = smoothstep(0.15, 0.7, y);
    float lines = 1.0 - smoothstep(0.05, 0.45, g);
    return vec3(0.97, 0.95, 0.9) * mix(0.55 + 0.45 * shade_, 1.0, 0.4) * lines;
  } else if (e == 27) { // psychedelic
    return mix(c, hue(y * 1.6 + u_time * 0.15), 0.75);
  }
  return c;
}

void main() {
  vec2 p = v_uv;
  int e = u_effect;
  if (u_grid == 1) {
    vec2 g = p * 3.0;
    vec2 cell = floor(g);
    vec2 gap = vec2(6.0 * 3.0 / u_res.x, 6.0 * 3.0 / u_res.y);
    p = fract(g);
    if (p.x < gap.x || p.x > 1.0 - gap.x || p.y < gap.y || p.y > 1.0 - gap.y) {
      outColor = vec4(0.04, 0.04, 0.05, 1.0);
      return;
    }
    p = (p - gap) / (1.0 - 2.0 * gap);
    e = u_effects[int(cell.y) * 3 + int(cell.x)];
  }
  vec2 quad = vec2(0.0);
  if (e == 8) {
    quad = floor(p * 2.0);
    p = fract(p * 2.0);
  }
  bool outside;
  p = warp(e, p, outside);
  if (outside) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = vec4(shade(e, p, quad), 1.0);
}`;

export interface DrawOptions {
  /** The effect's shader number, or for the grid, nine of them. */
  effect: number;
  grid: readonly number[] | null;
  mirror: boolean;
  /** Where bending effects center, 0..1 across and down the picture. */
  center: { x: number; y: number };
}

type Source = TexImageSource & { videoWidth?: number; videoHeight?: number; width?: number; height?: number };

/** Draws the camera's picture into a canvas. */
export interface Renderer {
  readonly canvas: HTMLCanvasElement;
  /** Whether it draws effects (and the grid), or only the plain picture. */
  readonly effects: boolean;
  /** Draw a frame of `source` (a playing video, or a still); false if it has no size yet. */
  draw(source: Source, options: DrawOptions): boolean;
  dispose(): void;
}

const GL_OPTIONS: WebGLContextAttributes = { preserveDrawingBuffer: true, antialias: false, alpha: false };

let glWorks: boolean | null = null;

/** Whether the shader runs here: tried once, on a canvas of its own (a canvas keeps its first context). */
function canUseGl(): boolean {
  if (glWorks === null) {
    const gl = document.createElement('canvas').getContext('webgl2', GL_OPTIONS);
    try {
      if (!gl) throw new Error('WebGL 2 isn’t available');
      new GlRenderer(gl.canvas as HTMLCanvasElement, gl).dispose();
      glWorks = true;
    } catch (e) {
      console.error('camera: effects are off:', e);
      glWorks = false;
    }
  }
  return glWorks;
}

/** The best renderer the canvas can have. */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canUseGl() ? canvas.getContext('webgl2', GL_OPTIONS) : null;
  return gl ? new GlRenderer(canvas, gl) : new PlainRenderer(canvas);
}

function sizeOf(source: Source): [number, number] {
  return [source.videoWidth ?? (source.width as number) ?? 0, source.videoHeight ?? (source.height as number) ?? 0];
}

class PlainRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly effects = false;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This computer can’t draw the camera’s picture');
    this.ctx = ctx;
  }

  draw(source: Source, options: DrawOptions): boolean {
    const [width, height] = sizeOf(source);
    if (!width || !height) return false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const ctx = this.ctx;
    ctx.save();
    if (options.mirror) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    ctx.restore();
    return true;
  }

  dispose(): void {}
}

class GlRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly effects = true;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private texture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private start = performance.now();

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.program = link(gl, VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(this.program, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // No mipmaps: they fail on some drivers, and the picture is drawn at its own size.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (const name of ['u_tex', 'u_grid', 'u_effects', 'u_effect', 'u_mirror', 'u_center', 'u_aspect', 'u_res', 'u_time']) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    gl.uniform1i(this.uniforms.u_tex!, 0);
  }

  draw(source: Source, options: DrawOptions): boolean {
    const [width, height] = sizeOf(source);
    if (!width || !height) return false;
    const { gl, canvas, uniforms: u } = this;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform1i(u.u_grid!, options.grid ? 1 : 0);
    gl.uniform1iv(u.u_effects!, Int32Array.from(options.grid ?? new Array<number>(9).fill(0)));
    gl.uniform1i(u.u_effect!, options.effect);
    gl.uniform1f(u.u_mirror!, options.mirror ? 1 : 0);
    gl.uniform2f(u.u_center!, options.center.x, options.center.y);
    gl.uniform1f(u.u_aspect!, width / height);
    gl.uniform2f(u.u_res!, width, height);
    gl.uniform1f(u.u_time!, (performance.now() - this.start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'The shader didn’t compile');
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'The shader didn’t link');
  return program;
}
