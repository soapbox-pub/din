import { useEffect, useState, type KeyboardEvent } from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import type { AppComponentProps } from '@/lib/apps';
import { answerCommandQuestion, getCommandQuestion } from '@/lib/commandConfirmWindows';
import { cn } from '@/lib/utils';
import { ContentPane } from '@/shared/appChrome';

/** How many windows show each question (one, but for a remount). */
const mounted = new Map<number, number>();

/**
 * A `din` command asking the user first (COMMAND_CONFIRM_APP_ID), one window
 * per question, opened by CommandHost: a window, not a dialog, so the rest of
 * the desktop stays usable (moving it aside, reading what's behind it, taking
 * a screenshot of part of the screen) while it waits. Answering closes it;
 * closing it or Escape is Don't Allow.
 */
export function CommandConfirmWindow({ windowId, params }: AppComponentProps) {
  const { close } = useWindowActions();
  const requestId = typeof params?.request === 'number' ? params.request : null;
  // Read once: answering forgets it, while the window plays its close.
  const [question] = useState(() => (requestId !== null ? getCommandQuestion(requestId) : undefined));
  useOwnWindowHeader();
  useWindowTitle(question?.title ?? 'Allow this?');

  // However the window goes (its close button, the Dock's Quit), the
  // command hears no. Deferred, so a remount doesn't count as closing.
  useEffect(() => {
    if (requestId === null) return;
    mounted.set(requestId, (mounted.get(requestId) ?? 0) + 1);
    return () => {
      mounted.set(requestId, (mounted.get(requestId) ?? 1) - 1);
      window.setTimeout(() => {
        if ((mounted.get(requestId) ?? 0) > 0) return;
        mounted.delete(requestId);
        answerCommandQuestion(requestId, false);
      }, 0);
    };
  }, [requestId]);

  const answer = (ok: boolean) => {
    if (requestId !== null) answerCommandQuestion(requestId, ok);
    close(windowId);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    answer(false);
  };

  const Icon = question?.fromAssistant ? Bot : SquareTerminal;

  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-4">
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
          {question?.fromAssistant ? 'The Assistant asks' : 'A command asks'}
        </h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane className="ml-2">
        {question ? (
          // Nothing is focused to answer with: Enter mustn't press the action.
          <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
            <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-6 text-center [&>*]:shrink-0">
              <span aria-hidden className="grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
                <Icon className="size-7" />
              </span>
              <h2 className="mt-4 text-base leading-snug font-semibold text-balance select-text">{question.title}</h2>
              {question.description && (
                <p className="mt-2 text-sm text-balance whitespace-pre-line text-muted-foreground select-text">{question.description}</p>
              )}
              <p className="mt-3 font-mono text-xs break-all text-muted-foreground/80 select-text">{question.command}</p>
            </div>
            <footer className="flex shrink-0 justify-end gap-2 p-6">
              <Button variant="secondary" className="rounded-full" onClick={() => answer(false)}>
                Don’t Allow
              </Button>
              <Button
                className={cn('rounded-full', question.destructive && 'bg-destructive text-white hover:bg-destructive/90')}
                onClick={() => answer(true)}
              >
                {question.action}
              </Button>
            </footer>
          </div>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Nothing to answer: whatever asked has stopped waiting.</p>
        )}
      </ContentPane>
    </div>
  );
}
