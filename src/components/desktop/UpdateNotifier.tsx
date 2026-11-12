import { useEffect, useMemo, useRef } from 'react';
import { useFixUpdateWithAssistant, useUpdateState } from '@/hooks/useUpdater';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cleanInstallerError } from '@/lib/installer';
import { setDinBadge } from '@/lib/appBadges';
import { notify, type NotificationSource } from '@/lib/notificationCenter';
import { getUpdaterBridge, shortRevision } from '@/lib/updater';
import {
  dismissUpdateNotice,
  dismissUpdateProblems,
  failureKey,
  isDinRestartPlanned,
  isUpdateProblemDismissed,
  securityKey,
  UPDATE_NOTICE_KEY,
  UPDATE_PROBLEM_KEY,
  useUpdateNoticePending,
} from '@/lib/updateNotice';

/** The commit already announced this boot, so a re-login doesn't repeat it. */
const NOTIFIED_KEY = 'updater:notified';
/** Likewise the restart a switched-to system needs. */
const RESTART_NOTIFIED_KEY = 'updater:restart-notified';
/** Likewise the failure. */
const FAILURE_NOTIFIED_KEY = 'updater:failure-notified';
/** Likewise the security fixes. */
const SECURITY_NOTIFIED_KEY = 'updater:security-notified';

const DIN: NotificationSource = { name: 'Din' };

/**
 * Says so once when a DinOS update is ready, and applies it or leads to the
 * restart; once when a system switched to (by Apply now, or nixos-rebuild
 * switch) needs Din or the computer restarted to be all there; when the
 * user's own changes stopped one, offers the assistant to fix it; and when
 * the branch has security fixes the system lacks, says so. Until the
 * update's notice is seen (in Settings → About) or dismissed, Settings'
 * Dock tile carries a dot.
 *
 * A failure or a security fix the user dismisses (or acts on) stays
 * dismissed, across restarts: a failure until it stops on another commit
 * of theirs, a fix for good. A fix that's new comes up however many
 * failures were dismissed before it.
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
        replaceKey: UPDATE_NOTICE_KEY,
        description: `Restart the computer to finish updating to commit ${commit}.`,
        actions: [{ id: 'details', label: 'Details' }],
        onAction: () => open('settings', { section: 'about' }),
      });
      return;
    }
    toast({
      title: 'A DinOS update is ready',
      replaceKey: UPDATE_NOTICE_KEY,
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
    // `din update local --restart` is about to restart Din itself.
    if (din && isDinRestartPlanned()) return;
    toast({
      title: din ? 'Restart Din to finish updating' : 'Restart to finish updating',
      replaceKey: UPDATE_NOTICE_KEY,
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

  // Once there's nothing left to do (applied, or another update took its
  // place and finished), the notice is stale.
  const settled = !!state && !staged && !state.restart;
  useEffect(() => {
    if (settled) dismissUpdateNotice();
  }, [settled]);

  const pending = useUpdateNoticePending();
  useEffect(() => {
    setDinBadge('update', 'settings', pending ? 'flag' : null);
  }, [pending]);

  // The latest, for the notification's action.
  const latest = useRef({ state, fixer });
  useEffect(() => {
    latest.current = { state, fixer };
  });

  // A failure is the user's commit it stopped on and why, not the error's
  // words, which name the branch's tip: the branch moving on is the same
  // failure, and once dismissed it stays dismissed.
  const head = state?.staged ?? state?.current ?? null;
  const failed = failure && state?.reason ? failureKey(state.reason, head) : null;
  // A run under way may bring the fixes in: wait for it.
  const settledRun = state?.phase === 'idle' || state?.phase === 'failed';
  const fixes = useMemo(() => (settledRun ? state?.security ?? [] : []), [settledRun, state?.security]);
  const freshFixes = fixes.filter((f) => !isUpdateProblemDismissed(securityKey(f.commit)));
  const fresh = freshFixes.map((f) => f.commit).join(',');

  // Picking an action, or dismissing it, sets the problem aside.
  const fixOrDetails = (id: string) => {
    const { state: current, fixer: currentFixer } = latest.current;
    if (id === 'update') {
      getUpdaterBridge()
        ?.check()
        .catch((e: unknown) =>
          toast({ title: 'Couldn’t update DinOS', description: cleanInstallerError(e), variant: 'destructive' }),
        );
      return;
    }
    // Without the assistant, Settings says why it can't.
    if (id === 'fix' && current && currentFixer.available) currentFixer.fix(current);
    else open('settings', { section: 'about' });
  };
  const fixOrDetailsRef = useRef(fixOrDetails);
  useEffect(() => {
    fixOrDetailsRef.current = fixOrDetails;
  });

  useEffect(() => {
    // A security fix's notice says why it's waiting, the failure too.
    if (!failed || fresh || isUpdateProblemDismissed(failed)) return;
    if (sessionStorage.getItem(FAILURE_NOTIFIED_KEY) === failed) return;
    sessionStorage.setItem(FAILURE_NOTIFIED_KEY, failed);
    notify({
      source: DIN,
      title: 'Couldn’t update DinOS',
      body: failure ?? '',
      replaceKey: UPDATE_PROBLEM_KEY,
      history: true,
      actions: [
        { id: 'fix', label: 'Fix with assistant' },
        { id: 'details', label: 'Details' },
      ],
      onActivate: (id) => fixOrDetailsRef.current(id),
      onClose: (why) => {
        if (why === 'dismissed') dismissUpdateProblems([failed]);
      },
    });
  }, [failed, failure, fresh]);

  useEffect(() => {
    if (!fresh || sessionStorage.getItem(SECURITY_NOTIFIED_KEY) === fresh) return;
    sessionStorage.setItem(SECURITY_NOTIFIED_KEY, fresh);
    const waiting = fixes.filter((f) => fresh.split(',').includes(f.commit));
    const [first] = waiting;
    const why = failure && failed
      ? `It can’t be installed: ${failure}`
      : 'Update DinOS to install it.';
    notify({
      source: DIN,
      title: waiting.length === 1 ? 'A security fix for DinOS is waiting' : `${waiting.length} security fixes for DinOS are waiting`,
      body: `${first.subject}${waiting.length > 1 ? `, and ${waiting.length - 1} more` : ''}. ${why}`,
      replaceKey: UPDATE_PROBLEM_KEY,
      history: true,
      urgency: waiting.some((f) => f.severity === 'high' || f.severity === 'critical') ? 'critical' : 'normal',
      actions: failed
        ? [
            { id: 'fix', label: 'Fix with assistant' },
            { id: 'details', label: 'Details' },
          ]
        : [
            { id: 'update', label: 'Update now' },
            { id: 'details', label: 'Details' },
          ],
      onActivate: (id) => fixOrDetailsRef.current(id),
      // Dismissed, it's every fix it told of, and the failure it named.
      onClose: (reason) => {
        if (reason === 'dismissed') {
          dismissUpdateProblems([...fixes.map((f) => securityKey(f.commit)), ...(failed ? [failed] : [])]);
        }
      },
    });
  }, [fresh, fixes, failure, failed]);

  return null;
}
