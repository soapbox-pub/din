import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatTime, player, usePlayer } from '../engine';
import { VisCanvas } from '../din/common';
import { useWindowDrag } from '../winamp/hooks';
import { cssColor, maskRegion, type SkinImages } from '@/shared/skins/wmp/images';
import { useAttrs, useView } from './mirror';
import type { VmNode } from '@/shared/skins/wmp/protocol';
import { visForEffect } from './effects';

type Attrs = Record<string, unknown>;

const num = (v: unknown, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: unknown, fallback: boolean) => (v === undefined || v === null || v === '' ? fallback : v === true || v === 'true' || v === 1);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const hasHandler = (a: Attrs, name: string) => Array.isArray(a.__handlers) && (a.__handlers as string[]).includes(name);

const CURSORS: Record<string, string> = {
  hand: 'pointer', help: 'help', sizeall: 'move', sizenesw: 'nesw-resize', sizens: 'ns-resize', sizenwse: 'nwse-resize', sizewe: 'ew-resize', uparrow: 'default',
};

/** Ambient attributes as a positioned box. */
function boxStyle(a: Attrs): CSSProperties {
  return {
    position: 'absolute',
    left: num(a.left),
    top: num(a.top),
    width: Math.max(0, num(a.width)),
    height: Math.max(0, num(a.height)),
    display: bool(a.visible, true) ? undefined : 'none',
    opacity: a.alphablend !== undefined ? Math.max(0, Math.min(255, num(a.alphablend, 255))) / 255 : undefined,
    zIndex: num(a.zindex),
    // Containers take no clicks themselves, so every element opts back in.
    pointerEvents: bool(a.passthrough, false) ? 'none' : 'auto',
    cursor: CURSORS[str(a.cursor).toLowerCase()],
  };
}

/** The image for a name, honoring the album-art pseudo-images. */
function imageUrl(images: SkinImages, albumArt: string | null, name: unknown, key?: unknown): string | null {
  const n = str(name);
  if (!n) return null;
  if (/^wmpimage_albumart/i.test(n)) return albumArt;
  if (n.includes('://')) return null;
  return images.url(n, key);
}

function eventProps(e: React.PointerEvent | React.MouseEvent, target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  return {
    altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, button: e.button === 2 ? 2 : 1,
    clientX: e.clientX, clientY: e.clientY, x: e.clientX, y: e.clientY, screenX: e.screenX, screenY: e.screenY,
    offsetX: Math.round(e.clientX - rect.left), offsetY: Math.round(e.clientY - rect.top),
  };
}

