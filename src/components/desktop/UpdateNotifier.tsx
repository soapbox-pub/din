import { useEffect, useRef } from 'react';
import { useFixUpdateWithAssistant, useUpdateState } from '@/hooks/useUpdater';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { shortRevision } from '@/lib/updater';

/** The commit already announced this boot, so a re-login doesn't repeat it. */
const NOTIFIED_KEY = 'updater:notified';
/** Likewise the failure. */
const FAILURE_NOTIFIED_KEY = 'updater:failure-notified';

/**
 * Says so once when a DinOS update is ready, and leads to the restart; and
 * when the user's own changes stopped one, offers the assistant to fix it.
 */
export function UpdateNotifier() {
  const state = useUpdateState();
  const { toast } = useToast();
  const { open } = useWindowActions();
  const fixer = useFixUpdateWithAssistant();
  const staged = state?.staged ?? null;
  const failure = state?.phase === 'failed' && state.reason ? state.error : null;

  useEffect(() => {
    if (!staged || sessionStorage.getItem(NOTIFIED_KEY) === staged) return;
    sessionStorage.setItem(NOTIFIED_KEY, staged);
    toast({
      title: 'A DinOS update is ready',
      description: `Restart to finish updating to commit ${shortRevision(staged)}.`,
      actions: [{ id: 'details', label: 'Details' }],
      onAction: () => open('settings', { section: 'about' }),
    });
  }, [staged, toast, open]);

  // The latest, for the notification's action.
  const latest = useRef({ state, fixer });
  useEffect(() => {
    latest.current = { state, fixer };
  });

  useEffect(() => {
    if (!failure || sessionStorage.getItem(FAILURE_NOTIFIED_KEY) === failure) return;
    sessionStorage.setItem(FAILURE_NOTIFIED_KEY, failure);
    toast({
      title: 'Couldn’t update DinOS',
      description: failure,
      actions: [
        { id: 'fix', label: 'Fix with assistant' },
        { id: 'details', label: 'Details' },
      ],
      onAction: (id) => {
        const { state: current, fixer: currentFixer } = latest.current;
        // Without the assistant, Settings says why it can't.
        if (id === 'fix' && current && currentFixer.available) currentFixer.fix(current);
        else open('settings', { section: 'about' });
      },
    });
  }, [failure, toast, open]);

  return null;
}
