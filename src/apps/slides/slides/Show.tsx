import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { Deck, Slide, SlideCtx, Transition } from './model';
import { SlideImage } from './render';

/**
 * Slide Show: the slides full screen on black, one at a time, with
 * PowerPoint's keys — Space, Enter, N, →, ↓ and Page Down go on; Backspace,
 * P, ←, ↑ and Page Up go back; Home and End; a number and Enter jumps; B and
 * W blank the screen; Esc ends — and the black "End of slide show" slide.
 */

const KEYFRAMES = `
@keyframes sl-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sl-push-l { from { transform: translateX(100%) } to { transform: none } }
@keyframes sl-push-out-l { from { transform: none } to { transform: translateX(-100%) } }
@keyframes sl-push-u { from { transform: translateY(100%) } to { transform: none } }
@keyframes sl-push-out-u { from { transform: none } to { transform: translateY(-100%) } }
@keyframes sl-wipe { from { clip-path: inset(0 100% 0 0) } to { clip-path: inset(0 0 0 0) } }
@keyframes sl-cover { from { transform: translateX(100%) } to { transform: none } }
`;

interface Anim {
  from: number;
  transition: Transition;
}

export function SlideShow({ deck, start, ctxFor, onExit }: { deck: Deck; start: number; ctxFor: (slide: Slide, index: number) => SlideCtx | null; onExit: (last: number) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(start);
  const [ended, setEnded] = useState(false);
  const [blank, setBlank] = useState<'black' | 'white' | null>(null);
  const [anim, setAnim] = useState<Anim | null>(null);
  const [typed, setTyped] = useState('');
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    const el = rootRef.current;
    el?.focus();
    el?.requestFullscreen?.().catch(() => {});
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement && rootRef.current) rootRef.current.focus();
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const visible = deck.slides.map((s, i) => (s.hidden && i !== start ? -1 : i)).filter((i) => i >= 0);

  const go = useCallback(
    (to: number, animate: boolean) => {
      setBlank(null);
      if (to >= deck.slides.length) {
        setEnded(true);
        return;
      }
      setEnded(false);
      const t = deck.slides[to]?.transition;
      if (animate && t && t.type !== 'none' && t.type !== 'cut' && !reduce) setAnim({ from: index, transition: t });
      else setAnim(null);
      setIndex(to);
    },
    [deck.slides, index, reduce],
  );

  const next = useCallback(() => {
    if (ended) {
      onExit(index);
      return;
    }
    const after = visible.find((i) => i > index);
    go(after ?? deck.slides.length, true);
  }, [ended, visible, index, go, onExit, deck.slides.length]);

  const prev = useCallback(() => {
    if (ended) {
      setEnded(false);
      return;
    }
    const before = [...visible].reverse().find((i) => i < index);
    if (before !== undefined) go(before, false);
  }, [ended, visible, index, go]);

  // Slides that advance on their own after a while.
  useEffect(() => {
    const t = deck.slides[index]?.transition;
    if (ended || blank || !t?.advTm) return;
    const id = window.setTimeout(next, t.advTm + (t.dur ?? 0));
    return () => window.clearTimeout(id);
  }, [index, ended, blank, deck.slides, next]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const k = e.key;
    if (/^[0-9]$/.test(k)) {
      setTyped((t) => t + k);
      return;
    }
    if (k === 'Enter' && typed) {
      const n = Number(typed) - 1;
      setTyped('');
      if (n >= 0 && n < deck.slides.length) go(n, false);
      e.preventDefault();
      return;
    }
    setTyped('');
    if (k === 'Escape' || (k === '-' && !e.ctrlKey)) {
      e.preventDefault();
      onExit(index);
    } else if ([' ', 'Enter', 'ArrowRight', 'ArrowDown', 'PageDown', 'n', 'N'].includes(k)) {
      e.preventDefault();
      if (blank) setBlank(null);
      else next();
    } else if (['Backspace', 'ArrowLeft', 'ArrowUp', 'PageUp', 'p', 'P'].includes(k)) {
      e.preventDefault();
      if (blank) setBlank(null);
      else prev();
    } else if (k === 'Home') {
      e.preventDefault();
      go(visible[0] ?? 0, false);
    } else if (k === 'End') {
      e.preventDefault();
      go(visible[visible.length - 1] ?? 0, false);
    } else if (k === 'b' || k === 'B' || k === '.') {
      e.preventDefault();
      setBlank((b) => (b === 'black' ? null : 'black'));
    } else if (k === 'w' || k === 'W' || k === ',') {
      e.preventDefault();
      setBlank((b) => (b === 'white' ? null : 'white'));
    }
  };

  const slideW = Math.min(size.w, (size.h * deck.w) / deck.h);
  const slideH = (slideW * deck.h) / deck.w;
  const ctx = ctxFor(deck.slides[index], index);
  const prevCtx = anim ? ctxFor(deck.slides[anim.from], anim.from) : null;
  const dur = anim?.transition.dur ?? 700;
  const type = anim?.transition.type ?? 'fade';
  const inAnim = type === 'push' ? (anim?.transition.dir === 'u' || anim?.transition.dir === 'd' ? 'sl-push-u' : 'sl-push-l') : type === 'wipe' ? 'sl-wipe' : type === 'cover' || type === 'pull' ? 'sl-cover' : 'sl-fade';
  const outAnim = type === 'push' ? (anim?.transition.dir === 'u' || anim?.transition.dir === 'd' ? 'sl-push-out-u' : 'sl-push-out-l') : null;

  const poke = () => {
    setIdle(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2500);
  };

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Slide Show"
      className="fixed inset-0 grid place-items-center overflow-hidden bg-black outline-none select-none"
      style={{ zIndex: 2147483000, cursor: idle ? 'none' : 'default' }}
      onKeyDown={onKeyDown}
      onMouseMove={poke}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        if (blank) setBlank(null);
        else next();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        prev();
      }}
      onWheel={(e) => (e.deltaY > 0 ? next() : prev())}
    >
      <style>{KEYFRAMES}</style>
      {ended ? (
        <p className="absolute top-3 left-0 right-0 text-center text-[15px] text-white/90" style={{ fontFamily: "'Segoe UI', 'Inter Variable', sans-serif" }}>
          End of slide show, click to exit.
        </p>
      ) : (
        <div className="relative overflow-hidden" style={{ width: slideW, height: slideH }}>
          {prevCtx && anim && (
            <div key={`out-${anim.from}-${index}`} className="absolute inset-0" style={outAnim ? { animation: `${outAnim} ${dur}ms ease-in-out forwards` } : undefined}>
              <SlideImage ctx={prevCtx} width={slideW} opts={{ links: true }} />
            </div>
          )}
          {ctx && (
            <div
              key={`in-${index}`}
              className="absolute inset-0"
              style={anim ? { animation: `${inAnim} ${dur}ms ease-in-out both` } : undefined}
              onAnimationEnd={() => setAnim(null)}
            >
              <SlideImage ctx={ctx} width={slideW} opts={{ links: true }} />
            </div>
          )}
        </div>
      )}
      {blank && <div className="absolute inset-0" style={{ background: blank }} />}
      {!idle && !ended && (
        <div className="absolute bottom-4 left-4 flex gap-1 opacity-60 transition-opacity hover:opacity-100 motion-reduce:transition-none" onClick={(e) => e.stopPropagation()}>
          <ShowButton label="Previous" onClick={prev}>
            <ChevronLeft className="size-4" />
          </ShowButton>
          <ShowButton label="Next" onClick={next}>
            <ChevronRight className="size-4" />
          </ShowButton>
          <ShowButton label="End Show" onClick={() => onExit(index)}>
            <X className="size-4" />
          </ShowButton>
        </div>
      )}
    </div>,
    document.body,
  );
}

function ShowButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full bg-[#3b3b3b]/80 text-white hover:bg-[#555] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      {children}
    </button>
  );
}
