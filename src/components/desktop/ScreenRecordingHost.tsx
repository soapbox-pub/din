import { memo, useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/useToast';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { appForFile } from '@/lib/fileTypes';
import { parentPath } from '@/lib/fs';
import {
  formatRecordingTime,
  getScreenRecorderBridge,
  stopRecording,
  useScreenRecorder,
} from '@/lib/screenRecorder';

/**
 * The menu bar's sign that the screen is being recorded, there only while it
 * is: a red dot and the time so far. Clicking it stops the recording, the
 * way GNOME's and macOS's do.
 */
export const ScreenRecordingMenuItem = memo(function ScreenRecordingMenuItem() {
  const { recording } = useScreenRecorder();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  if (!recording) return null;
  const elapsed = formatRecordingTime(now - recording.startedAt);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => void stopRecording()}
      aria-label={`Stop recording the screen (${elapsed})`}
      title="Stop recording"
      className="h-7 gap-1.5 rounded-md bg-destructive/15 px-2 text-destructive hover:bg-destructive/25 hover:text-destructive"
    >
      <span className="relative grid size-3 place-items-center" aria-hidden>
        <span className="absolute size-3 rounded-full bg-destructive/40 motion-safe:animate-ping" />
        <Square className="size-2.5 fill-current" />
      </span>
      <span className="text-xs font-medium tabular-nums">{elapsed}</span>
    </Button>
  );
});

/**
 * Says when a recording is saved, however it was stopped (the menu bar, the
 * Screenshot app, `din screenshot record stop`, or on its own), with the way
 * to it. Renders nothing.
 */
export function ScreenRecordingHost() {
  const { open } = useWindowActions();
  const queryClient = useQueryClient();

  useEffect(() => {
    const bridge = getScreenRecorderBridge();
    if (!bridge) return;
    return bridge.onFinished(({ path, durationMs, error }) => {
      if (!path) {
        toast({ title: 'Screen recording failed', description: error, variant: 'destructive' });
        return;
      }
      void invalidateListings(queryClient, path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      toast({
        title: error ? 'Screen recording stopped' : 'Screen recording saved',
        description: error ? `${error}. What was recorded is in ${name}.` : `${name} (${formatRecordingTime(durationMs)})`,
        actions: [
          { id: 'play', label: 'Play' },
          { id: 'show', label: 'Show in Files' },
        ],
        onAction: (action) => {
          if (action === 'show') open('file-browser', { path: parentPath(path), select: name });
          else open(appForFile(name), { path });
        },
      });
    });
  }, [open, queryClient]);

  return null;
}
