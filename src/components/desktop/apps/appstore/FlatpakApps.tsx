import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowDownToLine, Copy, Globe, Info, Loader2, Play, RefreshCw, Trash2 } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { SectionHeader } from '@/components/desktop/apps/appstore/common';
import { useSeen } from '@/components/desktop/apps/appstore/useSeen';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAuthor } from '@/hooks/useAuthor';
import {
  useFlatpakActions,
  useFlatpakBusy,
  useFlatpakCatalog,
  useFlatpakStatus,
  useInstalledFlatpaks,
} from '@/hooks/useNostrFlatpaks';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { formatBytes } from '@/lib/fs';
import { NATIVE_APP_PREFIX } from '@/lib/nativeApps';
import { flatpakNaddr, isOutdated, progressLabel, type FlatpakApp } from '@/lib/nostrFlatpaks';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * The App Store's Linux apps: NIP-82 apps whose releases carry a Flatpak
 * for this computer (src/lib/nostrFlatpaks.ts), in the Apps section beside
 * the nsites. Get downloads the release's bundle, checks it against its
 * hash, and installs it from Din's own Flatpak remote
 * (electron/nostr-flatpaks.mts); it's then an installed Linux app like any
 * other, in the launcher, and Update brings it to the newest release.
 */

/** Everything a card or page shows of an app's state here, and its actions. */
function useFlatpakState(app: FlatpakApp) {
  const installed = useInstalledFlatpaks().data?.get(app.identifier);
  const progress = useFlatpakBusy(app.identifier);
  const { install, remove } = useFlatpakActions();
  const { getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const status = useFlatpakStatus();
  const nativeId = NATIVE_APP_PREFIX + app.identifier;
  const outdated = !!installed && isOutdated(installed, app);
  const canInstall = !!status.data?.available;

  return {
    installed,
    outdated,
    progress,
    canInstall,
    get: () => void install(app, installed),
    open: () => {
      if (getApp(nativeId)) open(nativeId);
      else toast({ title: `${app.name} isn’t in the launcher yet`, description: 'It shows up there in a moment.' });
    },
    remove: () => void remove(app.identifier, app.name),
    copy: () => void navigator.clipboard.writeText(flatpakNaddr(app)).then(() => toast({ title: 'Address copied' })),
  };
}

/** The publisher's name and picture. */
function usePublisher(pubkey: string, enabled = true) {
  const author = useAuthor(enabled ? pubkey : undefined);
  const metadata = author.data?.metadata;
  return {
    name: (metadata?.display_name || metadata?.name)?.trim() || null,
    picture: metadata?.picture ? sanitizeImageUrl(metadata.picture) ?? null : null,
  };
}

/** Get, Update, Open, or how far it's got. */
export function FlatpakPill({ app, className }: { app: FlatpakApp; className?: string }) {
  const state = useFlatpakState(app);
  const busy = !!state.progress;
  const label = busy
    ? progressLabel(state.progress, !!state.installed)
    : state.outdated ? 'Update' : state.installed ? 'Open' : 'Get';
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={busy ? undefined : state.installed && !state.outdated ? state.open : state.get}
      disabled={!state.installed && !state.canInstall}
      title={state.canInstall ? (state.installed ? undefined : app.asset.size ? `Downloads ${formatBytes(app.asset.size)}` : undefined) : 'Linux apps install in the Din desktop app, with Flatpak'}
      aria-disabled={busy}
      aria-label={`${label} ${app.name}`}
      className={cn(
        'relative z-10 h-8 shrink-0 rounded-full px-5 font-semibold tabular-nums',
        'bg-secondary text-ink-accent hover:bg-secondary/80',
        busy && 'cursor-default text-muted-foreground hover:bg-secondary',
        className,
      )}
    >
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : state.outdated ? <RefreshCw aria-hidden /> : null}
      {label}
    </Button>
  );
}

