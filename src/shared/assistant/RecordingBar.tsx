import { useEffect, useRef, useState } from 'react';
import { Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const BARS = 12;

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How loud the microphone is, as bars drawn straight to the page (no render a frame). */
function LevelMeter({ analyser }: { analyser: AnalyserNode | null }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!analyser || !bars.current) return;
    const data = new Uint8Array(analyser.fftSize);
    const history = new Array<number>(BARS).fill(0);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 80) return;
      last = now;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      history.shift();
      history.push(Math.min(1, (peak / 128) * 2.5));
      const children = bars.current?.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        (children[i] as HTMLElement).style.transform = `scaleY(${0.15 + history[i] * 0.85})`;
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return (
    <span ref={bars} aria-hidden className="flex h-4 items-center gap-0.5">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className="h-full w-0.5 origin-center scale-y-[0.15] rounded-full bg-ink-accent transition-transform duration-75" />
      ))}
    </span>
  );
}

/**
 * The composer's toolbar while it records: how long, how loud, and Discard
 * or Stop (which attaches the recording).
 */
export function RecordingBar({
  startedAt,
  analyser,
  onStop,
  onDiscard,
}: {
  startedAt: number;
  analyser: AnalyserNode | null;
  onStop: () => void;
  onDiscard: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-1" role="status" aria-label="Recording audio">
      <span className="size-2 shrink-0 rounded-full bg-red-500 motion-safe:animate-pulse" aria-hidden />
      <span className="shrink-0 text-sm tabular-nums text-foreground">{elapsed(now - startedAt)}</span>
      <LevelMeter analyser={analyser} />
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onDiscard}
        aria-label="Discard recording"
        title="Discard recording (Esc)"
        className="size-8 rounded-full text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onStop}
        aria-label="Stop recording and attach it"
        className="h-8 gap-1.5 rounded-full px-3"
      >
        <Square className="size-3 fill-current" aria-hidden />
        Stop
      </Button>
    </div>
  );
}
