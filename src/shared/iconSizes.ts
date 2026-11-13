/**
 * The built-in apps' icons are 512px (public/icons/apps/), and an image is
 * decoded whole wherever it's drawn: a megabyte for the Dock's 59px, or a
 * sidebar title's 24px. scripts/icon-sizes.mjs keeps copies at these sizes
 * in public/icons/apps/<size>/, and bundledIconProps gives an <img> the lot,
 * so the browser takes the smallest that's sharp at its size on this screen.
 */
export const ICON_SIZES = [64, 128, 256];

const BUNDLED = /^\/icons\/apps\/([a-z0-9-]+)\.png$/;

type IconProps = { src: string } | { src: string; srcSet: string; sizes: string; loading: 'lazy'; ref: typeof releaseAutoSized };

/**
 * An <img>'s src, and for a bundled app icon its smaller copies with
 * `sizes="auto"` (its laid-out width picks one; Chromium takes `auto` only
 * on lazy images, which only waits for those off screen), and the ref that
 * lets go of such an image (below): an <img> with a ref of its own has it
 * call `releaseAutoSized` too.
 */
export function bundledIconProps(src: string): IconProps {
  const name = BUNDLED.exec(src)?.[1];
  if (!name) return { src };
  const srcSet = [...ICON_SIZES.map((size) => `/icons/apps/${size}/${name}.png ${size}w`), `${src} 512w`].join(', ');
  return { src, srcSet, sizes: 'auto', loading: 'lazy', ref: releaseAutoSized };
}

/**
 * A ref for a lazy `sizes="auto"` image, which Chromium (150, 151) otherwise
 * never frees once it's taken out of the page while laid out: its size
 * becoming none has it choose its source again (the 512px one, which it then
 * loads), and choosing signs it up for the viewport's changes after leaving
 * the document had signed it off. What's signed up is kept, with everything
 * that left the page with it: every tile of the apps menu each time it
 * closed, a closed window's title bar. An image that's no longer lazy when
 * it goes sits the choosing out. React runs a ref at mount and what it
 * returns at unmount, before the node leaves the page.
 */
export function releaseAutoSized(img: HTMLImageElement | null): (() => void) | undefined {
  if (!img) return;
  const auto = () => img.sizes === 'auto';
  // Shown again after being hidden (which unmounts refs, not nodes).
  if (auto() && img.loading !== 'lazy') img.loading = 'lazy';
  return () => {
    if (auto()) img.loading = 'eager';
  };
}
