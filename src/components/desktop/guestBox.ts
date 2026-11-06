import { useLayoutEffect, useState } from 'react';
import { findGuest } from '@/platform/guest';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a guest is on the screen, every frame while something is anchored to
 * it, so a window being dragged takes the suggestions along. Null while the
 * guest is hidden (a background tab, a minimized window).
 */
export function useGuestBox(wcId: number | null): Box | null {
  const [measured, setMeasured] = useState<{ wcId: number; box: Box | null } | null>(null);
  useLayoutEffect(() => {
    if (wcId === null) return;
    let frame = 0;
    let last = '';
    const measure = () => {
      const el = findGuest(wcId);
      const visible = !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const r = visible ? el.getBoundingClientRect() : null;
      const box = r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
      const key = JSON.stringify(box);
      if (key !== last) {
        last = key;
        setMeasured({ wcId, box });
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [wcId]);
  return measured && measured.wcId === wcId ? measured.box : null;
}
