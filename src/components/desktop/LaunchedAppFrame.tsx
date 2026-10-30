import { useState } from 'react';
import { FolderOpen, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/desktop/AppIcon';
import { DinAppFrame } from '@/components/desktop/DinAppFrame';
import type { AppComponentProps } from '@/lib/apps';
import {
  isApproved,
  PERMISSION_LABELS,
  rememberApproval,
  requestedAccess,
  withoutAccess,
  type LaunchedApp,
} from '@/lib/launchedApps';

interface Props extends AppComponentProps {
  app: LaunchedApp;
  /** Where it came from, to say before what it asks for. */
  from?: string;
}

/**
 * The window body of an app the `din` command runs (src/lib/launchedApps.ts),
 * or of one from a folder (FileAppFrame):
 * a built-in app's frame, once the user has said what its manifest may have.
 * Din hasn't reviewed its code, so its permissions are asked for, not given.
 */
export function LaunchedAppFrame({ app, from = 'It was started from the command line', ...props }: Props) {
  const { permissions, folders } = requestedAccess(app.manifest);
  const asks = permissions.length > 0 || folders.length > 0;
  const [answer, setAnswer] = useState<'allow' | 'deny' | null>(() => (!asks || isApproved(app) ? 'allow' : null));
  const name = app.manifest.short_name ?? app.manifest.name;

  if (answer) {
    const manifest = answer === 'allow' ? app.manifest : withoutAccess(app.manifest);
    return <DinAppFrame {...props} appId={app.appId} manifest={manifest} />;
  }

  return (
    <div className="flex size-full items-center justify-center overflow-auto bg-background p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-4">
          <AppIcon icon={app.definition.icon} className="size-14 shrink-0 rounded-xl" />
          <div className="min-w-0 space-y-1">
            <h2 className="text-xl font-semibold leading-tight">Let {name} do more than a web page?</h2>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <FolderOpen className="size-4 shrink-0" aria-hidden />
              <span className="truncate font-mono text-xs" title={app.source}>{app.source}</span>
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{from} and asks to:</p>
          <ul className="space-y-2 rounded-lg bg-muted/50 p-4 text-sm">
            {permissions.map((p) => (
              <li key={p} className="flex gap-2">
                <span aria-hidden className="text-muted-foreground">•</span>
                <span>{PERMISSION_LABELS[p]}</span>
              </li>
            ))}
            {folders.length > 0 && (
              <li className="flex gap-2">
                <span aria-hidden className="text-muted-foreground">•</span>
                <span>
                  Read and change files in{' '}
                  {folders.map((f, i) => (
                    <span key={f}>
                      {i > 0 && ', '}
                      <code className="font-mono text-xs">{f}</code>
                    </span>
                  ))}
                </span>
              </li>
            )}
          </ul>
          <p className="flex gap-2 text-sm text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            Allow it only if you trust whoever wrote it. Without these it still runs, as a plain web page.
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setAnswer('deny')}>
            Open Without
          </Button>
          <Button
            onClick={() => {
              rememberApproval(app);
              setAnswer('allow');
            }}
          >
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
