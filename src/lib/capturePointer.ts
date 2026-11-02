/**
 * Telling main where the pointer is, for Studio to draw it into its picture.
 * On Wayland Electron can't see the pointer (it reads 0,0 there), but the
 * desktop does: its document hears every move over it, including those
 * GuestInputHost replays from pages and native apps. Main asks for a couple
 * of seconds at a time while Studio polls (electron/capture.mts), and the
 * desktop says once a frame while the pointer moves.
 */
import { getCaptureBridge } from '@/lib/capture';

/** How long one ask from main lasts here: longer than main's, so asks in a row overlap. */
const REPORT_MS = 3_000;

let last: { x: number; y: number } | null = null;
let reportingUntil = 0;
let frame = 0;

function report(): void {
  frame = 0;
  if (last && performance.now() < reportingUntil) getCaptureBridge()?.pointerAt?.(last.x, last.y);
}

export function installCapturePointer(): void {
  const bridge = getCaptureBridge();
  if (!bridge?.onReportPointer) return;
  window.addEventListener(
    'pointermove',
    (e) => {
      last = { x: e.clientX, y: e.clientY };
      if (!frame && performance.now() < reportingUntil) frame = requestAnimationFrame(report);
    },
    { capture: true, passive: true },
  );
  bridge.onReportPointer(() => {
    reportingUntil = performance.now() + REPORT_MS;
    report();
  });
}
