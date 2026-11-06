import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Film, Loader2, MoreHorizontal, Scissors } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ProjectItem, TakeInfo } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { formatTime, formatWhen } from '../format';
import { itemActions, usedLength, useFileUrl, type ItemAction } from '../takes';
import { ActionItems } from './ActionItems';

const SCENES: Record<TakeInfo['scene'], string> = {
  'screen-camera': 'Screen and camera',
  camera: 'Camera',
  screen: 'Screen',
};

function transcriptNote(take: TakeInfo): string | null {
  switch (take.transcript) {
    case 'working':
      return 'Transcribing';
    case 'done':
      return 'Transcribed';
    case 'failed':
      return 'Couldn’t transcribe';
    default:
      return null;
  }
}

export interface ItemChange {
  keep?: boolean;
  note?: string;
  in?: number | null;
  out?: number | null;
}

const button = 'inline-flex h-8 items-center gap-1.5 rounded-full bg-background px-3.5 text-sm clay outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50';

/** One take or clip of the project: watch it, and say how the edit should use it. */
export function TakeView({
  item,
  index,
  count,
  options,
  onBack,
  onAction,
  onChange,
}: {
  item: ProjectItem;
  index: number;
  count: number;
  options: { canTranscribe: boolean };
  onBack: () => void;
  onAction: (action: ItemAction) => void;
  onChange: (change: ItemChange) => void;
}) {
  const { take } = item;
  const video = useFileUrl(take.program);
  const player = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState(item.note);
  const [error, setError] = useState<string | null>(null);
  // Another window, or `din studio arrange`, changed it. (Each take gets its own view: Studio keys it.)
  const [noteFrom, setNoteFrom] = useState(item.note);
  if (noteFrom !== item.note) {
    setNoteFrom(item.note);
    setNote(item.note);
  }

  // The part the edit uses is where it starts playing.
  const seeked = useRef<string | null>(null);
  const onLoaded = () => {
    if (seeked.current === take.path || !player.current) return;
    seeked.current = take.path;
    if (item.in !== null) player.current.currentTime = item.in;
  };

  const at = () => Math.round((player.current?.currentTime ?? 0) * 100) / 100;
  const setEdge = (edge: 'in' | 'out') => {
    const time = at();
    if (edge === 'in' && item.out !== null && time >= item.out) return setError('The start has to come before the end.');
    if (edge === 'out' && time <= (item.in ?? 0)) return setError('The end has to come after the start.');
    setError(null);
    onChange(edge === 'in' ? { in: time > 0 ? time : null } : { out: time });
  };
  const playUsed = () => {
    const v = player.current;
    if (!v) return;
    v.currentTime = item.in ?? 0;
    void v.play();
  };
  // Playing the part the edit uses stops at its end.
  useEffect(() => {
    const v = player.current;
    if (!v || item.out === null) return;
    const out = item.out;
    let stopped = false;
    const tick = () => {
      if (!stopped && v.currentTime >= out && v.currentTime < out + 0.5) {
        stopped = true;
        v.pause();
      }
      if (v.currentTime < out) stopped = false;
    };
    v.addEventListener('timeupdate', tick);
    return () => v.removeEventListener('timeupdate', tick);
  }, [item.out, video]);

  const finished = take.status === 'ready' || take.status === 'interrupted';
  const portrait = take.aspect === '9:16';
  const trimmed = item.in !== null || item.out !== null;
  const meta = [
    take.kind === 'clip' ? 'Clip' : null,
    formatWhen(take.created),
    take.duration > 0 ? formatTime(take.duration * 1000) : null,
    take.kind === 'recording' ? take.aspect : null,
    take.kind === 'recording' ? SCENES[take.scene] : null,
    transcriptNote(take),
  ].filter(Boolean);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&>*]:shrink-0">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
            <ArrowLeft className="size-4.5" strokeWidth={1.75} aria-hidden />
            Back to recording
          </button>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`More for ${take.title}`} className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <ActionItems groups={itemActions(item, { first: index === 0, last: index === count - 1 }, options)} kind="dropdown" onAction={onAction} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className={cn('mx-auto w-full overflow-hidden rounded-xl bg-black shadow-lg ring-1 ring-black/10', portrait ? 'max-w-sm' : take.aspect === '1:1' ? 'max-w-xl' : '', !item.keep && 'opacity-60')}>
          <div className={cn('grid place-items-center', portrait ? 'aspect-[9/16]' : take.aspect === '1:1' ? 'aspect-square' : 'aspect-video')}>
            {video ? (
              <video ref={player} key={video} src={video} controls playsInline onLoadedMetadata={onLoaded} className="h-full w-full bg-black" aria-label={`${take.title}, as recorded`} />
            ) : take.status === 'finishing' ? (
              <p className="flex items-center gap-2 text-sm text-white/70">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {take.kind === 'clip' ? 'Adding…' : 'Saving…'}
              </p>
            ) : (
              <Film className="size-8 text-white/30" aria-hidden />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="text-muted-foreground tabular-nums">{index + 1}. </span>
              {take.title}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{meta.join(' · ')}</p>
            {take.status === 'interrupted' && (
              <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                {take.kind === 'clip' ? 'This clip wasn’t added all the way.' : 'This take was cut off before it was stopped. What was recorded until then is kept.'}
              </p>
            )}
          </div>
          <button type="button" onClick={() => onChange({ keep: !item.keep })} aria-pressed={!item.keep} className={button}>
            {item.keep ? <EyeOff className="size-4.5" strokeWidth={1.75} aria-hidden /> : <Eye className="size-4.5" strokeWidth={1.75} aria-hidden />}
            {item.keep ? 'Leave Out of the Edit' : 'Use in the Edit'}
          </button>
        </div>

        <section aria-labelledby="studio-trim" className="rounded-2xl bg-card p-4 clay">
          <h2 id="studio-trim" className="flex items-center gap-2 text-base font-semibold">
            <Scissors strokeWidth={1.75} className="size-4.5 text-ink-accent" aria-hidden />
            The part to use
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {trimmed
              ? `From ${formatTime((item.in ?? 0) * 1000)} to ${formatTime((item.out ?? take.duration) * 1000)}, ${formatTime(usedLength(item) * 1000)} of it.`
              : 'All of it. Play to where it should start or end, and mark it. The Assistant still cuts mistakes and pauses inside it.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={button} disabled={!video || !finished} onClick={() => setEdge('in')}>
              Start Here
            </button>
            <button type="button" className={button} disabled={!video || !finished} onClick={() => setEdge('out')}>
              End Here
            </button>
            {trimmed && (
              <>
                <button type="button" className={button} disabled={!video} onClick={playUsed}>
                  Play the Part
                </button>
                <button type="button" className={button} onClick={() => onChange({ in: null, out: null })}>
                  Use All of It
                </button>
              </>
            )}
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
        </section>

        <section aria-labelledby="studio-note">
          <h2 id="studio-note" className="mb-2 text-sm font-semibold text-muted-foreground">Note for the Assistant</h2>
          <textarea
            id="studio-note-field"
            aria-labelledby="studio-note"
            value={note}
            rows={3}
            placeholder="Anything about this one: “the second half is better”, “use as the intro”"
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note.trim() !== item.note && onChange({ note: note.trim() })}
            className="w-full resize-y rounded-xl bg-foreground/[0.06] px-3 py-2 text-[15px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </section>
      </div>
    </div>
  );
}
