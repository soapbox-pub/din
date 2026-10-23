import { createElement, memo, useState, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
    <ol className="flex flex-col gap-5" aria-label="Conversation">
      {entries.map((entry) => {
        if (entry.kind === 'user') {
          return (
            <li key={entry.message.id} className="flex justify-end">
              <UserBubble message={entry.message} />
            </li>
          );
        }
        if (entry.kind === 'turn') {
          return (
            <li key={entry.id}>
              <Turn messages={entry.messages} working={running && entry === last} />
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
    <div className="flex max-w-[85%] flex-col items-end gap-1.5">
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
      <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground shadow-sm">
        {message.text}
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

function Turn({ messages, working }: { messages: AssistantMessage[]; working: boolean }) {
  const lastMessage = messages[messages.length - 1];
  return (
    <div className="flex gap-3">
      <div
        aria-hidden
        className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary/25 to-primary/5 text-primary ring-1 ring-primary/20"
      >
        <Bot className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-2">
            {message.content.map((part, index) => (
              <Part key={part.type === 'tool' ? part.id : `${message.id}:${index}`} part={part} />
            ))}
            {message.retry && message === lastMessage && (
              <p className="text-xs text-muted-foreground">
                Retrying (attempt {message.retry.attempt})… {message.retry.error.message}
              </p>
            )}
            {message.error && <ErrorBanner message={message.error.message ?? message.error.type ?? 'Something went wrong'} />}
          </div>
        ))}
        {working && <Working />}
      </div>
    </div>
  );
}

function Part({ part }: { part: AssistantContent }) {
  if (part.type === 'text') return part.text.trim() ? <Markdown text={part.text} /> : null;
  if (part.type === 'reasoning') return part.text.trim() ? <Reasoning text={part.text} /> : null;
  return <ToolCard name={part.name} state={part.state} />;
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        <Brain className="size-3.5" aria-hidden />
        Thinking
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Markdown text={text} className="mt-1.5 border-l-2 border-border pl-3 text-sm text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

const TOOL_ICONS: [RegExp, LucideIcon][] = [
  [/^(read|view|cat)$/, FileText],
  [/^(write|edit|patch|multiedit|apply_patch)/, FilePen],
  [/^(bash|shell|exec|command)/, SquareTerminal],
  [/^(grep|search|websearch)/, Search],
  [/^(glob|list|ls|find)/, FolderSearch],
  [/^(webfetch|fetch|browse)/, Globe],
  [/^(todo)/, ListTodo],
  [/^(task|subagent|agent)/, Bot],
];

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const icon = TOOL_ICONS.find(([pattern]) => pattern.test(name.toLowerCase()))?.[1] ?? Wrench;
  return createElement(icon, { className, 'aria-hidden': true });
}

/** The one-line gist of a tool call: the file, command, pattern or URL. */
function toolSummary(state: ToolState): string {
  if (state.status === 'streaming') return '';
  const input = state.input;
  for (const key of ['description', 'command', 'path', 'filePath', 'file_path', 'pattern', 'url', 'query', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0];
  }
  return '';
}

function toolOutput(state: ToolState): string {
  if (state.status === 'completed' || state.status === 'error') {
    return (state.content ?? [])
      .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.name ?? c.mime ?? 'file'}]`))
      .join('\n');
  }
  return '';
}

function ToolCard({ name, state }: { name: string; state: ToolState }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(state);
  const output = toolOutput(state);
  const diff = 'metadata' in state ? state.metadata?.diff : undefined;
  const input = state.status === 'streaming' ? state.input : JSON.stringify(state.input, null, 2);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border/70 bg-muted/30">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ToolIcon name={name} className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={summary}>
          {summary}
        </span>
        <ToolStatus status={state.status} />
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t border-border/60 p-2.5">
          {state.status === 'error' && <ErrorBanner message={state.error.message ?? 'The tool failed'} />}
          {typeof diff === 'string' && diff ? (
            <Diff text={diff} />
          ) : (
            <OutputBlock label="Input" text={input} />
          )}
          {output && <OutputBlock label="Output" text={output} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolStatus({ status }: { status: ToolState['status'] }) {
  if (status === 'completed') return <Check className="size-3.5 shrink-0 text-primary" aria-label="Done" />;
  if (status === 'error') return <X className="size-3.5 shrink-0 text-destructive" aria-label="Failed" />;
  return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Running" />;
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