/** Mouse events the skin listens for, sent to its script. */
function useMouse(node: VmNode, a: Attrs) {
  const { send } = useView();
  const fire = (name: string, e: React.PointerEvent | React.MouseEvent, attrs?: Attrs) => {
    if (!hasHandler(a, `on${name}`) && !attrs) return;
    send({ type: 'event', iid: node.iid, name, event: eventProps(e, e.currentTarget as HTMLElement), attrs });
  };
  return {
    fire,
    handlers: {
      onPointerEnter: (e: React.PointerEvent) => fire('mouseover', e),
      onPointerLeave: (e: React.PointerEvent) => fire('mouseout', e),
      onPointerMove: hasHandler(a, 'onmousemove') ? (e: React.PointerEvent) => fire('mousemove', e) : undefined,
      onDoubleClick: (e: React.MouseEvent) => fire('dblclick', e),
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * A VIEW or SUBVIEW. Its own box takes no clicks: only its background
 * does, where it's painted (a color, or the image's pixels that aren't the
 * transparency color), so a click on a see-through part reaches whatever
 * is behind - a drawer tucked under it, or one with a lower zIndex.
 */
function Container({ node, root }: { node: VmNode; root?: boolean }) {
  const a = useAttrs(node.iid);
  const { images, send } = useView();
  const drag = useWindowDrag();
  const bg = str(a.backgroundimage);
  const img = bg ? images.get(bg) : undefined;
  const w = num(a.width);
  const h = num(a.height);
  const transparency = a.transparencycolor;
  const clip = bg && (a.clippingcolor !== undefined || (root && transparency !== undefined))
    ? images.region(bg, a.clippingcolor ?? transparency, w, h)
    : str(a.clippingimage)
      ? images.region(a.clippingimage, a.clippingcolor ?? 'auto', w, h)
      : null;
  const url = bg ? images.url(bg, transparency ?? a.clippingcolor) : null;
  const background = cssColor(a.backgroundcolor) ?? (root && !bg && a.backgroundcolor === undefined ? '#fff' : undefined);
  const tiled = bool(a.backgroundtiled, false);
  const stretch = bool(a.resizebackgroundimage, false);
  const filters: string[] = [];
  if (num(a.backgroundimagehueshift)) filters.push(`hue-rotate(${num(a.backgroundimagehueshift)}deg)`);
  if (a.backgroundimagesaturation !== undefined && num(a.backgroundimagesaturation, 1) !== 1) filters.push(`saturate(${num(a.backgroundimagesaturation, 1)})`);
  const box = boxStyle(a);
  const style: CSSProperties = root
    ? { position: 'absolute', left: 0, top: 0, width: w, height: h, opacity: box.opacity }
    : box;
  // Where the background catches the pointer: all of it under a color,
  // else just the image's opaque pixels.
  const fill = !!background || tiled || stretch;
  const hit = fill || !img ? null : images.region(bg, transparency ?? a.clippingcolor ?? 'none');
  return (
    <div style={{ ...style, overflow: 'hidden', clipPath: clip ?? undefined, pointerEvents: 'none', isolation: 'isolate' }}>
      {(url || background) && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: fill || !img ? '100%' : img.w,
            height: fill || !img ? '100%' : img.h,
            backgroundColor: background,
            backgroundImage: url ? `url("${url}")` : undefined,
            backgroundRepeat: tiled ? 'repeat' : 'no-repeat',
            backgroundSize: stretch ? '100% 100%' : undefined,
            filter: filters.join(' ') || undefined,
            clipPath: hit ?? undefined,
            zIndex: 0,
            pointerEvents: box.pointerEvents === 'none' ? 'none' : 'auto',
          }}
          onPointerDown={(e) => {
            if (hasHandler(a, 'onmousedown')) send({ type: 'event', iid: node.iid, name: 'mousedown', event: eventProps(e, e.currentTarget) });
            drag.onPointerDown(e);
          }}
          onPointerMove={drag.onPointerMove}
          onPointerUp={(e) => {
            drag.onPointerUp();
            if (hasHandler(a, 'onmouseup')) send({ type: 'event', iid: node.iid, name: 'mouseup', event: eventProps(e, e.currentTarget) });
          }}
          onClick={(e) => {
            if (hasHandler(a, 'onclick')) send({ type: 'event', iid: node.iid, name: 'click', event: eventProps(e, e.currentTarget) });
          }}
        />
      )}
      <Children nodes={node.children} />
    </div>
  );
}

