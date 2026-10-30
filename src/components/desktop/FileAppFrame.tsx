import { useEffect, useState } from 'react';
import { FolderX, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LaunchedAppFrame } from '@/components/desktop/LaunchedAppFrame';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import type { AppComponentProps } from '@/lib/apps';
import { getAppsBridge } from '@/lib/dinApps';
import { folderError, type FileAppEntry } from '@/lib/fileApps';
import type { LaunchedApp } from '@/lib/launchedApps';

interface Props extends AppComponentProps {
  appId: string;
}

type State =
  | { status: 'opening' }
  | { status: 'open'; entry: FileAppEntry; generation: number }
  | { status: 'error'; message: string };

/**
 * The window body of an app from a folder (src/lib/fileApps.ts): main opens
 * the folder (it serves only those it was asked for), then the app loads at
 * din+file://<host>/, asking first for what its manifest wants, like a
 * launched app. Whenever a file in the folder changes it loads again, with
 * the manifest read afresh.
 */
export function FileAppFrame({ appId, ...props }: Props) {
  const { fileApps, getApp, refreshFileApp } = useInstalledApps();
  const path = fileApps.find((e) => e.appId === appId)?.path ?? null;
  const [state, setState] = useState<State>({ status: 'opening' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const bridge = getAppsBridge();
    if (path === null || !bridge) return;
    let cancelled = false;
    bridge.folder(path).then(
      (opened) => {
        if (cancelled) return;
        const entry = refreshFileApp(opened);
        if (!entry) return;
        // The window keeps the app it has until the new one is ready.
        setState({ status: 'open', entry, generation });
      },
      (error: unknown) => !cancelled && setState({ status: 'error', message: folderError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [path, generation, refreshFileApp]);

  useEffect(() => {
    return getAppsBridge()?.onFolderChanged((e) => {
      if (e.appId === appId) setGeneration((g) => g + 1);
    });
  }, [appId]);

  if (path === null || state.status === 'error') {
    return (
      <div className="flex size-full items-center justify-center overflow-auto bg-background p-6">
        <div className="w-full max-w-md space-y-4 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
            <FolderX className="size-7" aria-hidden />
          </span>
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">{path === null ? 'This app was removed' : 'This app’s folder can’t be opened'}</h2>
            {path !== null && (
              <p className="break-all font-mono text-xs text-muted-foreground">{path}</p>
            )}
          </div>
          {state.status === 'error' && path !== null && (
            <>
              <p className="text-sm text-muted-foreground" role="alert">{state.message}</p>
              <Button
                onClick={() => {
                  setState({ status: 'opening' });
                  setGeneration((g) => g + 1);
                }}
              >
                <RotateCw aria-hidden /> Try Again
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (state.status === 'opening') return <div className="size-full bg-background" />;

  const definition = getApp(appId);
  if (!definition) return <div className="size-full bg-background" />;
  const app: LaunchedApp = { appId, manifest: state.entry.manifest, source: state.entry.path, ephemeral: false, definition };
  return (
    <LaunchedAppFrame
      key={state.generation}
      {...props}
      app={app}
      from="It runs from a folder on this computer"
    />
  );
}
