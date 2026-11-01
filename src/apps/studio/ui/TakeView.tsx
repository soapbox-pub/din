import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Film, FolderOpen, Loader2, MoreHorizontal, Play, Sparkles } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { TakeInfo } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { useDin } from '@/sdk/react';
import { formatTime, formatWhen } from '../format';
import { useFileUrl, type TakeAction } from '../takes';
import { TakeActionItems } from './TakeActionItems';

const SCENES: Record<TakeInfo['scene'], string> = {
  'screen-camera': 'Screen and camera',
  camera: 'Camera',
  screen: 'Screen',
};

/** What people ask for most, to start from. */
const SUGGESTIONS = [
  'A vertical clip for TikTok with captions',
  'Cut the mistakes and long pauses',
  'A YouTube video with chapters',
  'Three short clips of the best moments',
];

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

function EditRow({ path, onOpen, onReveal }: { path: string; onOpen: () => void; onReveal: () => void }) {
  const name = path.split('/').pop() ?? path;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-accent/60">
          <Film className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:underline">
            {name}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`More for ${name}`} className="grid size-7 place-items-center rounded-md text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onOpen}>
                <Play className="size-4" aria-hidden />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onReveal}>
                <FolderOpen className="size-4" aria-hidden />
                Show in Files
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <Play className="size-4" aria-hidden />
          Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={onReveal}>
          <FolderOpen className="size-4" aria-hidden />
          Show in Files
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** One take: watch it, and ask the Assistant to make something of it. */
export function TakeView({
  take,
  focusComposer,
  options,
  onBack,
  onAction,
  onRefresh,
}: {
  take: TakeInfo;
  /** Put the cursor in "What should the Assistant make?" as it opens. */
  focusComposer: number;
  options: { canTranscribe: boolean; canAssist: boolean };
  onBack: () => void;
  onAction: (action: TakeAction) => void;
  onRefresh: () => void;
}) {
  const din = useDin();
  const video = useFileUrl(take.program);
  const [prompt, setPrompt] = useState('');
  const [sent, setSent] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const finished = take.status === 'ready' || take.status === 'interrupted';

  useEffect(() => {
    if (focusComposer) composer.current?.focus();
  }, [focusComposer]);

  // What the Assistant makes lands in edits/: listed as it appears.
  useEffect(() => {
    const fs = din.system.fs;
    if (!fs) return;
    let id: number | null = null;
    let live = true;
    const dir = `${take.path}/edits`;
    void fs.watch(dir).then((watch) => {
      if (!live && watch !== null) void fs.unwatch(watch);
      else id = watch;
    });
    const off = fs.onChange((path) => {
      if (path === dir || path.startsWith(`${dir}/`)) onRefresh();
    });
    return () => {
      live = false;
      off();
      if (id !== null) void fs.unwatch(id);
    };
  }, [din, take.path, onRefresh]);

  const send = () => {
    const text = prompt.trim();
    if (!text) return;
    const nonce = Date.now();
    void din.app.open('assistant', { intent: 'studio.edit', directory: take.path, prompt: text, title: take.title, nonce, intentNonce: nonce, sessionID: null });
    setSent(true);
    setPrompt('');
  };

  const openFile = (path: string) => void din.files.fromPath(path).then((h) => din.app.openFiles([h]));
  const reveal = (path: string) => void din.files.fromPath(path.slice(0, path.lastIndexOf('/'))).then((h) => din.app.openFiles([h]));
  const note = transcriptNote(take);
  const portrait = take.aspect === '9:16';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="size-4" aria-hidden />
            Back to recording
          </button>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`More for ${take.title}`} className="grid size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <TakeActionItems take={take} kind="dropdown" options={options} onAction={onAction} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className={cn('mx-auto w-full overflow-hidden rounded-xl bg-black shadow-lg ring-1 ring-black/10', portrait ? 'max-w-sm' : take.aspect === '1:1' ? 'max-w-xl' : '')}>
          <div className={cn('grid place-items-center', portrait ? 'aspect-[9/16]' : take.aspect === '1:1' ? 'aspect-square' : 'aspect-video')}>
            {video ? (
              <video key={video} src={video} controls playsInline className="h-full w-full bg-black" aria-label={`${take.title}, as recorded`} />
            ) : take.status === 'finishing' ? (
              <p className="flex items-center gap-2 text-sm text-white/70">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Saving…
              </p>
            ) : (
              <Film className="size-8 text-white/30" aria-hidden />
            )}
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{take.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[formatWhen(take.created), take.duration > 0 ? formatTime(take.duration * 1000) : null, take.aspect, SCENES[take.scene], note]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {take.status === 'interrupted' && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">This take was cut off before it was stopped. What was recorded until then is kept.</p>
          )}
        </div>

        <section aria-labelledby="studio-make" className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 id="studio-make" className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Make with Assistant
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Say what you want. The Assistant cuts it from this take, using what was said and the marks you made, and saves it beside it.
          </p>
          {options.canAssist ? (
            <>
              <div className="mt-3 flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
                <textarea
                  ref={composer}
                  value={prompt}
                  rows={2}
                  disabled={!finished}
                  aria-label="What should the Assistant make?"
                  placeholder={finished ? 'What should the Assistant make?' : 'Available once the take is saved'}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    setSent(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={!prompt.trim() || !finished}
                  aria-label="Send to the Assistant"
                  className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
                >
                  <ArrowUp className="size-4" />
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!finished}
                    onClick={() => {
                      setPrompt(s);
                      setSent(false);
                      composer.current?.focus();
                    }}
                    className="h-8 rounded-full bg-muted px-3 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
              {sent && <p className="mt-3 text-sm text-muted-foreground" role="status">Sent. The Assistant is working on it, and what it makes shows up below.</p>}
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Turn on the Assistant in Settings to edit takes with it.</p>
          )}
        </section>

        <section aria-labelledby="studio-edits">
          <h2 id="studio-edits" className="mb-2 text-sm font-semibold text-muted-foreground">Made from this take</h2>
          {take.edits.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">Nothing yet. What the Assistant makes is saved in this take’s edits folder.</div>
          ) : (
            <ul className="flex flex-col gap-0.5 rounded-xl border p-1">
              {take.edits.map((path) => (
                <EditRow key={path} path={path} onOpen={() => openFile(path)} onReveal={() => reveal(path)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
