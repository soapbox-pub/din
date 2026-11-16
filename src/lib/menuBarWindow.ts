import { isShown, type WindowState } from '@/hooks/useWindows';
import { EVEN_SPLIT, snapRect, underMenuBar, type Rect, type SnapSplit, type SnapZone, type WorkArea } from '@/lib/monitors';

/** Whether windows under the bar, maximized or snapped along the top, span the whole width of its work area between them. */
function coversWidth(under: { maximized: boolean; snapped: SnapZone | null; split: SnapSplit | null }[], area: WorkArea): boolean {
  const spans = under
    .map((w) => (w.maximized ? area : w.snapped ? snapRect(area, w.snapped, w.split ?? EVEN_SPLIT) : null))
    .filter((r): r is Rect => r !== null)
    .map((r) => [r.x, r.x + r.width] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = area.x;
  for (const [from, to] of spans) {
    if (from > reach + 1) return false;
    reach = Math.max(reach, to);
  }
  return reach >= area.x + area.width - 1;
}

/**
 * The window whose look the menu bar takes: of those under it (maximized,
 * or snapped along the top, on the primary monitor), the top one, once they
 * span its whole width between them; else null, and the bar is the
 * wallpaper's. A maximized window paints the bar's strip itself only while
 * it's this one, so one lower down never shows through in place of the look
 * of a window snapped over it, which the bar's text follows.
 */
export function menuBarWindow(windows: WindowState[], area: WorkArea): WindowState | null {
  const under = windows.filter((w) => underMenuBar(w) && isShown(w) && (w.monitor === null || w.monitor === area.id));
  return coversWidth(under, area) ? under.reduce<WindowState | null>((top, w) => (!top || w.z > top.z ? w : top), null) : null;
}
