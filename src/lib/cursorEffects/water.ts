/**
 * Water, after Compiz's water plugin: the screen as the surface of a pond,
 * rippling where the pointer stirs it.
 *
 * The waves are a height field on a coarse grid (one cell per `CELL` CSS
 * pixels), stepped with the classic two-buffer wave equation on the CPU;
 * even a wide screen is only tens of thousands of cells. Each frame the
 * field goes up as a texture and a fragment shader bends a snapshot of the
 * screen through it, lights the slopes, and fades to nothing where the
 * water is still, so the live screen shows everywhere else.
 *
 * The snapshot is taken once, when the water starts moving from calm, and
 * kept until it's calm again: capturing while it ripples would capture the
 * ripples, which would then ripple themselves. Without one (no capture
 * here, or not yet), the waves are drawn as light on glass alone.
 */

/** CSS pixels per cell of the height field. */
const CELL = 6;
/** How much of a wave survives each step. */
const DAMPING = 0.975;
/** Steps a second; the simulation runs at this rate whatever the frame rate. */
const RATE = 60;
/** Below this, the water counts as calm. */
const CALM = 0.004;

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
uniform sampler2D u_height;
uniform sampler2D u_back;
uniform vec2 u_texel;
uniform float u_hasBack;
uniform float u_refract;
out vec4 color;
void main() {
  float l = texture(u_height, v_uv - vec2(u_texel.x, 0.0)).r;
  float r = texture(u_height, v_uv + vec2(u_texel.x, 0.0)).r;
  float u = texture(u_height, v_uv - vec2(0.0, u_texel.y)).r;
  float d = texture(u_height, v_uv + vec2(0.0, u_texel.y)).r;
  vec2 slope = vec2(r - l, d - u);
  float steep = length(slope);
  float cover = smoothstep(0.004, 0.05, steep);
  if (cover <= 0.0) discard;
  vec3 normal = normalize(vec3(-slope * 6.0, 1.0));
  vec3 light = normalize(vec3(-0.4, -0.6, 0.7));
  float shine = pow(max(dot(normal, light), 0.0), 24.0);
  float shade = dot(normal.xy, vec2(0.5, 0.7));
  vec4 back = u_hasBack > 0.5 ? texture(u_back, v_uv + slope * u_refract) : vec4(0.0);
  vec3 lit = back.rgb * (1.0 + shade * 0.6) + vec3(shine * 0.7);
  float alpha = u_hasBack > 0.5 ? cover : cover * clamp(shine * 0.8 + abs(shade) * 0.35, 0.0, 0.8);
  color = vec4((u_hasBack > 0.5 ? lit : vec3(1.0) * (shine + 0.25)) * alpha, alpha);
}`;

export class Water {
  private gl: WebGL2RenderingContext | null;
  private program: WebGLProgram | null = null;
  private heightTexture: WebGLTexture | null = null;
  private backTexture: WebGLTexture | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private cols = 0;
  private rows = 0;
  private current = new Float32Array(0);
  private previous = new Float32Array(0);
  private width = 0;
  private height = 0;
  private pending = 0;
  private energy = 0;
  private hasBack = false;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (this.gl) this.setUp(this.gl);
  }

  /** Whether WebGL2 is here to draw with. */
  get available(): boolean {
    return this.program !== null;
  }

  /** Whether anything is still moving. */
  get moving(): boolean {
    return this.energy > CALM;
  }

  private setUp(gl: WebGL2RenderingContext): void {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vs || !fs || !program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    this.program = program;
    for (const name of ['u_height', 'u_back', 'u_texel', 'u_hasBack', 'u_refract']) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const texture = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.heightTexture = texture();
    this.backTexture = texture();
  }

  /** Size the surface to `width` × `height` CSS pixels, drawn at `scale` device pixels each. */
  resize(width: number, height: number, scale: number): void {
    const cols = Math.max(2, Math.ceil(width / CELL));
    const rows = Math.max(2, Math.ceil(height / CELL));
    this.width = width;
    this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * scale));
    this.canvas.height = Math.max(1, Math.round(height * scale));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.current = new Float32Array(cols * rows);
    this.previous = new Float32Array(cols * rows);
    this.energy = 0;
  }

  /** Push the water down around (x, y), in CSS pixels: `radius` wide, `strength` deep. */
  disturb(x: number, y: number, radius: number, strength: number): void {
    if (!this.cols) return;
    const cx = x / CELL;
    const cy = y / CELL;
    const r = Math.max(1, radius / CELL);
    const x0 = Math.max(1, Math.floor(cx - r));
    const x1 = Math.min(this.cols - 2, Math.ceil(cx + r));
    const y0 = Math.max(1, Math.floor(cy - r));
    const y1 = Math.min(this.rows - 2, Math.ceil(cy + r));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const d = Math.hypot(i - cx, j - cy) / r;
        if (d >= 1) continue;
        this.current[j * this.cols + i] -= strength * (0.5 + 0.5 * Math.cos(d * Math.PI));
      }
    }
    this.energy = Math.max(this.energy, strength);
  }

  /** What to bend: a picture of the screen under the surface, or null for light alone. */
  setBackground(image: TexImageSource | null): void {
    const gl = this.gl;
    this.hasBack = false;
    if (!gl || !this.program || !image) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.hasBack = true;
  }

  /** Run the waves on by `dt` ms. */
  step(dt: number): void {
    if (!this.cols || this.energy <= CALM) return;
    this.pending = Math.min(this.pending + dt, 100);
    const interval = 1000 / RATE;
    const { cols, rows } = this;
    while (this.pending >= interval) {
      this.pending -= interval;
      const next = this.previous;
      const now = this.current;
      let peak = 0;
      for (let j = 1; j < rows - 1; j++) {
        const row = j * cols;
        for (let i = 1; i < cols - 1; i++) {
          const k = row + i;
          const h = ((now[k - 1] + now[k + 1] + now[k - cols] + now[k + cols]) * 0.5 - next[k]) * DAMPING;
          next[k] = h;
          const a = h < 0 ? -h : h;
          if (a > peak) peak = a;
        }
      }
      this.previous = now;
      this.current = next;
      this.energy = peak;
    }
    if (this.energy <= CALM) {
      this.current.fill(0);
      this.previous.fill(0);
    }
  }

  /** Draw the surface as it is now. */
  render(): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.energy <= CALM) return;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, this.cols, this.rows, 0, gl.RED, gl.FLOAT, this.current);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.backTexture);
    gl.uniform1i(this.uniforms.u_height, 0);
    gl.uniform1i(this.uniforms.u_back, 1);
    gl.uniform2f(this.uniforms.u_texel, 1 / this.cols, 1 / this.rows);
    gl.uniform1f(this.uniforms.u_hasBack, this.hasBack ? 1 : 0);
    // A slope of one cell's height bends the picture about a cell and a half.
    gl.uniform1f(this.uniforms.u_refract, (CELL * 1.5) / Math.max(1, Math.min(this.width, this.height)) * 8);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Still the water at once. */
  calm(): void {
    this.current.fill(0);
    this.previous.fill(0);
    this.energy = 0;
    this.hasBack = false;
  }

  /** Give the GPU its memory back. */
  dispose(): void {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.gl = null;
    this.program = null;
  }
}
