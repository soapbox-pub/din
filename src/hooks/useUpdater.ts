import { useCallback, useEffect, useState } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import {
  useAssistantReady,
  useHomeDirectory,
  usePreferredModel,
  useStartConversation,
} from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import { cleanAssistantError } from '@/lib/assistant';
import { DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_URL, getUpdaterBridge } from '@/lib/updater';
import type { UpdateState } from '@/lib/updater';

const ASSISTANT_APP_ID = 'assistant';

/** DinOS's versions and the update in progress, kept current by the main process. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const bridge = getUpdaterBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.state().then((initial) => {
      if (!cancelled) setState((current) => current ?? initial);
    });
    const unsubscribe = bridge.onProgress(setState);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}

/** What the assistant is asked when an update stopped on the user's changes. */
function fixPrompt(state: UpdateState): string {
  const branch = state.branch ?? DEFAULT_UPDATE_BRANCH;
  const url = state.url ?? DEFAULT_UPDATE_URL;
  return [
    `DinOS couldn't update itself: ${state.error ?? 'my changes stopped it.'}`,
    `Load the dinos skill and fix it: bring ~/DinOS up to date with ${branch} of ${url}, keeping my changes,`,
    'then build it with nixos-rebuild boot, so the update is ready when I restart.',
  ].join(' ');
}

/**
 * Hand a failed update to the assistant: a conversation that merges the
 * branch into the user's changes in ~/DinOS and builds it, opened in the
 * Assistant. `available` is false while the assistant is off or starting.
 */
export function useFixUpdateWithAssistant(): {
  available: boolean;
  pending: boolean;
  fix: (state: UpdateState) => void;
} {
  const ready = useAssistantReady();
  const home = useHomeDirectory();
  const { model } = usePreferredModel();
  const start = useStartConversation();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const { mutate } = start;

  const fix = useCallback(
    (state: UpdateState) =>
      mutate(
        { text: fixPrompt(state), model, directory: home },
        {
          onSuccess: (session) =>
            open(ASSISTANT_APP_ID, { sessionID: session.id, directory: undefined, nonce: Date.now() }),
          onError: (error) =>
            toast({ title: 'Couldn’t ask the assistant', description: cleanAssistantError(error), variant: 'destructive' }),
        },
      ),
    [mutate, model, home, open, toast],
  );

  return { available: ready, pending: start.isPending, fix };
}
