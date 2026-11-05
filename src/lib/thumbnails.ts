import { fileUrl } from '@/lib/fs';
import { extensionOf, hasOwnIcon, isPlayableVideo, isViewableImage } from '@/lib/fileTypes';

/**
 * Thumbnails for the Files app: small WebP renditions of images and video
 * frames, and programs' own icons (AppImages', .exes'), made in the renderer from din-file: URLs
 * and cached as object URLs
 * for the session. Decoding is the expensive part, so only a few run at
 * once, and a thumbnail scrolled out of view before its turn is skipped.
 */

/** Longest edge of a thumbnail, in px (enough for the largest grid zoom on HiDPI). */
const THUMB_SIZE = 256;
/** Images bigger than this aren't worth decoding for an icon. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** Thumbnails kept before the oldest are dropped. */
const CACHE_LIMIT = 1500;
const CONCURRENCY = 3;
const VIDEO_TIMEOUT_MS = 10_000;

interface ThumbSource {
  path: string;
  size: number | null;
  mtimeMs: number | null;
}

const cache = new Map<string, Promise<string | null>>();
const queue: { run: () => Promise<void>; wanted: () => boolean }[] = [];
let running = 0;

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    if (!job.wanted()) continue;
    running++;
    void job.run().finally(() => {
      running--;
      pump();
    });
  }
}

/** Draw a bitmap (or video frame) scaled to fit THUMB_SIZE, as a WebP blob URL. */
async function encode(source: CanvasImageSource, width: number, height: number): Promise<string | null> {
  if (!width || !height) return null;
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
  return URL.createObjectURL(blob);
}

async function imageThumb(src: ThumbSource): Promise<string | null> {
  if (src.size !== null && src.size > MAX_IMAGE_BYTES) return null;
  // SVGs are vectors: the file itself is the best thumbnail.
  if (extensionOf(src.path) === 'svg') return fileUrl(src.path);
  const response = await fetch(await fileUrl(src.path));
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    return await encode(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * A program's own icon (an AppImage's or an .exe's), which the file protocol pulls out
 * of it at `?icon`, already small enough to show as it is.
 */
async function ownIcon(src: ThumbSource): Promise<string | null> {
  const response = await fetch(`${await fileUrl(src.path)}?icon`);
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

function videoThumb(src: ThumbSource): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let done = false;
    const finish = (url: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), VIDEO_TIMEOUT_MS);
    video.muted = true;
    video.preload = 'metadata';
    // CORS-clean, so the frame can be read back off the canvas.
    video.crossOrigin = 'anonymous';
    video.onloadedmetadata = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      video.currentTime = Math.min(d * 0.1, 30);
    };
    video.onseeked = () => {
      encode(video, video.videoWidth, video.videoHeight).then(finish, () => finish(null));
    };
    video.onerror = () => finish(null);
    fileUrl(src.path).then((url) => (video.src = url), () => finish(null));
  });
}

/**
 * A thumbnail URL for a file, or null when it has none. `wanted` is asked
 * just before the work starts, so callers that have gone away (scrolled
 * out of view, unmounted) don't cost a decode.
 */
export function getThumbnail(src: ThumbSource, wanted: () => boolean): Promise<string | null> {
  const name = src.path.slice(src.path.lastIndexOf('/') + 1);
  const isImage = isViewableImage(name);
  const isIcon = hasOwnIcon(name);
  if (!isImage && !isIcon && !isPlayableVideo(name)) return Promise.resolve(null);
  const key = `${src.path}\0${src.mtimeMs ?? ''}\0${src.size ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const promise = new Promise<string | null>((resolve) => {
    queue.push({
      wanted: () => {
        if (wanted()) return true;
        // Nobody's waiting: forget it so the next caller queues it afresh.
        cache.delete(key);
        resolve(null);
        return false;
      },
      run: () =>
        (isImage ? imageThumb(src) : isIcon ? ownIcon(src) : videoThumb(src))
          .catch(() => null)
          .then(resolve),
    });
    pump();
  });
  cache.set(key, promise);

  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      const stale = cache.get(oldest);
      cache.delete(oldest);
      void stale?.then((url) => {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
      });
    }
  }
  return promise;
}

/** Whether a thumbnail is already made (so it can show without a fade). */
export function peekThumbnail(src: ThumbSource): Promise<string | null> | undefined {
  return cache.get(`${src.path}\0${src.mtimeMs ?? ''}\0${src.size ?? ''}`);
}
