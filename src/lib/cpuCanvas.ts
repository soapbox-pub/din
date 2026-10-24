/**
 * Every 2D canvas in the shell is backed by memory, not the GPU.
 *
 * An accelerated 2D canvas keeps its pixels in the GPU process. When that
 * process dies (a driver reset, frequent on DinOS's amdgpu) Chromium starts
 * a new one, wipes every such canvas and leaves anything made from them -
 * patterns, ImageBitmaps - pointing at images the new process never had.
 * Drawing one fails the whole batch, so a canvas that was fine before the
 * reset paints black from then on (seen in the Photo Editor), and a
 * document's layers come back empty. Canvases in memory don't depend on the
 * GPU process at all and survive a reset untouched.
 *
 * `willReadFrequently` is the standard way to ask for that, and the first
 * getContext call on a canvas decides it, so every 2D context the shell's
 * apps (and their libraries) open goes through here. Canvases that draw GPU
 * textures every frame, where a copy to memory would cost more than a reset
 * loses, opt out with `keepAccelerated` before their first getContext.
 *
 * This covers the shell's own world only. Browser tabs and the preload's
 * isolated world have their own prototypes and keep Chromium's default.
 */

const accelerated = new WeakSet<HTMLCanvasElement | OffscreenCanvas>();

/** Leave this canvas on the GPU. Call before its first getContext. */
export function keepAccelerated(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  accelerated.add(canvas);
}

type GetContext = (this: HTMLCanvasElement | OffscreenCanvas, type: string, options?: unknown) => unknown;

function patch(proto: { getContext: unknown }) {
  const original = proto.getContext as GetContext;
  proto.getContext = function (this: HTMLCanvasElement | OffscreenCanvas, type: string, options?: unknown) {
    if (type !== '2d' || accelerated.has(this)) return original.call(this, type, options);
    const opts = typeof options === 'object' && options !== null ? options : {};
    return original.call(this, type, { ...opts, willReadFrequently: true });
  };
}

export function installCpuCanvas(): void {
  if (typeof HTMLCanvasElement !== 'undefined') patch(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') patch(OffscreenCanvas.prototype);
}
