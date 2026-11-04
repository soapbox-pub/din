import { createContext, createElement, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  Bot,
  Braces,
  Brain,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  FilePen,
  FileText,
  FolderSearch,
  GitFork,
  Globe,
  ListTodo,
  Loader2,
  MessageCircleQuestion,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { AttachmentItem } from '@/shared/assistant/Attachments';
import { CopyButton } from '@/shared/assistant/CopyButton';
import { Markdown } from '@/shared/assistant/Markdown';
import {
  tildify,
  toolTaskID,
  type AssistantContent,
  type PromptFile,
  type QueuedMessage,
  type SessionMessage,
  type ToolState,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { useAgentColor } from '@/hooks/useAssistant';

/** Tool output shown in full up to this many characters. */
const MAX_OUTPUT_CHARS = 20_000;

type AssistantMessage = Extract<SessionMessage, { type: 'assistant' }>;
type UserMessage = Extract<SessionMessage, { type: 'user' }>;
type IdleMessage = Extract<SessionMessage, { type: 'idle' }>;

/** The agent's work on one prompt: from the user's message to the session going idle. */
interface TurnEntry {
  kind: 'turn';
  id: string;
  /** When the prompt was sent. */
  start: number;
  /** Its assistant messages, and whatever else the session recorded meanwhile. */
  items: SessionMessage[];
  /** How it ended, once it has. */
  idle?: IdleMessage;
}

/** Messages grouped as the transcript shows them. */
type Entry = { kind: 'user'; message: UserMessage } | TurnEntry | { kind: 'note'; message: SessionMessage };

function group(messages: SessionMessage[]): Entry[] {
  const entries: Entry[] = [];
  let turn: TurnEntry | undefined;
  // The prompt the agent is working on, until the session goes idle.
  let prompt: UserMessage | undefined;
  // A compaction partway through a prompt splits its turn; the rest is keyed by the compaction.
  let compaction: SessionMessage | undefined;
  const open = (first: SessionMessage): TurnEntry => {
    // A turn whose prompt is past the loaded window would otherwise be keyed by its
    // first visible message, which changes as the window slides and remounts it.
    const from = compaction ?? prompt;
    turn = {
      kind: 'turn',
      id: compaction ? `turn:${compaction.id}` : prompt ? `turn:${prompt.id}` : entries.length === 0 ? 'turn:earlier' : first.id,
      start: from?.time.created ?? first.time.created,
      items: [],
    };
    entries.push(turn);
    return turn;
  };
  for (const message of messages) {
    if (message.type === 'user') {
      // One sent while it works closes the turn so far; the agent's next steps start another.
      entries.push({ kind: 'user', message });
      turn = undefined;
      prompt = message;
      compaction = undefined;
    } else if (message.type === 'compaction') {
      // The summary reads as a reply of its own, not as part of the work.
      entries.push({ kind: 'note', message });
      turn = undefined;
      if (prompt) compaction = message;
    } else if (message.type === 'idle') {
      if (!turn && prompt) open(message);
      if (turn) turn.idle = message;
      else entries.push({ kind: 'note', message });
      turn = undefined;
      prompt = undefined;
      compaction = undefined;
    } else if (message.type === 'assistant' || turn || prompt) {
      (turn ?? open(message)).items.push(message);
    } else entries.push({ kind: 'note', message });
  }
  return entries;
}

const NO_TASKS: ReadonlySet<string> = new Set();

/** The ids of the commands and subagents the conversation started that still run. */
const TasksContext = createContext(NO_TASKS);

/** Whether a step's call has returned but left a command or subagent running. */
function stillRunning(step: Step, tasks: ReadonlySet<string>): boolean {
  if (step.type !== 'tool' || toolRunning(step)) return false;
  const id = toolTaskID(step);
  return id !== undefined && tasks.has(id);
}

function compacting(message: SessionMessage): boolean {
  return message.type === 'compaction' && message.status === 'running';
}

/** The turn a prompt opens before the agent has written anything. */
function emptyTurn(prompt: UserMessage): TurnEntry {
  return { kind: 'turn', id: `turn:${prompt.id}`, start: prompt.time.created, items: [] };
}

/**
 * "Working · 7s · Running npm test…", for the conversation the agent is
 * working on: what its last turn's working line says, then `children`.
 * `fallback` while it compacts, which says so itself.
 */
export function CurrentWork({
  messages,
  fallback,
  children,
}: {
  messages: SessionMessage[];
  fallback: ReactNode;
  children?: ReactNode;
}) {
  const status = currentWork(messages, useNow(true));
  if (!status) return fallback;
  return (
    <span className="min-w-0 truncate">
      <span className={SHIMMER}>{status}</span>
      {children}
    </span>
  );
}

function currentWork(messages: SessionMessage[], now: number): string | undefined {
  const entries = group(messages);
  const last = entries[entries.length - 1];
  if (last?.kind === 'turn') return workingLabel(last, now);
  if (last?.kind === 'user') return workingLabel(emptyTurn(last.message), now);
  return last && compacting(last.message) ? undefined : 'Working…';
}

/** Whether the trailing group of steps is still going, for the line to narrate it. */
function stepsLive(steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  return steps.some(toolRunning) || (last?.type === 'reasoning' && !last.time?.completed);
}

function workingLabel(turn: TurnEntry, now: number): string {
  const list = blocks(turn.items);
  const tail = list[list.length - 1];
  const tailSteps = tail?.kind === 'steps' ? tail.steps : [];
  const step = stepsLive(tailSteps) ? activeLabel(tailSteps) : tail?.kind === 'text' ? 'Writing…' : 'Thinking…';
  return `Working · ${duration(Math.max(0, now - turn.start))} · ${step}`;
}

/** A conversation's messages, oldest first. */
export const Transcript = memo(function Transcript({
  messages,
  queued = [],
  running,
  tasks = NO_TASKS,
  home,
  onCancelQueued,
  onSendNow,
  onFork,
  workElsewhere = false,
}: {
  messages: SessionMessage[];
  /** Messages sent while it works that the agent hasn't taken yet. */
  queued?: QueuedMessage[];
  /** The agent is working: the last turn shows it. */
  running: boolean;
  /**
   * The ids of the commands and subagents it started that still run: the
   * calls that started them, and what holds those, keep spinning.
   */
  tasks?: ReadonlySet<string>;
  home?: string;
  onCancelQueued?: (message: QueuedMessage) => void;
  /**
   * Given while it's waiting on a command or subagent that can go to the
   * background (Ctrl+B): messages waiting for its next step offer Send now,
   * which moves them there.
   */
  onSendNow?: () => void;
  /** Fork the conversation from before one of the user's messages. */
  onFork?: (message: UserMessage) => void;
  /**
   * What it's doing shows outside the transcript (`CurrentWork`), so the
   * turn it's working on doesn't narrate it: its line just sums up the
   * steps so far ("Read 3 files, ran a command"), to open them.
   */
  workElsewhere?: boolean;
}) {
  const entries = group(messages);
  const last = entries[entries.length - 1];
  // One the agent has just taken can show up in both until the inbox refetches.
  const taken = new Set(messages.map((m) => m.id));
  const waiting = queued.filter((q) => !taken.has(q.id));
  return (
    <TasksContext value={tasks}>
    <ol className="flex flex-col gap-8" aria-label="Conversation">
      {entries.map((entry) => {
        if (entry.kind === 'user') {
          return (
            <li key={entry.message.id} className="group/user flex justify-end">
              <UserBubble message={entry.message} onFork={onFork && (() => onFork(entry.message))} />
            </li>
          );
        }
        if (entry.kind === 'turn') {
          return (
            <li key={entry.id} className="group/turn">
              <Turn
                turn={entry}
                working={running && entry === last}
                latest={entry === last}
                workElsewhere={workElsewhere}
                home={home}
              />
            </li>
          );
        }
        const note = <Note message={entry.message} home={home} />;
        return note ? <li key={entry.message.id}>{note}</li> : null;
      })}
      {running && last?.kind === 'user' && !workElsewhere && (
        <li key={`turn:${last.message.id}`} className="group/turn">
          <Turn turn={emptyTurn(last.message)} working latest home={home} />
        </li>
      )}
      {running && !workElsewhere && last?.kind === 'note' && !compacting(last.message) && (
        <li>
          <Working />
        </li>
      )}
      {waiting.map((message) => (
        <li key={message.id} className="group/user flex justify-end">
          <QueuedBubble
            message={message}
            onCancel={onCancelQueued && (() => onCancelQueued(message))}
            onSendNow={message.delivery === 'steer' ? onSendNow : undefined}
          />
        </li>
      ))}
    </ol>
    </TasksContext>
  );
});

function QueuedBubble({
  message,
  onCancel,
  onSendNow,
}: {
  message: QueuedMessage;
  onCancel?: () => void;
  onSendNow?: () => void;
}) {
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5">
      <Attachments files={message.payload.files} />
      <div className="whitespace-pre-wrap wrap-anywhere rounded-3xl border border-dashed border-border px-5 py-2.5 leading-7 text-muted-foreground">
        {message.payload.text}
      </div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Clock className="size-3" aria-hidden />
        {message.delivery === 'steer' ? 'Sending at its next step' : 'Queued until it’s done'}
        {onSendNow && (
          <button
            type="button"
            onClick={onSendNow}
            title="Move what it’s waiting on to the background (Ctrl+B)"
            className="ml-1 h-6 rounded-md px-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Send now
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel this message"
            title="Cancel"
            className="ml-1 grid size-6 place-items-center rounded-md hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

function Attachments({ files = [] }: { files?: PromptFile[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-end justify-end gap-1.5" aria-label="Attachments">
      {files.map((file, index) => (
        <AttachmentItem key={index} file={{ ...file, uri: file.source?.type === 'uri' ? file.source.uri : undefined }} />
      ))}
    </ul>
  );
}

function UserBubble({ message, onFork }: { message: UserMessage; onFork?: () => void }) {
  const hasText = !!message.text.trim();
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5">
      <Attachments files={message.files} />
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!hasText && !onFork}>
          <div className="whitespace-pre-wrap wrap-anywhere rounded-3xl bg-muted px-5 py-2.5 leading-7 text-foreground">
            {message.text}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {hasText && (
            <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(message.text).catch(() => {})}>
              <Copy aria-hidden /> Copy
            </ContextMenuItem>
          )}
          {onFork && (
            <ContextMenuItem onSelect={onFork}>
              <GitFork aria-hidden /> Fork
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <div className="-mt-0.5 flex opacity-0 focus-within:opacity-100 group-hover/user:opacity-100">
        {onFork && (
          <button
            type="button"
            onClick={onFork}
            aria-label="Fork from here"
            title="Fork: a new conversation from before this message, with it in the composer"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GitFork className="size-4" aria-hidden />
          </button>
        )}
        {hasText && <CopyButton text={message.text} label="Copy message" />}
      </div>
    </div>
  );
}

function Working() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <span className="flex gap-1" aria-hidden>
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 rounded-full bg-current motion-safe:animate-bounce"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      Working…
    </div>
  );
}

type ToolPart = Extract<AssistantContent, { type: 'tool' }>;
type ReasoningPart = Extract<AssistantContent, { type: 'reasoning' }>;
type Step = (ToolPart | ReasoningPart) & { key: string };

/** A turn as it's shown: prose, and each unbroken run of tool calls and thinking folded into one line. */
type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'error'; key: string; message: string }
  | { kind: 'note'; key: string; message: SessionMessage };

function blocks(items: SessionMessage[]): Block[] {
  const out: Block[] = [];
  for (const message of items) {
    if (message.type !== 'assistant') {
      out.push({ kind: 'note', key: message.id, message });
      continue;
    }
    message.content.forEach((part, index) => {
      const key = part.type === 'tool' ? part.id : `${message.id}:${index}`;
      if (part.type === 'text') {
        if (part.text.trim()) out.push({ kind: 'text', key, text: part.text });
        return;
      }
      if (part.type === 'reasoning' && !part.text.trim()) return;
      const last = out[out.length - 1];
      if (last?.kind === 'steps') last.steps.push({ ...part, key });
      else out.push({ kind: 'steps', key, steps: [{ ...part, key }] });
    });
    if (message.error) {
      out.push({ kind: 'error', key: `${message.id}:error`, message: message.error.message ?? message.error.type ?? 'Something went wrong' });
    }
  }
  return out;
}

function toolRunning(step: Step): boolean {
  return step.type === 'tool' && (step.state.status === 'streaming' || step.state.status === 'running');
}

/** The current time, ticking each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** "12s", "5m 12s", "1h 5m". */
function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One turn: the work folded into a single line that narrates it while it runs
 * and sums it up after ("Worked for 5m 12s"), then the reply in full.
 */
function Turn({
  turn,
  working,
  latest,
  workElsewhere = false,
  home,
}: {
  turn: TurnEntry;
  working: boolean;
  latest: boolean;
  /** What it's doing shows elsewhere: while it works, the line only sums up the steps so far, to open them. */
  workElsewhere?: boolean;
  home?: string;
}) {
  const [open, setOpen] = useState(false);
  const tasks = useContext(TasksContext);
  const now = useNow(working);
  const assistants = turn.items.filter((m): m is AssistantMessage => m.type === 'assistant');
  const lastMessage = assistants[assistants.length - 1];
  const list = blocks(turn.items);
  const tail = list[list.length - 1];
  // The trailing group narrates the work while a step in it is still going.
  const live = working && tail?.kind === 'steps' && stepsLive(tail.steps);

  // The reply is the prose after the last step; everything before it is the work.
  let cut = -1;
  list.forEach((block, index) => {
    if (block.kind === 'steps' || block.kind === 'note') cut = index;
  });
  const work = list.slice(0, cut + 1).filter((block) => block.kind !== 'error');
  const workErrors = list.slice(0, cut + 1).filter((block) => block.kind === 'error');
  const after = list.slice(cut + 1);
  const reply = after.flatMap((block) => (block.kind === 'text' ? [block.text.trim()] : [])).join('\n\n');

  const outcome = turn.idle?.outcome ?? (lastMessage?.error ? 'failed' : 'succeeded');
  const end = turn.idle?.time.created ?? Math.max(turn.start, ...assistants.map((m) => m.time.completed ?? m.time.created));
  const elapsed = duration(Math.max(0, end - turn.start));
  // While what it's doing shows elsewhere, the line is only the way into the steps.
  const quiet = working && workElsewhere;
  let label: string;
  if (quiet) label = doneLabel(work.flatMap((block) => (block.kind === 'steps' ? block.steps : [])));
  else if (working) label = workingLabel(turn, now);
  else if (outcome === 'interrupted') label = `Stopped after ${elapsed}`;
  else if (outcome === 'failed') label = `Failed after ${elapsed}`;
  else label = `Worked for ${elapsed}`;
  // What it left running keeps the line spinning after the turn is over.
  const leftRunning = working
    ? 0
    : work.reduce((n, block) => n + (block.kind === 'steps' ? block.steps.filter((s) => stillRunning(s, tasks)).length : 0), 0);
  if (leftRunning > 0) label += ` · ${stillRunningLabel(leftRunning)}`;
  const spinning = (working && !quiet) || leftRunning > 0;

  const render = (block: Block) => {
    if (block.kind === 'text') return <Markdown key={block.key} text={block.text} />;
    if (block.kind === 'error') return <ErrorBanner key={block.key} message={block.message} />;
    if (block.kind === 'note') return <Note key={block.key} message={block.message} home={home} />;
    return <Steps key={block.key} steps={block.steps} live={live && block === tail} />;
  };

  const summary = (
    <>
      {spinning && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
      <span className={cn('min-w-0 truncate', working && !quiet && SHIMMER)}>{label}</span>
    </>
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {work.length > 0 ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className={cn(TRIGGER, 'max-w-full')}>
            {summary}
            <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="ml-1.5 mt-3 flex flex-col gap-4 border-l border-border/60 pl-4">{work.map(render)}</div>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        ((working && !quiet) || (!working && outcome !== 'succeeded')) && (
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">{summary}</p>
        )
      )}
      {workErrors.map(render)}
      {after.map(render)}
      {turn.idle?.outcome === 'failed' && turn.idle.error && (
        <ErrorBanner message={turn.idle.error.message ?? 'The assistant stopped with an error'} />
      )}
      {working && lastMessage?.retry && (
        <p className="text-xs text-muted-foreground">
          Retrying (attempt {lastMessage.retry.attempt})… {lastMessage.retry.error.message}
        </p>
      )}
      {!working && reply && (
        <div
          className={cn(
            '-ml-2 -mt-2 flex',
            !latest && 'opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100',
          )}
        >
          <CopyButton text={reply} label="Copy reply" />
        </div>
      )}
    </div>
  );
}

const SHIMMER =
  'bg-[linear-gradient(90deg,var(--color-muted-foreground)_40%,var(--color-foreground)_50%,var(--color-muted-foreground)_60%)] bg-[length:200%_100%] bg-clip-text text-transparent motion-safe:animate-shimmer';

const TRIGGER =
  'flex min-w-0 items-center gap-1.5 rounded-md text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A run of steps as one line ("Read 3 files, ran a command") that opens into the list of them. */
function Steps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const tasks = useContext(TasksContext);
  if (steps.length === 1 && steps[0].type === 'reasoning') return <Reasoning step={steps[0]} live={live} />;
  const failed = steps.filter((step) => step.type === 'tool' && step.state.status === 'error').length;
  const leftRunning = live ? 0 : steps.filter((step) => stillRunning(step, tasks)).length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(TRIGGER, 'max-w-full')}>
        {(live || leftRunning > 0) && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
        <span className={cn('min-w-0 truncate', live && SHIMMER)} role={live ? 'status' : undefined}>
          {live ? activeLabel(steps) : doneLabel(steps)}
          {leftRunning > 0 && ` · ${stillRunningLabel(leftRunning)}`}
        </span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="ml-1.5 mt-2 flex flex-col gap-0.5 border-l border-border/60 pl-2">
          {steps.map((step) => (
            <li key={step.key}>{step.type === 'tool' ? <ToolStep step={step} /> : <ThoughtStep step={step} />}</li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function thoughtLabel(step: ReasoningPart, live: boolean): string {
  if (live) return 'Thinking…';
  const seconds = step.time?.completed ? Math.round((step.time.completed - step.time.created) / 1000) : 0;
  return seconds > 0 ? `Thought for ${seconds}s` : 'Thought';
}

function Reasoning({ step, live }: { step: ReasoningPart; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={TRIGGER}>
        <span className={cn(live && SHIMMER)}>{thoughtLabel(step, live)}</span>
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown text={step.text} className="mt-2 border-l border-border/60 pl-3 text-sm leading-6 text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

const ROW =
  'group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function RowChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      className={cn(
        'size-3.5 shrink-0 transition-transform',
        open ? 'rotate-90' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
      )}
      aria-hidden
    />
  );
}

function ThoughtStep({ step }: { step: ReasoningPart }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={ROW}>
        <Brain className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{thoughtLabel(step, false)}</span>
        <RowChevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown text={step.text} className="mb-2 ml-7 mt-1 text-sm leading-6 text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function stillRunningLabel(n: number): string {
  return n === 1 ? '1 task still running' : `${n} tasks still running`;
}

function ToolStep({ step }: { step: ToolPart }) {
  const [open, setOpen] = useState(false);
  const background = stillRunning({ ...step, key: step.id }, useContext(TasksContext));
  const { state } = step;
  const kind = toolKind(step.name);
  const target = toolTarget(kind, state);
  const output = toolOutput(state);
  const diff = 'metadata' in state ? state.metadata?.diff : undefined;
  const command = state.status !== 'streaming' && kind.command ? str(state.input.command, false) : undefined;
  const input = state.status === 'streaming' ? state.input : (command ?? JSON.stringify(state.input, null, 2));
  const done = state.status === 'completed' || state.status === 'error';

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={ROW}>
        {createElement(kind.icon, { className: 'size-3.5 shrink-0', 'aria-hidden': true })}
        <span className="min-w-0 flex-1 truncate" title={target?.full}>
          {done && !background ? kind.past(step.name) : kind.active(step.name)}
          {target && <code className="ml-1.5 font-mono text-xs text-foreground/80">{target.short}</code>}
        </span>
        {background && <span className="shrink-0 text-xs">in the background</span>}
        <ToolStatus status={background ? 'running' : state.status} />
        <RowChevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 ml-7 mt-1 space-y-2 rounded-lg bg-muted/50 p-2.5">
          {state.status === 'error' && <ErrorBanner message={state.error.message ?? 'The tool failed'} />}
          {typeof diff === 'string' && diff ? (
            <Diff text={diff} />
          ) : (
            input && <OutputBlock label={command ? 'Command' : 'Input'} text={input} />
          )}
          {output && <OutputBlock label="Output" text={output} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolStatus({ status }: { status: ToolState['status'] }) {
  if (status === 'completed') return null;
  if (status === 'error') return <X className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />;
  return <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Running" />;
}

interface ToolKind {
  icon: LucideIcon;
  /** "Reading", shown while the call runs. */
  active: (name: string) => string;
  /** "Read", once it's done. */
  past: (name: string) => string;
  /** "read 3 files", for a group's summary line. */
  count: (n: number) => string;
  /** What the call acts on, from its input. */
  target?: (input: Record<string, unknown>) => string | undefined;
  /** Count distinct targets rather than calls (the same file read twice is one file). */
  distinct?: boolean;
  /** Its input is a shell command: show that rather than the JSON. */
  command?: boolean;
}

function str(value: unknown, firstLine = true): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return firstLine ? value.trim().split('\n')[0] : value.trim();
}

const filePath = (input: Record<string, unknown>) => str(input.filePath) ?? str(input.path) ?? str(input.file_path);

const counted = (one: string, many: string) => (n: number) => (n === 1 ? one : many.replace('#', String(n)));
const fixed = (text: string) => () => text;

const TOOL_KINDS: [RegExp, ToolKind][] = [
  [/^(read|view|cat)$/, { icon: FileText, active: fixed('Reading'), past: fixed('Read'), count: counted('read a file', 'read # files'), target: filePath, distinct: true }],
  [/^(write|edit|patch|multiedit|apply_patch)/, { icon: FilePen, active: fixed('Editing'), past: fixed('Edited'), count: counted('edited a file', 'edited # files'), target: filePath, distinct: true }],
  [/^(execute|code)/, { icon: Braces, active: fixed('Running code'), past: fixed('Ran code'), count: counted('ran code', 'ran code # times'), target: (input) => str(input.description) }],
  [/^(bash|shell|exec|command)/, { icon: SquareTerminal, active: fixed('Running'), past: fixed('Ran'), count: counted('ran a command', 'ran # commands'), target: (input) => str(input.command), command: true }],
  [/^websearch/, { icon: Globe, active: fixed('Searching the web for'), past: fixed('Searched the web for'), count: counted('searched the web', 'searched the web # times'), target: (input) => str(input.query) }],
  [/^(webfetch|fetch|browse)/, { icon: Globe, active: fixed('Opening'), past: fixed('Opened'), count: counted('opened a page', 'opened # pages'), target: (input) => str(input.url), distinct: true }],
  [/^(grep|search)/, { icon: Search, active: fixed('Searching for'), past: fixed('Searched for'), count: counted('searched the code', 'searched the code # times'), target: (input) => str(input.pattern) ?? str(input.query) }],
  [/^(glob|list|ls|find)/, { icon: FolderSearch, active: fixed('Looking for'), past: fixed('Looked for'), count: counted('looked for files', 'looked for files # times'), target: (input) => str(input.pattern) ?? filePath(input) }],
  [/^todo/, { icon: ListTodo, active: fixed('Updating the plan'), past: fixed('Updated the plan'), count: counted('updated the plan', 'updated the plan # times') }],
  [/^(task|subagent|agent)/, { icon: Bot, active: fixed('Delegating'), past: fixed('Delegated'), count: counted('started a subagent', 'started # subagents'), target: (input) => str(input.description) }],
  [/^skill/, { icon: Sparkles, active: fixed('Loading skill'), past: fixed('Loaded skill'), count: counted('loaded a skill', 'loaded # skills'), target: (input) => str(input.id) ?? str(input.name) }],
  [/^question/, { icon: MessageCircleQuestion, active: fixed('Asking you'), past: fixed('Asked you'), count: counted('asked you a question', 'asked you # questions') }],
];

const OTHER_TOOL: ToolKind = {
  icon: Wrench,
  active: (name) => `Using ${name}`,
  past: (name) => `Used ${name}`,
  count: counted('used a tool', 'used # tools'),
  target: (input) => {
    for (const key of ['description', 'command', 'path', 'filePath', 'file_path', 'pattern', 'url', 'query', 'prompt']) {
      const value = str(input[key]);
      if (value) return value;
    }
  },
};

function toolKind(name: string): ToolKind {
  return TOOL_KINDS.find(([pattern]) => pattern.test(name.toLowerCase()))?.[1] ?? OTHER_TOOL;
}

/** What a call acts on, short (a file's name, a URL without its scheme) and in full. */
function toolTarget(kind: ToolKind, state: ToolState): { short: string; full: string } | undefined {
  if (state.status === 'streaming') return undefined;
  const full = kind.target?.(state.input);
  if (!full) return undefined;
  if (kind.target === filePath) return { short: full.replace(/\/+$/, '').split('/').pop() || full, full };
  if (/^https?:\/\//.test(full)) return { short: full.replace(/^https?:\/\//, ''), full };
  return { short: full, full };
}

function stepLabel(step: ToolPart, done: boolean): string {
  const kind = toolKind(step.name);
  const target = toolTarget(kind, step.state);
  const verb = done ? kind.past(step.name) : kind.active(step.name);
  return target ? `${verb} ${target.short}` : verb;
}

/** What the group is doing now: the newest step that's still going. */
function activeLabel(steps: Step[]): string {
  const last = steps[steps.length - 1];
  if (last.type === 'reasoning') return 'Thinking…';
  const running = steps.filter((step): step is Step & ToolPart => toolRunning(step));
  return `${stepLabel(running[running.length - 1] ?? last, false)}…`;
}

/** What the group did: "Read 3 files, edited a file, ran 2 commands". */
function doneLabel(steps: Step[]): string {
  const tools = steps.filter((step): step is Step & ToolPart => step.type === 'tool');
  if (tools.length === 0) return 'Thought';
  if (tools.length === 1) return stepLabel(tools[0], true);
  const tallies = new Map<ToolKind, { calls: number; targets: Set<string> }>();
  for (const tool of tools) {
    const kind = toolKind(tool.name);
    const tally = tallies.get(kind) ?? { calls: 0, targets: new Set<string>() };
    tally.calls++;
    const target = toolTarget(kind, tool.state);
    if (target) tally.targets.add(target.full);
    tallies.set(kind, tally);
  }
  const phrases = [...tallies].map(([kind, { calls, targets }]) => kind.count(kind.distinct && targets.size ? targets.size : calls));
  const text = phrases.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toolOutput(state: ToolState): string {
  if (state.status === 'completed' || state.status === 'error') {
    return (state.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.name ?? c.mime ?? 'file'}]`))
      .join('\n');
  }
  return '';
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  const clipped = text.length > MAX_OUTPUT_CHARS;
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-xs leading-relaxed">
        {clipped ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text}
      </pre>
    </div>
  );
}

function Diff({ text }: { text: string }) {
  const lines = text.slice(0, MAX_OUTPUT_CHARS).split('\n');
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-background/70 py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            'px-2',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/15 text-red-700 dark:text-red-300',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

function Divider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border/70" />
      <span className="max-w-[70%] truncate">{children}</span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function AgentSwitched({ agent }: { agent: string }) {
  const color = useAgentColor();
  return (
    <Divider>
      Agent: <span style={{ color: color(agent) }}>{agent}</span>
    </Divider>
  );
}

/** The summary that replaced the conversation so far in the model's context, shown as a reply. */
function Compaction({ message }: { message: Extract<SessionMessage, { type: 'compaction' }> }) {
  const summary = message.summary?.trim();
  if (message.status === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <Divider>Couldn’t summarize the conversation</Divider>
        {message.error && message.error.type !== 'aborted' && (
          <ErrorBanner message={message.error.message ?? 'The summary failed'} />
        )}
      </div>
    );
  }
  const running = message.status === 'running';
  return (
    <div className="group/turn flex min-w-0 flex-col gap-4">
      <Divider>
        <span className={cn(running && SHIMMER)}>{running ? 'Summarizing the conversation…' : 'Conversation summarized'}</span>
      </Divider>
      {summary && <Markdown text={summary} />}
      {!running && summary && (
        <div className="-ml-2 -mt-2 flex opacity-0 focus-within:opacity-100 group-hover/turn:opacity-100">
          <CopyButton text={summary} label="Copy summary" />
        </div>
      )}
    </div>
  );
}

type SyntheticMessage = Extract<SessionMessage, { type: 'synthetic' | 'system' }>;

/** A command's leading `cd <dir> &&`, which says nothing about what it does. */
const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;

/** What finished in the background and how, for its notice's line. */
function backgroundLabel(source: string, state: string | undefined): { icon: LucideIcon; text: string } {
  const how = state === 'error' ? 'failed' : state === 'cancelled' ? 'stopped' : 'finished';
  if (source === 'shell') return { icon: SquareTerminal, text: `Background command ${how}` };
  if (source === 'subagent') return { icon: Bot, text: `Subagent ${how}` };
  if (/image/i.test(source)) return { icon: Sparkles, text: `Image ${how}` };
  return { icon: Clock, text: `Background task ${how}` };
}

/**
 * The notice the session gets when work it left running finishes (a
 * background command, subagent or image): a quiet row like a tool step's,
 * naming it, that opens into what it reported.
 */
function BackgroundDone({ message }: { message: SyntheticMessage }) {
  const [open, setOpen] = useState(false);
  const { source = '', state } = message.metadata ?? {};
  const { icon, text } = backgroundLabel(source, state);
  const full = message.description?.trim() ?? '';
  const short = (source === 'shell' ? full.replace(LEADING_CD, '') : full).split('\n')[0];
  // The report comes wrapped in one element (`<shell id=… command=…>…</shell>`).
  const body = message.text.trim().replace(/^<[a-z_-]+\b[^>]*>\n?/i, '').replace(/\n?<\/[a-z_-]+>$/i, '').trim();
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(ROW, '-ml-1.5 w-[calc(100%+0.75rem)]')}>
        {createElement(icon, { className: 'size-3.5 shrink-0', 'aria-hidden': true })}
        <span className="min-w-0 flex-1 truncate" title={full}>
          {text}
          {short && <code className="ml-1.5 font-mono text-xs text-foreground/80">{short}</code>}
        </span>
        {state === 'error' && <X className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />}
        <RowChevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 ml-5 mt-1 space-y-2 rounded-lg bg-muted/50 p-2.5">
          {source === 'shell' && full && <OutputBlock label="Command" text={full} />}
          {body && <OutputBlock label={source === 'shell' ? 'Output' : 'Result'} text={body} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Everything else a session records, as a quiet line, or nothing. */
function Note({ message, home }: { message: SessionMessage; home?: string }) {
  switch (message.type) {
    case 'model-switched':
      return <Divider>Model: {message.model.id}</Divider>;
    case 'agent-switched':
      return <AgentSwitched agent={message.agent} />;
    case 'location-switched':
      return <Divider>Working in {tildify(message.location.directory, home)}</Divider>;
    case 'compaction':
      return <Compaction message={message} />;
    case 'skill':
      return <Divider>Using skill: {message.name}</Divider>;
    case 'synthetic':
      if (message.metadata?.source) return <BackgroundDone message={message} />;
      return message.description ? <Divider>{message.description}</Divider> : null;
    case 'shell':
      return (
        <div className="rounded-lg bg-muted/50 p-2.5">
          <p className="font-mono text-xs">$ {message.command}</p>
          {message.output?.output && <OutputBlock label="Output" text={message.output.output} />}
        </div>
      );
    case 'idle':
      if (message.outcome === 'interrupted') return <Divider>Stopped</Divider>;
      if (message.outcome === 'failed' && message.error) {
        return <ErrorBanner message={message.error.message ?? 'The assistant stopped with an error'} />;
      }
      return null;
    default:
      return null;
  }
}
