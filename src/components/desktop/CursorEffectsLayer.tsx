import { useContext, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { MonitorsContext } from '@/contexts/MonitorsContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useSystemCursorStatus } from '@/hooks/useSystemCursor';
import { FIND_MAX_SCALE, cursorEffects } from '@/lib/cursorEffects';
import type { CursorImage } from '@/lib/cursorEffects/scene';
import { portalContainer } from '@/lib/portalContainer';
import { setPowerMode } from '@/lib/powerMode';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { useCursorEffectTint } from '@/components/desktop/useCursorEffectTint';
import { useReducedMotion } from '@/shared/reducedMotion';

/**
 * The pointer's own arrow, as big as it's drawn, from the theme's image
 * nearest `magnify` times its size (so it stays sharp drawn that much
 * bigger); null until it's known, or outside the shell.
 */
function useCursorImage(wanted: boolean, zoom: number, magnify = 1): CursorImage | null {
  const status = useSystemCursorStatus();
  const theme = status.data?.theme;
  const size = status.data?.size;
  const { data } = useQuery({
    queryKey: ['cursor', 'effect-image', theme, size, magnify],
    queryFn: async () => {
      const bridge = getSystemCursorBridge();
      if (!bridge || !theme || !size) return null;
      const arrow = (await bridge.preview(theme, Math.min(256, Math.round(size * magnify)))).find((p) => p.role === 'default');
      if (!arrow) return null;
      const pixels = new Uint8ClampedArray(arrow.rgba.length);
      pixels.set(arrow.rgba);
      const bitmap = await createImageBitmap(new ImageData(pixels, arrow.width, arrow.height));
      return { bitmap, hotX: arrow.hotX, hotY: arrow.hotY };
    },
    enabled: wanted && !!theme && !!size,
    staleTime: Infinity,
    retry: false,
  });
  return useMemo(() => {
    if (!data || !size) return null;
    const { bitmap, hotX, hotY } = data;
    // The pointer is drawn `size` device-independent pixels big whatever the
    // interface zoom; this layer's pixels are zoomed ones.
    const scale = size / Math.max(bitmap.width, bitmap.height, 1) / zoom;
    return { source: bitmap, width: bitmap.width * scale, height: bitmap.height * scale, hotX: hotX * scale, hotY: hotY * scale };
  }, [data, size, zoom]);
}

/**
 * The layer cursor effects draw on (src/lib/cursorEffects): over the whole
 * screen, above everything, taking no input. Feeds the engine the user's
 * choices, the screen's size, and whether the system asks for less motion,
 * and switches power mode (src/lib/powerMode.ts), whose sparks it draws.
 * It's in the desktop's layer, not <body>, so it stays on top while that
 * layer is a modal dialog for something fullscreen on another monitor.
 */
export function CursorEffectsLayer() {
  const { config } = useAppContext();
  const layout = useContext(MonitorsContext);
  const host = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const cursor = useCursorImage(config.cursorTrail === 'mouse-trails', config.zoomLevel / 100);
  const bigCursor = useCursorImage(config.cursorShakeToFind, config.zoomLevel / 100, FIND_MAX_SCALE);

  useEffect(() => {
    const el = host.current;
    return el ? cursorEffects.mount(el) : undefined;
  }, []);

  useEffect(() => {
    cursorEffects.setEnabled(!reduced);
  }, [reduced]);

  useEffect(() => {
    cursorEffects.setSettings({
      trail: config.cursorTrail,
      click: config.cursorClick,
      showMouse: config.cursorShowMouse,
      shakeToFind: config.cursorShakeToFind,
      firePaint: config.cursorFirePaint,
      water: config.cursorWater,
    });
  }, [config.cursorTrail, config.cursorClick, config.cursorShowMouse, config.cursorShakeToFind, config.cursorFirePaint, config.cursorWater]);

  useEffect(() => {
    setPowerMode(config.powerMode && !reduced, config.powerModeShake);
  }, [config.powerMode, config.powerModeShake, reduced]);

  useEffect(() => {
    cursorEffects.setCursorImage(cursor);
  }, [cursor]);

  useEffect(() => {
    cursorEffects.setFindCursorImage(bigCursor);
  }, [bigCursor]);

  const tint = useCursorEffectTint(config.cursorThemeColor);
  useEffect(() => {
    cursorEffects.setTint(tint);
  }, [tint]);

  const width = layout?.width ?? window.innerWidth;
  const height = layout?.height ?? window.innerHeight;
  useEffect(() => {
    cursorEffects.setViewport(width, height);
  }, [width, height]);

  return createPortal(
    <ScreenLayer ref={host} aria-hidden className="pointer-events-none z-[2147483000] overflow-hidden" style={{ contain: 'strict' }} />,
    portalContainer(),
  );
}
