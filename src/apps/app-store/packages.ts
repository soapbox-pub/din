import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuthor } from '@/hooks/useAuthor';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { packageCoordinate, packageNaddr, type CursorPackage, type IconPackage, type PackageAddress, type PackageType, type ThemePackage } from '@/lib/themePackages';
import type { PackageHandlers, PackageTryOn } from '@/shared/store/packageParts';
import { toast } from '@/shared/toast';
import { dinStore, usePubkey, useStoreState } from './store';

/**
 * What the store's Cursors, Icons and Skins do with a published theme: Get,
 * Update, Use, Remove and Delete from Nostr, each asked of the desktop by
 * its address (din.store), which looks it up itself.
 */

/** What a theme becomes once it's got, for the toast. */
const BECOMES: Record<PackageType, string> = {
  cursor: 'It’s now your pointer.',
  icon: 'They’re now your icons.',
  skin: 'The Media Player is wearing it.',
  extension: 'It runs on the sites you browse.',
};

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What every card, page and menu of a section does, sharing one set of busy flags. */
export function usePackageHandlers(type: Exclude<PackageType, 'extension'>, onSelect: (address: PackageAddress | null) => void): PackageHandlers {
  const state = useStoreState();
  const pubkey = usePubkey();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const here = state?.packages[type];
  const installed = useMemo(() => new Map((here?.installed ?? []).map((p) => [p.coordinate, p])), [here?.installed]);
  const current = here?.current ?? null;

  const stateOf = (pkg: ThemePackage) => {
    const entry = installed.get(packageCoordinate(pkg));
    return {
      id: entry?.id ?? null,
      outdated: !!entry && entry.publishedAt < pkg.createdAt,
      inUse: !!entry && entry.id === current,
      busy: busy.has(packageCoordinate(pkg)),
    };
  };

  const track = async (pkg: ThemePackage, run: () => Promise<unknown>, failure: string) => {
    const key = packageCoordinate(pkg);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await run();
    } catch (error) {
      toast(failure, { body: errorText(error), destructive: true });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return {
    stateOf,
    act: (pkg) => {
      const s = stateOf(pkg);
      if (s.busy || (s.inUse && !s.outdated)) return;
      if (s.id && !s.outdated) {
        const id = s.id;
        void track(pkg, () => dinStore().use(type, id), `Couldn’t use ${pkg.title}`);
        return;
      }
      void track(pkg, async () => {
        await dinStore().install({ type: 'package', address: packageNaddr(pkg) });
        toast(`${pkg.title} ${s.id ? 'updated' : 'installed'}`, { body: BECOMES[pkg.type] });
      }, `Couldn’t get ${pkg.title}`);
    },
    remove: (pkg) => {
      const { id } = stateOf(pkg);
      if (id) void track(pkg, () => dinStore().remove({ type, id }), `Couldn’t remove ${pkg.title}`);
    },
    // The desktop asks, where the store can't answer for the user.
    deleteOwn: (pkg) => {
      void track(pkg, async () => {
        if (await dinStore().deletePublished(packageNaddr(pkg))) toast(`${pkg.title} deleted from Nostr`);
      }, `Couldn’t delete ${pkg.title}`);
    },
    deleting: null,
    cancelDelete: () => {},
    confirmDelete: () => {},
    select: (pkg) => onSelect({ type: pkg.type, pubkey: pkg.pubkey, identifier: pkg.identifier }),
    copyAddress: (pkg) => void navigator.clipboard.writeText(packageNaddr(pkg)).then(() => toast('Address copied')),
    canInstall: here?.canInstall ?? false,
    isOwn: (pkg) => pkg.pubkey === pubkey,
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

export interface TryOn extends PackageTryOn {
  /** The theme being tried on, or being got ready to. */
  trying: CursorPackage | IconPackage | null;
  loading: boolean;
  /** Keep the pointer tried on, installed. */
  keep: () => void;
}

/**
 * The store's Try On, until it's stopped, got, or the store leaves the
 * section: the desktop wears it (din.store.tryOn) and takes it off again,
 * and when the window closes.
 */
export function useTryOn(): TryOn {
  const state = useStoreState();
  const [started, setStarted] = useState<CursorPackage | IconPackage | null>(null);
  const tryingOn = state?.tryingOn ?? null;
  // Once the desktop has said it's wearing it, its saying otherwise means it
  // came off there (it failed, or another window's took its place).
  const confirmed = useRef(false);
  useEffect(() => {
    if (!started) {
      confirmed.current = false;
      return;
    }
    const mine = tryingOn?.address === packageNaddr(started);
    if (mine) confirmed.current = true;
    else if (confirmed.current || tryingOn) {
      confirmed.current = false;
      setStarted(null);
    }
  }, [tryingOn, started]);
  const trying = started;
  const cursorsHere = state?.packages.cursor.canInstall ?? false;

  const can = useCallback(
    (pkg: ThemePackage): pkg is CursorPackage | IconPackage =>
      (pkg.type === 'cursor' && cursorsHere) || (pkg.type === 'icon' && pkg.icons.length > 0),
    [cursorsHere],
  );
  const fail = (pkg: ThemePackage) => (error: unknown) => {
    setStarted(null);
    toast(`Couldn’t try on ${pkg.title}`, { body: errorText(error), destructive: true });
  };
  const stop = useCallback(() => {
    setStarted(null);
    void dinStore().endTryOn(false);
  }, []);

  // Leaving the section takes it off.
  const wearing = useRef(false);
  useEffect(() => {
    wearing.current = !!trying;
  }, [trying]);
  useEffect(() => () => {
    if (wearing.current) void dinStore().endTryOn(false);
  }, []);

  return {
    trying,
    loading: !!trying && (!tryingOn || tryingOn.loading),
    can,
    isTrying: (pkg) => !!trying && packageCoordinate(trying) === packageCoordinate(pkg),
    start: (pkg) => {
      if (!can(pkg)) return;
      setStarted(pkg);
      void dinStore().tryOn(packageNaddr(pkg)).catch(fail(pkg));
    },
    stop,
    keep: () => {
      setStarted(null);
      void dinStore().endTryOn(true);
    },
  };
}
