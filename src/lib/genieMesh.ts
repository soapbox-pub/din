/**
 * The genie through a real mesh: a window's bitmap snapshot drawn in WebGL
 * over a 2 × GRID_RES grid, each vertex placed by the Compiz magic-lamp model
 * (`genieFrame` in src/lib/genie.ts). Unlike the CSS fallback, which can
 * only fit one projective transform to the corners, the sides follow the
 * lamp's sigmoid curve.
 *
 * One canvas covers the workspace for the length of the animation, stacked
 * at the window's z-index, and is removed (its context released) shortly
 * after the timeline ends, or when it's cancelled.
 *
 * The texture never gets mipmaps: generateMipmap fails on some drivers
 * (ANGLE's GL backend on amdgpu, see Terminal.tsx), and LINEAR filtering is
 * complete without them. A one-pixel transparent border around the snapshot
 * gives the curved edges a smooth falloff instead of a hard, aliased edge.
 */

import { GENIE_DURATION_MS, genieFrame, type GenieRect } from '@/lib/genie';

/** Mesh rows. Compiz's magic lamp defaults to a grid this fine or coarser. */
const GRID_RES = 64;

/** Frames the final frame stays up after the timeline ends. */
const HOLD_FRAMES = 3;

const VERTEX_SHADER = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_view;
varying vec2 v_uv;
void main() {
  vec2 clip = a_pos / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv) * u_alpha;
}`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/**
 * Animate a snapshot of the window into (`minimize`) or out of (`restore`)
 * the dock tile rect, both in workspace coordinates (`parent`'s). `image`
 * must already be decoded. Same contract as animateGenie: the first frame is
 * painted synchronously, `onDone` fires once when the timeline completes
 * (never on cancel), and the returned function cancels. Returns null, having
 * drawn nothing, when WebGL can't be used - the caller falls back.
 */
export function animateGenieMesh(
  parent: HTMLElement,
  image: HTMLImageElement,
  win: GenieRect,
  target: GenieRect,
  direction: 'minimize' | 'restore',
  zIndex: number,
  onDone: () => void,
): (() => void) | null {
  const viewW = parent.clientWidth;
  const viewH = parent.clientHeight;
  const texW = image.naturalWidth;
  const texH = image.naturalHeight;
  if (!viewW || !viewH || !texW || !texH) return null;

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = String(zIndex);

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
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (texW + 2 > maxTex || texH + 2 > maxTex || !vs || !fs || !program) {
    release();
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    release();
    return null;
  }
  gl.useProgram(program);

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

  // Two vertices per row (the model is linear along a row), as one strip:
  // x, y in workspace pixels, then u, v. The grid spans the padded texture,
  // so its outer rows and columns sit one snapshot pixel past the window.
  const vertices = new Float32Array((GRID_RES + 1) * 2 * 4);
  const padX = 1 / texW;
  const padY = 1 / texH;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW);
  const aPos = gl.getAttribLocation(program, 'a_pos');
  const aUv = gl.getAttribLocation(program, 'a_uv');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aUv);
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
  gl.uniform2f(gl.getUniformLocation(program, 'u_view'), viewW, viewH);
  const uAlpha = gl.getUniformLocation(program, 'u_alpha');
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);

  const paint = (p: number) => {
    const frame = genieFrame(win, target, p);
    for (let row = 0; row <= GRID_RES; row++) {
      const v = row / GRID_RES;
      const gy = -padY + v * (1 + 2 * padY);
      const left = frame.point(-padX, gy);
      const right = frame.point(1 + padX, gy);
      const i = row * 8;
      vertices[i] = left.x;
      vertices[i + 1] = left.y;
      vertices[i + 2] = 0;
      vertices[i + 3] = v;
      vertices[i + 4] = right.x;
      vertices[i + 5] = right.y;
      vertices[i + 6] = 1;
      vertices[i + 7] = v;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    gl.uniform1f(uAlpha, frame.opacity);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, (GRID_RES + 1) * 2);
  };

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
  // frame. (After a minimize it's fully faded, so holding it is invisible.)
  let hold = HOLD_FRAMES;
  const holdFrame = () => {
    if (--hold > 0) raf = requestAnimationFrame(holdFrame);
    else teardown();
  };
  const start = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / GENIE_DURATION_MS);
    paint(direction === 'minimize' ? t : 1 - t);
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
