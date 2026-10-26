import { createContext, useContext, useRef, useState, type CSSProperties } from 'react';
import { useWindowChrome } from '@/contexts/WindowChromeContext';
import type { WinampSkin } from './skin';
import type { SpriteDef } from './sprites';

export const SkinContext = createContext<WinampSkin | null>(null);

export function useSkin(): WinampSkin {
  const skin = useContext(SkinContext);
  if (!skin) throw new Error('Winamp parts need a skin');
  return skin;
}

/** Background style showing one sprite (or a region of a sheet). */
export function spriteStyle(skin: WinampSkin, def: SpriteDef | readonly [SpriteDef[0], number, number, number, number]): CSSProperties {
  const [sheetName, x, y, width, height] = def;
  const sheet = skin.sheets[sheetName];
  if (!sheet) return { width, height };
  return {
    width,
    height,
    backgroundImage: `url("${sheet.url}")`,
    backgroundPosition: `-${x}px -${y}px`,
    backgroundRepeat: 'no-repeat',
  };
}

/** Drag the whole Din window from a skin's title bar. */
export function useWindowDrag() {
  const chrome = useWindowChrome();
  const moving = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (chrome.beginMove({ clientX: e.clientX, clientY: e.clientY })) {
        moving.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (moving.current) chrome.gestureMove({ clientX: e.clientX, clientY: e.clientY });
    },
    onPointerUp: () => {
      if (!moving.current) return;
      moving.current = false;
      chrome.gestureEnd();
    },
  };
}

/** A pointer drag across an element, reported as a fraction along it (0-1). */
export function useSliderDrag(
  axis: 'x' | 'y',
  onValue: (fraction: number, done: boolean) => void,
  thumb = 0,
) {
  const dragging = useRef(false);
  const [active, setActive] = useState(false);
  const at = (e: React.PointerEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // The element is scaled with the skin; rect is in screen pixels.
    const scale = axis === 'x' ? rect.width / (e.currentTarget as HTMLElement).offsetWidth : rect.height / (e.currentTarget as HTMLElement).offsetHeight;
    const size = (axis === 'x' ? rect.width : rect.height) - thumb * scale;
    const pos = (axis === 'x' ? e.clientX - rect.left : e.clientY - rect.top) - (thumb * scale) / 2;
    return Math.max(0, Math.min(1, size > 0 ? pos / size : 0));
  };
  return {
    active,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        dragging.current = true;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        onValue(at(e), false);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (dragging.current) onValue(at(e), false);
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!dragging.current) return;
        dragging.current = false;
        setActive(false);
        onValue(at(e), true);
      },
      onPointerCancel: () => {
        dragging.current = false;
        setActive(false);
      },
    },
  };
}
