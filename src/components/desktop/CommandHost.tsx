import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useWidgets } from '@/contexts/WidgetsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { runCommandLine, runStructured, type CommandContext } from '@/lib/commands';
import { getCommandBridge, parseCommandRequest } from '@/lib/commands/bridge';

interface Asking {
  title: string;
  description: string;
  action: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * Runs the `din` command's commands (src/lib/commands/, from
 * electron/din-launch.mts) against the desktop as it is, and asks the user
 * on screen when one wants that.
 */
export function CommandHost() {
  const { config, updateConfig } = useAppContext();
  const { windows, active, actions } = useWindowManager();
  const apps = useInstalledApps();
  const widgets = useWidgets();
  const areas = useWorkAreas();
  const openUrl = useOpenUrl();
  const { user } = useCurrentUser();
  const { mutateAsync: publish } = useNostrPublish();
  const [asking, setAsking] = useState<Asking[]>([]);

  const live = useRef({ config, updateConfig, windows, active, actions, apps, widgets, areas, openUrl, user, publish });
  useLayoutEffect(() => {
    live.current = { config, updateConfig, windows, active, actions, apps, widgets, areas, openUrl, user, publish };
  });

  useEffect(() => {
    const bridge = getCommandBridge();
    if (!bridge) return;
    return bridge.onRun((raw) => {
      const request = parseCommandRequest(raw);
      if (!request) return;
      void bridge.taken(request.id);
      const ctx: CommandContext = {
        get config() { return live.current.config; },
        updateConfig: (updater) => live.current.updateConfig(updater),
        get windows() { return live.current.windows; },
        get actions() { return live.current.actions; },
        get apps() { return live.current.apps; },
        get widgets() { return live.current.widgets; },
        get workspaces() { return live.current.active; },
        get monitors() { return live.current.areas.map((area) => area.id); },
        get pubkey() { return live.current.user?.pubkey; },
        publish: (template) => live.current.publish(template),
        openUrl: (url) => live.current.openUrl(url),
        confirm: (question) => new Promise<boolean>((resolve) => {
          setAsking((queue) => [...queue, { ...question, resolve }]);
        }),
        cwd: request.cwd,
        session: 'session' in request ? request.session : undefined,
      };
      const run = 'argv' in request ? runCommandLine(request.argv, ctx) : runStructured(request.path, request.input, ctx);
      void run.then((answer) => bridge.answer(request.id, answer));
    });
  }, []);

  const current = asking[0];
  const settle = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    setAsking((queue) => queue.slice(1));
  };

  return (
    <AlertDialog open={!!current} onOpenChange={(open) => !open && settle(false)}>
      {current && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{current.title}</AlertDialogTitle>
            <AlertDialogDescription>{current.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>Don’t Allow</AlertDialogCancel>
            <AlertDialogAction
              className={current.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : undefined}
              onClick={() => settle(true)}
            >
              {current.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
