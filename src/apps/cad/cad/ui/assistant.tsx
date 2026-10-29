import { useLayoutEffect, useRef } from 'react';
import { CircleAlert, Plus, X } from 'lucide-react';
import { AssistantUnavailable } from '@/shared/assistant/AssistantUnavailable';
import { Composer } from '@/shared/assistant/Composer';
import { ModelPicker } from '@/shared/assistant/ModelPicker';
import { FormCard, PermissionCard } from '@/shared/assistant/RequestCards';
import { Transcript } from '@/shared/assistant/Transcript';
import { useQuestionHandoff } from '@/shared/assistant/useQuestionHandoff';
import {
  useAssistantReady,
  useAssistantSession,
  useCancelQueued,
  useInterruptSession,
  usePreferredModel,
  useSessionForms,
  useSessionInbox,
  useSessionMessages,
  useSessionPermissions,
  useSwitchModel,
} from '@/hooks/useAssistant';
import { cleanAssistantError, modelKey } from '@/lib/assistant';
import { useAssistantHost } from '@/shared/assistant/host';
import { cn } from '@/lib/utils';
import type { CadAssistant } from '../useCadAssistant';
import { FOCUS } from './style';

const IDEAS = ['Dimension the selected objects', 'Put a title block around the drawing', 'Draw a 1200 × 800 table with four legs in plan'];

/** The assistant's palette, docked at the right like Properties. */
export function AssistantPalette({ assistant, onClose }: { assistant: CadAssistant; onClose: () => void }) {
  const ready = useAssistantReady();
  const { sessionID, running, problem, submit, reset, sending } = assistant;
  const { data: session } = useAssistantSession(sessionID);
  const { data: transcript } = useSessionMessages(sessionID);
  const { data: permissions = [] } = useSessionPermissions(sessionID);
  const { data: forms = [] } = useSessionForms(sessionID);
  const composerRef = useQuestionHandoff(forms.length > 0);
  const { data: queued } = useSessionInbox(sessionID);
  const { model, setModel, models } = usePreferredModel();
  const interrupt = useInterruptSession();
  const cancelQueued = useCancelQueued();
  const switchModel = useSwitchModel();
  const { notify } = useAssistantHost();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messages = transcript?.messages;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, queued, permissions.length, forms.length, running, problem]);

  const fail = (title: string) => (error: unknown) => notify({ title, description: cleanAssistantError(error), destructive: true });

  return (
    <aside aria-label="Assistant" className="dark flex w-[360px] shrink-0 flex-col border-l border-[#15191e] bg-[#262c35] text-[#e3e8ef] select-text" style={{ colorScheme: 'dark' }}>
      <div className="flex h-7 shrink-0 items-center gap-1 bg-[#272d36] pr-1 pl-2.5 text-[12px] font-semibold tracking-wide uppercase">
        <span className="flex-1">Assistant</span>
        {sessionID && (
          <button type="button" aria-label="New conversation" title="New conversation" disabled={running} onClick={reset} className={cn('grid size-5 place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-white/10 disabled:opacity-40', FOCUS)}>
            <Plus className="size-3.5" />
          </button>
        )}
        <button type="button" aria-label="Close Assistant" onClick={onClose} className={cn('grid size-5 place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-white/10', FOCUS)}>
          <X className="size-3.5" />
        </button>
      </div>
      {!ready ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <AssistantUnavailable compact />
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
            }}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-4 text-[14px]"
          >
            {sessionID ? (
              <Transcript
                messages={messages ?? []}
                queued={queued}
                running={running}
                onCancelQueued={(message) => cancelQueued.mutate({ sessionID, id: message.id }, { onError: fail('Couldn’t cancel') })}
              />
            ) : (
              <div className="flex flex-col gap-3 pt-2">
                <p className="text-[14px] leading-relaxed text-[#c4ccd7]">Ask for changes to this drawing in your own words. The assistant sees what’s on screen and what you’ve selected, and you watch it draw. Each answer is one step to undo.</p>
                <ul className="flex flex-col gap-1.5" aria-label="Ideas">
                  {IDEAS.map((idea) => (
                    <li key={idea}>
                      <button
                        type="button"
                        onClick={() => {
                          const t = textareaRef.current;
                          if (!t) return;
                          // The composer keeps its own text: set it as typing would.
                          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(t, idea);
                          t.dispatchEvent(new Event('input', { bubbles: true }));
                          t.focus();
                        }}
                        className={cn('w-full rounded-lg border border-[#3b4452] px-3 py-2 text-left text-[13px] text-[#dfe4ec] hover:bg-white/5', FOCUS)}
                      >
                        {idea}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="space-y-2 px-3 pb-3">
            {problem && (
              <p role="alert" className="flex gap-2 rounded-lg border border-[#7a5b2b] bg-[#3a3123] px-3 py-2 text-[12.5px] text-[#ffd9a0]">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>Some of the assistant’s changes were left out: {problem}</span>
              </p>
            )}
            {permissions.map((request) => (
              <PermissionCard key={request.id} request={request} />
            ))}
            {forms.map((form) => (
              <FormCard key={form.id} form={form} />
            ))}
            <div ref={composerRef} hidden={forms.length > 0}>
              <Composer
                textareaRef={textareaRef}
                running={running}
                busy={sending}
                placeholder={running ? 'Add something while it works…' : sessionID ? 'Ask for another change…' : 'What should change?'}
                onSubmit={(text, files) => {
                  stick.current = true;
                  return submit(text, files).catch((error: unknown) => {
                    fail('Couldn’t send')(error);
                    throw error;
                  });
                }}
                onStop={() => sessionID && interrupt.mutate(sessionID, { onError: fail('Couldn’t stop') })}
                toolbar={
                  <ModelPicker
                    models={models}
                    value={session?.model ?? model}
                    recent={model ? [modelKey(model)] : []}
                    onChange={(m) => {
                      setModel(m);
                      if (sessionID) switchModel.mutate({ sessionID, model: m }, { onError: fail('Couldn’t switch models') });
                    }}
                  />
                }
              />
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
