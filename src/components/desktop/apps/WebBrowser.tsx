import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  MonitorDown,
  RotateCw,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveNavigation, sanitizeUrl } from '@/lib/sanitizeUrl';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { useToast } from '@/hooks/useToast';
import {
  BrowserView,
  type BrowserViewHandle,
} from '@/components/desktop/apps/BrowserView';

const HOME_URL = 'https://en.wikipedia.org/wiki/Main_Page';

/**
 * A minimal web browser.
 *
 * The actual rendering surface is abstracted by <BrowserView>, which uses an
 * Electron <webview> when available (loads any site) and falls back to a
 * sandboxed <iframe> in a plain browser (subject to remote framing policies).
 * Only https URLs are ever loaded (see `resolveNavigation` / `sanitizeUrl`).
 *
 * The toolbar's install button turns the current site into a desktop app
 * (PWA-style): it gets an entry in the app launcher and opens in its own
 * chrome-less window.
 */
export function WebBrowser(_props: AppComponentProps) {
  const [address, setAddress] = useState(HOME_URL);
  const [src, setSrc] = useState(HOME_URL);
  const [history, setHistory] = useState<string[]>([HOME_URL]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(false);
  // Page metadata reported by the Electron webview (null in the iframe
  // fallback); used to prefill the install dialog.
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [favicon, setFavicon] = useState<string | null>(null);
  const viewRef = useRef<BrowserViewHandle>(null);

  const navigate = useCallback(
    (raw: string) => {
      const resolved = resolveNavigation(raw);
      if (!resolved) return;
      setSrc(resolved);
      setAddress(resolved);
      setPageTitle(null);
      setFavicon(null);
      setHistory((h) => {
        const trimmed = h.slice(0, cursor + 1);
        setCursor(trimmed.length);
        return [...trimmed, resolved];
      });
    },
    [cursor],
  );

  const go = useCallback(
    (delta: number) => {
      const target = cursor + delta;
      if (target < 0 || target >= history.length) return;
      setCursor(target);
      setSrc(history[target]);
      setAddress(history[target]);
      setPageTitle(null);
      setFavicon(null);
    },
    [cursor, history],
  );

  const onTitleChange = useCallback((title: string) => {
    setPageTitle(title || null);
  }, []);

  const onFaviconChange = useCallback((favicons: string[]) => {
    setFavicon(favicons[0] ?? null);
  }, []);

  const canBack = cursor > 0;
  const canForward = cursor < history.length - 1;

  return (
    <div className="flex h-full w-full flex-col">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(address);
        }}
        className="relative flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5"
      >
        <NavButton label="Go back" disabled={!canBack} onClick={() => go(-1)}>
          <ArrowLeft className="size-4" />
        </NavButton>
        <NavButton label="Go forward" disabled={!canForward} onClick={() => go(1)}>
          <ArrowRight className="size-4" />
        </NavButton>
        <NavButton label="Reload page" onClick={() => viewRef.current?.reload()}>
          <RotateCw className={cn('size-4', loading && 'animate-spin')} />
        </NavButton>

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/80" aria-hidden />
          <input
            type="text"
            inputMode="url"
            aria-label="Address and search bar"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-full border border-border/60 bg-secondary/80 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        <InstallSiteButton url={src} pageTitle={pageTitle} favicon={favicon} />

        {loading && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary"
          />
        )}
      </form>

      <div className="relative flex-1 overflow-hidden bg-white">
        <BrowserView
          ref={viewRef}
          src={src}
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          onTitleChange={onTitleChange}
          onFaviconChange={onFaviconChange}
        />
      </div>
    </div>
  );
}

/**
 * Toolbar button + popover to install the current site as a desktop app,
 * like installing a PWA on other OSes.
 */
function InstallSiteButton({
  url,
  pageTitle,
  favicon,
}: {
  url: string;
  pageTitle: string | null;
  favicon: string | null;
}) {
  const { installWebApp, findWebAppByUrl } = useInstalledApps();
  const { open: openApp } = useWindowManager();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const site = useMemo(() => {
    const safe = sanitizeUrl(url);
    if (!safe) return null;
    const { hostname, origin } = new URL(safe);
    return {
      url: safe,
      hostname,
      // Prefer the favicon the page reported; fall back to the site root's
      // conventional /favicon.ico (AppIcon degrades to a glyph on 404).
      icon: (favicon && sanitizeUrl(favicon)) || `${origin}/favicon.ico`,
    };
  }, [url, favicon]);

  const installed = site ? findWebAppByUrl(site.url) : undefined;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setName(pageTitle ?? site?.hostname ?? '');
  };

  const install = () => {
    if (!site) return;
    const webApp = installWebApp({ name, url: site.url, icon: site.icon });
    if (!webApp) return;
    setOpen(false);
    toast({
      title: `${webApp.name} installed`,
      description: 'Find it in the app launcher, or right-click it to pin it to the taskbar.',
    });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Install site as app"
          title="Install site as app"
          disabled={!site}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
            'hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
          )}
        >
          <MonitorDown className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80">
        {!site ? null : installed ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <AppIcon icon={installed.icon ?? ''} className="size-8 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{installed.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  Already installed
                </p>
              </div>
            </div>
            <Button
              className="w-full"
              onClick={() => {
                setOpen(false);
                openApp(installed.id);
              }}
            >
              Open app
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              install();
            }}
          >
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Install site as app</h3>
              <p className="text-xs text-muted-foreground">
                Adds this site to your app launcher and opens it in its own
                window.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <AppIcon icon={site.icon} className="size-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor="install-app-name" className="text-xs">
                  App name
                </Label>
                <Input
                  id="install-app-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={site.hostname}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8"
                />
              </div>
            </div>
            <p className="truncate text-xs text-muted-foreground" title={site.url}>
              {site.url}
            </p>
            <Button type="submit" className="w-full">
              Install
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

function NavButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
