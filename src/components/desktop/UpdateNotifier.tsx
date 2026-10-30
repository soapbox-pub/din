import { useEffect, useRef } from 'react';
import { useFixUpdateWithAssistant, useUpdateState } from '@/hooks/useUpdater';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cleanInstallerError } from '@/lib/installer';
import { getUpdaterBridge, shortRevision } from '@/lib/updater';

/** The commit already announced this boot, so a re-login doesn't repeat it. */
const NOTIFIED_KEY = 'updater:notified';
/** Likewise the restart a switched-to system needs. */
const RESTART_NOTIFIED_KEY = 'updater:restart-notified';
/** Likewise the failure. */
const FAILURE_NOTIFIED_KEY = 'updater:failure-notified';

/**
 * Says so once when a DinOS update is ready, and applies it or leads to the
 * restart; once when a system switched to (by Apply now, or nixos-rebuild
 * switch) needs Din or the computer restarted to be all there; and
 * when the user's own changes stopped one, offers the assistant to fix it.
 */
export function UpdateNotifier() {
  const state = useUpdateState();
  const { toast } = useToast();
  const { open } = useWindowActions();
  const fixer = useFixUpdateWithAssistant();
  const staged = state?.staged ?? null;
  const stagedNeeds = state?.stagedNeeds ?? null;
  // Only once nothing's staged: the staged update's notice covers it.
  const restart = !staged && state?.restart ? `${state.current ?? ''}:${state.restart}` : null;
  const failure = state?.phase === 'failed' && state.reason ? state.error : null;

  useEffect(() => {
    if (!staged || sessionStorage.getItem(NOTIFIED_KEY) === staged) return;
    sessionStorage.setItem(NOTIFIED_KEY, staged);
    const commit = shortRevision(staged);
    if (stagedNeeds === 'reboot') {
      toast({
        title: 'A DinOS update is ready',
        description: `Restart the computer to finish updating to commit ${commit}.`,
        actions: [{ id: 'details', label: 'Details' }],
        onAction: () => open('settings', { section: 'about' }),
      });
      return;
    }
    toast({
      title: 'A DinOS update is ready',
      description: stagedNeeds === 'din'
        ? `Apply commit ${commit} now, then restart Din to finish.`
        : `Apply commit ${commit} now. Nothing needs to restart.`,
      actions: [
        { id: 'apply', label: 'Apply now' },
        { id: 'details', label: 'Details' },
      ],
      onAction: (id) => {
        if (id !== 'apply') return open('settings', { section: 'about' });
        getUpdaterBridge()
          ?.apply()
          .catch((e: unknown) =>
            toast({
              title: 'Couldn’t apply the update',
              description: cleanInstallerError(e),
              variant: 'destructive',
            }),
          );
      },
    });
  }, [staged, stagedNeeds, toast, open]);

  useEffect(() => {
    if (!restart || sessionStorage.getItem(RESTART_NOTIFIED_KEY) === restart) return;
    sessionStorage.setItem(RESTART_NOTIFIED_KEY, restart);
    const din = restart.endsWith(':din');
    toast({
      title: din ? 'Restart Din to finish updating' : 'Restart to finish updating',
      description: din
        ? 'The system is up to date, but Din keeps running the version it started with until it restarts. Open apps will close.'
        : 'The system is up to date, but its new kernel loads when the computer starts.',
      actions: [
        { id: 'restart', label: din ? 'Restart Din' : 'Restart now' },
        { id: 'details', label: 'Details' },
      ],
      onAction: (id) => {
        if (id !== 'restart') return open('settings', { section: 'about' });
        const bridge = getUpdaterBridge();
        void (din ? bridge?.restartDin() : bridge?.reboot())?.catch((e: unknown) =>
          toast({
            title: din ? 'Couldn’t restart Din' : 'Couldn’t restart',
            description: cleanInstallerError(e),
            variant: 'destructive',
          }),
        );
      },
    });
  }, [restart, toast, open]);

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
