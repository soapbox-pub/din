import { memo, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { CornerDownLeft } from 'lucide-react';
import { AssistantUnavailable } from '@/components/desktop/assistant/AssistantUnavailable';
import { Composer } from '@/components/desktop/assistant/Composer';
import { ModelPicker } from '@/components/desktop/assistant/ModelPicker';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import {
  assistantKeys,
  getViewedSession,
  isDinSession,
  subscribeAssistantEvents,
  useAssistantDirectory,
  useAssistantEventSync,
  useAssistantReady,
  usePendingRequests,
  usePreferredModel,
  useReplyPermission,
  useStartConversation,
} from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import {
  assistantApi,
  cleanAssistantError,
  describePermission,
  getAssistantBridge,
  sessionTitle,
  type PermissionRequest,
} from '@/lib/assistant';
import {
  isAssistantPromptDictationHeld,
  onHoldAssistantPromptDictation,
  onToggleAssistantPrompt,
} from '@/lib/assistantPrompt';
import { cancelDictation, elementTarget, getDictationState, startDictation } from '@/lib/dictation';
import { closeNotification, notify } from '@/lib/notificationCenter';
import { focusedWindow, type WindowState } from '@/hooks/useWindows';

const ASSISTANT_APP_ID = 'assistant';
const SOURCE = { appId: ASSISTANT_APP_ID, name: 'Assistant' };

/**
 * The assistant's desktop-wide half. Renders the Super+A prompt, else
 * nothing.
 *
 * - Tells the main process whether the assistant is on (Settings →
 *   Assistant), which starts OpenCode's server and follows its events.
 * - Keeps the assistant's queries current from those events.
 * - Notifies when the agent needs an answer (a permission request, with
 *   Allow and Deny right on the notification, or a question), and when a
 *   conversation started in Din finishes - unless that conversation is on
 *   screen already.
 * - The prompt: Super+A anywhere opens a box to ask the assistant something;
 *   Enter starts a conversation and shows it in the Assistant window.
 */
export const AssistantHost = memo(function AssistantHost() {
  const { config } = useAppContext();
  const enabled = config.assistantEnabled;

  useEffect(() => {
    void getAssistantBridge()?.setEnabled(enabled).catch(() => {});
  }, [enabled]);

  useAssistantEventSync();

  return (
    <>
      <AssistantNotifications />
      <QuickPrompt />
    </>
  );
});

/** Subscribes to window state (to know what's on screen), so kept apart. */
function AssistantNotifications() {
  useAssistantNotifications();
  return null;
}

/** Whether the user is looking at this conversation right now. */
function useIsWatching(): (sessionID: string) => boolean {
  const { windows } = useWindowManager();
  const windowsRef = useRef<WindowState[]>(windows);
  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);
  return (sessionID) => {
    if (getViewedSession() !== sessionID || !document.hasFocus()) return false;
    const top = focusedWindow(windowsRef.current);
    return top?.appId === ASSISTANT_APP_ID;
  };
}

function useAssistantNotifications() {
  const ready = useAssistantReady();
  const { permissions, forms } = usePendingRequests();
  const { open } = useWindowActions();
  const reply = useReplyPermission();
  const queryClient = useQueryClient();
  const isWatching = useIsWatching();

  const show = (sessionID: string) => open(ASSISTANT_APP_ID, { sessionID, nonce: Date.now() });
  // The latest of each for callbacks that outlive a render.
  const latest = useRef({ show, reply: reply.mutate, isWatching });
  useEffect(() => {
    latest.current = { show, reply: reply.mutate, isWatching };
  });

  // Permission requests and questions: one notification each, gone once
  // answered (here, in the window, or in a Terminal).
  const shown = useRef(new Map<string, string>());
  useEffect(() => {
    if (!ready) return;
    const pending = new Set<string>();
    const announce = (key: string, sessionID: string, make: () => string) => {
      pending.add(key);
      if (shown.current.has(key)) return;
      if (latest.current.isWatching(sessionID)) {
        // On screen already; don't announce it later either.
        shown.current.set(key, '');
        return;
      }
      shown.current.set(key, make());
    };

    for (const request of permissions) {
      announce(`permission:${request.id}`, request.sessionID, () => notifyPermission(request));
    }
    for (const form of forms) {
      announce(`form:${form.id}`, form.sessionID, () =>
        notify({
          source: SOURCE,
          title: 'The assistant has a question',
          // The question tool titles every form "Questions"; the question
          // itself is the first field's.
          body: form.fields[0]?.description || form.fields[0]?.title || form.title,
          urgency: 'critical',
          replaceKey: `assistant:form:${form.id}`,
          onActivate: () => latest.current.show(form.sessionID),
        }),
      );
    }
    for (const [key, notificationId] of shown.current) {
      if (pending.has(key)) continue;
      if (notificationId) closeNotification(notificationId, 'closed');
      shown.current.delete(key);
    }

    function notifyPermission(request: PermissionRequest): string {
      const { title, detail } = describePermission(request);
      return notify({
        source: SOURCE,
        title: `Allow the assistant to ${title.toLowerCase()}?`,
        body: detail,
        urgency: 'critical',
        actions: [
          { id: 'once', label: 'Allow' },
          { id: 'reject', label: 'Deny' },
        ],
        replaceKey: `assistant:permission:${request.id}`,
        onActivate: (action) => {
          if (action === 'once' || action === 'reject') latest.current.reply({ request, decision: action });
          else latest.current.show(request.sessionID);
        },
      });
    }
  }, [ready, permissions, forms]);

  // A conversation started here finishing, or failing.
  useEffect(
    () =>
      subscribeAssistantEvents((event) => {
        const sessionID = event.sessionID;
        if (!sessionID || !isDinSession(sessionID) || latest.current.isWatching(sessionID)) return;
        const failed = event.type === 'session.execution.failed';
        if (event.type !== 'session.execution.succeeded' && !failed) return;
        const error = event.data?.error as { message?: unknown } | undefined;
        void queryClient
          .fetchQuery({ queryKey: assistantKeys.session(sessionID), queryFn: () => assistantApi.session(sessionID) })
          .catch(() => null)
          .then((session) =>
            notify({
              source: SOURCE,
              title: failed ? 'The assistant stopped with an error' : 'The assistant is done',
              body: failed && typeof error?.message === 'string' ? error.message : session ? sessionTitle(session) : '',
              replaceKey: `assistant:done:${sessionID}`,
              onActivate: () => latest.current.show(sessionID),
            }),
          );
      }),
    [queryClient],
  );
}

