import { memo, useState } from 'react';
import { Bot, Loader2, Maximize2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AssistantUnavailable } from '@/shared/assistant/AssistantUnavailable';
import { Composer } from '@/shared/assistant/Composer';
import { ProjectIcon } from '@/shared/assistant/ProjectIcon';
import { FormCard, PermissionCard } from '@/shared/assistant/RequestCards';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import {
  useActiveSessions,
  useAssistantDirectory,
  useAssistantReady,
  useAssistantSessions,
  useDirectoryIcons,
  useHomeDirectory,
  usePendingRequests,
  usePreferredModel,
  useStartConversation,
} from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import {
  cleanAssistantError,
  directoryName,
  getAssistantBridge,
  relativeTime,
  sessionTitle,
  type SessionInfo,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';

const ASSISTANT_APP_ID = 'assistant';

/**
 * The assistant's robot in the menu bar: busy while the agent works, with a
 * dot when it's waiting on the user. Its panel answers what it's waiting on,
 * shows what's running and lately done, and takes a new request. Renders
 * nothing outside the Electron shell or while the assistant is off.
 */
export const AssistantMenuItem = memo(function AssistantMenuItem() {
  const { config } = useAppContext();
  const ready = useAssistantReady();
  const { data: active = [] } = useActiveSessions();
  const pending = usePendingRequests();
  const [open, setOpen] = useState(false);

  if (!getAssistantBridge() || !config.assistantEnabled) return null;

  const waiting = pending.permissions.length + pending.forms.length;
  const working = ready && active.length > 0;
  const label =
    waiting > 0
      ? `Assistant: waiting for you`
      : working
        ? `Assistant: ${active.length} working`
        : 'Assistant';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          title={label}
          className={cn(
            'relative size-7 rounded-md hover:bg-foreground/10 hover:text-foreground',
            working || waiting > 0 ? 'text-primary' : 'text-foreground/90',
          )}
        >
          <Bot className={cn('size-4.5', working && waiting === 0 && 'motion-safe:animate-pulse')} />
          {waiting > 0 && (
            <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-primary ring-2 ring-background" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-96 p-0">
        <AssistantPanel onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
});

function AssistantPanel({ onDone }: { onDone: () => void }) {
  const ready = useAssistantReady();
  const { open } = useWindowActions();
  const show = (sessionID?: string) => {
    open(ASSISTANT_APP_ID, { sessionID, directory: undefined, nonce: Date.now() });
    onDone();
  };

  return (
    <div className="flex max-h-[min(36rem,80vh)] flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <img src="/icons/apps/assistant.png" alt="" className="size-5 object-contain" />
        <p className="flex-1 text-sm font-semibold">Assistant</p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Assistant settings"
          title="Settings"
          onClick={() => {
            open('settings', { section: 'assistant' });
            onDone();
          }}
        >
          <Settings2 className="size-3.5" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Open the Assistant"
          title="Open the Assistant"
          onClick={() => show()}
        >
          <Maximize2 className="size-3.5" aria-hidden />
        </Button>
      </div>
      {ready ? <ReadyPanel onShow={show} onDone={onDone} /> : <AssistantUnavailable compact />}
    </div>
  );
}

function ReadyPanel({ onShow, onDone }: { onShow: (sessionID?: string) => void; onDone: () => void }) {
  const { data: sessions, isLoading } = useAssistantSessions();
  const { data: active = [] } = useActiveSessions();
  const pending = usePendingRequests();
  const home = useHomeDirectory();
  const directory = useAssistantDirectory();
  const { model } = usePreferredModel();
  const start = useStartConversation();
  const { toast } = useToast();

  const all = sessions ?? [];
  const recent = [
    ...all.filter((s) => active.includes(s.id)),
    ...all.filter((s) => !active.includes(s.id) && !s.time.archived).slice(0, 5),
  ];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {(pending.permissions.length > 0 || pending.forms.length > 0) && (
        <section aria-label="Waiting for you" className="space-y-2 p-3">
          {pending.permissions.map((request) => (
            <PermissionCard key={request.id} request={request} className="p-3" />
          ))}
          {pending.forms.map((form) => (
            <FormCard key={form.id} form={form} className="p-3" />
          ))}
        </section>
      )}

      <div className="p-3">
        <Composer
          busy={start.isPending}
          placeholder="Ask the assistant…"
          className="rounded-xl"
          onSubmit={(text, files) =>
            start.mutateAsync(
              { text, files, model, directory },
              {
                onSuccess: (session) => onShow(session.id),
                onError: (error) =>
                  toast({ title: 'Couldn’t ask the assistant', description: cleanAssistantError(error), variant: 'destructive' }),
              },
            )
          }
        />
        <p className="mt-1.5 px-1 text-xs text-muted-foreground">Super+A asks from anywhere.</p>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> Loading conversations…
        </p>
      ) : (
        recent.length > 0 && (
          <SessionSection title="Recent" sessions={recent} active={active} home={home} onShow={onShow} />
        )
      )}
      <button
        type="button"
        onClick={() => {
          onShow();
          onDone();
        }}
        className="w-full border-t border-border/60 px-4 py-2.5 text-left text-sm font-medium text-primary hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        All conversations
      </button>
    </div>
  );
}

function SessionSection({
  title,
  sessions,
  active,
  home,
  onShow,
}: {
  title: string;
  sessions: SessionInfo[];
  active: string[];
  home?: string;
  onShow: (sessionID: string) => void;
}) {
  const icons = useDirectoryIcons([...new Set(sessions.map((s) => s.location.directory))]);
  return (
    <section aria-label={title} className="pb-2">
      <h3 className="px-4 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              onClick={() => onShow(session.id)}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              {active.includes(session.id) ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-label="Working" />
              ) : (
                <ProjectIcon
                  src={icons.get(session.location.directory)}
                  fallback={<Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{sessionTitle(session)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {directoryName(session.location.directory, home)} · {relativeTime(session.time.updated)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
