import { useEffect, useRef } from 'react';
import { KeyRound } from 'lucide-react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { getKindLabel } from '@/lib/kindLabels';
import { closeNotification, notify } from '@/lib/notificationCenter';
import { getProgramSignerBridge, type ProgramSignerRequest } from '@/lib/programSigner';
import {
  forgetProgramSignerRequest,
  PROGRAM_SIGNER_APP_ID,
  setProgramSignerRequest,
} from '@/lib/programSignerWindows';
import { headline } from './programSignerText';

/** A line for its notification. */
function summary(request: ProgramSignerRequest): string {
  const from = request.via ? ` · from ${request.via}` : '';
  if (request.method === 'sign_event') return `${request.kind !== null ? getKindLabel(request.kind) : 'An event'}${from}`;
  return `${request.command}${from}`.slice(0, 200);
}

/**
 * What the notification may allow without the window: what "Allow" there
 * would do is all in its title and body. Spending, and changing the
 * accounts or their password, are only answered in the window, which shows
 * the amount or the account.
 */
function allowFromNotification(request: ProgramSignerRequest): boolean {
  return request.canProcess;
}

/**
 * Asks the user about programs that want to sign as them through nostrd
 * (electron/nostrd-approval.mts): ngit in the Terminal, a script the
 * Assistant runs. As with sudo's approvals (AdminPromptHost), each is a
 * notification first, so nothing takes the keyboard while the user types
 * elsewhere; it can be allowed or denied right there, and clicking it opens
 * the request's window (ProgramSignerWindow), which shows what would be
 * signed and offers allowing it for longer. Closing the window denies it.
 *
 * Renders nothing; does nothing outside the Electron shell.
 */
export function ProgramSignerHost() {
  const actions = useWindowActions();
  const live = useRef(actions);
  useEffect(() => {
    live.current = actions;
  });

  useEffect(() => {
    const bridge = getProgramSignerBridge();
    if (!bridge) return;
    const notifications = new Map<number, string>();
    const windows = new Map<number, string>();
    const add = (request: ProgramSignerRequest) => {
      if (notifications.has(request.requestId)) return;
      setProgramSignerRequest(request);
      const allow = allowFromNotification(request);
      notifications.set(
        request.requestId,
        notify({
          source: { name: 'Din', icon: KeyRound },
          title: headline(request, null).title,
          body: summary(request),
          urgency: 'critical',
          actions: [...(allow ? [{ id: 'allow', label: 'Allow' }] : []), { id: 'deny', label: 'Don’t allow' }],
          replaceKey: `program-signer:${request.requestId}`,
          onScreenOnly: true,
          onActivate: (action) => {
            if (action === 'allow' && allow) void bridge.answer(request.requestId, 'once').catch(() => {});
            else if (action === 'deny') void bridge.answer(request.requestId, 'deny').catch(() => {});
            else {
              const id = live.current.open(PROGRAM_SIGNER_APP_ID, { request: request.requestId });
              if (id) windows.set(request.requestId, id);
            }
          },
        }),
      );
    };
    const offRequest = bridge.onRequest(add);
    const offCancel = bridge.onCancel((requestId) => {
      forgetProgramSignerRequest(requestId);
      const notification = notifications.get(requestId);
      if (notification) closeNotification(notification, 'closed');
      notifications.delete(requestId);
      const windowId = windows.get(requestId);
      if (windowId) live.current.close(windowId);
      windows.delete(requestId);
    });
    // Asked before this desktop was there (it reloaded).
    void bridge.pending().then((list) => list.forEach(add)).catch(() => {});
    return () => {
      offRequest();
      offCancel();
    };
  }, []);

  return null;
}
