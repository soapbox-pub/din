import { useEffect, useState } from 'react';
import { Bot, ChevronRight, Copy, Loader2, MessageSquare, Square, SquareTerminal } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CurrentWork } from '@/shared/assistant/Transcript';
import type { BackgroundTask } from '@/hooks/useAssistant';
import type { SessionMessage } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** "12s", "5m", "1h 5m": how long a task has run, to the minute past the first. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const ICON_BUTTON =
  'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';

/**
 * Above the composer: "2 background tasks running", for the commands and
 * subagents the agent left running after its turn (or while it carries on),
 * opening into a list of them to open or stop. Nothing when there are none.
 * While the agent works it's the working line too ("Working · 7s · Running…
 * · 2 in the background"), which the transcript then leaves out.
 */
export function BackgroundTasks({
  tasks,
  working,
  stopping,
  onOpen,
  onStop,
}: {
  tasks: BackgroundTask[];
  /** The conversation, while the agent works on it. */
  working?: SessionMessage[];
  /** The tasks being stopped. */
  stopping: ReadonlySet<string>;
  /** Open a subagent's conversation. */
  onOpen: (sessionID: string) => void;
  onStop: (task: BackgroundTask) => void;
}) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  const count = (
    <span role="status" className="min-w-0 truncate">
      {tasks.length === 1 ? '1 background task' : `${tasks.length} background tasks`} running…
    </span>
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        {working ? (
          <CurrentWork messages={working} fallback={count}>
            {` · ${tasks.length} in the background`}
          </CurrentWork>
        ) : (
          count
        )}
        <ChevronRight className={cn('size-3.5 shrink-0 motion-safe:transition-transform', open && 'rotate-90')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul
          aria-label="Background tasks"
          className="mt-2 max-h-56 space-y-px overflow-y-auto rounded-xl border border-border/70 bg-muted/30 p-1"
        >
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              stopping={stopping.has(task.id)}
              onOpen={task.kind === 'subagent' ? () => onOpen(task.id) : undefined}
              onStop={() => onStop(task)}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TaskRow({
  task,
  stopping,
  onOpen,
  onStop,
}: {
  task: BackgroundTask;
  stopping: boolean;
  onOpen?: () => void;
  onStop: () => void;
}) {
  const now = useNow();
  const shell = task.kind === 'shell';
  const Icon = shell ? SquareTerminal : Bot;
  const copy = () => void navigator.clipboard?.writeText(task.title).catch(() => {});
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group flex min-w-0 items-center gap-2 rounded-lg py-0.5 pl-2 pr-0.5 text-sm hover:bg-foreground/5">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={shell ? 'Command' : 'Subagent'} />
            {onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                title={`Open “${task.title}”`}
                className="min-w-0 flex-1 truncate rounded-sm text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {task.title}
              </button>
            ) : (
              <code className="min-w-0 flex-1 truncate font-mono text-xs" title={task.title}>
                {task.title}
              </code>
            )}
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title="Running for">
              {elapsed(now - task.started)}
            </span>
            {onOpen && (
              <button type="button" onClick={onOpen} className={ICON_BUTTON} aria-label="Open its conversation" title="Open its conversation">
                <MessageSquare className="size-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              className={ICON_BUTTON}
              aria-label={shell ? 'Stop the command' : 'Stop the subagent'}
              title="Stop"
            >
              {stopping ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Square className="size-3 fill-current" aria-hidden />}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onOpen ? (
            <ContextMenuItem onSelect={onOpen}>
              <MessageSquare aria-hidden /> Open Its Conversation
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={copy}>
              <Copy aria-hidden /> Copy Command
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled={stopping} onSelect={onStop}>
            <Square aria-hidden /> Stop
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}