/** An app's right-click menu, mirroring its card's and page's buttons. */
function FlatpakContextMenu({ app, onSelect, children }: { app: FlatpakApp; onSelect?: (app: FlatpakApp) => void; children: ReactNode }) {
  const state = useFlatpakState(app);
  const busy = !!state.progress;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {state.installed && !state.outdated ? (
          <ContextMenuItem onSelect={state.open} disabled={busy}>
            <Play aria-hidden />
            Open
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={state.get} disabled={busy || !state.canInstall}>
            {state.outdated ? <RefreshCw aria-hidden /> : <ArrowDownToLine aria-hidden />}
            {state.outdated ? 'Update' : 'Get'}
          </ContextMenuItem>
        )}
        {onSelect && (
          <ContextMenuItem onSelect={() => onSelect(app)}>
            <Info aria-hidden />
            View Details
          </ContextMenuItem>
        )}
        {state.installed && (
          <ContextMenuItem onSelect={state.remove} disabled={busy}>
            <Trash2 aria-hidden />
            Remove from This Computer
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={state.copy}>
          <Copy aria-hidden />
          Copy Address
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FlatpakIcon({ app, className }: { app: FlatpakApp; className?: string }) {
  if (app.icon) return <AppIcon icon={app.icon} className={cn('object-contain', className)} />;
  const initial = app.name.match(/\p{L}|\p{N}/u)?.[0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      className={cn('grid place-items-center rounded-[28%] bg-gradient-to-br from-primary to-primary/70 text-2xl font-semibold text-primary-foreground', className)}
    >
      {initial}
    </span>
  );
}

/** One app's card: icon, name, publisher, summary, and its pill. */
function FlatpakCard({ app, onSelect }: { app: FlatpakApp; onSelect: (app: FlatpakApp) => void }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const publisher = usePublisher(app.pubkey, seen);
  return (
    <FlatpakContextMenu app={app} onSelect={onSelect}>
      <div ref={ref} className="relative flex min-w-0 flex-col gap-3 rounded-xl bg-card clay p-4 transition-shadow motion-safe:hover:shadow-md">
        <button
          type="button"
          onClick={() => onSelect(app)}
          aria-label={`View details for ${app.name}`}
          className="absolute inset-0 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <div className="flex items-center gap-3">
          <FlatpakIcon app={app} className="size-14 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" title={app.name}>{app.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[publisher.name ? `by ${publisher.name}` : null, 'Linux app'].filter(Boolean).join(' · ')}
            </p>
          </div>
          <FlatpakPill app={app} />
        </div>
        <p className="line-clamp-2 min-h-10 flex-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{app.summary}</p>
      </div>
    </FlatpakContextMenu>
  );
}

export function FlatpakGrid({ apps, onSelect }: { apps: FlatpakApp[]; onSelect: (app: FlatpakApp) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
      {apps.map((app) => (
        <FlatpakCard key={`${app.pubkey}:${app.identifier}`} app={app} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FlatpakGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-3">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl bg-card clay p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-14 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-3 w-4/5" />
            </div>
            <Skeleton className="h-8 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
}

const SECTION_TITLE = 'Linux Apps';
const SECTION_SUBTITLE = 'Desktop apps published on Nostr, installed as Flatpaks.';

/** The Apps section's Linux apps, where this computer can install them. */
export function FlatpakAppsSection({ onSelect }: { onSelect: (app: FlatpakApp) => void }) {
  const status = useFlatpakStatus();
  const catalog = useFlatpakCatalog();
  if (!status.data?.available) return null;
  if (!catalog.isPending && !catalog.data?.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label={SECTION_TITLE}>
      <SectionHeader title={SECTION_TITLE} subtitle={SECTION_SUBTITLE} />
      {catalog.isPending ? <FlatpakGridSkeleton /> : <FlatpakGrid apps={catalog.data ?? []} onSelect={onSelect} />}
    </section>
  );
}

/** A Linux app's page: what it is, its newest release, and getting, updating, opening or removing it. */
export function FlatpakAppDetail({ app }: { app: FlatpakApp }) {
  const publisher = usePublisher(app.pubkey);
  const state = useFlatpakState(app);
  const openUrl = useOpenUrl();
  const ref = useRef<HTMLDivElement>(null);
  const released = new Date(app.release.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  return (
    <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none" aria-label={`${app.name} details`}>
      <div className="border-b border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 @2xl:flex-row @2xl:items-center @2xl:gap-6 @2xl:p-6">
          <FlatpakIcon app={app} className="size-24 shrink-0 text-4xl drop-shadow-md @2xl:size-28" />
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="min-w-0">
              <h1 className="break-words text-3xl font-bold tracking-tight">{app.name}</h1>
              {publisher.name && (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <Avatar className="size-5">
                    {publisher.picture && <AvatarImage src={publisher.picture} alt="" />}
                    <AvatarFallback className="text-[10px]">{publisher.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{publisher.name}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FlatpakPill app={app} />
              {state.installed && (
                <Button size="sm" variant="ghost" onClick={state.remove} disabled={!!state.progress} className="h-8 rounded-full px-4">
                  <Trash2 aria-hidden />
                  Remove
                </Button>
              )}
              {app.website && (
                <Button size="sm" variant="ghost" onClick={() => app.website && openUrl(app.website)} className="h-8 rounded-full px-4">
                  <Globe aria-hidden />
                  Website
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={state.copy} className="h-8 rounded-full px-4">
                <Copy aria-hidden />
                Copy Address
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-4 @2xl:p-6">
        {app.screenshots.length > 0 && (
          <section className="flex flex-col gap-4" aria-label="Screenshots">
            <SectionHeader title="Screenshots" />
            <div className="-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2">
              {app.screenshots.map((src, i) => (
                <img
                  key={src}
                  src={src}
                  alt={`Screenshot ${i + 1} of ${app.name}`}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="h-56 w-auto max-w-none shrink-0 snap-start rounded-xl border border-border bg-muted object-contain shadow-sm"
                />
              ))}
            </div>
          </section>
        )}

        {app.description || app.summary ? (
          <p className="max-w-prose whitespace-pre-line text-base leading-relaxed [overflow-wrap:anywhere]">{app.description || app.summary}</p>
        ) : (
          <p className="text-muted-foreground">This app doesn’t describe itself.</p>
        )}

        {app.categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {app.categories.map((tag) => (
              <span key={tag} className="max-w-full truncate rounded-md bg-secondary px-2 py-0.5 text-sm text-secondary-foreground" title={tag}>
                {tag}
              </span>
            ))}
          </div>
        )}

        {app.release.notes && (
          <section className="flex flex-col gap-4" aria-label="What’s new">
            <SectionHeader title="What’s New" subtitle={`Version ${app.release.version} · ${released}`} />
            <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {app.release.notes.length > 2000 ? `${app.release.notes.slice(0, 2000)}…` : app.release.notes}
            </p>
          </section>
        )}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className={cn(settingsGroup, 'text-sm')}>
            <InfoRow label="Version">{app.release.version}</InfoRow>
            {state.installed && <InfoRow label="Installed">{state.installed.version || 'Yes'}</InfoRow>}
            <InfoRow label="Download size">{app.asset.size ? formatBytes(app.asset.size) : 'Unknown'}</InfoRow>
            <InfoRow label="Kind">Linux app (Flatpak)</InfoRow>
            <InfoRow label="Flatpak id"><span className="font-mono text-xs">{app.identifier}</span></InfoRow>
            {app.license && <InfoRow label="License">{app.license}</InfoRow>}
            {app.repository && <InfoRow label="Source code"><span className="font-mono text-xs" title={app.repository}>{app.repository}</span></InfoRow>}
            <InfoRow label="Publisher">{publisher.name ?? 'Unknown'}</InfoRow>
            <InfoRow label="Released">{released}</InfoRow>
          </dl>
        </section>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
