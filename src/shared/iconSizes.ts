/**
 * The built-in apps' icons are 512px (public/icons/apps/), and an image is
 * decoded whole wherever it's drawn: a megabyte for the Dock's 59px, or a
 * sidebar title's 24px. scripts/icon-sizes.mjs keeps copies at these sizes
 * in public/icons/apps/<size>/, and bundledIconProps gives an <img> the lot,
 * so the browser takes the smallest that's sharp at its size on this screen.
 */
export const ICON_SIZES = [64, 128, 256];

const BUNDLED = /^\/icons\/apps\/([a-z0-9-]+)\.png$/;

type IconProps = { src: string } | { src: string; srcSet: string; sizes: string; loading: 'lazy' };

/**
 * An <img>'s src, and for a bundled app icon its smaller copies with
 * `sizes="auto"` (its laid-out width picks one; Chromium takes `auto` only
 * on lazy images, which only waits for those off screen).
 */
export function bundledIconProps(src: string): IconProps {
  const name = BUNDLED.exec(src)?.[1];
  if (!name) return { src };
  const srcSet = [...ICON_SIZES.map((size) => `/icons/apps/${size}/${name}.png ${size}w`), `${src} 512w`].join(', ');
  return { src, srcSet, sizes: 'auto', loading: 'lazy' };
}
