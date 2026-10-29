import { createPortal } from 'react-dom';
import { useBrightnessPreview, useBrightnessStatus } from '@/hooks/useBrightness';
import { portalContainer } from '@/lib/portalContainer';

/**
 * Software dimming below the backlight's floor. Brightness levels under 0
 * (see src/lib/brightness.ts) are drawn as a black layer over everything Din
 * shows, native apps included, at that many percent opacity. It follows a
 * slider drag live through the brightness preview. The pointer, which din-shell
 * draws outside Din, stays bright.
 */
export function ScreenDimmer() {
  const status = useBrightnessStatus();
  const preview = useBrightnessPreview();
  const level = preview ?? status.data?.brightness ?? 0;
  if (level >= 0) return null;

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[2147483647] bg-black"
      style={{ opacity: -level / 100 }}
    />,
    portalContainer(),
  );
}
