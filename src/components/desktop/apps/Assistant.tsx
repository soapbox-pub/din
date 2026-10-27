import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Folder,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AssistantUnavailable } from '@/components/desktop/assistant/AssistantUnavailable';
import { Composer } from '@/components/desktop/assistant/Composer';
import { ModelPicker } from '@/components/desktop/assistant/ModelPicker';
import { FormCard, PermissionCard } from '@/components/desktop/assistant/RequestCards';
import { SessionList } from '@/components/desktop/assistant/SessionList';
import { Transcript } from '@/components/desktop/assistant/Transcript';
import { useFilePicker } from '@/contexts/FilePickerContext';
import {
  useActiveSessions,
  useAssistantAgents,
  useAssistantDirectory,
  useAssistantReady,
  useAssistantSession,
  useAssistantSessions,
  useCancelQueued,
  useDeleteSession,
  useHomeDirectory,
  useInterruptSession,
  useMarkViewedSession,
  usePreferredModel,
  useRenameSession,
  useSendPrompt,
  useSessionForms,
  useSessionInbox,
  useSessionMessages,
  useSessionPermissions,
  useStartConversation,
  useSwitchAgent,
  useSwitchModel,
} from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import type { AppComponentProps } from '@/lib/apps';
import {
  cleanAssistantError,
  formatCost,
  modelKey,
  sessionTitle,
  tildify,
  type SessionInfo,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  'What’s taking up the most space in my home folder?',
  'Write a script that renames my screenshots by date',
  'Explain what this computer is running right now',
];

/**
 * Assistant - conversations with OpenCode, the coding agent, through its
 * background server (see src/lib/assistant.ts).
 *
 * Conversations are OpenCode's sessions, so the list includes the ones
 * started from a Terminal too, and they keep working with the window
 * closed: the menu bar's robot shows what's running, and Din notifies when
 * the agent finishes or needs an answer (AssistantHost). The agent asks
 * before what its rules say to ask about; the request shows above the
 * composer. Opened with `sessionID` (and a fresh `nonce`) in its launch
 * params, it shows that conversation; with `directory` instead (Files' "Open
 * in Assistant"), it starts a new one in that folder.
 */
