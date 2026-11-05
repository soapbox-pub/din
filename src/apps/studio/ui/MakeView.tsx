import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Film, FolderOpen, MoreHorizontal, Play, Scissors, Sparkles, StickyNote } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ProjectInfo } from '@/lib/capture';
import { useDin } from '@/sdk/react';
import { appLink } from '@/shared/launch';
import { formatTime } from '../format';
import { usedLength } from '../takes';
import { Poster } from './ProjectPanel';

/** What people ask for most, to start from. */
const SUGGESTIONS = [
  'One video from my takes, with the mistakes and long pauses cut',
  'A vertical clip for TikTok with captions',
  'A YouTube video with chapters',
  'Three short clips of the best moments',
];

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

/** The project as a whole: what goes in, in order, and asking the Assistant to make something of it. */
export function MakeView({
  project,
  focusComposer,
  canAssist,
  onBack,
  onRefresh,
}: {
  project: ProjectInfo;
  /** Put the cursor in "What should the Assistant make?" as it opens. */
  focusComposer: number;
  canAssist: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const din = useDin();
  const [prompt, setPrompt] = useState('');
  const [sent, setSent] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const kept = project.items.filter((i) => i.keep);
  const left = project.items.length - kept.length;
  const busy = kept.filter((i) => i.take.status === 'recording' || i.take.status === 'finishing').length;
  const ready = kept.length > 0 && busy === 0;
  const total = kept.reduce((sum, i) => sum + usedLength(i), 0);

  useEffect(() => {
    if (focusComposer) composer.current?.focus();
  }, [focusComposer]);

  // What the Assistant makes lands in edits/: listed as it appears.
  useEffect(() => {
    const fs = din.system.fs;
    if (!fs) return;
    let id: number | null = null;
    let live = true;
    const dir = `${project.path}/edits`;
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
  }, [din, project.path, onRefresh]);

  const send = () => {
    const text = prompt.trim();
    if (!text || !ready) return;
    const nonce = Date.now();
    void window.open(appLink('assistant', { intent: 'studio.edit', directory: project.path, prompt: text, title: project.title, nonce, intentNonce: nonce, sessionID: null }));
    setSent(true);
    setPrompt('');
  };

  const openFile = (path: string) => void din.files.fromPath(path).then((h) => din.app.openFiles([h]));
  const reveal = (path: string) => void din.files.fromPath(path.slice(0, path.lastIndexOf('/'))).then((h) => din.app.openFiles([h]));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-6">
        <div>
          <button type="button" onClick={onBack} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="size-4" aria-hidden />
            Back to recording
          </button>
        </div>

        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {kept.length === 0
              ? 'Nothing is in the edit yet.'
              : `${kept.length} ${kept.length === 1 ? 'piece goes' : 'pieces go'} to the Assistant, in this order${total > 0 ? `, ${formatTime(total * 1000)} in all` : ''}.`}
            {left > 0 && ` ${left} left out.`}
          </p>
        </div>

        {kept.length > 0 && (
          <ol className="flex gap-3 overflow-x-auto pb-1" aria-label="What goes in, in order">
            {kept.map((item, i) => (
              <li key={item.take.path} className="w-36 shrink-0">
                <div className="relative">
                  <Poster take={item.take} className="aspect-video w-full" />
                  <span className="absolute top-1 left-1 grid min-w-5 place-items-center rounded bg-black/70 px-1 text-[11px] font-semibold text-white tabular-nums">{i + 1}</span>
                </div>
                <p className="mt-1 truncate text-sm font-medium">{item.take.title}</p>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  {item.take.kind === 'clip' && <span className="rounded bg-muted px-1 font-medium">Clip</span>}
                  <span className="tabular-nums">{formatTime(usedLength(item) * 1000)}</span>
                  {(item.in !== null || item.out !== null) && <Scissors className="size-3" aria-label="Trimmed" />}
                  {item.note && <StickyNote className="size-3" aria-label="Has a note" />}
                </p>
              </li>
            ))}
          </ol>
        )}

        <section aria-labelledby="studio-make" className="rounded-2xl border bg-card p-4 shadow-sm">
          <h2 id="studio-make" className="flex items-center gap-2 text-base font-semibold">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Make with Assistant
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Say what you want. The Assistant puts it together from the takes and clips in the edit, in their order, using what was said, your trims and notes and the marks you made, and saves it in the project.
          </p>
          {canAssist ? (
            <>
              <div className="mt-3 flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
                <textarea
                  ref={composer}
                  value={prompt}
                  rows={2}
                  disabled={!ready}
                  aria-label="What should the Assistant make?"
                  placeholder={ready ? 'What should the Assistant make?' : busy ? 'Available once every take is saved' : 'Record a take or add a clip first'}
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
                  disabled={!prompt.trim() || !ready}
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
                    disabled={!ready}
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
            <p className="mt-3 text-sm text-muted-foreground">Turn on the Assistant in Settings to edit projects with it.</p>
          )}
        </section>

        <section aria-labelledby="studio-edits">
          <h2 id="studio-edits" className="mb-2 text-sm font-semibold text-muted-foreground">Made from this project</h2>
          {project.edits.length === 0 ? (
            <div className="rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">Nothing yet. What the Assistant makes is saved in the project’s edits folder.</div>
          ) : (
            <ul className="flex flex-col gap-0.5 rounded-xl border p-1">
              {project.edits.map((path) => (
                <EditRow key={path} path={path} onOpen={() => openFile(path)} onReveal={() => reveal(path)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
