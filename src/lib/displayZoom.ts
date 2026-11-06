import type { AppConfig } from '@/contexts/AppContext';
import { autoZoomFor } from '@/lib/autoZoom';
import type { DisplayOutput } from '@/lib/display';

/**
 * Zoom, display by display, under din-shell: each display is zoomed to suit
 * its own pixel density (src/lib/autoZoom.ts) unless the user chose a zoom
 * for it, which is remembered for that display (`AppConfig.displayZoom`, by
 * make, model and serial, so it follows the display to another port). The
 * zoom is the display's scale in din-shell, which draws Din at the densest
 * display's and scales it down on the others, so a hidpi panel beside a
 * low-dpi monitor shows the desktop at the same size on both. Settings →
 * Display, Settings → Accessibility and `din display set --zoom` all set it
 * here; AppProvider hands it to din-shell.
 *
 * Elsewhere there's one zoom for the whole desktop, `AppConfig.zoomLevel`.
 */

export const MIN_ZOOM = 50; // %
export const MAX_ZOOM = 200; // %
export const ZOOM_STEP = 10; // %

/** Clamp a zoom percentage to the supported range and round to an integer. */
export function clampZoom(percent: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(percent)));
}

/** What a display's zoom is remembered by. */
export function displayKey(output: DisplayOutput): string {
  return output.id || output.name;
}

/** A display's zoom, as a percentage, and whether it's its automatic one. */
export function zoomOf(
  output: DisplayOutput,
  chosen: Record<string, number> | undefined,
): { percent: number; automatic: boolean } {
  const percent = chosen?.[displayKey(output)];
  return percent === undefined ? { percent: autoZoomFor(output), automatic: true } : { percent, automatic: false };
}

/**
 * The config with OUTPUT zoomed to PERCENT, remembered for it, or back to its
 * automatic zoom (PERCENT null).
 */
export function withDisplayZoom(
  config: Partial<AppConfig>,
  output: DisplayOutput,
  percent: number | null,
): Partial<AppConfig> {
  const { [displayKey(output)]: _, ...rest } = config.displayZoom ?? {};
  return { ...config, displayZoom: percent === null ? rest : { ...rest, [displayKey(output)]: clampZoom(percent) } };
}

/**
 * The scales to give din-shell so each display on is at its zoom, by output
 * name, or null when they all are already.
 */
export function scalesToApply(
  outputs: DisplayOutput[],
  chosen: Record<string, number> | undefined,
): Record<string, number> | null {
  const scales: Record<string, number> = {};
  let changed = false;
  for (const output of outputs) {
    if (!output.enabled) continue;
    const scale = zoomOf(output, chosen).percent / 100;
    scales[output.name] = scale;
    if (Math.abs((output.scale ?? 1) - scale) > 0.005) changed = true;
  }
  return changed ? scales : null;
}
