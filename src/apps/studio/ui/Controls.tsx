import { useEffect, useRef, type ReactNode } from 'react';
import {
  Camera,
  CameraOff,
  ChevronUp,
  Flag,
  Mic,
  MicOff,
  MonitorSpeaker,
  Radio,
  RotateCcw,
  Settings2,
  Square,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LiveStatus } from '@/lib/capture';
import { cn } from '@/lib/utils';
import type { CameraShape } from '../engine/layout';
import { deviceName } from '../engine/media';
import { formatTime } from '../format';

export type Phase = 'idle' | 'countdown' | 'starting' | 'recording' | 'stopping';

interface DeviceControl {
  on: boolean;
  devices: MediaDeviceInfo[];
  /** The chosen device's id, or '' for the default. */
  selected: string;
  error: string | null;
  onToggle: () => void;
  onSelect: (id: string) => void;
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

const ROUND = 'grid size-10 place-items-center rounded-full text-white/85 transition-colors outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none disabled:opacity-40';

/** A device's button, and beside it the menu to pick which one. */
function DeviceButton({
  control,
  kind,
  iconOn,
  iconOff,
  disabled,
  extra,
  meter,
}: {
  control: DeviceControl;
  kind: 'Camera' | 'Microphone';
  iconOn: ReactNode;
  iconOff: ReactNode;
  disabled: boolean;
  extra?: ReactNode;
  meter?: () => number;
}) {
  const ring = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!meter || !control.on) return;
    let frame = 0;
    const tick = () => {
      const el = ring.current;
      if (el) el.style.transform = `scale(${1 + meter() * 0.35})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [meter, control.on]);

  const label = control.on ? `Turn the ${kind.toLowerCase()} off` : `Turn the ${kind.toLowerCase()} on`;
  return (
    <div className="flex items-center">
      <Hint label={control.error ?? label}>
        <button type="button" className={cn(ROUND, 'relative', !control.on && 'text-white/50', control.error && 'text-amber-300')} aria-label={label} aria-pressed={control.on} disabled={disabled} onClick={control.onToggle}>
          {meter && control.on && <span ref={ring} aria-hidden className="absolute inset-1.5 rounded-full bg-emerald-400/25 transition-transform duration-75" />}
          <span className="relative">{control.on ? iconOn : iconOff}</span>
        </button>
      </Hint>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="grid h-10 w-5 place-items-center rounded-full text-white/60 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40" aria-label={`${kind} options`} disabled={disabled}>
            <ChevronUp className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          <DropdownMenuLabel>{kind}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={control.selected} onValueChange={control.onSelect}>
            <DropdownMenuRadioItem value="">System default</DropdownMenuRadioItem>
            {control.devices.map((d, i) => (
              <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId}>
                <span className="truncate">{deviceName(d, `${kind} ${i + 1}`)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {extra}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function Controls({
  phase,
  elapsed,
  markers,
  camera,
  mic,
  micLevel,
  shape,
  onShape,
  mirror,
  onMirror,
  computerSound,
  onComputerSound,
  computerSoundAvailable,
  countdown,
  onCountdown,
  hideWhileRecording,
  onHideWhileRecording,
  canRecord,
  onRecord,
  onStop,
  onMark,
  live,
  canGoLive,
  onGoLive,
  onEndLive,
}: {
  phase: Phase;
  elapsed: number;
  markers: number;
  camera: DeviceControl;
  mic: DeviceControl;
  micLevel: () => number;
  shape: CameraShape;
  onShape: (shape: CameraShape) => void;
  mirror: boolean;
  onMirror: (mirror: boolean) => void;
  computerSound: boolean;
  onComputerSound: (on: boolean) => void;
  computerSoundAvailable: boolean;
  countdown: number;
  onCountdown: (seconds: number) => void;
  hideWhileRecording: boolean;
  onHideWhileRecording: (hide: boolean) => void;
  canRecord: boolean;
  onRecord: () => void;
  onStop: () => void;
  onMark: (kind: 'highlight' | 'retake') => void;
  live: LiveStatus | null;
  canGoLive: boolean;
  onGoLive: () => void;
  onEndLive: () => void;
}) {
  const busy = phase !== 'idle';
  const recording = phase === 'recording';

  return (
    <div className="flex shrink-0 justify-center px-4 pb-4">
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-900/90 px-2 py-1.5 text-white shadow-xl backdrop-blur-xl">
        {recording ? (
          <>
            <Hint label="Mark a moment to keep (Ctrl+M)">
              <button type="button" className={ROUND} aria-label="Mark a highlight" onClick={() => onMark('highlight')}>
                <Flag className="size-[18px]" />
              </button>
            </Hint>
            <Hint label="That didn’t go right: mark it to cut (Ctrl+Backspace)">
              <button type="button" className={ROUND} aria-label="Mark a retake" onClick={() => onMark('retake')}>
                <RotateCcw className="size-[18px]" />
              </button>
            </Hint>
            {markers > 0 && (
              <span className="px-1 text-xs text-white/60 tabular-nums" aria-live="polite">
                {markers} {markers === 1 ? 'mark' : 'marks'}
              </span>
            )}
          </>
        ) : (
          <>
            <DeviceButton
              control={mic}
              kind="Microphone"
              iconOn={<Mic className="size-[18px]" />}
              iconOff={<MicOff className="size-[18px]" />}
              disabled={busy}
              meter={micLevel}
            />
            <DeviceButton
              control={camera}
              kind="Camera"
              iconOn={<Camera className="size-[18px]" />}
              iconOff={<CameraOff className="size-[18px]" />}
              disabled={busy}
              extra={
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Shape</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={shape} onValueChange={(v) => onShape(v as CameraShape)}>
                    <DropdownMenuRadioItem value="circle">Circle</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="rounded">Rounded</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="split">Side by side</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={mirror} onCheckedChange={(v) => onMirror(v === true)}>
                    Mirror
                  </DropdownMenuCheckboxItem>
                </>
              }
            />
            <Hint label={computerSoundAvailable ? (computerSound ? 'Computer sound is recorded with the screen' : 'Record the computer’s sound with the screen') : 'The computer’s sound can’t be recorded here'}>
              <button
                type="button"
                className={cn(ROUND, computerSound ? 'text-white' : 'text-white/50')}
                aria-label="Record the computer’s sound"
                aria-pressed={computerSound}
                disabled={busy || !computerSoundAvailable}
                onClick={() => onComputerSound(!computerSound)}
              >
                <MonitorSpeaker className="size-[18px]" />
              </button>
            </Hint>
          </>
        )}

        <div className="mx-2 flex items-center gap-2">
          {recording || phase === 'stopping' ? (
            <button
              type="button"
              onClick={onStop}
              disabled={phase === 'stopping'}
              aria-label={`Stop recording (${formatTime(elapsed)})`}
              className="group flex h-12 items-center gap-2.5 rounded-full bg-white/10 pr-4 pl-1.5 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
            >
              <span className="grid size-9 place-items-center rounded-full bg-red-500 shadow-[0_0_0_3px_rgba(255,255,255,0.9)]">
                <Square className="size-3.5 fill-white text-white" />
              </span>
              <span className="text-[15px] font-medium tabular-nums">{phase === 'stopping' ? 'Saving…' : formatTime(elapsed)}</span>
            </button>
          ) : (
            <Hint label="Start recording (Ctrl+R)">
              <button
                type="button"
                onClick={onRecord}
                disabled={!canRecord || busy}
                aria-label="Start recording"
                className="grid size-12 place-items-center rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.9)] outline-none transition-transform hover:scale-105 focus-visible:ring-4 focus-visible:ring-white/60 active:scale-95 disabled:opacity-40 disabled:hover:scale-100 motion-reduce:transition-none"
              >
                <span className={cn('size-10 rounded-full bg-red-500 transition-all', phase !== 'idle' && 'size-8 rounded-lg')} />
              </button>
            </Hint>
          )}
        </div>

        {live ? (
          <button
            type="button"
            onClick={onEndLive}
            disabled={live.phase === 'ending'}
            className="flex h-10 items-center gap-2 rounded-full bg-red-500 px-4 text-sm font-semibold text-white outline-none hover:bg-red-600 focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60"
          >
            <Radio className="size-4" aria-hidden />
            {live.phase === 'ending' ? 'Ending…' : 'End Stream'}
          </button>
        ) : (
          <Hint label={canGoLive ? 'Stream to YouTube, Twitch and more' : 'Going live isn’t available here'}>
            <button
              type="button"
              onClick={onGoLive}
              disabled={!canGoLive || phase === 'countdown' || phase === 'stopping'}
              className="flex h-10 items-center gap-2 rounded-full px-4 text-sm font-medium text-white/90 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-40"
            >
              <Radio className="size-4" aria-hidden />
              Go Live
            </button>
          </Hint>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={ROUND} aria-label="Recording options" disabled={busy}>
              <Settings2 className="size-[18px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-64">
            <DropdownMenuLabel>Countdown</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={String(countdown)} onValueChange={(v) => onCountdown(Number(v))}>
              <DropdownMenuRadioItem value="0">None</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="3">3 seconds</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="5">5 seconds</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="10">10 seconds</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={hideWhileRecording} onCheckedChange={(v) => onHideWhileRecording(v === true)}>
              Hide Studio while recording the screen
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
