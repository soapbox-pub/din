import { useEffect, useRef } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { formatBytes } from '@/lib/fs';
import { closeNotificationByKey, notify } from '@/lib/notificationCenter';
import { cleanSystemMonitorError, getSystemMonitorBridge, type ResourceAlert } from '@/lib/systemMonitor';

const SOURCE = { appId: 'system-monitor', name: 'System Monitor' };
/** How long a program gets to quit after Stop before Force Quit is offered. */
const QUIT_GRACE_MS = 5000;

function cores(alert: ResourceAlert): string {
  const used = Math.max(1, Math.round((alert.cpu / 100) * alert.cpuCount));
  return `${used} of ${alert.cpuCount} processor cores`;
}

function describe(alert: ResourceAlert): { title: string; body: string } {
  if (alert.kind === 'cpu') {
    return {
      title: `${alert.name} is slowing your computer down`,
      body: `It has kept ${cores(alert)} busy for the last minute.`,
    };
  }
  return {
    title: `${alert.name} is using a lot of memory`,
    body: `It holds ${formatBytes(alert.memory)}, and the computer has ${formatBytes(alert.memoryFree)} left of ${formatBytes(alert.memoryTotal)}.`,
  };
}

/**
 * The System Monitor's warnings (electron/resource-alerts.mts): a
 * notification when a program keeps the processor busy for a minute or holds
 * the most memory while it's running out, with Stop, and Force Quit if it
 * doesn't. Clicking one opens the System Monitor. Off with
 * `resourceAlerts` (Settings → Notifications). Renders nothing.
 */
export function ResourceAlertsHost() {
  const { config } = useAppContext();
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  const enabled = config.resourceAlerts;

  useEffect(() => {
    const bridge = getSystemMonitorBridge();
    if (!enabled || !bridge?.watchAlerts) return;
    /** Alerts still on screen or waiting on Stop, by id. */
    const live = new Map<string, { alert: ResourceAlert; stopping: ReturnType<typeof setTimeout> | null }>();
    const key = (id: string) => `system-monitor:${id}`;
    const showMonitor = () => openRef.current('system-monitor');

    const failed = (alert: ResourceAlert, error: unknown) =>
      notify({
        source: SOURCE,
        title: `Couldn’t stop ${alert.name}`,
        body: cleanSystemMonitorError(error),
        replaceKey: key(alert.id),
        onActivate: showMonitor,
      });

    const forceQuit = (alert: ResourceAlert) => {
      bridge.forceQuit(alert.pid).catch((error: unknown) => failed(alert, error));
    };

    const stop = (alert: ResourceAlert) => {
      const entry = live.get(alert.id);
      bridge.end(alert.pid).then(
        () => {
          if (!entry) return;
          // Still running a while later: it's ignoring the request.
          entry.stopping = setTimeout(() => {
            if (!live.has(alert.id)) return;
            notify({
              source: SOURCE,
              title: `${alert.name} isn’t quitting`,
              body: 'Force quit it to stop it now. Anything it hasn’t saved is lost.',
              urgency: 'normal',
              timeout: 0,
              replaceKey: key(alert.id),
              actions: [{ id: 'force-quit', label: 'Force Quit' }],
              onActivate: (action) => (action === 'force-quit' ? forceQuit(alert) : showMonitor()),
            });
          }, QUIT_GRACE_MS);
        },
        (error: unknown) => failed(alert, error),
      );
    };

    const show = (alert: ResourceAlert) => {
      live.set(alert.id, { alert, stopping: null });
      notify({
        source: SOURCE,
        ...describe(alert),
        replaceKey: key(alert.id),
        actions: [
          { id: 'stop', label: 'Stop' },
          { id: 'show', label: 'Show in System Monitor' },
        ],
        onActivate: (action) => (action === 'stop' ? stop(alert) : showMonitor()),
      });
    };

    const gone = (id: string) => {
      const entry = live.get(id);
      if (!entry) return;
      if (entry.stopping) clearTimeout(entry.stopping);
      live.delete(id);
      closeNotificationByKey(key(id));
    };

    const unwatch = bridge.watchAlerts(show, gone);
    return () => {
      unwatch();
      for (const id of [...live.keys()]) gone(id);
    };
  }, [enabled]);

  return null;
}
