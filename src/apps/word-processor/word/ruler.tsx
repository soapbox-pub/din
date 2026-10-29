import { useRef, useState } from 'react';

/**
 * Word's horizontal ruler: the margins in gray, inches counted from the left
 * margin, and the paragraph's indent markers to drag: first line (the
 * triangle on top), hanging (the one below), left (the box under it, which
 * moves both) and right.
 */

export interface Indents {
  /** Pixels from the left margin. */
  left: number;
  /** The first line, relative to `left`. */
  first: number;
  /** Pixels from the right margin. */
  right: number;
}

type Marker = 'first' | 'hanging' | 'left' | 'right';

const STEP = 6; // 1/16 inch

export function Ruler({
  pageW,
  mLeft,
  mRight,
  zoom,
  indents,
  onChange,
}: {
  pageW: number;
  mLeft: number;
  mRight: number;
  zoom: number;
  indents: Indents;
  onChange: (i: Indents, done: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ marker: Marker; value: Indents } | null>(null);
  const shown = drag?.value ?? indents;
  const k = zoom / 100;
  const text = pageW - mLeft - mRight;

  const start = (marker: Marker) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = ref.current!.getBoundingClientRect();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const from = indents;
    const firstAbs = from.left + from.first;
    let value = from;
    const move = (ev: PointerEvent) => {
      const raw = (ev.clientX - box.left) / k - mLeft;
      const x = ev.altKey ? raw : Math.round(raw / STEP) * STEP;
      const clamp = (v: number) => Math.max(-mLeft, Math.min(text + mRight - 24, v));
      if (marker === 'first') value = { ...from, first: clamp(x) - from.left };
      else if (marker === 'hanging') value = { ...from, left: clamp(x), first: firstAbs - clamp(x) };
      else if (marker === 'left') value = { ...from, left: clamp(x) };
      else value = { ...from, right: Math.max(-mRight, Math.min(text - from.left - 24, text - x)) };
      setDrag({ marker, value });
      onChange(value, false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDrag(null);
      onChange(value, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  // Ticks every eighth of an inch, numbered every inch from the left margin.
  const ticks: React.ReactNode[] = [];
  const first = -Math.floor(mLeft / 12);
  const last = Math.floor((pageW - mLeft) / 12);
  for (let i = first; i <= last; i++) {
    const x = (mLeft + i * 12) * k;
    if (i % 8 === 0) {
      if (i !== 0)
        ticks.push(
          <span key={i} className="absolute top-[3px] -translate-x-1/2 text-[9px] leading-none text-[#424242] tabular-nums" style={{ left: x }}>
            {Math.abs(i / 8)}
          </span>,
        );
    } else {
      const h = i % 4 === 0 ? 6 : 3;
      ticks.push(<span key={i} className="absolute w-px bg-[#7a7a7a]" style={{ left: x, top: 9 - h / 2, height: h }} />);
    }
  }
  const at = (px: number) => (mLeft + px) * k;
  const tri = 'absolute h-0 w-0 cursor-ew-resize border-x-[5px] border-x-transparent';
  return (
    <div ref={ref} className="relative h-[18px] shrink-0 select-none" style={{ width: pageW * k }} aria-hidden>
      <div className="absolute inset-y-0 left-0 bg-[#d9d9d9]" style={{ width: mLeft * k }} />
      <div className="absolute inset-y-0 bg-white" style={{ left: mLeft * k, width: text * k }} />
      <div className="absolute inset-y-0 right-0 bg-[#d9d9d9]" style={{ width: mRight * k }} />
      <div className="absolute inset-0 border-y border-[#c8c8c8]" />
      {ticks}
      <span title="First Line Indent" onPointerDown={start('first')} className={`${tri} top-0 border-t-[7px] border-t-[#616161]`} style={{ left: at(shown.left + shown.first) - 5 }} />
      <span title="Hanging Indent" onPointerDown={start('hanging')} className={`${tri} top-[6px] border-b-[7px] border-b-[#616161]`} style={{ left: at(shown.left) - 5 }} />
      <span title="Left Indent" onPointerDown={start('left')} className="absolute top-[13px] h-[5px] w-[10px] cursor-ew-resize border border-[#616161] bg-[#f3f3f3]" style={{ left: at(shown.left) - 5 }} />
      <span title="Right Indent" onPointerDown={start('right')} className={`${tri} top-[6px] border-b-[7px] border-b-[#616161]`} style={{ left: at(text - shown.right) - 5 }} />
      {drag && <span className="pointer-events-none absolute top-[18px] w-px border-l border-dashed border-[#424242]" style={{ height: 4000, left: drag.marker === 'right' ? at(text - shown.right) : drag.marker === 'first' ? at(shown.left + shown.first) : at(shown.left) }} />}
    </div>
  );
}
