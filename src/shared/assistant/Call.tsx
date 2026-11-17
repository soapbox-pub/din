import { useEffect, useState } from 'react';
import { Loader2, Mic, MicOff, PhoneOff, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Call, CallPhase } from '@/shared/assistant/useCall';

function useElapsed(since: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, '0')}`;
}

const STATUS: Record<CallPhase, string> = {
  listening: 'Listening…',
  thinking: 'Working on it · keep talking to add something',
  speaking: 'Speaking',
  muted: 'Muted',
  paused: 'Listening stopped',
};

/**
 * The composer's place during a call: what's being heard, how long the
 * call has gone, Interrupt while the assistant speaks, Mute and End.
 */
export function CallBar({ call }: { call: Call }) {
  const elapsed = useElapsed(call.startedAt);
  const { phase } = call;
  // While it speaks, what's heard is its own voice.
  const heard = phase === 'speaking' ? '' : call.heard;
  const live = phase === 'listening' || phase === 'thinking';
  return (
    <div
      role="region"
      aria-label="Call with the assistant"
      className="flex items-center gap-3 rounded-2xl bg-card clay p-2 pl-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && phase === 'speaking') {
          event.preventDefault();
          call.interrupt();
        }
      }}
    >
      <span className="relative grid size-10 shrink-0 place-items-center" aria-hidden>
        {live && <span className="absolute inset-0 rounded-full bg-primary/20 motion-safe:animate-ping [animation-duration:2s]" />}
        <span
          className={cn(
            'relative grid size-9 place-items-center rounded-full',
            phase === 'muted' || phase === 'paused' ? 'bg-muted text-muted-foreground' : 'bg-pigment text-primary-foreground clay-pigment',
          )}
        >
          {phase === 'muted' || phase === 'paused' ? (
            <MicOff className="size-4.5" strokeWidth={1.75} />
          ) : phase === 'speaking' ? (
            <SpeakingBars />
          ) : phase === 'thinking' && !heard ? (
            <Loader2 className="size-4.5 motion-safe:animate-spin" strokeWidth={1.75} />
          ) : (
            <Mic className="size-4.5" strokeWidth={1.75} />
          )}
        </span>
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className={cn('line-clamp-2 text-sm', heard ? 'text-foreground' : 'text-muted-foreground')}>
          {phase === 'paused' ? call.problem : heard || STATUS[phase]}
        </p>
        <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">On a call · {elapsed}</p>
      </div>
      {phase === 'speaking' && (
        <Button type="button" variant="secondary" size="sm" onClick={call.interrupt} title="Stop it speaking (Esc)" className="rounded-full">
          <Square className="size-3 fill-current" aria-hidden />
          Interrupt
        </Button>
      )}
      {phase === 'paused' ? (
        <Button type="button" variant="secondary" size="sm" onClick={call.resume} className="rounded-full">
          <Mic aria-hidden />
          Resume
        </Button>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={call.toggleMute}
          aria-label={phase === 'muted' ? 'Unmute' : 'Mute'}
          aria-pressed={phase === 'muted'}
          title={phase === 'muted' ? 'Unmute' : 'Mute'}
          className={cn('size-9 rounded-full', phase === 'muted' && 'bg-selected text-foreground')}
        >
          {phase === 'muted' ? <MicOff className="size-4.5" strokeWidth={1.75} aria-hidden /> : <Mic className="size-4.5" strokeWidth={1.75} aria-hidden />}
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        onClick={call.end}
        aria-label="End call"
        title="End call"
        className="size-9 rounded-full bg-destructive text-white hover:bg-destructive/90"
      >
        <PhoneOff className="size-4.5" strokeWidth={1.75} aria-hidden />
      </Button>
    </div>
  );
}

/** Three bars rising and falling while the assistant speaks. */
function SpeakingBars() {
  return (
    <span className="flex h-4 items-center gap-0.5">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-full w-1 origin-center rounded-full bg-current motion-safe:animate-[call-bar_900ms_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
