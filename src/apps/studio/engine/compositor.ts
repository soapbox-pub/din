import type { CaptureRect } from '@/lib/capture';
import { CANVAS, frameFor, type Frame, type Layout, type Size } from './layout';

/**
 * The picture Studio records and streams: the screen and the camera drawn
 * onto one canvas, thirty times a second, in the layout chosen. What the
 * stage shows is this canvas, so what's seen is what's recorded.
 *
 * Frames are read from the tracks themselves (MediaStreamTrackProcessor),
 * not from <video> elements, and the clock is a worker's: both keep going
 * while the window is minimized, which it is while the screen is recorded.
 */

const FPS = 30;

/** Chromium has it on windows too; TypeScript's DOM types have it only in workers. */
type TrackProcessor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
const TrackProcessor = (globalThis as unknown as { MediaStreamTrackProcessor: TrackProcessor }).MediaStreamTrackProcessor;

/** The newest frame of a video track, kept as it arrives. */
class FrameSource {
  readonly track: MediaStreamTrack;
  latest: VideoFrame | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame>;
  private stopped = false;

  constructor(track: MediaStreamTrack) {
    this.track = track;
    this.reader = new TrackProcessor({ track }).readable.getReader();
    void this.pump();
  }

  private async pump(): Promise<void> {
    while (!this.stopped) {
      let result: ReadableStreamReadResult<VideoFrame>;
      try {
        result = await this.reader.read();
      } catch {
        return;
      }
      if (result.done) return;
      if (this.stopped) {
        result.value.close();
        return;
      }
      this.latest?.close();
      this.latest = result.value;
    }
  }

  get size(): Size | null {
    return this.latest ? { width: this.latest.displayWidth, height: this.latest.displayHeight } : null;
  }

  stop(): void {
    this.stopped = true;
    void this.reader.cancel().catch(() => {});
    this.latest?.close();
    this.latest = null;
  }
}

