import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { ArrowDownToLine, ChevronDown, Copy, Globe, Info, Play, RefreshCw, Trash2 } from 'lucide-react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAuthor } from '@/hooks/useAuthor';
import {
  useFlatpakActions,
  useFlatpakBusy,
  useFlatpakStatus,
  useInstalledFlatpaks,
} from '@/hooks/useNostrFlatpaks';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { formatBytes } from '@/lib/fs';
import { NATIVE_APP_PREFIX } from '@/lib/nativeApps';
import { ngitRepositoryUri } from '@/lib/nostrUri';
import {
  chosenFormat,
  flatpakNaddr,
  formatName,
  installFormats,
  isOutdated,
  progressLabel,
  type LinuxApp,
  type LinuxFormat,
} from '@/lib/nostrFlatpaks';
import { sanitizeImageUrl, sanitizeNavigationUrl } from '@/lib/sanitizeUrl';
import { cn } from '@/lib/utils';
import { settingsGroup } from '@/shared/settingsChromeStyles';

// react-markdown is only loaded for a page with release notes.
const ReleaseNotes = lazy(() => import('@/components/desktop/apps/appstore/ReleaseNotes'));

/**
 * The App Store's Linux apps: NIP-82 apps whose releases carry a Flatpak or
 * an AppImage for this computer (src/lib/nostrFlatpaks.ts), in the Apps
 * section beside the nsites. Get downloads the release's bundle, checks it
 * against its hash, and installs it (electron/nostr-flatpaks.mts): a
 * Flatpak from Din's own Flatpak remote where it has one and Flatpak is
 * here, else its AppImage. It's then an installed Linux app like any other,
 * in the launcher, and Update brings it to the newest release the same way.
 *
 * An app is one app however many ways it comes. Get never says which way;
 * the others are named only in the menu under its caret, as Get as AppImage.
 */

