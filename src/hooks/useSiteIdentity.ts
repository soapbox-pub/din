import type { LucideIcon } from 'lucide-react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useNsiteIdentity } from '@/hooks/useNsiteIcon';
import { canonicalHostOfUrl } from '@/lib/nsiteApps';
import { originLabel } from '@/lib/signerLabels';

export interface SiteIdentity {
  name: string;
  /** Absent for a website that isn't installed: it goes by its host alone. */
  icon?: LucideIcon | string;
  /** The site is an nsite, so its name is bound to the key that signs its files. */
  nsite: boolean;
}

/**
 * What to call an origin and draw it as: the installed app it belongs to, as
 * the launcher shows it; an nsite as its own files name it (its host is a key
 * nobody can read); and any other website by its host.
 */
export function useSiteIdentity(origin: string): SiteIdentity {
  const { findAppIdForUrl, getApp } = useInstalledApps();
  const nsiteHost = canonicalHostOfUrl(`${origin}/`);
  const stored = useNsiteIdentity(nsiteHost);

  const appId = findAppIdForUrl(`${origin}/`);
  const app = appId ? getApp(appId) : undefined;
  if (app) return { name: app.name, icon: app.icon, nsite: Boolean(nsiteHost) };

  if (nsiteHost) {
    return {
      name: stored?.name?.trim() || `${nsiteHost.slice(0, 12)}…`,
      icon: stored?.icon ?? undefined,
      nsite: true,
    };
  }
  return { name: originLabel(origin), nsite: false };
}
