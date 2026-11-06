import { useEffect, useRef } from 'react';
import { FolderOpen, FolderPlus, MoreHorizontal, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useToast } from '@/hooks/useToast';
import { getAppsBridge } from '@/lib/dinApps';
import { useChooseAppFolder } from '@/hooks/useChooseAppFolder';
import { fileAppDefinition, fileAppEntry, type FileAppEntry, type OpenedFolder } from '@/lib/fileApps';
import { PERMISSION_LABELS, rememberApproval, requestedAccess } from '@/lib/launchedApps';

/**
 * Apps from folders on this computer (src/lib/fileApps.ts), in the App
 * Store: the page a chosen folder opens on, and the section listing
 * the ones added.
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

interface Action {
  label: string;
  icon: LucideIcon;
  run: () => void;
  destructive?: boolean;
}

/** The apps added from folders, and a card to add another. Nothing outside the Electron shell. */
export function FolderAppsSection({ onChose }: { onChose: (opened: OpenedFolder) => void }) {
  const { fileApps, uninstallApp } = useInstalledApps();
  const { open, closeApp } = useWindowActions();
  const { choose, busy } = useChooseAppFolder();
  if (!getAppsBridge()) return null;

  const pick = async () => {
    const opened = await choose();
    if (opened) onChose(opened);
  };

  return (
    <section className="flex flex-col gap-4" aria-label="Apps from your folders">
      <SectionHeader title="From Your Folders" subtitle="Make your own app, and use it as you work on it." />
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @7xl:grid-cols-3">
        {[...fileApps].sort((a, b) => b.addedAt - a.addedAt).map((entry) => {
          const actions: Action[][] = [
            [{ label: 'Open', icon: FolderOpen, run: () => open(entry.appId) }],
            [{
              label: 'Remove',
              icon: Trash2,
              destructive: true,
              run: () => {
                closeApp(entry.appId);
                uninstallApp(entry.appId);
              },
            }],
          ];
          return <FolderAppCard key={entry.appId} entry={entry} actions={actions} onOpen={() => open(entry.appId)} />;
        })}
        <button
          type="button"
          onClick={() => void pick()}
          disabled={busy}
          className="flex min-h-28 items-center gap-3 bg-foreground/[0.04] rounded-xl p-4 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
        >
          <span className="grid size-14 shrink-0 place-items-center rounded-[28%] bg-gradient-to-br from-warning/25 to-warning/5 text-warning">
            <FolderPlus className="size-6" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block font-semibold">Add from a Folder…</span>
            <span className="block text-sm text-muted-foreground">Any folder with an index.html</span>
          </span>
        </button>
      </div>
    </section>
  );
}

function FolderAppCard({ entry, actions, onOpen }: { entry: FileAppEntry; actions: Action[][]; onOpen: () => void }) {
  const name = appName(entry);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative flex min-h-28 items-center gap-3 rounded-xl bg-card clay p-4 transition-shadow motion-safe:hover:shadow-md">
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${name}`}
            className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <AppIcon icon={fileAppDefinition(entry).icon} className="size-14 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" title={name}>{name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground" title={entry.path}>{entry.path}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="relative z-10 size-8 shrink-0 rounded-full" aria-label={`More for ${name}`}>
                <MoreHorizontal aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {actions.map((group, i) => [
                i > 0 && <DropdownMenuSeparator key={`sep-${i}`} />,
                ...group.map(({ label, icon: Icon, run, destructive }) => (
                  <DropdownMenuItem key={label} onSelect={run} variant={destructive ? 'destructive' : 'default'}>
                    <Icon aria-hidden /> {label}
                  </DropdownMenuItem>
                )),
              ])}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {actions.map((group, i) => [
          i > 0 && <ContextMenuSeparator key={`sep-${i}`} />,
          ...group.map(({ label, icon: Icon, run, destructive }) => (
            <ContextMenuItem key={label} onSelect={run} variant={destructive ? 'destructive' : 'default'}>
              <Icon aria-hidden /> {label}
            </ContextMenuItem>
          )),
        ])}
      </ContextMenuContent>
    </ContextMenu>
  );
}
