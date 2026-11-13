import { useEffect, useRef } from 'react';
import { FolderOpen, ShieldAlert } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useToast } from '@/hooks/useToast';
import { fileAppDefinition, fileAppEntry, type FileAppEntry, type OpenedFolder } from '@/lib/fileApps';
import { PERMISSION_LABELS, rememberApproval, requestedAccess } from '@/lib/launchedApps';

/**
 * Apps from folders on this computer (src/lib/fileApps.ts), in the App
 * Store: the page a folder chosen with its title bar's folder button opens
 * on. Once added, one is in the launcher like any other app.
 */

/** Its manifest's name, as the launcher shows it. */
function appName(entry: FileAppEntry): string {
  return entry.manifest.short_name ?? entry.manifest.name;
}

/**
 * The page a chosen folder opens on: the app as its manifest describes it,
 * what it asks for, and Add (which allows that, so its window doesn't ask
 * again), or Open once it's in the launcher.
 */
export function FolderAppDetail({ opened }: { opened: OpenedFolder }) {
  const { fileApps, installFileApp } = useInstalledApps();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const installed = fileApps.find((e) => e.appId === opened.appId);
  const entry = installed ?? fileAppEntry(opened);
  const name = appName(entry);
  const { permissions, folders } = requestedAccess(entry.manifest);
  const asks = permissions.length > 0 || folders.length > 0;
  // Set by Add; the app opens once it's in the registry, a render later.
  const openOnInstall = useRef(false);

  useEffect(() => ref.current?.focus(), []);
  useEffect(() => {
    if (!openOnInstall.current || !installed) return;
    openOnInstall.current = false;
    open(installed.appId);
  }, [installed, open]);

  const add = () => {
    const added = installFileApp(opened);
    rememberApproval({ appId: added.appId, manifest: added.manifest, source: added.path, ephemeral: false, definition: fileAppDefinition(added) });
    openOnInstall.current = true;
    toast({ title: `${name} added`, description: 'Find it in the app launcher. It reloads whenever you change a file in its folder.' });
  };

  return (
    <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none" aria-label={`${name} details`}>
      <div
        className="border-b border-border"
        style={entry.manifest.theme_color ? { backgroundImage: `linear-gradient(to bottom, ${entry.manifest.theme_color}33, transparent)` } : undefined}
      >
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 @2xl:flex-row @2xl:items-center @2xl:gap-6 @2xl:p-6">
          <AppIcon icon={fileAppDefinition(entry).icon} className="size-24 shrink-0 drop-shadow-md @2xl:size-28" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{name}</h1>
              <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                <FolderOpen className="size-4 shrink-0" aria-hidden />
                <span className="truncate font-mono text-xs" title={entry.path}>{entry.path}</span>
              </p>
            </div>
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={installed ? () => open(installed.appId) : add}
                aria-label={installed ? `Open ${name}` : `Add ${name}`}
                className="h-8 rounded-full bg-secondary px-5 font-semibold text-ink-accent hover:bg-secondary/80"
              >
                {installed ? 'Open' : 'Add'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
        {entry.manifest.description ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed">{entry.manifest.description}</p>
        ) : (
          <p className="text-muted-foreground">This app doesn’t describe itself.</p>
        )}

        <section className="flex flex-col gap-4" aria-label="What it may do">
          <SectionHeader title="What it may do" />
          {asks ? (
            <div className="flex max-w-prose flex-col gap-3">
              <ul className="space-y-2 rounded-xl bg-card clay p-4 text-sm">
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
                Adding it allows these. Add it only if you trust whoever wrote it.
              </p>
            </div>
          ) : (
            <p className="max-w-prose text-sm text-muted-foreground">
              Nothing more than a web page: its manifest asks for no permissions.
            </p>
          )}
        </section>

        <FolderAppNotes />
      </div>
    </div>
  );
}

/** How a folder becomes an app. */
function FolderAppNotes() {
  return (
    <section className="flex max-w-prose flex-col gap-2 text-sm text-muted-foreground" aria-label="About apps from folders">
      <p className="font-medium text-foreground">Making a Din app</p>
      <p>
        A folder with an <code className="font-mono">index.html</code> (a build’s{' '}
        <code className="font-mono">dist/</code>, or plain files) runs in a window of its own, with{' '}
        <code className="font-mono">window.din</code> defined before its scripts. Its name, icon, window size and
        permissions come from the manifest its page links (<code className="font-mono">din.permissions</code>,{' '}
        <code className="font-mono">din.window</code>), and it reloads whenever you save a file in it.
      </p>
    </section>
  );
}