/** Everything a card or page shows of an app's state here, and its actions. */
function useFlatpakState(app: LinuxApp) {
  const installed = useInstalledFlatpaks().data?.get(app.identifier);
  const progress = useFlatpakBusy(app.identifier);
  const { install, remove } = useFlatpakActions();
  const { getApp } = useInstalledApps();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const status = useFlatpakStatus();
  const nativeId = NATIVE_APP_PREFIX + app.identifier;
  const outdated = !!installed && isOutdated(installed, app);
  const formats = status.data?.formats ?? [];
  const ways = installFormats(app, formats);
  const format = chosenFormat(app, formats, installed);
  const canInstall = installed ? ways.includes(installed.format) : ways.length > 0;

  return {
    installed,
    outdated,
    progress,
    canInstall,
    /** How it's installed, or would be by Get. */
    format,
    /** The other ways to get it, by name in Get's menu; none once it's installed. */
    others: installed ? [] : ways.slice(1),
    get: (way: LinuxFormat = format) => void install(app, way, installed),
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

/**
 * How far an install has got, as a ring the pill's height, as the App Store
 * on a phone shows it: filling while the share is known, spinning while
 * it isn't. What it's doing is its tooltip and accessible name, or beside
 * it with `withLabel`.
 */
function ProgressRing({ app, label, percent, withLabel }: { app: LinuxApp; label: string; percent?: number; withLabel?: boolean }) {
  const r = 13;
  const circumference = 2 * Math.PI * r;
  const known = percent !== undefined;
  return (
    <span className="relative z-10 flex shrink-0 items-center gap-2">
      <span
        role="progressbar"
        aria-label={`${label}: ${app.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? percent : undefined}
        title={label}
        className="grid size-8 place-items-center rounded-full bg-secondary"
      >
        <svg viewBox="0 0 32 32" className={cn('size-7 -rotate-90', !known && 'motion-safe:animate-spin')} aria-hidden>
          <circle cx="16" cy="16" r={r} fill="none" strokeWidth="3" className="stroke-foreground/10" />
          <circle
            cx="16"
            cy="16"
            r={r}
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - (known ? Math.max(percent, 2) : 25) / 100)}
            className="stroke-ink-accent transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
          />
        </svg>
      </span>
      {withLabel && <span className="text-sm tabular-nums text-muted-foreground" aria-hidden>{label}</span>}
    </span>
  );
}

const pillClass = 'h-8 shrink-0 rounded-full bg-secondary font-semibold text-ink-accent hover:bg-secondary/80';

/**
 * Get, Update, Open, or how far it's got. Where an app comes more than one
 * way, Get has a caret whose menu names the others; Get itself never says.
 */
export function FlatpakPill({ app, className, withLabel }: { app: LinuxApp; className?: string; withLabel?: boolean }) {
  const state = useFlatpakState(app);
  if (state.progress) {
    return (
      <ProgressRing
        app={app}
        label={progressLabel(state.progress, !!state.installed)}
        percent={state.progress.percent}
        withLabel={withLabel}
      />
    );
  }
  const label = state.outdated ? 'Update' : state.installed ? 'Open' : 'Get';
  const size = app.assets[state.format]?.size;
  const split = state.others.length > 0;
  const main = (
    <Button
      size="sm"
      variant="secondary"
      onClick={state.installed && !state.outdated ? state.open : () => state.get()}
      disabled={!state.installed && !state.canInstall}
      title={state.canInstall ? (state.installed ? undefined : size ? `Downloads ${formatBytes(size)}` : undefined) : 'Linux apps install in the Din desktop app'}
      aria-label={`${label} ${app.name}`}
      className={cn(pillClass, 'relative z-10 px-5', split && 'rounded-r-none pr-3', className)}
    >
      {state.outdated ? <RefreshCw aria-hidden /> : null}
      {label}
    </Button>
  );
  if (!split) return main;
  return (
    <div role="group" aria-label={`Get ${app.name}`} className="relative z-10 flex shrink-0 items-center">
      {main}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Other ways to get ${app.name}`}
            className={cn(pillClass, 'w-8 rounded-l-none border-l border-foreground/10 pl-1 pr-2')}
          >
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {state.others.map((way) => (
            <DropdownMenuItem key={way} onSelect={() => state.get(way)}>
              <ArrowDownToLine aria-hidden />
              Get as {formatName(way)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** An app's right-click menu, mirroring its card's and page's buttons. */
function FlatpakContextMenu({ app, onSelect, children }: { app: LinuxApp; onSelect?: (app: LinuxApp) => void; children: ReactNode }) {
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
          <ContextMenuItem onSelect={() => state.get()} disabled={busy || !state.canInstall}>
            {state.outdated ? <RefreshCw aria-hidden /> : <ArrowDownToLine aria-hidden />}
            {state.outdated ? 'Update' : 'Get'}
          </ContextMenuItem>
        )}
        {state.others.map((way) => (
          <ContextMenuItem key={way} onSelect={() => state.get(way)} disabled={busy}>
            <ArrowDownToLine aria-hidden />
            Get as {formatName(way)}
          </ContextMenuItem>
        ))}
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

function FlatpakIcon({ app, className }: { app: LinuxApp; className?: string }) {
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
export function FlatpakCard({ app, onSelect }: { app: LinuxApp; onSelect: (app: LinuxApp) => void }) {
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
            <p className="truncate text-xs text-muted-foreground" title={publisher.name ?? undefined}>
              {publisher.name ? `by ${publisher.name}` : app.identifier}
            </p>
          </div>
          <FlatpakPill app={app} />
        </div>
        <p className="line-clamp-2 min-h-10 flex-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{app.summary}</p>
      </div>
    </FlatpakContextMenu>
  );
}

/** A Linux app's page: what it is, its newest release, and getting, updating, opening or removing it. */
export function FlatpakAppDetail({ app }: { app: LinuxApp }) {
  const publisher = usePublisher(app.pubkey);
  const state = useFlatpakState(app);
  const openUrl = useOpenUrl();
  const ref = useRef<HTMLDivElement>(null);
  // A web address opens as itself, an ngit one (nostr://npub…/relay/repo) as
  // its repository's nostr:naddr1… (NIP-21), which the Web Browser shows.
  const sourceUrl = !app.repository
    ? null
    : /^https?:\/\//i.test(app.repository)
      ? sanitizeNavigationUrl(app.repository)
      : ngitRepositoryUri(app.repository);
  const downloadSize = app.assets[state.format]?.size;
  const released = new Date(app.release.createdAt * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  // Take focus so Escape goes back without a click first.
  useEffect(() => ref.current?.focus(), []);

  return (
    <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none" aria-label={`${app.name} details`}>
      <div>
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
              <FlatpakPill app={app} withLabel />
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
            <Suspense fallback={<p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{app.release.notes.slice(0, 400)}</p>}>
              <ReleaseNotes text={app.release.notes.length > 6000 ? `${app.release.notes.slice(0, 6000)}…` : app.release.notes} />
            </Suspense>
          </section>
        )}

        <section className="flex flex-col gap-4" aria-label="Information">
          <SectionHeader title="Information" />
          <dl className={cn(settingsGroup, 'text-sm')}>
            <InfoRow label="Version">{app.release.version}</InfoRow>
            {state.installed && <InfoRow label="Installed">{state.installed.version || 'Yes'}</InfoRow>}
            <InfoRow label="Download size">{downloadSize ? formatBytes(downloadSize) : 'Unknown'}</InfoRow>
            <InfoRow label="Kind">Linux app ({formatName(state.format)})</InfoRow>
            <InfoRow label="Identifier"><span className="font-mono text-xs">{app.identifier}</span></InfoRow>
            {app.license && <InfoRow label="License">{app.license}</InfoRow>}
            {app.repository && (
              <InfoRow label="Source code">
                {sourceUrl ? (
                  <a
                    href={sourceUrl}
                    onClick={(event) => {
                      event.preventDefault();
                      openUrl(sourceUrl);
                    }}
                    title={sourceUrl}
                    className="rounded-sm font-mono text-xs text-ink-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {app.repository}
                  </a>
                ) : (
                  <span className="font-mono text-xs" title={app.repository}>{app.repository}</span>
                )}
              </InfoRow>
            )}
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
