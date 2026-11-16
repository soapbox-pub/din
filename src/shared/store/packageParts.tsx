import type { ReactNode } from 'react';
import { ArrowDownToLine, Check, Copy, Eye, EyeOff, Info, RefreshCw, Trash2 } from 'lucide-react';
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { ExtensionPackage, ThemePackage } from '@/lib/themePackages';
import { SectionHeader } from '@/shared/store/common';

/**
 * What the App Store's Cursors, Icons and Skins (in its own app) and the Web
 * Browser's about:extensions (on the desktop) show of a published theme or
 * extension, given what each does with it (PackageHandlers): each has its
 * own, the App Store's over din.store and the browser's over the desktop's
 * own hooks.
 */

/** Where a published theme stands on this computer, and what its button does. */
export interface PackageState {
  /** Its directory name, when installed. */
  id: string | null;
  /** Installed, but an older version than this. */
  outdated: boolean;
  /** The pointer's or the icons' now. */
  inUse: boolean;
  busy: boolean;
}

export interface PackageHandlers {
  stateOf: (pkg: ThemePackage) => PackageState;
  /** Get, Update or Use, whichever it needs. */
  act: (pkg: ThemePackage) => void;
  remove: (pkg: ThemePackage) => void;
  /** Ask to delete one of the user's own from Nostr; `deleting` is the one asked about, where the asking is in the page. */
  deleteOwn: (pkg: ThemePackage) => void;
  deleting: ThemePackage | null;
  cancelDelete: () => void;
  confirmDelete: (pkg: ThemePackage) => void;
  select: (pkg: ThemePackage) => void;
  copyAddress: (pkg: ThemePackage) => void;
  canInstall: boolean;
  isOwn: (pkg: ThemePackage) => boolean;
}

/** Try On, for a cursor theme or icon set, where it's offered. */
export interface PackageTryOn {
  can: (pkg: ThemePackage) => boolean;
  isTrying: (pkg: ThemePackage) => boolean;
  start: (pkg: ThemePackage) => void;
  stop: () => void;
}

/** A theme's right-click menu, mirroring its card's and page's buttons. */
export function PackageContextMenu({
  pkg,
  handlers,
  tryOn,
  children,
}: {
  pkg: ThemePackage;
  handlers: PackageHandlers;
  tryOn?: PackageTryOn;
  children: ReactNode;
}) {
  const state = handlers.stateOf(pkg);
  const done = state.inUse && !state.outdated;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => handlers.act(pkg)} disabled={done || state.busy || !handlers.canInstall}>
          {state.outdated ? <RefreshCw aria-hidden /> : state.id ? <Check aria-hidden /> : <ArrowDownToLine aria-hidden />}
          {state.outdated ? 'Update' : state.id ? (pkg.type === 'extension' ? 'Installed' : 'Use') : 'Get'}
        </ContextMenuItem>
        {tryOn && tryOn.can(pkg) && !done && (
          <ContextMenuItem onSelect={() => (tryOn.isTrying(pkg) ? tryOn.stop() : tryOn.start(pkg))}>
            {tryOn.isTrying(pkg) ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {tryOn.isTrying(pkg) ? 'Stop Trying On' : 'Try On'}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => handlers.select(pkg)}>
          <Info aria-hidden />
          View Details
        </ContextMenuItem>
        {state.id && (
          <ContextMenuItem onSelect={() => handlers.remove(pkg)} disabled={state.busy}>
            <Trash2 aria-hidden />
            Remove from This Computer
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handlers.copyAddress(pkg)}>
          <Copy aria-hidden />
          Copy Address
        </ContextMenuItem>
        {handlers.isOwn(pkg) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => handlers.deleteOwn(pkg)}>
              <Trash2 aria-hidden />
              Delete from Nostr…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Asks before one of the user's own published themes is deleted from their relays. */
export function DeleteDialog({ handlers }: { handlers: PackageHandlers }) {
  const pkg = handlers.deleting;
  return (
    <AlertDialog open={!!pkg} onOpenChange={(open) => !open && handlers.cancelDelete()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {pkg?.title} from Nostr?</AlertDialogTitle>
          <AlertDialogDescription>
            Asks your relays to delete it, so it leaves the App Store. Anyone who already has it keeps it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() => pkg && handlers.confirmDelete(pkg)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What an extension says it can do, from its manifest; Get shows the same before installing. */
export function ExtensionAccess({ pkg }: { pkg: ExtensionPackage }) {
  const sites = pkg.hosts.includes('<all_urls>') || pkg.hosts.some((h) => /^\*:\/\/\*\/\*$/.test(h) || /^https?:\/\/\*\/\*$/.test(h))
    ? ['Every site']
    : pkg.hosts;
  if (!sites.length && !pkg.permissions.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label="What it can do">
      <SectionHeader title="What It Can Do" />
      <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2">
        {sites.length > 0 && (
          <div className="rounded-xl bg-card clay p-4">
            <p className="mb-2 text-sm font-medium">Read and change data on</p>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {sites.map((site) => (
                <li key={site} className="truncate font-mono text-xs" title={site}>{site}</li>
              ))}
            </ul>
          </div>
        )}
        {pkg.permissions.length > 0 && (
          <div className="rounded-xl bg-card clay p-4">
            <p className="mb-2 text-sm font-medium">Permissions</p>
            <ul className="flex flex-wrap gap-1.5">
              {pkg.permissions.map((permission) => (
                <li key={permission} className="rounded-full bg-muted px-2.5 py-0.5 font-mono text-xs text-muted-foreground">
                  {permission}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