function Children({ nodes }: { nodes: VmNode[] }) {
  return (
    <>
      {nodes.map((n) => (
        <Element key={n.iid} node={n} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

function Button({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { images, albumArt, send } = useView();
  const { fire, handlers } = useMouse(node, a);
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const enabled = bool(a.enabled, true);
  const down = bool(a.down, false);
  const sticky = bool(a.sticky, false);
  const key = a.transparencycolor;
  const pick = () => {
    if (!enabled) return a.disabledimage ?? a.image;
    if ((pressed && hover) || down) return hover ? (a.hoverdownimage ?? a.downimage ?? a.image) : (a.downimage ?? a.image);
    if (hover) return a.hoverimage ?? a.image;
    return a.image;
  };
  const url = imageUrl(images, albumArt, pick(), key);
  const clip = str(a.clippingimage) ? images.region(a.clippingimage, a.clippingcolor ?? 'auto', num(a.width), num(a.height)) : null;
  const tip = str(down ? (a.downtooltip ?? a.uptooltip) : a.uptooltip) || str(a.tooltip);
  return (
    <div
      role="button"
      aria-label={tip || str(a.accname) || node.attrs.id}
      aria-pressed={sticky ? down : undefined}
      aria-disabled={!enabled}
      title={tip && !tip.startsWith('res://') ? tip : undefined}
      style={{
        ...boxStyle(a),
        clipPath: clip ?? undefined,
        backgroundImage: url ? `url("${url}")` : undefined,
        backgroundRepeat: bool(a.tiled, false) ? 'repeat' : 'no-repeat',
        backgroundSize: bool(a.resizeimages, false) ? '100% 100%' : undefined,
      }}
      {...handlers}
      onPointerEnter={(e) => {
        setHover(true);
        handlers.onPointerEnter(e);
      }}
      onPointerLeave={(e) => {
        setHover(false);
        handlers.onPointerLeave(e);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!enabled || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressed(true);
        fire('mousedown', e);
      }}
      onPointerUp={(e) => {
        if (!pressed) return;
        setPressed(false);
        fire('mouseup', e);
        const inside = e.currentTarget.contains(document.elementFromPoint(e.clientX, e.clientY));
        if (!inside || !enabled) return;
        send({ type: 'event', iid: node.iid, name: 'click', event: eventProps(e, e.currentTarget), attrs: sticky ? { down: !down } : undefined });
      }}
    />
  );
}

/** One image of buttons, a mapping image saying which pixel is whose. */
function ButtonGroup({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { images, mirror, send } = useView();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(-1);
  const [pressed, setPressed] = useState(-1);
  const drag = useWindowDrag();
  const [, setVersion] = useState(0);
  const map = images.get(a.mappingimage);
  const w = num(a.width, map?.w ?? 0);
  const h = num(a.height, map?.h ?? 0);
  const children = node.children;

  // Children's attributes (visible, enabled, down, colors) drive the drawing.
  useEffect(() => {
    const unsubs = children.map((c) => mirror.subscribe(c.iid, () => setVersion((v) => v + 1)));
    return () => unsubs.forEach((u) => u());
  }, [children, mirror]);

  const colors = children.map((c) => {
    const color = cssColor(mirror.get(c.iid)?.mappingcolor);
    return color ?? null;
  });
  const indexAt = useMemo(() => {
    if (!map) return null;
    const keys = new Map<number, number>();
    colors.forEach((c, i) => {
      const m = c && /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
      if (m) keys.set((Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]), i);
    });
    const out = new Int16Array(map.w * map.h).fill(-1);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      const k = keys.get((map.data[i] << 16) | (map.data[i + 1] << 8) | map.data[i + 2]);
      if (k !== undefined) out[p] = k;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- colors is derived from mirror, keyed by its string
  }, [map, colors.join('|')]);

  const states = children.map((c) => mirror.get(c.iid) ?? {});
  const stateKey = states.map((s, i) => `${bool(s.visible, true)}${bool(s.enabled, true)}${bool(s.down, false)}${hover === i}${pressed === i}`).join();

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !map || !indexAt) return;
    const key = a.transparencycolor;
    const layer = (name: unknown) => {
      const img = images.get(name);
      if (!img) return null;
      return { img, mask: key !== undefined ? images.mask(name, key) : null };
    };
    const base = layer(a.image);
    const hoverL = layer(a.hoverimage ?? a.image);
    const downL = layer(a.downimage ?? a.image);
    const hoverDownL = layer(a.hoverdownimage ?? a.downimage ?? a.image);
    const disabledL = layer(a.disabledimage ?? a.image);
    const showBackground = bool(a.showbackground, false);
    const out = ctx.createImageData(map.w, map.h);
    for (let p = 0; p < indexAt.length; p++) {
      const idx = indexAt[p];
      let src: ReturnType<typeof layer> = null;
      if (idx >= 0) {
        const s = states[idx];
        if (bool(s.visible, true)) {
          const down = bool(s.down, false) || pressed === idx;
          src = !bool(s.enabled, true) ? disabledL : down && hover === idx ? hoverDownL : down ? downL : hover === idx ? hoverL : base;
        } else if (showBackground) src = base;
      } else if (showBackground) src = base;
      if (!src || p >= src.img.w * src.img.h) continue;
      const x = p % map.w;
      const y = Math.floor(p / map.w);
      if (x >= src.img.w || y >= src.img.h) continue;
      const q = y * src.img.w + x;
      if (src.mask && !src.mask[q]) continue;
      out.data.set(src.img.data.subarray(q * 4, q * 4 + 4), p * 4);
    }
    ctx.putImageData(out, 0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraws when any button's state (stateKey) changes
  }, [map, indexAt, stateKey, a.image, a.hoverimage, a.downimage, a.hoverdownimage, a.disabledimage, a.transparencycolor, a.showbackground, images]);

  // Only the buttons' pixels take clicks (all of the image's, shown whole).
  const showBackground = bool(a.showbackground, false);
  const visibleKey = states.map((st) => (bool(st.visible, true) ? 1 : 0)).join('');
  const hitClip = useMemo(() => {
    if (!map || !indexAt || showBackground) return null;
    const mask = new Uint8Array(indexAt.length);
    for (let p = 0; p < mask.length; p++) mask[p] = indexAt[p] >= 0 && visibleKey[indexAt[p]] === '1' ? 1 : 0;
    return maskRegion(mask, map.w, map.h);
  }, [map, indexAt, showBackground, visibleKey]);

  const at = (e: React.PointerEvent | React.MouseEvent) => {
    if (!map || !indexAt) return -1;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * w);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * h);
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return -1;
    const idx = indexAt[y * map.w + x];
    if (idx < 0) return -1;
    const s = states[idx];
    return bool(s.visible, true) && bool(s.enabled, true) ? idx : -1;
  };
  const fireChild = (idx: number, name: string, e: React.PointerEvent | React.MouseEvent, attrs?: Attrs) => {
    const child = children[idx];
    if (!child) return;
    const s = states[idx];
    if (!attrs && !hasHandler(s, `on${name}`)) return;
    send({ type: 'event', iid: child.iid, name, event: eventProps(e, e.currentTarget as HTMLElement), attrs });
  };
  const tipOf = (idx: number) => {
    const s = states[idx];
    if (!s) return undefined;
    const tip = str(bool(s.down, false) ? (s.downtooltip ?? s.uptooltip) : s.uptooltip);
    return tip && !tip.startsWith('res://') ? tip : undefined;
  };
  const cursorOf = (idx: number) => CURSORS[str(states[idx]?.cursor ?? a.cursor).toLowerCase()];

  return (
    <canvas
      ref={canvasRef}
      width={map?.w ?? 1}
      height={map?.h ?? 1}
      role="group"
      aria-label={str(a.accname) || node.attrs.id || 'Buttons'}
      title={hover >= 0 ? tipOf(hover) : undefined}
      style={{ ...boxStyle(a), width: w, height: h, clipPath: hitClip ?? undefined, cursor: hover >= 0 ? cursorOf(hover) : undefined }}
      onPointerMove={(e) => {
        drag.onPointerMove(e);
        const idx = at(e);
        if (idx !== hover) {
          if (hover >= 0) fireChild(hover, 'mouseout', e);
          if (idx >= 0) fireChild(idx, 'mouseover', e);
          setHover(idx);
        }
      }}
      onPointerLeave={(e) => {
        if (hover >= 0) fireChild(hover, 'mouseout', e);
        setHover(-1);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const idx = at(e);
        if (idx < 0) {
          drag.onPointerDown(e);
          return;
        }
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setPressed(idx);
        fireChild(idx, 'mousedown', e);
      }}
      onPointerUp={(e) => {
        drag.onPointerUp();
        const was = pressed;
        setPressed(-1);
        if (was < 0) return;
        fireChild(was, 'mouseup', e);
        if (at(e) !== was) return;
        const s = states[was];
        const sticky = bool(s.sticky, false) || bool(a.radio, false);
        if (bool(a.radio, false)) {
          children.forEach((c, i) => i !== was && bool(states[i].down, false) && send({ type: 'attrs', iid: c.iid, attrs: { down: false } }));
        }
        fireChild(was, 'click', e, sticky ? { down: bool(a.radio, false) ? true : !bool(s.down, false) } : {});
      }}
    />
  );
}

// ---------------------------------------------------------------------------

/** Pointer drags along a slider, reported as the pointer's position over the element (0-1 along its axis). */
function useDrag(onMove: (e: React.PointerEvent, rect: DOMRect) => void, onEnd: (e: React.PointerEvent, rect: DOMRect) => void, onBegin: (e: React.PointerEvent) => void) {
  const active = useRef(false);
  const [dragging, setDragging] = useState(false);
  return {
    dragging,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        active.current = true;
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        onBegin(e);
        onMove(e, e.currentTarget.getBoundingClientRect());
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (active.current) onMove(e, e.currentTarget.getBoundingClientRect());
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!active.current) return;
        active.current = false;
        setDragging(false);
        onEnd(e, e.currentTarget.getBoundingClientRect());
      },
    },
  };
}

