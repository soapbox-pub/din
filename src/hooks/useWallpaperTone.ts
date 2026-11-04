import { useContext, useEffect, useState } from 'react';
import { MonitorsContext } from '@/contexts/MonitorsContext';
import { useDesktopTheme } from '@/hooks/useDesktopTheme';
import { viewportMonitor } from '@/lib/monitors';
import { isDarkThemeColor } from '@/lib/themeColor';

export type WallpaperTone = 'dark' | 'light';

/** How much of the strip is read, in samples: enough to tell its regions apart. */
const SAMPLES_WIDE = 128;
const SAMPLES_TALL = 4;

/** Whether most of the strip's samples would carry white text, as isDarkThemeColor decides it. */
function toneOfPixels(rgba: Uint8ClampedArray): WallpaperTone {
  const samples = rgba.length / 4;
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const hex = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    if (isDarkThemeColor(`#${hex.toString(16).padStart(6, '0')}`)) dark++;
  }
  return dark * 2 >= samples ? 'dark' : 'light';
}

/** An image whose pixels can be read back off a canvas, if its server allows it. */
function loadReadableImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Couldn't read ${src}`));
    image.src = src;
  });
}

interface Strip {
  /** Where the primary monitor sits on the whole screen, which a tiled image starts from. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The strip's height, from the top of the monitor. */
  stripHeight: number;
  /** What shows through a transparent image. */
  backdrop: string;
  tile: boolean;
}

/** The tone of the image along the top of the monitor, placed the way Wallpaper places it. */
function readTone(image: HTMLImageElement, strip: Strip): WallpaperTone {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLES_WIDE;
  canvas.height = SAMPLES_TALL;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No canvas context');
  ctx.fillStyle = strip.backdrop;
  ctx.fillRect(0, 0, SAMPLES_WIDE, SAMPLES_TALL);
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(SAMPLES_WIDE / strip.width, SAMPLES_TALL / strip.stripHeight);

  if (strip.tile) {
    const pattern = ctx.createPattern(image, 'repeat');
    if (!pattern) throw new Error('No pattern');
    ctx.translate(-strip.x, -strip.y);
    ctx.fillStyle = pattern;
    ctx.fillRect(strip.x, strip.y, strip.width, strip.stripHeight);
  } else {
    // object-fit: cover, centered.
    const scale = Math.max(strip.width / image.naturalWidth, strip.height / image.naturalHeight);
    const left = (image.naturalWidth - strip.width / scale) / 2;
    const top = (image.naturalHeight - strip.height / scale) / 2;
    ctx.drawImage(image, left, top, strip.width / scale, strip.stripHeight / scale, 0, 0, strip.width, strip.stripHeight);
  }
  return toneOfPixels(ctx.getImageData(0, 0, SAMPLES_WIDE, SAMPLES_TALL).data);
}

/**
 * Whether the wallpaper along the top of the primary monitor is dark or
 * light, for the menu bar over it, which takes one look along its whole
 * length, as macOS's does.
 *
 * Null when the desktop has no wallpaper image, only the theme's own
 * background color, which its text color already suits. A wallpaper it can't
 * read (a server that doesn't allow it) counts as dark, as it does until the
 * image arrives: white text over a dark scrim stays legible on anything.
 */
export function useWallpaperTone(stripHeight: number): WallpaperTone | null {
  const theme = useDesktopTheme();
  const layout = useContext(MonitorsContext);
  const { x, y, width, height } = layout?.primary ?? viewportMonitor();

  // As Wallpaper chooses it.
  const background = theme?.background?.mimeType.startsWith('image/') ? theme.background : null;
  const src = theme ? background?.url ?? null : '/wallpaper.jpg';
  const tile = background?.mode === 'tile';
  const backdrop = theme?.colors.background ?? '#0b0f14';

  const [read, setRead] = useState<{ key: string; tone: WallpaperTone } | null>(null);
  const key = `${src} ${tile} ${backdrop} ${x} ${y} ${width} ${height} ${stripHeight}`;

  useEffect(() => {
    if (!src) return;
    let live = true;
    loadReadableImage(src)
      .then((image) => readTone(image, { x, y, width, height, stripHeight, backdrop, tile }))
      .catch(() => 'dark' as const)
      .then((tone) => {
        if (live) setRead({ key, tone });
      });
    return () => {
      live = false;
    };
  }, [key, src, tile, backdrop, x, y, width, height, stripHeight]);

  if (!src) return null;
  return read?.key === key ? read.tone : 'dark';
}
