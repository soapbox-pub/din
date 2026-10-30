import { useEffect } from 'react';
import { useUpdateState } from '@/hooks/useUpdater';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { shortRevision } from '@/lib/updater';

/** The commit already announced this boot, so a re-login doesn't repeat it. */
const NOTIFIED_KEY = 'updater:notified';

/** Says so once when a DinOS update is ready, and leads to the restart. */
export function UpdateNotifier() {
  const state = useUpdateState();
  const { toast } = useToast();
  const { open } = useWindowActions();
  const staged = state?.staged ?? null;

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

  return null;
}