/**
 * A slider's track. Tiled, it's three slices along its direction: the
 * first and last borderSize pixels are end caps, and the middle repeats.
 */
function trackStyle(url: string, img: { w: number; h: number } | undefined, tiled: boolean, vertical: boolean, border: number, w: number, h: number): CSSProperties {
  const length = vertical ? h : w;
  const imgLength = img ? (vertical ? img.h : img.w) : length;
  if (!tiled || !img || imgLength >= length) {
    return { backgroundImage: `url("${url}")`, backgroundRepeat: 'no-repeat', backgroundPosition: vertical ? 'center bottom' : 'left center' };
  }
  const cap = Math.max(0, Math.min(border, Math.floor((imgLength - 1) / 2)));
  if (cap === 0) {
    return { backgroundImage: `url("${url}")`, backgroundRepeat: vertical ? 'repeat-y' : 'repeat-x', backgroundPosition: vertical ? 'center bottom' : 'left center' };
  }
  const cross = vertical ? img.w : img.h;
  const across = vertical ? (w - cross) / 2 : (h - cross) / 2;
  return {
    ...(vertical ? { left: across, right: across } : { top: across, bottom: across }),
    borderImageSource: `url("${url}")`,
    borderImageSlice: vertical ? `${cap} 0 fill` : `0 ${cap} fill`,
    borderImageWidth: vertical ? `${cap}px 0` : `0 ${cap}px`,
    borderImageRepeat: vertical ? 'stretch repeat' : 'repeat stretch',
  };
}

