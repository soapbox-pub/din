import type { LucideIcon } from 'lucide-react';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useNsiteIdentity } from '@/hooks/useNsiteIcon';
import { appIdOfOrigin } from '@/lib/dinApps';
import { parseCanonicalNsiteHost } from '@/lib/nsite';
import { canonicalHostOfUrl } from '@/lib/nsiteApps';
import { originLabel } from '@/lib/signerLabels';

export interface SiteIdentity {
  name: string;
  /** Absent for a website that isn't installed: it goes by its host alone. */
  icon?: LucideIcon | string;
  /** The site is an nsite, so its name is bound to the key that signs its files. */
  nsite: boolean;
  /** Who publishes an nsite, by their profile name, once it has loaded. */
  publisher?: string;
}

/**
 * What to call an origin and draw it as: the installed app (or Din app) it
 * belongs to, as the launcher shows it; an nsite as its own files name it (its host is a key
 * nobody can read); and any other website by its host.
 */
export function useSiteIdentity(origin: string): SiteIdentity {
  const { findAppIdForUrl, getApp } = useInstalledApps();
  const nsiteHost = canonicalHostOfUrl(`${origin}/`);
  const stored = useNsiteIdentity(nsiteHost);
  const publisher = useNsitePublisher(nsiteHost);

  const appId = appIdOfOrigin(origin) ?? findAppIdForUrl(`${origin}/`);
  const app = appId ? getApp(appId) : undefined;
  if (app) return { name: app.name, icon: app.icon, nsite: Boolean(nsiteHost), publisher };

  if (nsiteHost) {
    return {
      name: stored?.name?.trim() || `${nsiteHost.slice(0, 12)}…`,
      icon: stored?.icon ?? undefined,
      nsite: true,
      publisher,
    };
  }
  return { name: originLabel(origin), nsite: false };
}

/** The profile name of the key an nsite's host stands for. */
export function useNsitePublisher(nsiteHost: string | null | undefined): string | undefined {
  const pubkey = nsiteHost ? parseCanonicalNsiteHost(nsiteHost)?.pubkey : undefined;
  const metadata = useAuthor(pubkey).data?.metadata;
  return (metadata?.display_name || metadata?.name)?.trim() || undefined;
}
