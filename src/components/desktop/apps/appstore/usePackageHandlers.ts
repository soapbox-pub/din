import { useState } from 'react';
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useIconThemeStatus } from '@/hooks/useIconTheme';
import { useSystemCursorStatus } from '@/hooks/useSystemCursor';
import { canKeepPackages, useInstalledPackages, useThemePackageActions } from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { packageCoordinate, packageNaddr, type PackageAddress, type PackageType, type ThemePackage } from '@/lib/themePackages';

/**
 * What the App Store's Cursors, Icons and Skins (PackageStore) and the Web
 * Browser's about:extensions (ExtensionsPage) do with a published theme or
 * extension: Get, Update, Use, Remove, Delete from Nostr, and who made it.
 */

/** What a theme becomes once it's got, for the toast. */
const BECOMES: Record<PackageType, string> = {
  cursor: 'It’s now your pointer.',
  icon: 'They’re now your icons.',
  skin: 'The Media Player is wearing it.',
  extension: 'It runs on the sites you browse.',
};

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
  /** Ask to delete one of the user's own from Nostr; `deleting` is the one asked about. */
  deleteOwn: (pkg: ThemePackage) => void;
  deleting: ThemePackage | null;
  cancelDelete: () => void;
  confirmDelete: (pkg: ThemePackage) => void;
  select: (pkg: ThemePackage) => void;
  canInstall: boolean;
  isOwn: (pkg: ThemePackage) => boolean;
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

/** What every card, page and menu of a tab does, sharing one installed list and one set of busy flags. */
export function usePackageHandlers(type: PackageType, onSelect: (address: PackageAddress | null) => void): PackageHandlers {
  const installed = useInstalledPackages(type);
  const cursorStatus = useSystemCursorStatus();
  const iconStatus = useIconThemeStatus();
  const actions = useThemePackageActions();
  const { user } = useCurrentUser();
  const { toast } = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<ThemePackage | null>(null);

  // Which skin the Media Player wears is its own, so a skin is never In Use here.
  const current = type === 'cursor' ? cursorStatus.data?.theme : type === 'icon' ? iconStatus.data?.theme : undefined;
  const canInstall = canKeepPackages(type) && (
    type === 'cursor' ? cursorStatus.data?.canChange !== false
      : type === 'icon' ? iconStatus.data?.canChange !== false
        : true);

  const stateOf = (pkg: ThemePackage): PackageState => {
    const entry = installed.data?.get(packageCoordinate(pkg));
    return {
      id: entry?.id ?? null,
      // An extension's newest release is only known once fetched; it's out of date when its package is another.
      outdated: !!entry && (pkg.type === 'extension'
        ? !!pkg.asset && !!entry.sha256 && entry.sha256 !== pkg.asset.sha256
        : entry.publishedAt < pkg.createdAt),
      // An extension is at work as soon as it's installed.
      inUse: !!entry && (pkg.type === 'extension' || entry.id === current),
      busy: busy.has(packageCoordinate(pkg)),
    };
  };

  const track = async (pkg: ThemePackage, run: () => Promise<unknown>, failure: string) => {
    const key = packageCoordinate(pkg);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await run();
    } catch (error) {
      toast({ title: failure, description: cleanError(error), variant: 'destructive' });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const act = (pkg: ThemePackage) => {
    const state = stateOf(pkg);
    if (state.busy || (state.inUse && !state.outdated)) return;
    if (state.id && !state.outdated) {
      void track(pkg, () => actions.use(pkg.type, state.id as string), `Couldn’t use ${pkg.title}`);
      return;
    }
    void track(
      pkg,
      async () => {
        await actions.install(pkg);
        toast({ title: `${pkg.title} ${state.id ? 'updated' : 'installed'}`, description: BECOMES[pkg.type] });
      },
      `Couldn’t get ${pkg.title}`,
    );
  };

  const remove = (pkg: ThemePackage) => {
    const { id } = stateOf(pkg);
    if (id) void track(pkg, () => actions.remove(pkg.type, id), `Couldn’t remove ${pkg.title}`);
  };

  return {
    stateOf,
    act,
    remove,
    deleteOwn: setDeleting,
    select: (pkg) => onSelect({ type: pkg.type, pubkey: pkg.pubkey, identifier: pkg.identifier }),
    canInstall,
    isOwn: (pkg) => pkg.pubkey === user?.pubkey,
    deleting,
    cancelDelete: () => setDeleting(null),
    confirmDelete: (pkg) => {
      setDeleting(null);
      void track(pkg, () => actions.deleteOwn(pkg), `Couldn’t delete ${pkg.title}`);
    },
  };
}

/** The author's name and picture. */
export function usePackageAuthor(pubkey: string | undefined) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  return {
    name: (metadata?.display_name || metadata?.name)?.trim() || null,
    picture: metadata?.picture ? sanitizeImageUrl(metadata.picture) : null,
  };
}

export function useCopyAddress() {
  const { toast } = useToast();
  return (pkg: ThemePackage) => {
    void navigator.clipboard.writeText(packageNaddr(pkg)).then(() => toast({ title: 'Address copied' }));
  };
}

