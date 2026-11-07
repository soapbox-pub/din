/**
 * What keeps its own clicks in a title bar: pressing it doesn't move the
 * window, double-clicking it doesn't maximize the window, and right-clicking
 * it doesn't open the window menu. Shared by the desktop's WindowDragRegion
 * and the app runtime's `app-region: drag`, so the two can't drift apart.
 *
 * Double-clicks matter most: two quick clicks count as one even when the
 * second lands on another control, as when closing tab after tab whose
 * close buttons slide under the pointer.
 */
export const TITLE_BAR_CONTROLS =
  'button, input, textarea, select, a[href], [role="tab"], [contenteditable]:not([contenteditable="false"]), [data-window-no-drag]';
