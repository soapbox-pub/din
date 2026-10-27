import { useCallback, useState } from 'react';
import { Info, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getBrowserBridge, type SiteInfo } from '@/lib/browser';
import { ENV_NAME_RE, getNappHost, MAX_ENV_VALUE, MAX_ENV_VARS, type NappStatus } from '@/lib/napp';
import type { SiteCapability } from '@/lib/promptBridge';
import { SITE_CAPABILITIES } from '@/lib/siteCapabilities';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

/** What a napp asks the user for, in the order shown. */
const NAPP_CAPABILITIES: SiteCapability[] = ['notifications', 'background-sync'];

interface EnvRow {
  key: number;
  name: string;
  value: string;
}

let nextRowKey = 1;

function toRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([name, value]) => ({ key: nextRowKey++, name, value }));
}

/** Why a set of variables can't be saved, or null. */
function envProblem(rows: EnvRow[]): string | null {
  const named = rows.filter((r) => r.name || r.value);
  if (named.length > MAX_ENV_VARS) return `At most ${MAX_ENV_VARS} variables.`;
  const seen = new Set<string>();
  for (const { name, value } of named) {
    if (!ENV_NAME_RE.test(name)) return `"${name}" isn't a valid name: letters, digits and _, not starting with a digit.`;
    if (seen.has(name)) return `${name} is set twice.`;
    if (value.length > MAX_ENV_VALUE) return `${name} is longer than ${MAX_ENV_VALUE} characters.`;
    seen.add(name);
  }
  return null;
}

/**
 * The info button in an installed nsite's title bar: what the app may do on
 * this computer (notifications, which its push subscriptions need, and
 * background refresh), its window.ENV variables, and clearing everything it
 * keeps outside its files. Renders nothing outside the Electron shell.
 */
export function NappInfoButton({
  host,
  name,
  onReload,
  className,
}: {
  host: string;
  name: string;
  /** Reload the app's page (ENV is read when it loads). */
  onReload: () => void;
  className?: string;
}) {
  const napp = getNappHost();
  const browser = getBrowserBridge();
  const origin = `nsite://${host}`;
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SiteInfo | null>(null);
  const [status, setStatus] = useState<NappStatus | null>(null);
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(() => {
    if (!napp) return;
    void napp.status(host).then((next) => {
      setStatus(next);
      setRows(toRows(next.env));
      setDirty(false);
    }, () => {});
    void browser?.getSiteInfo(origin, false).then(setInfo, () => {});
  }, [napp, browser, host, origin]);

  // Re-read each time it opens: the app may have asked for something since.
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    refresh();
    setSaved(false);
    setError(null);
    setConfirmClear(false);
  };

  if (!napp) return null;

  const setPermission = (capability: SiteCapability, allow: boolean) => {
    if (!browser) return;
    setInfo((prev) => prev && { ...prev, permissions: { ...prev.permissions, [capability]: allow } });
    void browser.setSitePermission(origin, capability, allow, false).then(refresh, () => {});
  };

  const editRow = (key: number, patch: Partial<EnvRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
    setSaved(false);
    setError(null);
  };

  const saveEnv = () => {
    const problem = envProblem(rows);
    if (problem) {
      setError(problem);
      return;
    }
    const env = Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.name, r.value]));
    napp.setEnv(host, env).then(
      () => {
        setDirty(false);
        setSaved(true);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save.'),
    );
  };

  const clearData = () => {
    void napp.clearData(host).then(() => {
      setOpen(false);
      onReload();
    }, () => {});
  };

  const activity = [
    status && status.subscriptions > 0 ? 'Watching Nostr for notifications, even while closed' : null,
    status && status.syncTags.length > 0 ? 'Refreshing in the background, at most every 15 minutes' : null,
  ].filter((line): line is string => line !== null);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${name}`}
          title={`About ${name}`}
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-md',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <Info className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 space-y-4">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 space-y-0.5">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-xs text-muted-foreground">
              Every file is checked against the app's signed manifest before it loads.
            </p>
          </div>
        </div>

        {browser && (
          <div className="space-y-2 border-t border-border/60 pt-4">
            <p className="text-xs font-medium text-muted-foreground">Permissions</p>
            <ul className="space-y-1">
              {NAPP_CAPABILITIES.map((capability) => {
                const { name: label, icon: Icon } = SITE_CAPABILITIES[capability];
                const answer = info?.permissions[capability];
                const id = `napp-permission-${capability}`;
                return (
                  <li key={capability} className="flex items-center gap-3 rounded-md py-1">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
                      <span className="block text-sm">{label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {answer === true ? 'Allowed' : answer === false ? 'Blocked' : 'Asks first'}
                      </span>
                    </label>
                    <Switch id={id} checked={answer === true} onCheckedChange={(on) => setPermission(capability, on)} />
                  </li>
                );
              })}
            </ul>
            {activity.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {activity.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-border/60 pt-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-muted-foreground">Environment</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={rows.length >= MAX_ENV_VARS}
              onClick={() => {
                setRows((prev) => [...prev, { key: nextRowKey++, name: '', value: '' }]);
                setDirty(true);
                setSaved(false);
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              Add
            </Button>
          </div>
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Variables set here are this computer's, and the app reads them as <code>window.ENV</code>.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.key} className="flex items-center gap-2">
                  <Input
                    aria-label="Name"
                    placeholder="NAME"
                    value={row.name}
                    onChange={(e) => editRow(row.key, { name: e.target.value })}
                    className="h-8 w-28 font-mono text-xs"
                    spellCheck={false}
                  />
                  <Input
                    aria-label={row.name ? `Value of ${row.name}` : 'Value'}
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => editRow(row.key, { value: e.target.value })}
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    aria-label={row.name ? `Remove ${row.name}` : 'Remove'}
                    onClick={() => {
                      setRows((prev) => prev.filter((r) => r.key !== row.key));
                      setDirty(true);
                      setSaved(false);
                    }}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {dirty && (
            <Button type="button" size="sm" variant="secondary" className="w-full" onClick={saveEnv}>
              Save
            </Button>
          )}
          {saved && (
            <div className="flex items-center gap-3 rounded-lg bg-secondary/60 p-3">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">Reload the app to use them.</p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => {
                  onReload();
                  setOpen(false);
                }}
              >
                Reload
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-border/60 pt-4">
          {confirmClear ? (
            <>
              <p className="text-xs text-muted-foreground">
                This deletes what {name} stored here, its notifications and subscriptions, its environment and its
                permissions. The app stays installed.
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" variant="destructive" className="flex-1" onClick={clearData}>
                  Clear data
                </Button>
              </div>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setConfirmClear(true)}>
              <Trash2 className="size-3.5" aria-hidden />
              Clear app data
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