/** The Super+A box: ask something from anywhere. */
const QuickPrompt = memo(function QuickPrompt() {
  const [open, setOpen] = useState(false);
  const ready = useAssistantReady();
  const directory = useAssistantDirectory();
  const { model, setModel, models } = usePreferredModel();
  const start = useStartConversation();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => onToggleAssistantPrompt(() => setOpen((current) => !current)), []);

  // Holding Super+A opens the prompt listening; the text lands in it when the
  // key comes up, unsent.
  const dictatePending = useRef(false);
  const dictatedInto = useRef<HTMLTextAreaElement | null>(null);
  const [holdNonce, setHoldNonce] = useState(0);
  useEffect(
    () =>
      onHoldAssistantPromptDictation(() => {
        dictatePending.current = true;
        setOpen(true);
        setHoldNonce((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!open) {
      dictatePending.current = false;
      if (dictatedInto.current && getDictationState().owner === dictatedInto.current) cancelDictation();
      dictatedInto.current = null;
      return;
    }
    // The dialog's content mounts a frame or so after it opens.
    let frame = 0;
    let tries = 0;
    const start = () => {
      if (!dictatePending.current) return;
      const textarea = textareaRef.current;
      if (!textarea) {
        if (++tries < 30) frame = requestAnimationFrame(start);
        return;
      }
      dictatePending.current = false;
      if (!isAssistantPromptDictationHeld()) return;
      dictatedInto.current = textarea;
      void startDictation(elementTarget(textarea), { held: true });
    };
    start();
    return () => cancelAnimationFrame(frame);
  }, [open, holdNonce, ready]);

  const submit = (text: string, files: Parameters<typeof start.mutateAsync>[0]['files']) =>
    start.mutateAsync(
      { text, files, model, directory },
      {
        onSuccess: (session) => {
          setOpen(false);
          openApp(ASSISTANT_APP_ID, { sessionID: session.id, nonce: Date.now() });
        },
        onError: (error) =>
          toast({ title: 'Couldn’t ask the assistant', description: cleanAssistantError(error), variant: 'destructive' }),
      },
    );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            textareaRef.current?.focus();
          }}
          className="fixed left-1/2 top-[18%] z-50 w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">Ask the assistant</DialogPrimitive.Title>
          <div className="rounded-3xl border border-border/70 bg-background/95 p-2 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2">
              <img src="/icons/apps/assistant.png" alt="" className="size-6 object-contain" />
              <p className="text-sm font-medium text-muted-foreground">Ask the assistant</p>
            </div>
            {ready ? (
              <>
                <Composer
                  textareaRef={textareaRef}
                  busy={start.isPending}
                  placeholder="What should it do?"
                  onSubmit={submit}
                  className="border-0 bg-transparent shadow-none focus-within:shadow-none"
                  toolbar={<ModelPicker models={models} value={model} onChange={setModel} />}
                />
                <p className="flex items-center justify-end gap-1.5 px-3 pb-1 pt-1 text-xs text-muted-foreground">
                  <CornerDownLeft className="size-3" aria-hidden /> to send · Esc to close · Super+A anytime, hold it to speak
                </p>
              </>
            ) : (
              <AssistantUnavailable compact />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});