export function Assistant({ params }: AppComponentProps) {
  const ready = useAssistantReady();
  const requested = typeof params?.sessionID === 'string' ? params.sessionID : null;
  const requestedDirectory = typeof params?.directory === 'string' ? params.directory : null;
  const [sessionID, setSessionID] = useState<string | null>(requested);
  const [listOpen, setListOpen] = useState(false);
  // A new conversation from the list, in a project's folder when it says so.
  const [draft, setDraft] = useState<{ directory: string | null; count: number }>({ directory: null, count: 0 });

  // Single-instance: a relaunch (a notification, the menu bar) brings new
  // params without remounting. One with no session asks for a new one.
  const nonce = params?.nonce;
  const [launch, setLaunch] = useState({ requested, nonce });
  if (launch.requested !== requested || launch.nonce !== nonce) {
    setLaunch({ requested, nonce });
    setSessionID(requested);
    setDraft((prev) => ({ directory: null, count: prev.count }));
  }

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-background text-foreground">
        <AssistantUnavailable />
      </div>
    );
  }

  const choose = (id: string | null) => {
    setSessionID(id);
    setListOpen(false);
  };

  const startNew = (directory?: string) => {
    setDraft((prev) => ({ directory: directory ?? null, count: prev.count + 1 }));
    choose(null);
  };

  return (
    <div className="@container/assistant relative flex h-full w-full bg-background text-foreground">
      <SessionList
        selected={sessionID}
        onSelect={choose}
        onNew={startNew}
        className={cn(
          listOpen ? 'flex' : 'hidden',
          'absolute inset-y-0 left-0 z-20 shadow-xl @2xl/assistant:static @2xl/assistant:flex @2xl/assistant:shadow-none',
        )}
      />
      {listOpen && (
        <button
          type="button"
          aria-label="Close the conversation list"
          className="absolute inset-0 z-10 bg-background/40 @2xl/assistant:hidden"
          onClick={() => setListOpen(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {sessionID ? (
          <Conversation key={sessionID} sessionID={sessionID} onShowList={() => setListOpen(true)} onDeleted={() => choose(null)} />
        ) : (
          <NewConversation
            key={`${String(launch.nonce)}:${draft.count}`}
            initialDirectory={draft.directory ?? (draft.count === 0 ? requestedDirectory : null)}
            onStarted={choose}
            onShowList={() => setListOpen(true)}
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

function Conversation({
  sessionID,
  onShowList,
  onDeleted,
}: {
  sessionID: string;
  onShowList: () => void;
  onDeleted: () => void;
}) {
  const { data: session } = useAssistantSession(sessionID);
  const { data: transcript, isLoading } = useSessionMessages(sessionID);
  const { data: permissions = [] } = useSessionPermissions(sessionID);
  const { data: forms = [] } = useSessionForms(sessionID);
  const { data: queued } = useSessionInbox(sessionID);
  const { data: active = [] } = useActiveSessions();
  const { models, setModel } = usePreferredModel();
  const { data: recentData } = useRecentModelKeys();
  const home = useHomeDirectory();
  const send = useSendPrompt(sessionID);
  const interrupt = useInterruptSession();
  const cancelQueued = useCancelQueued();
  const switchModel = useSwitchModel();
  const switchAgent = useSwitchAgent();
  const { toast } = useToast();
  const running = active.includes(sessionID);
  const messages = transcript?.messages;
  useMarkViewedSession(sessionID);

  // Follow the conversation down as it grows, unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, queued, permissions.length, forms.length, running]);

  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: cleanAssistantError(error), variant: 'destructive' });

  return (
    <>
      <ConversationHeader session={session} home={home} running={running} onShowList={onShowList} onDeleted={onDeleted} />
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6 @2xl/assistant:px-6">
          {isLoading && !messages ? (
            <TranscriptSkeleton />
          ) : (
            <>
              {transcript?.more && (
                <p className="mb-6 text-center text-xs text-muted-foreground">Earlier messages aren’t shown.</p>
              )}
              <Transcript
                messages={messages ?? []}
                queued={queued}
                running={running}
                home={home}
                onCancelQueued={(message) =>
                  cancelQueued.mutate({ sessionID, id: message.id }, { onError: fail('Couldn’t cancel') })
                }
              />
            </>
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-4 @2xl/assistant:px-6">
        {permissions.map((request) => (
          <PermissionCard key={request.id} request={request} />
        ))}
        {forms.map((form) => (
          <FormCard key={form.id} form={form} />
        ))}
        <Composer
          autoFocus
          running={running}
          busy={send.isPending}
          placeholder={running ? 'Add something while it works…' : 'Reply…'}
          onSubmit={(text, files) => {
            stick.current = true;
            return send.mutateAsync({ text, files }, { onError: fail('Couldn’t send') });
          }}
          onStop={() => interrupt.mutate(sessionID, { onError: fail('Couldn’t stop') })}
          toolbar={
            <>
              <ModelPicker
                models={models}
                value={session?.model}
                recent={recentData}
                onChange={(model) => {
                  setModel(model);
                  switchModel.mutate({ sessionID, model }, { onError: fail('Couldn’t switch models') });
                }}
              />
              <AgentPicker
                value={session?.agent ?? 'build'}
                onChange={(agent) => switchAgent.mutate({ sessionID, agent }, { onError: fail('Couldn’t switch') })}
              />
            </>
          }
        />
      </div>
    </>
  );
}

function ConversationHeader({
  session,
  home,
  running,
  onShowList,
  onDeleted,
}: {
  session: SessionInfo | undefined;
  home?: string;
  running: boolean;
  onShowList: () => void;
  onDeleted: () => void;
}) {
  const rename = useRenameSession();
  const remove = useDeleteSession();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [confirming, setConfirming] = useState(false);
  const cost = session ? formatCost(session.cost) : '';

  const saveTitle = () => {
    setEditing(false);
    const next = title.trim();
    if (!session || !next || next === session.title) return;
    rename.mutate(
      { sessionID: session.id, title: next },
      { onError: (error) => toast({ title: 'Couldn’t rename', description: cleanAssistantError(error), variant: 'destructive' }) },
    );
  };

  return (
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <ListToggle onClick={onShowList} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') setEditing(false);
            }}
            aria-label="Conversation title"
            className="h-7 text-sm"
          />
        ) : session ? (
          <h2 className="truncate text-sm font-semibold">{sessionTitle(session)}</h2>
        ) : (
          <Skeleton className="h-4 w-48" />
        )}
        {session && (
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <Folder className="size-3 shrink-0" aria-hidden />
            <span className="truncate" title={session.location.directory}>
              {tildify(session.location.directory, home)}
            </span>
            {cost && <span aria-label="Cost so far">· {cost}</span>}
            {running && (
              <span className="flex items-center gap-1 text-primary">
                · <Loader2 className="size-3 animate-spin" aria-hidden /> Working
              </span>
            )}
          </p>
        )}
      </div>
      {session && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Conversation options">
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => {
                setTitle(sessionTitle(session));
                setEditing(true);
              }}
            >
              <Pencil aria-hidden /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              <Trash2 aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              It’s removed from OpenCode too, for every app that shows it. Files the assistant changed stay as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() =>
                session &&
                remove.mutate(session.id, {
                  onSuccess: onDeleted,
                  onError: (error) =>
                    toast({ title: 'Couldn’t delete', description: cleanAssistantError(error), variant: 'destructive' }),
                })
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}

function ListToggle({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 @2xl/assistant:hidden"
      aria-label="Show conversations"
      onClick={onClick}
    >
      <PanelLeft className="size-4" aria-hidden />
    </Button>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-8" aria-label="Loading the conversation">
      <div className="flex justify-end">
        <Skeleton className="h-11 w-2/3 rounded-3xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="mb-5 h-4 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

function NewConversation({
  initialDirectory,
  onStarted,
  onShowList,
}: {
  initialDirectory: string | null;
  onStarted: (id: string) => void;
  onShowList: () => void;
}) {
  const defaultDirectory = useAssistantDirectory();
  const home = useHomeDirectory();
  const [directory, setDirectory] = useState<string | null>(initialDirectory);
  const [agent, setAgent] = useState('build');
  const { model, setModel, models } = usePreferredModel();
  const { data: recent } = useRecentModelKeys();
  const start = useStartConversation();
  const { pickFile } = useFilePicker();
  const { toast } = useToast();
  const folder = directory ?? defaultDirectory;

  const begin = (text: string, files: Parameters<typeof start.mutateAsync>[0]['files'] = []) =>
    start.mutateAsync(
      { text, files, model, agent, directory: folder },
      {
        onSuccess: (session) => onStarted(session.id),
        onError: (error) =>
          toast({ title: 'Couldn’t start the conversation', description: cleanAssistantError(error), variant: 'destructive' }),
      },
    );

  const chooseFolder = async () => {
    const picked = await pickFile({ title: 'Work in a folder', confirmLabel: 'Choose', directory: true, initialPath: folder }).catch(
      () => null,
    );
    if (picked) setDirectory(picked);
  };

  return (
    <>
      <header className="flex items-center px-3 py-2 @2xl/assistant:hidden">
        <ListToggle onClick={onShowList} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 @2xl/assistant:px-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <div aria-hidden className="absolute inset-2 rounded-full bg-primary/25 blur-2xl motion-safe:animate-pulse" />
              <img src="/icons/apps/assistant.png" alt="" className="relative size-24 object-contain drop-shadow-sm" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight @xl/assistant:text-4xl">What can I help with?</h1>
            <p className="max-w-md text-muted-foreground">
              The assistant can read and change files, run commands and look things up on this computer. It asks before
              anything its rules say to check with you.
            </p>
          </div>
          <Composer
            autoFocus
            busy={start.isPending}
            placeholder="Ask the assistant to do something…"
            onSubmit={(text, files) => begin(text, files)}
            toolbar={
              <>
                <ModelPicker models={models} value={model} recent={recent} onChange={setModel} />
                <AgentPicker value={agent} onChange={setAgent} />
              </>
            }
          />
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full" onClick={() => void chooseFolder()}>
              <Folder className="size-3.5" aria-hidden />
              <span className="max-w-60 truncate">{folder ? tildify(folder, home) : 'Home'}</span>
              <ChevronDown className="size-3 opacity-60" aria-hidden />
            </Button>
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                variant="ghost"
                size="sm"
                disabled={start.isPending}
                className="h-8 rounded-full bg-muted/60 text-muted-foreground hover:text-foreground"
                onClick={() => void begin(suggestion).catch(() => {})}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Build (does the work) or Plan (only reads and plans), and any others configured. */
function AgentPicker({ value, onChange }: { value: string; onChange: (agent: string) => void }) {
  const { data: agents = [] } = useAssistantAgents();
  const current = agents.find((a) => a.id === value);
  if (agents.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-label={`Agent: ${current?.name ?? value}`}
        >
          {current?.name ?? value}
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {agents.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id} className="items-start">
              <span>
                <span className="block font-medium">{agent.name}</span>
                {agent.description && (
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{agent.description}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The recently used models' keys, for the picker's first group. */
function useRecentModelKeys(): { data: string[] } {
  const { model } = usePreferredModel();
  const { data: sessions } = useAssistantSessions();
  return useMemo(() => {
    const keys = [
      ...(model ? [modelKey(model)] : []),
      ...(sessions ?? []).flatMap((s) => (s.model ? [modelKey(s.model)] : [])),
    ];
    return { data: [...new Set(keys)] };
  }, [model, sessions]);
}