function Slider({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { images, albumArt, send } = useView();
  const [local, setLocal] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const min = num(a.min, 0);
  const max = num(a.max, 100);
  const w = num(a.width);
  const h = num(a.height);
  const vertical = str(a.direction).toLowerCase() === 'vertical';
  const border = num(a.bordersize);
  const enabled = bool(a.enabled, true);
  const value = local ?? num(a.value, min);
  const f = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  const length = vertical ? h : w;
  const pos = border + f * (length - 2 * border);
  const key = a.transparencycolor;
  const thumbName = !enabled ? (a.thumbdisabledimage ?? a.thumbimage) : local !== null ? (a.thumbdownimage ?? a.thumbimage) : hover ? (a.thumbhoverimage ?? a.thumbimage) : a.thumbimage;
  const thumb = images.get(thumbName);
  const thumbUrl = imageUrl(images, albumArt, thumbName, key);
  const bgName = !enabled ? (a.disabledimage ?? a.backgroundimage) : hover ? (a.backgroundhoverimage ?? a.backgroundimage) : a.backgroundimage;
  const fgName = hover ? (a.foregroundhoverimage ?? a.foregroundimage) : a.foregroundimage;
  const bgUrl = imageUrl(images, albumArt, bgName, key);
  const fgUrl = enabled ? imageUrl(images, albumArt, fgName, key) : null;
  const fgImg = images.get(fgName);
  const tiled = bool(a.tiled, true);
  const slide = bool(a.slide, true);
  const valueAt = (e: React.PointerEvent, rect: DOMRect) => {
    const scale = vertical ? rect.height / h : rect.width / w;
    const p = vertical ? (rect.bottom - e.clientY) / scale : (e.clientX - rect.left) / scale;
    const frac = Math.max(0, Math.min(1, (p - border) / Math.max(1, length - 2 * border)));
    return min + frac * (max - min);
  };
  const interactive = enabled && !!a.thumbimage;
  const { handlers } = useDrag(
    (e, rect) => {
      const v = valueAt(e, rect);
      setLocal(v);
      send({ type: 'event', iid: node.iid, name: 'positionchange', attrs: { value: v } });
    },
    (e, rect) => {
      const v = valueAt(e, rect);
      send({ type: 'event', iid: node.iid, name: 'dragend', attrs: { value: v } });
      setLocal(null);
    },
    () => send({ type: 'event', iid: node.iid, name: 'dragbegin' }),
  );
  const fgColor = cssColor(a.foregroundcolor) ?? (a.backgroundcolor !== undefined && !fgUrl && !bgUrl ? '#fff' : undefined);
  const bgColor = cssColor(a.backgroundcolor);
  const grad = (from: string | undefined, to: unknown) => (from && cssColor(to) ? `linear-gradient(${vertical ? 'to top' : 'to right'}, ${from}, ${cssColor(to)})` : undefined);
  const tip = str(a.tooltip);
  const fillStyle: CSSProperties = vertical ? { left: 0, right: 0, bottom: 0, height: pos } : { top: 0, bottom: 0, left: 0, width: pos };
  return (
    <div
      role="slider"
      aria-label={tip || str(a.accname) || node.attrs.id || 'Slider'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      title={tip && !tip.startsWith('res://') ? tip : undefined}
      tabIndex={interactive ? 0 : -1}
      onKeyDown={(e) => {
        const step = (max - min) / 20;
        const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? step : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -step : 0;
        if (!d || !interactive) return;
        e.preventDefault();
        e.stopPropagation();
        const v = Math.max(min, Math.min(max, value + d));
        send({ type: 'event', iid: node.iid, name: 'positionchange', attrs: { value: v } });
        send({ type: 'event', iid: node.iid, name: 'dragend', attrs: { value: v } });
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      {...(interactive ? handlers : { onPointerDown: (e: React.PointerEvent) => e.stopPropagation() })}
      style={{ ...boxStyle(a), outline: 'none', background: grad(bgColor, a.backgroundendcolor) ?? bgColor, overflow: 'hidden' }}
    >
      {bgUrl && (
        <div style={{ position: 'absolute', inset: 0, ...trackStyle(bgUrl, images.get(bgName), tiled, vertical, border, w, h) }} />
      )}
      {enabled && (fgUrl || fgColor) && (
        <div style={{ position: 'absolute', overflow: 'hidden', ...fillStyle }}>
          <div
            style={{
              position: 'absolute',
              ...(vertical ? { left: 0, right: 0, bottom: slide && fgImg ? pos - fgImg.h : 0, height: slide && fgImg ? fgImg.h : h } : { top: 0, bottom: 0, left: slide && fgImg ? pos - fgImg.w : 0, width: slide && fgImg ? fgImg.w : w }),
              // An undefined `background` shorthand would still reset the image, so only one is set.
              ...(fgUrl
                ? { backgroundImage: `url("${fgUrl}")`, backgroundRepeat: tiled && !slide ? (vertical ? 'repeat-y' : 'repeat-x') : 'no-repeat' }
                : { background: grad(fgColor, a.foregroundendcolor) ?? fgColor }),
            }}
          />
        </div>
      )}
      {thumbUrl && thumb && (
        <div
          style={{
            position: 'absolute',
            width: thumb.w,
            height: thumb.h,
            left: vertical ? (w - thumb.w) / 2 : pos - thumb.w / 2,
            top: vertical ? h - pos - thumb.h / 2 : (h - thumb.h) / 2,
            backgroundImage: `url("${thumbUrl}")`,
          }}
        />
      )}
    </div>
  );
}

function CustomSlider({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { images, send } = useView();
  const [local, setLocal] = useState<number | null>(null);
  const [hover, setHover] = useState(false);
  const posImg = images.get(a.positionimage);
  const enabled = bool(a.enabled, true);
  const name = !enabled ? (a.disabledimage ?? a.image) : local !== null ? (a.downimage ?? a.image) : hover ? (a.hoverimage ?? a.image) : a.image;
  const strip = images.get(name);
  const fw = posImg?.w ?? num(a.width);
  const fh = posImg?.h ?? num(a.height);
  const horizontal = !!strip && strip.w > fw;
  const frames = strip ? Math.max(1, horizontal ? Math.round(strip.w / fw) : Math.round(strip.h / fh)) : 1;
  const min = num(a.min, 0);
  const max = num(a.max, 100);
  const value = local ?? num(a.value, min);
  const k = max > min ? Math.round(((value - min) / (max - min)) * (frames - 1)) : 0;
  const url = images.url(name, a.transparencycolor);
  const valueAt = (e: React.PointerEvent, rect: DOMRect): number | null => {
    const x = ((e.clientX - rect.left) / rect.width) * fw;
    const y = ((e.clientY - rect.top) / rect.height) * fh;
    const px = images.pixel(a.positionimage, x, y);
    if (!px || px[0] !== px[1] || px[1] !== px[2]) return null;
    const frame = Math.round((px[0] * (frames - 1)) / 255);
    return frames > 1 ? min + (frame * (max - min)) / (frames - 1) : min;
  };
  const { handlers } = useDrag(
    (e, rect) => {
      const v = valueAt(e, rect);
      if (v === null) return;
      setLocal(v);
      send({ type: 'event', iid: node.iid, name: 'positionchange', attrs: { value: v } });
    },
    (e, rect) => {
      const v = valueAt(e, rect) ?? local;
      send({ type: 'event', iid: node.iid, name: 'dragend', attrs: v !== null ? { value: v } : undefined });
      setLocal(null);
    },
    () => send({ type: 'event', iid: node.iid, name: 'dragbegin' }),
  );
  const clip = images.region(a.positionimage, '#ff00ff', fw, fh);
  const tip = str(a.tooltip);
  return (
    <div
      role="slider"
      aria-label={tip || node.attrs.id || 'Dial'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      title={tip && !tip.startsWith('res://') ? tip : undefined}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      {...(enabled ? handlers : {})}
      style={{
        ...boxStyle(a),
        width: fw,
        height: fh,
        clipPath: clip ?? undefined,
        backgroundImage: url ? `url("${url}")` : undefined,
        backgroundPosition: horizontal ? `-${k * fw}px 0` : `0 -${k * fh}px`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}

// ---------------------------------------------------------------------------

function fontCss(a: Attrs, hover: boolean, enabled: boolean): CSSProperties {
  const style = str(!enabled ? (a.disabledfontstyle ?? a.fontstyle) : hover ? (a.hoverfontstyle ?? a.fontstyle) : a.fontstyle).toLowerCase();
  const normal = style.includes('normal');
  const face = str(a.fontface) || 'Tahoma';
  return {
    fontFamily: `"${face.replace(/"/g, '')}", Tahoma, Verdana, Arial, sans-serif`,
    fontSize: (num(a.fontsize, 10) * 96) / 72,
    fontWeight: !normal && style.includes('bold') ? 700 : 400,
    fontStyle: !normal && style.includes('italic') ? 'italic' : 'normal',
    textDecoration: !normal ? [style.includes('underline') && 'underline', style.includes('strikeout') && 'line-through'].filter(Boolean).join(' ') || undefined : undefined,
    lineHeight: 1.2,
  };
}

function Text({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { send } = useView();
  const { handlers } = useMouse(node, a);
  const drag = useWindowDrag();
  const [hover, setHover] = useState(false);
  const enabled = bool(a.enabled, true);
  const value = str(a.value);
  const scrolling = bool(a.scrolling, false);
  const [scroll, setScroll] = useState({ offset: 0, half: 0 });
  const innerRef = useRef<HTMLSpanElement>(null);
  const amount = Math.max(1, num(a.scrollingamount, 6));
  const delay = Math.max(30, num(a.scrollingdelay, 85));
  const right = str(a.scrollingdirection).toLowerCase() === 'right';
  useEffect(() => {
    if (!scrolling) return;
    const t = window.setInterval(() => {
      const half = (innerRef.current?.scrollWidth ?? 0) / 2;
      if (half > 0) setScroll((s) => ({ offset: (s.offset + amount) % half, half }));
    }, delay);
    return () => window.clearInterval(t);
  }, [scrolling, amount, delay]);
  const color = cssColor(!enabled ? (a.disabledforegroundcolor ?? a.foregroundcolor) : hover ? (a.hoverforegroundcolor ?? a.foregroundcolor) : a.foregroundcolor) ?? '#000';
  const bg = cssColor(!enabled ? (a.disabledbackgroundcolor ?? a.backgroundcolor) : hover ? (a.hoverbackgroundcolor ?? a.backgroundcolor) : a.backgroundcolor);
  const justify = str(a.justification).toLowerCase();
  const wrap = bool(a.wordwrap, false);
  const clickable = hasHandler(a, 'onclick') || hasHandler(a, 'onmousedown');
  const tip = str(a.tooltip);
  return (
    <div
      {...handlers}
      onPointerEnter={(e) => {
        setHover(true);
        handlers.onPointerEnter(e);
      }}
      onPointerLeave={(e) => {
        setHover(false);
        handlers.onPointerLeave(e);
      }}
      onPointerDown={(e) => {
        if (!clickable) return;
        e.stopPropagation();
        if (hasHandler(a, 'onmousedown')) send({ type: 'event', iid: node.iid, name: 'mousedown', event: eventProps(e, e.currentTarget) });
      }}
      onPointerMove={drag.onPointerMove}
      onClick={(e) => clickable && enabled && send({ type: 'event', iid: node.iid, name: 'click', event: eventProps(e, e.currentTarget) })}
      title={tip ? (tip.startsWith('res://') ? undefined : tip) : value || undefined}
      role={clickable ? 'button' : undefined}
      style={{
        ...boxStyle(a),
        ...fontCss(a, hover, enabled),
        color,
        backgroundColor: bg,
        textAlign: justify === 'right' ? 'right' : justify === 'center' ? 'center' : 'left',
        whiteSpace: wrap ? 'normal' : 'nowrap',
        overflow: 'hidden',
        textOverflow: scrolling || wrap ? undefined : 'ellipsis',
        userSelect: 'none',
      }}
    >
      {scrolling ? (
        <span ref={innerRef} style={{ display: 'inline-block', whiteSpace: 'nowrap', transform: `translateX(${right ? scroll.offset - scroll.half : -scroll.offset}px)` }}>
          {value}&nbsp;&nbsp;{value}&nbsp;&nbsp;
        </span>
      ) : (
        value
      )}
    </div>
  );
}

function Video({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const ref = useRef<HTMLDivElement>(null);
  const video = usePlayer((s) => !!s.queue[s.current]?.video);
  useEffect(() => (video && ref.current ? player.attachVideo(ref.current) : undefined), [video]);
  return <div ref={ref} style={{ ...boxStyle(a), backgroundColor: cssColor(a.backgroundcolor) }} onPointerDown={(e) => e.stopPropagation()} onClick={() => player.toggle()} />;
}

function Effects({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { send } = useView();
  const vis = visForEffect(num(a.__effect), num(a.currentpreset));
  return (
    <div
      style={{ ...boxStyle(a), backgroundColor: '#000' }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => hasHandler(a, 'onclick') && send({ type: 'event', iid: node.iid, name: 'click', event: eventProps(e, e.currentTarget) })}
      title={str(a.tooltip) || undefined}
    >
      {vis === 'art' ? <AlbumArt /> : <VisCanvas vis={vis} className="absolute inset-0" />}
    </div>
  );
}

function AlbumArt() {
  const { albumArt } = useView();
  return albumArt ? <img src={albumArt} alt="" className="absolute inset-0 size-full object-contain" /> : null;
}

function Playlist({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { send } = useView();
  const queue = usePlayer((s) => s.queue);
  const current = usePlayer((s) => s.current);
  const selected = new Set(Array.isArray(a.__selected) ? (a.__selected as number[]) : []);
  const fg = cssColor(a.foregroundcolor) ?? '#000';
  const bg = cssColor(a.backgroundcolor) ?? '#fff';
  const select = (i: number, e: React.MouseEvent) => {
    const next = e.ctrlKey ? new Set(selected) : new Set<number>();
    if (e.ctrlKey && next.has(i)) next.delete(i);
    else next.add(i);
    send({ type: 'attrs', iid: node.iid, attrs: { __selected: [...next] } });
  };
  const visible = bool(a.playlistitemsvisible, true);
  return (
    <div
      role="listbox"
      aria-label="Playlist"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{ ...boxStyle(a), backgroundColor: bg, color: fg, overflowY: 'auto', fontFamily: 'Tahoma, Verdana, sans-serif', fontSize: 11 }}
      className="mp-scroll"
    >
      {visible &&
        queue.map((t, i) => {
          const playing = i === current;
          const sel = selected.has(i);
          return (
            <div
              key={t.key}
              role="option"
              aria-selected={sel}
              onClick={(e) => select(i, e)}
              onDoubleClick={() => player.playIndex(i)}
              style={{
                display: 'flex',
                gap: 8,
                padding: '1px 4px',
                cursor: 'default',
                color: sel ? (cssColor(a.itemselectedcolor) ?? '#fff') : playing ? (cssColor(a.itemplayingcolor) ?? '#00ff00') : t.failed ? (cssColor(a.itemerrorcolor) ?? 'red') : undefined,
                backgroundColor: sel ? (cssColor(a.itemselectedbackgroundcolor) ?? '#316ac5') : playing ? (cssColor(a.itemplayingbackgroundcolor) ?? undefined) : undefined,
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              <span>{formatTime(t.duration)}</span>
            </div>
          );
        })}
    </div>
  );
}

function EditBox({ node }: { node: VmNode }) {
  const a = useAttrs(node.iid);
  const { send } = useView();
  return (
    <input
      value={str(a.value)}
      readOnly={bool(a.readonly, false)}
      onChange={(e) => send({ type: 'attrs', iid: node.iid, attrs: { value: e.target.value } })}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (hasHandler(a, 'onkeydown')) send({ type: 'event', iid: node.iid, name: 'keydown', event: { keyCode: e.keyCode } });
      }}
      style={{ ...boxStyle(a), ...fontCss(a, false, true), color: cssColor(a.foregroundcolor) ?? '#000', backgroundColor: cssColor(a.backgroundcolor) ?? '#fff', border: bool(a.border, true) ? '2px inset #ccc' : 'none', padding: '0 2px' }}
    />
  );
}

function ListBox({ node, popup }: { node: VmNode; popup: boolean }) {
  const a = useAttrs(node.iid);
  const { send } = useView();
  const items = Array.isArray(a.__items) ? (a.__items as string[]) : [];
  const shown = popup ? bool(a.__shown, false) : bool(a.visible, true);
  const selectedItem = num(a.selecteditem, -1);
  if (!shown) return null;
  return (
    <div
      role="listbox"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        ...boxStyle(a),
        display: undefined,
        width: popup ? undefined : num(a.width),
        height: popup ? undefined : num(a.height),
        minWidth: popup ? 80 : undefined,
        zIndex: popup ? 1000 : num(a.zindex),
        ...fontCss(a, false, true),
        color: cssColor(a.foregroundcolor) ?? '#000',
        backgroundColor: cssColor(a.backgroundcolor) ?? '#fff',
        border: '1px solid #888',
        overflowY: 'auto',
        boxShadow: popup ? '2px 2px 6px rgb(0 0 0 / 0.4)' : undefined,
      }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          role="option"
          aria-selected={i === selectedItem}
          onClick={() => send({ type: 'attrs', iid: node.iid, attrs: popup ? { selecteditem: i, __shown: false } : { selecteditem: i } })}
          style={{ padding: '1px 6px', background: i === selectedItem ? '#316ac5' : undefined, color: i === selectedItem ? '#fff' : undefined, cursor: 'default', whiteSpace: 'nowrap' }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}

const NON_VISUAL = new Set(['player', 'settings', 'controls', 'equalizersettings', 'videosettings', 'mediacenter', 'automenu', 'playerapplication', 'column', 'item', 'theme', 'skinimages']);

export function Element({ node }: { node: VmNode }): ReactNode {
  if (NON_VISUAL.has(node.tag)) return null;
  switch (node.tag) {
    case 'view':
      return <Container node={node} root />;
    case 'subview':
      return <Container node={node} />;
    case 'button':
    case 'buttonelement':
      return <Button node={node} />;
    case 'buttongroup':
      return <ButtonGroup node={node} />;
    case 'slider':
    case 'progressbar':
      return <Slider node={node} />;
    case 'customslider':
      return <CustomSlider node={node} />;
    case 'text':
      return <Text node={node} />;
    case 'video':
      return <Video node={node} />;
    case 'effects':
      return <Effects node={node} />;
    case 'playlist':
      return <Playlist node={node} />;
    case 'editbox':
      return <EditBox node={node} />;
    case 'listbox':
      return <ListBox node={node} popup={false} />;
    case 'popup':
      return <ListBox node={node} popup />;
    default:
      return null;
  }
}
