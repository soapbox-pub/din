import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useThemePackageActions } from '@/hooks/useThemePackages';
import { useToast } from '@/hooks/useToast';
import { canTryOnSystemCursor, endSystemCursorTryOn, tryOnSystemCursor } from '@/lib/cursorTryOn';
import { blobUrl, packageCoordinate, type CursorPackage, type IconPackage, type ThemePackage } from '@/lib/themePackages';
import { previewDesktopThemeIcons } from '@/shared/themeIcons';

/**
 * The App Store's Try On, until it's stopped, got, or the store leaves the
 * section. An icon set's preview icons, downloaded and checked against their
 * hashes, are shown over the installed theme's (previewDesktopThemeIcons).
 * A cursor theme is installed and made the system's pointer, then put back
 * (src/lib/cursorTryOn.ts).
 */

/** The biggest preview icon worth inlining. */
const MAX_ICON_BYTES = 512 * 1024;

const SHA256_HEX = (data: ArrayBuffer) =>
  crypto.subtle.digest('SHA-256', data).then((digest) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''));

function dataUrl(data: ArrayBuffer, mime: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([data], { type: mime }));
  });
}

/** A published icon set's preview icons as data URLs, by name, as the desktop's theme icons are kept. */
function iconTriesQuery(pkg: IconPackage) {
  return {
    queryKey: ['theme-packages', 'try-icons', packageCoordinate(pkg), pkg.createdAt],
    staleTime: Infinity,
    queryFn: async ({ signal }: { signal?: AbortSignal }): Promise<Record<string, string>> => {
      const found = await Promise.all(
        pkg.icons.map(async (icon) => {
          const url = blobUrl(pkg, icon.sha256);
          if (!url) return null;
          try {
            const response = await fetch(url, { signal, referrerPolicy: 'no-referrer' });
            if (!response.ok) return null;
            const data = await response.arrayBuffer();
            if (data.byteLength > MAX_ICON_BYTES || (await SHA256_HEX(data)) !== icon.sha256) return null;
            return [icon.name, await dataUrl(data, icon.mime)] as const;
          } catch {
            return null;
          }
        }),
      );
      return Object.fromEntries(found.filter((entry) => entry !== null));
    },
  };
}

// Which App Store window's try-on is worn: there's one pointer and one set
// of icons for them all, so one window's starting takes off another's, and
// that one's closing or stopping leaves alone what it no longer wears.
let wearer: object | null = null;
const wearerChanged = new Set<() => void>();

function setWearer(next: object | null): void {
  wearer = next;
  for (const changed of wearerChanged) changed();
}

/** Take off whatever's tried on; resolves once the pointer's put back. */
function takeOffAny(): Promise<void> {
  previewDesktopThemeIcons(null);
  return endSystemCursorTryOn().catch(() => {});
}

/** Take off what `me` tried on, if it's still worn. */
function takeOff(me: object): Promise<void> {
  if (wearer !== me) return Promise.resolve();
  setWearer(null);
  return takeOffAny();
}

/** Whether a published theme can be tried on before getting it. */
export function canTryOn(pkg: ThemePackage): pkg is CursorPackage | IconPackage {
  return (pkg.type === 'cursor' && canTryOnSystemCursor()) || (pkg.type === 'icon' && pkg.icons.length > 0);
}

export interface TryOn {
  /** The theme being tried on, or being got ready to. */
  trying: CursorPackage | IconPackage | null;
  loading: boolean;
  start: (pkg: ThemePackage) => void;
  stop: () => void;
  /** Keep the pointer tried on, installed. */
  keep: () => void;
  isTrying: (pkg: ThemePackage) => boolean;
}

/**
 * `installedId` is the id a theme is installed as here, if it is
 * (usePackageHandlers' stateOf), so trying it on doesn't download it again.
 */
export function useTryOn(installedId: (pkg: ThemePackage) => string | null): TryOn {
  const queryClient = useQueryClient();
  const actions = useThemePackageActions();
  const { toast } = useToast();
  const [trying, setTrying] = useState<CursorPackage | IconPackage | null>(null);
  const [loading, setLoading] = useState(false);
  // Which start is current, so one superseded or stopped mid-download puts nothing on.
  const run = useRef(0);
  const [me] = useState(() => ({}));

  useEffect(() => {
    // Another window's try-on took this one's off.
    const changed = () => {
      if (wearer === me) return;
      run.current++;
      setTrying(null);
      setLoading(false);
    };
    wearerChanged.add(changed);
    return () => {
      wearerChanged.delete(changed);
      void takeOff(me);
    };
  }, [me]);

  const refreshPointer = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['cursor'] });
    void queryClient.invalidateQueries({ queryKey: ['theme-packages', 'installed', 'cursor'] });
  }, [queryClient]);

  const end = useCallback(
    (done: Promise<void>) => {
      run.current++;
      void done.finally(refreshPointer);
      setTrying(null);
      setLoading(false);
    },
    [refreshPointer],
  );
  const stop = useCallback(() => end(takeOff(me)), [end, me]);
  const keep = useCallback(() => {
    if (wearer !== me) return end(Promise.resolve());
    setWearer(null);
    end(endSystemCursorTryOn(true));
  }, [end, me]);

  const start = (pkg: ThemePackage) => {
    if (!canTryOn(pkg)) return;
    void takeOffAny();
    setWearer(me);
    const id = ++run.current;
    setTrying(pkg);
    setLoading(true);
    void (async () => {
      try {
        if (pkg.type === 'cursor') {
          // One started or stopped after this takes it off once it's on.
          await tryOnSystemCursor(installedId(pkg), () => actions.install(pkg));
          refreshPointer();
        } else {
          const icons = await queryClient.fetchQuery(iconTriesQuery(pkg));
          if (id !== run.current) return;
          if (!Object.keys(icons).length) throw new Error('None of its icons could be downloaded.');
          previewDesktopThemeIcons(icons);
        }
        if (id === run.current) setLoading(false);
      } catch (error) {
        if (id !== run.current) return;
        setTrying(null);
        setLoading(false);
        refreshPointer();
        toast({
          title: `Couldn’t try on ${pkg.title}`,
          description: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error),
          variant: 'destructive',
        });
      }
    })();
  };

  return {
    trying,
    loading,
    start,
    stop,
    keep,
    isTrying: (pkg) => !!trying && packageCoordinate(trying) === packageCoordinate(pkg),
  };
}
