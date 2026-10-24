import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { Deck, Slide, SlideCtx } from './model';
import { SlideImage } from './render';

/**
 * The slide thumbnails down the left of Normal view, and Slide Sorter's
 * grid of them: click to go to a slide, Shift/Ctrl to select several,
 * drag to reorder, right-click for the slide menu.
 */

const ACCENT = '#c43e1c';

const Thumb = memo(function Thumb({
  ratio,
  slide,
  index,
  width,
  ctxFor,
  selected,
  current,
}: {
  /** Height over width. */
  ratio: number;
  slide: Slide;
  index: number;
  width: number;
  ctxFor: (slide: Slide, index: number) => SlideCtx | null;
  selected: boolean;
  current: boolean;
}) {
  const ctx = useMemo(() => ctxFor(slide, index), [ctxFor, slide, index]);
  return (
    <div
      className={cn('relative overflow-hidden rounded-[3px] bg-white', slide.hidden && 'opacity-50')}
      style={{
        boxShadow: current ? `0 0 0 2px ${ACCENT}` : selected ? `0 0 0 2px ${ACCENT}99` : '0 0 0 1px #c8c8c8',
        width,
        height: width * ratio,
      }}
    >
      {ctx && <SlideImage ctx={ctx} width={width} />}
    </div>
  );
});

export function ThumbPane({
  deck,
  current,
  selected,
  ctxFor,
  onPick,
  onMove,
  onContext,
  onFocus,
  width,
  grid,
  onOpen,
}: {
  deck: Deck;
  current: number;
  selected: Set<string>;
  ctxFor: (slide: Slide, index: number) => SlideCtx | null;
  onPick: (index: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => void;
  onMove: (uids: string[], to: number) => void;
  onContext: (at: { x: number; y: number }, index: number | null) => void;
  onFocus: () => void;
  width: number;
  /** Slide Sorter: a grid instead of a column. */
  grid?: boolean;
  onOpen?: (index: number) => void;
}) {
  const [drop, setDrop] = useState<number | null>(null);
  const dragging = useRef<string[] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the current slide in view.
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const thumbW = grid ? width : Math.max(80, width - 48);
  return (
    <div
      ref={listRef}
      tabIndex={-1}
      role="listbox"
      aria-label="Slides"
      aria-multiselectable
      className={cn('min-h-0 overflow-y-auto outline-none', grid ? 'flex flex-1 flex-wrap content-start gap-x-6 gap-y-8 bg-[#f3f3f3] p-8' : 'h-full py-3 pr-3')}
      onPointerDown={() => onFocus()}
      onContextMenu={(e) => {
        e.preventDefault();
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
        onContext({ x: e.clientX, y: e.clientY }, el ? Number(el.dataset.index) : null);
      }}
      onDragOver={(e) => {
        if (!dragging.current) return;
        e.preventDefault();
        const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-index]') ?? []);
        let at = items.length;
        for (const it of items) {
          const r = it.getBoundingClientRect();
          const before = grid ? e.clientY < r.bottom && e.clientX < r.left + r.width / 2 && e.clientY > r.top - 16 : e.clientY < r.top + r.height / 2;
          if (before) {
            at = Number(it.dataset.index);
            break;
          }
        }
        setDrop(at);
      }}
      onDragLeave={(e) => {
        if (!listRef.current?.contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragging.current && drop !== null) onMove(dragging.current, drop);
        dragging.current = null;
        setDrop(null);
      }}
    >
      {deck.slides.map((s, i) => {
        const isSel = selected.has(s.uid);
        return (
          <div
            key={s.uid}
            data-index={i}
            role="option"
            aria-selected={isSel}
            aria-label={`Slide ${i + 1}${s.hidden ? ', hidden' : ''}`}
            draggable
            onDragStart={(e) => {
              const uids = isSel ? deck.slides.filter((x) => selected.has(x.uid)).map((x) => x.uid) : [s.uid];
              dragging.current = uids;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', `slides:${uids.length}`);
            }}
            onDragEnd={() => {
              dragging.current = null;
              setDrop(null);
            }}
            onMouseDown={(e) => {
              if (e.button === 0) onPick(i, e);
              else if (e.button === 2 && !isSel) onPick(i, { shiftKey: false, ctrlKey: false, metaKey: false });
            }}
            onDoubleClick={() => onOpen?.(i)}
            className={cn('relative flex cursor-default select-none', grid ? 'flex-col items-start gap-1.5' : 'items-start gap-1.5 py-1.5 pl-1')}
          >
            {drop === i && <span className={cn('pointer-events-none absolute z-10 bg-[#c43e1c]', grid ? '-left-3.5 top-0 bottom-6 w-[3px]' : 'top-[-2px] right-0 left-6 h-[3px]')} />}
            {!grid && (
              <span className={cn('w-6 shrink-0 pt-0.5 text-right text-[12px] tabular-nums', i === current ? 'font-semibold text-[#c43e1c]' : 'text-[#424242]')}>
                {s.hidden ? <span className="inline-block border border-[#616161] px-[2px] leading-[13px] line-through">{i + 1}</span> : i + 1}
              </span>
            )}
            <Thumb ratio={deck.h / deck.w} slide={s} index={i} width={thumbW} ctxFor={ctxFor} selected={isSel} current={i === current} />
            {grid && (
              <span className={cn('text-[12px] tabular-nums', i === current ? 'font-semibold text-[#c43e1c]' : 'text-[#424242]')}>
                {s.hidden ? <span className="border border-[#616161] px-[2px] line-through">{i + 1}</span> : i + 1}
              </span>
            )}
          </div>
        );
      })}
      {drop === deck.slides.length && <div className={cn('h-[3px] bg-[#c43e1c]', grid ? 'h-24 w-[3px]' : 'ml-7')} />}
    </div>
  );
}