/** A worker's steady tick: timers on the page are slowed while it's hidden, a worker's aren't. */
function ticker(fps: number, tick: () => void): () => void {
  const source = `setInterval(() => postMessage(0), ${Math.round(1000 / fps)});`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.onmessage = tick;
  return () => {
    worker.terminate();
    URL.revokeObjectURL(url);
  };
}

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** A tiny copy of the screen, stretched behind it where it doesn't fill its area. */
  private haze: HTMLCanvasElement;
  private hazeCtx: CanvasRenderingContext2D;
  private screen: FrameSource | null = null;
  private camera: FrameSource | null = null;
  private stopTicker: (() => void) | null = null;
  private listeners = new Set<() => void>();
  layout: Layout;
  mirror = false;
  /** The part of a screen capture that's the display being recorded, as fractions of it. */
  screenCrop: CaptureRect = { x: 0, y: 0, width: 1, height: 1 };
  /** Where the pointer is on the display, as fractions of it, kept current by whoever knows. */
  pointer: { x: number; y: number } | null = null;
  /** The last frame drawn. */
  frame: Frame = { screen: null, screenArea: null, camera: null, cameraClip: 0 };

  constructor(layout: Layout) {
    this.layout = layout;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.haze = document.createElement('canvas');
    this.haze.width = 48;
    this.haze.height = 27;
    this.hazeCtx = this.haze.getContext('2d', { alpha: false, willReadFrequently: false })!;
    this.resize();
  }

  start(): void {
    this.stopTicker ??= ticker(FPS, () => this.draw());
  }

  /** Show the picture in an element; returns how to take it out again. */
  mount(parent: HTMLElement): () => void {
    const node = this.canvas;
    node.className = 'block h-full w-full';
    node.setAttribute('aria-hidden', 'true');
    parent.appendChild(node);
    return () => node.remove();
  }

  setMirror(mirror: boolean): void {
    this.mirror = mirror;
  }

  setScreenCrop(crop: CaptureRect): void {
    this.screenCrop = crop;
  }

  setPointer(pointer: { x: number; y: number } | null): void {
    this.pointer = pointer;
  }

  dispose(): void {
    this.stopTicker?.();
    this.stopTicker = null;
    this.screen?.stop();
    this.camera?.stop();
    this.screen = this.camera = null;
  }

  setLayout(layout: Layout): void {
    const reshape = layout.aspect !== this.layout.aspect;
    this.layout = layout;
    if (reshape) this.resize();
  }

  setScreen(track: MediaStreamTrack | null): void {
    if (this.screen?.track === track) return;
    this.screen?.stop();
    this.screen = track ? new FrameSource(track) : null;
  }

  setCamera(track: MediaStreamTrack | null): void {
    if (this.camera?.track === track) return;
    this.camera?.stop();
    this.camera = track ? new FrameSource(track) : null;
  }

  get hasScreen(): boolean {
    return this.screen !== null;
  }

  get hasCamera(): boolean {
    return this.camera !== null;
  }

  /** Called after every frame drawn (the stage follows the camera's place). */
  onDraw(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The picture as a stream, for recording and going live. */
  captureStream(): MediaStream {
    return this.canvas.captureStream(FPS);
  }

  /** The picture now, as a JPEG. */
  snapshot(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', 0.85));
  }

  private resize(): void {
    const { width, height } = CANVAS[this.layout.aspect];
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** The screen's size once cropped to the display. */
  private screenSize(): Size | null {
    const size = this.screen?.size;
    if (!size) return null;
    return { width: Math.round(size.width * this.screenCrop.width), height: Math.round(size.height * this.screenCrop.height) };
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const screenFrame = this.screen?.latest ?? null;
    const cameraFrame = this.camera?.latest ?? null;
    const frame = frameFor(this.layout, screenFrame ? this.screenSize() : null, cameraFrame !== null);
    this.frame = frame;

    ctx.fillStyle = '#0b0b0d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (screenFrame && frame.screen && frame.screenArea) {
      const size = screenFrame.displayWidth;
      const crop = {
        x: this.screenCrop.x * size,
        y: this.screenCrop.y * screenFrame.displayHeight,
        width: this.screenCrop.width * size,
        height: this.screenCrop.height * screenFrame.displayHeight,
      };
      const area = frame.screenArea;
      const fills = Math.abs(frame.screen.width - area.width) < 2 && Math.abs(frame.screen.height - area.height) < 2;
      if (!fills) {
        // Blurred and dimmed, by drawing it tiny and stretching it back.
        this.hazeCtx.drawImage(screenFrame, crop.x, crop.y, crop.width, crop.height, 0, 0, this.haze.width, this.haze.height);
        ctx.save();
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.haze, area.x, area.y, area.width, area.height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(area.x, area.y, area.width, area.height);
        ctx.restore();
      }
      ctx.drawImage(screenFrame, crop.x, crop.y, crop.width, crop.height, frame.screen.x, frame.screen.y, frame.screen.width, frame.screen.height);
      this.drawPointer(frame.screen);
    }

    if (cameraFrame && frame.camera) this.drawCamera(cameraFrame, frame.camera, frame.cameraClip);

    for (const listener of this.listeners) listener();
  }

  private drawCamera(source: VideoFrame, rect: CaptureRect, clip: Frame['cameraClip']): void {
    const { ctx } = this;
    // Cover: crop the camera to the rect's shape, from its middle.
    const sw = source.displayWidth;
    const sh = source.displayHeight;
    const scale = Math.max(rect.width / sw, rect.height / sh);
    const cw = rect.width / scale;
    const ch = rect.height / scale;
    const sx = (sw - cw) / 2;
    const sy = (sh - ch) / 2;
    const path = new Path2D();
    if (clip === 'circle') path.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, 0, Math.PI * 2);
    else path.roundRect(rect.x, rect.y, rect.width, rect.height, clip);
    const bubble = clip === 'circle' || clip > 0;

    ctx.save();
    if (bubble) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = rect.width * 0.08;
      ctx.shadowOffsetY = rect.width * 0.02;
      ctx.fillStyle = '#000';
      ctx.fill(path);
      ctx.shadowColor = 'transparent';
    }
    ctx.clip(path);
    if (this.mirror) {
      ctx.translate(rect.x * 2 + rect.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, sx, sy, cw, ch, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
    if (bubble) {
      ctx.save();
      ctx.lineWidth = Math.max(2, rect.width * 0.008);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.stroke(path);
      ctx.restore();
    }
  }

  /** A capture of the screen doesn't have the pointer in it: drawn where it is. */
  private drawPointer(screen: CaptureRect): void {
    const p = this.pointer;
    if (!p || p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1) return;
    const { ctx } = this;
    const x = screen.x + p.x * screen.width;
    const y = screen.y + p.y * screen.height;
    const s = Math.max(0.6, screen.height / 1000) * 1.3;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    const arrow = new Path2D('M0 0 L0 17 L4.2 13 L7 19.5 L10 18.2 L7.3 11.9 L13 11.9 Z');
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#000';
    ctx.fill(arrow);
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#fff';
    ctx.stroke(arrow);
    ctx.restore();
  }
}
