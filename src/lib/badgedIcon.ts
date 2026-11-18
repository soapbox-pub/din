/**
 * An icon with another in its corner, drawn into one picture: App Info's
 * window wears the app's icon with Settings' cog on it, in its title bar, its
 * Dock tile and the window switcher, which take a window's icon as one image.
 */

function load(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  // A favicon from another site is drawn only if it says it may be; one that
  // doesn't taints the canvas, and toDataURL throws.
  if (!src.startsWith('/') && !src.startsWith('data:')) img.crossOrigin = 'anonymous';
  img.src = src;
  return img.decode().then(() => img);
}

/**
 * `icon` with `badge` on its bottom-right corner, as a PNG data URL `size`
 * pixels square, or null when either can't be drawn (a site's favicon that
 * doesn't allow it).
 */
export async function badgedIcon(icon: string, badge: string, size = 256): Promise<string | null> {
  try {
    const [base, corner] = await Promise.all([load(icon), load(badge)]);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // The icon a little in from the corner the cog sits on, as AppIcon's
    // web badge leaves it.
    const inset = size * 0.04;
    const scale = Math.min((size - inset) / base.naturalWidth, (size - inset) / base.naturalHeight);
    const w = base.naturalWidth * scale;
    const h = base.naturalHeight * scale;
    ctx.drawImage(base, (size - inset - w) / 2, (size - inset - h) / 2, w, h);
    const b = size * 0.48;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = size * 0.03;
    ctx.shadowOffsetY = size * 0.01;
    ctx.drawImage(corner, size - b, size - b, b, b);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
