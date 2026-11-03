import { isInternalOutput, type DisplayOutput } from '@/lib/display';

/**
 * The zoom Din picks for a display when the user hasn't chosen one: from its
 * pixel density, so a HiDPI panel isn't left with a tiny desktop.
 *
 * At 100%, Din reads comfortably on a laptop panel of about 160 pixels per
 * inch (a 14" 1920×1200) and on a monitor of about 120, which sits further
 * away. Denser displays zoom by how much denser they are, in steps of 25%,
 * from 100% (never smaller) to 200%, and never so far that the desktop is
 * less than 1280 px across. A display that doesn't say its size, or says one
 * that's really its aspect ratio (as projectors and some TVs do), stays at
 * 100%.
 */

const LAPTOP_PPI = 160;
const MONITOR_PPI = 120;
const MIN_WIDTH = 1280;
const STEP = 25;

/** Sizes in mm that EDIDs give for an aspect ratio rather than a screen. */
function bogusSize(width: number, height: number): boolean {
  if (width < 100 || height < 60) return true;
  const ratios = [[160, 90], [160, 100], [160, 120], [150, 100]];
  return ratios.some(([w, h]) => width === w && height === h);
}

/** The automatic zoom for an output, as a percentage. */
export function autoZoomFor(output: DisplayOutput): number {
  const mode = output.current;
  const size = output.physicalSize;
  if (!mode || !size || bogusSize(size.width, size.height)) return 100;
  // Rotated, the mode and the panel's size may not run the same way.
  const pixels = Math.max(mode.width, mode.height);
  const mm = Math.max(size.width, size.height);
  const ppi = pixels / (mm / 25.4);
  const reference = isInternalOutput(output.name) ? LAPTOP_PPI : MONITOR_PPI;
  const percent = Math.round((ppi / reference) * 100 / STEP) * STEP;
  const widest = Math.floor((pixels / MIN_WIDTH) * 100 / STEP) * STEP;
  return Math.max(100, Math.min(200, percent, widest));
}

/** The automatic zoom for the desktop: its primary display's, or null where unknown. */
export function autoZoomForOutputs(outputs: DisplayOutput[]): number | null {
  const primary = outputs.find((o) => o.primary && o.enabled) ?? outputs.find((o) => o.enabled);
  return primary ? autoZoomFor(primary) : null;
}
