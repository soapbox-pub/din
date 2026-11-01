import { memo, useEffect, useState } from 'react';
import { Radio, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useCaptureState } from '@/lib/capture';
import { formatRecordingTime } from '@/lib/screenRecorder';

/**
 * The menu bar's sign that Studio is recording or live, there only while it
 * is. Clicking the recording stops it, as the screen recorder's does (Studio
 * finishes the take); clicking LIVE shows Studio, where the stream is ended,
 * so a stray click can't end a broadcast.
 */
export const StudioMenuItem = memo(function StudioMenuItem() {
  const { recording, live } = useCaptureState();
  const { open } = useWindowActions();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!recording && !live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording, live]);

  return (
    <>
      {live && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => open('studio')}
          aria-label={live.phase === 'live' ? `Live on ${live.destination} (${formatRecordingTime(now - live.startedAt)}): show Studio` : `Going live on ${live.destination}: show Studio`}
          title={live.behind ? 'Your connection is falling behind' : `Live on ${live.destination}`}
          className="h-7 gap-1.5 rounded-md bg-destructive px-2 text-white hover:bg-destructive/90 hover:text-white"
        >
          <Radio className="size-3.5" aria-hidden />
          <span className="text-xs font-semibold tracking-wide">{live.phase === 'live' ? 'LIVE' : '…'}</span>
          {live.phase === 'live' && <span className="text-xs tabular-nums">{formatRecordingTime(now - live.startedAt)}</span>}
        </Button>
      )}
      {recording && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => open('studio', { action: 'stop', nonce: Date.now() })}
          aria-label={`Stop recording ${recording.title} (${formatRecordingTime(now - recording.startedAt)})`}
          title="Stop recording"
          className="h-7 gap-1.5 rounded-md bg-destructive/15 px-2 text-destructive hover:bg-destructive/25 hover:text-destructive"
        >
          <span className="relative grid size-3 place-items-center" aria-hidden>
            <span className="absolute size-3 rounded-full bg-destructive/40 motion-safe:animate-ping" />
            <Square className="size-2.5 fill-current" />
          </span>
          <span className="text-xs font-medium tabular-nums">{formatRecordingTime(now - recording.startedAt)}</span>
        </Button>
      )}
    </>
  );
});
