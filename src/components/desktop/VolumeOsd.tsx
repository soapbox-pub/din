import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HeadphoneOff, Headphones, Mic, MicOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { glassPanel } from '@/shared/appChromeStyles';
import { MAX_VOLUME, getAudioBridge } from '@/lib/audio';
import type { AudioStatus } from '@/lib/audio';
import { VolumeGlyph } from '@/components/desktop/VolumeIndicator';
import { AUDIO_INPUT_KEY } from '@/hooks/useAudio';
import { useAppContext } from '@/hooks/useAppContext';
import { OverdriveMeter } from '@/components/ui/overdrive-slider';
import { knockAnimation } from '@/lib/overdrive';
import { announce } from '@/lib/announce';
import { playVolumeFeedback } from '@/lib/volumeFeedback';
import { OsdLayer } from './OsdLayer';

/** How long the OSD stays on screen after the last volume change. */
const OSD_VISIBLE_MS = 1500;
/** Longer when it also says where sound now goes. */
const DEVICE_OSD_VISIBLE_MS = 3000;

/**
 * On-screen volume display. Listens for media-key volume changes pushed from
 * the main process (window.dinos.audio.onOsd) and shows a transient overlay with the
 * new level, GNOME/macOS style, over anything in full screen too (OsdLayer),
 * with headphones for its icon while sound goes to a pair. A step up or down
 * plays a tick at the new level (src/lib/volumeFeedback.ts) unless Settings
 * turned that off. The mic-mute key shows the microphone's state the same
 * way. Also primes the audio status cache so the menu-bar control and
 * Settings reflect the change immediately.
 *
 * Renders nothing (and registers no listener) outside the Electron shell.
 */
export function VolumeOsd() {
  const queryClient = useQueryClient();
  const { config } = useAppContext();
  const feedback = useRef(config.volumeFeedback !== false);
  useEffect(() => {
    feedback.current = config.volumeFeedback !== false;
  }, [config.volumeFeedback]);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [input, setInput] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  /** The output sound just moved to, shown above the level. */
  const [device, setDevice] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const meterRef = useRef<HTMLDivElement>(null);
  const last = useRef<AudioStatus | null>(null);

  useEffect(() => {
    const audio = getAudioBridge();
    if (!audio) return;

    const show = (next: AudioStatus, isInput: boolean, nextDevice: string | null = null) => {
      announce(volumeAnnouncement(next, isInput, nextDevice));
      setStatus(next);
      setInput(isInput);
      setDevice(nextDevice);
      setVisible(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), nextDevice ? DEVICE_OSD_VISIBLE_MS : OSD_VISIBLE_MS);
    };

    const unsubscribe = audio.onOsd((next) => {
      // The volume keys stop at 100 and knock once before going past it.
      if (next.volume === 100 && last.current?.volume === 100 && last.current.muted === next.muted) {
        knockAnimation(meterRef.current, 1);
      }
      const { device: switchedTo, headphones: toHeadphones, step, ...state } = next;
      last.current = state;
      setHeadphones(toHeadphones === true);
      show(state, false, switchedTo ?? null);
      if (step && feedback.current && !state.muted && state.volume !== 0) playVolumeFeedback();
      queryClient.setQueryData(['audio', 'status'], state);
      // A new output means a new device list, in the menu and Settings.
      if (switchedTo) void queryClient.invalidateQueries({ queryKey: ['audio', 'devices'] });
    });
    const unsubscribeInput = audio.onInputOsd((next) => {
      last.current = null;
      show(next, true);
      queryClient.setQueryData(AUDIO_INPUT_KEY, next);
    });

    return () => {
      unsubscribe();
      unsubscribeInput();
      window.clearTimeout(hideTimer.current);
    };
  }, [queryClient]);

  if (!status) return null;

  if (input) {
    const MicIcon = status.muted ? MicOff : Mic;
    return (
      <OsdLayer aria-hidden visible={visible}>
        <div className={cn('flex items-center gap-3 px-4 py-3', glassPanel)}>
          <MicIcon
            className={cn('size-6 shrink-0', status.muted ? 'text-muted-foreground' : 'text-foreground')}
          />
          <span className="text-sm font-medium text-foreground">
            {status.muted ? 'Microphone off' : 'Microphone on'}
          </span>
        </div>
      </OsdLayer>
    );
  }

  const muted = status.muted || status.volume === 0;
  const level = muted ? 0 : status.volume ?? 0;
  const glyphClass = cn('size-6 shrink-0', muted ? 'text-muted-foreground' : 'text-foreground');
  const HeadphonesIcon = muted ? HeadphoneOff : Headphones;

  return (
    <OsdLayer aria-hidden visible={visible}>
      <div className={cn('flex flex-col gap-2 px-4 py-3', glassPanel)}>
        {device && (
          <p className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
            <Headphones className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            {device}
          </p>
        )}
        <div className="flex items-center gap-3">
          {headphones ? (
            <HeadphonesIcon className={glyphClass} aria-hidden />
          ) : (
            <VolumeGlyph volume={status.volume} muted={status.muted} className={glyphClass} />
          )}
          <OverdriveMeter
            ref={meterRef}
            value={level}
            min={0}
            max={100}
            overMax={MAX_VOLUME}
            muted={muted}
            width={160}
            makeRoom
          />
          <span className="w-11 text-right text-sm font-medium tabular-nums text-foreground">
            {muted ? '—' : `${level}%`}
          </span>
        </div>
      </div>
    </OsdLayer>
  );
}

/** What the OSD shows, for a screen reader (src/lib/announce.ts). */
function volumeAnnouncement(status: AudioStatus, input: boolean, device: string | null): string {
  if (input) return status.muted ? 'Microphone off' : 'Microphone on';
  const level = status.muted || status.volume === 0 ? 'Muted' : `Volume ${status.volume ?? 0}%`;
  return device ? `Now playing through ${device}. ${level}` : level;
}
