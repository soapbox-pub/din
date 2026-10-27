import { createElement, memo, useState, type ReactNode } from 'react';
import {
  Bot,
  Braces,
  Brain,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  FolderSearch,
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
import { CopyButton } from '@/components/desktop/assistant/CopyButton';
import { Markdown } from '@/components/desktop/assistant/Markdown';
import { tildify, type AssistantContent, type SessionMessage, type ToolState } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** Tool output shown in full up to this many characters. */
const MAX_OUTPUT_CHARS = 20_000;

type AssistantMessage = Extract<SessionMessage, { type: 'assistant' }>;

/** Messages grouped as the transcript shows them: each assistant run is one turn. */
type Entry =
  | { kind: 'user'; message: Extract<SessionMessage, { type: 'user' }> }
  | { kind: 'turn'; id: string; messages: AssistantMessage[] }
  | { kind: 'note'; message: SessionMessage };

function group(messages: SessionMessage[]): Entry[] {
  const entries: Entry[] = [];
  for (const message of messages) {
    if (message.type === 'user') entries.push({ kind: 'user', message });
    else if (message.type === 'assistant') {
      const last = entries[entries.length - 1];
      if (last?.kind === 'turn') last.messages.push(message);
      else entries.push({ kind: 'turn', id: message.id, messages: [message] });
    } else entries.push({ kind: 'note', message });
  }
  return entries;
}

/** A conversation's messages, oldest first. */
export const Transcript = memo(function Transcript({
  messages,
  running,
  home,
}: {
  messages: SessionMessage[];
  /** The agent is working: the last turn shows it. */
  running: boolean;
  home?: string;
}) {
  const entries = group(messages);
  const last = entries[entries.length - 1];
  return (
    <ol className="flex flex-col gap-8" aria-label="Conversation">
      {entries.map((entry) => {
        if (entry.kind === 'user') {
          return (
            <li key={entry.message.id} className="group/user flex justify-end">
              <UserBubble message={entry.message} />
            </li>
          );
        }
        if (entry.kind === 'turn') {
          return (
            <li key={entry.id} className="group/turn">
              <Turn messages={entry.messages} working={running && entry === last} latest={entry === last} />
            </li>
          );
        }
        const note = <Note message={entry.message} home={home} />;
        return note ? <li key={entry.message.id}>{note}</li> : null;
      })}
      {running && last?.kind !== 'turn' && (
        <li>
          <Working />
        </li>
      )}
    </ol>
  );
});

function UserBubble({ message }: { message: Extract<SessionMessage, { type: 'user' }> }) {
  return (
    <div className="flex max-w-[80%] flex-col items-end gap-1.5">
      {(message.files ?? []).length > 0 && (
        <ul className="flex flex-wrap justify-end gap-1.5">
          {(message.files ?? []).map((file, index) => (
            <li
              key={index}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
            >
              <FileText className="size-3.5" aria-hidden />
              {file.name ?? file.mime}
            </li>
          ))}
        </ul>
      )}
      <div className="whitespace-pre-wrap break-words rounded-3xl bg-muted px-5 py-2.5 leading-7 text-foreground">
        {message.text}
      </div>
      {message.text.trim() && (
        <CopyButton
          text={message.text}
          label="Copy message"
          className="-mt-0.5 opacity-0 focus-visible:opacity-100 group-hover/user:opacity-100"
        />
      )}
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
  | { kind: 'error'; key: string; message: string };

function blocks(messages: AssistantMessage[]): Block[] {
  const out: Block[] = [];
  for (const message of messages) {
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

function Turn({ messages, working, latest }: { messages: AssistantMessage[]; working: boolean; latest: boolean }) {
  const lastMessage = messages[messages.length - 1];
  const list = blocks(messages);
  const tail = list[list.length - 1];
  const tailSteps = tail?.kind === 'steps' ? tail.steps : [];
  const lastStep = tailSteps[tailSteps.length - 1];
  // The trailing group narrates the work while a step in it is still going.
  const live = working && (tailSteps.some(toolRunning) || (lastStep?.type === 'reasoning' && !lastStep.time?.completed));
  const reply = list.flatMap((block) => (block.kind === 'text' ? [block.text.trim()] : [])).join('\n\n');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {list.map((block) => {
        if (block.kind === 'text') return <Markdown key={block.key} text={block.text} />;
        if (block.kind === 'error') return <ErrorBanner key={block.key} message={block.message} />;
        return <Steps key={block.key} steps={block.steps} live={live && block === tail} />;
      })}
      {lastMessage?.retry && (
        <p className="text-xs text-muted-foreground">
          Retrying (attempt {lastMessage.retry.attempt})… {lastMessage.retry.error.message}
        </p>
      )}
      {working && !live && <Working />}
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
  if (steps.length === 1 && steps[0].type === 'reasoning') return <Reasoning step={steps[0]} live={live} />;
  const failed = steps.filter((step) => step.type === 'tool' && step.state.status === 'error').length;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={cn(TRIGGER, 'max-w-full')}>
        {live && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />}
        <span className={cn('min-w-0 truncate', live && SHIMMER)} role={live ? 'status' : undefined}>
          {live ? activeLabel(steps) : doneLabel(steps)}
        </span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="ml-1.5 mt-2 flex flex-col gap-0.5 border-l border-border pl-2">
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
        <Markdown text={step.text} className="mt-2 border-l border-border pl-3 text-sm leading-6 text-muted-foreground" />
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

function ToolStep({ step }: { step: ToolPart }) {
  const [open, setOpen] = useState(false);
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
          {done ? kind.past(step.name) : kind.active(step.name)}
          {target && <code className="ml-1.5 font-mono text-xs text-foreground/80">{target.short}</code>}
        </span>
        <ToolStatus status={state.status} />
        <RowChevron open={open} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 ml-7 mt-1 space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
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

/** Everything else a session records, as a quiet line, or nothing. */
function Note({ message, home }: { message: SessionMessage; home?: string }) {
  switch (message.type) {
    case 'model-switched':
      return <Divider>Model: {message.model.id}</Divider>;
    case 'agent-switched':
      return <Divider>Agent: {message.agent}</Divider>;
    case 'location-switched':
      return <Divider>Working in {tildify(message.location.directory, home)}</Divider>;
    case 'compaction':
      return <Divider>{message.status === 'running' ? 'Summarizing the conversation…' : 'Conversation summarized'}</Divider>;
    case 'skill':
      return <Divider>Using skill: {message.name}</Divider>;
    case 'shell':
      return (
        <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
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
