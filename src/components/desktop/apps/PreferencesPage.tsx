import { useCallback, useEffect, useState } from 'react';
import { Puzzle, Settings, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { crxIconUrl, getCrxBridge, type CrxExtension } from '@/lib/crx';
import type { Userscript } from '@/lib/userscripts';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { UserscriptsSection } from '@/components/desktop/apps/UserscriptManager';

/** Where extensions come from. */
const WEB_STORE_URL = 'https://chromewebstore.google.com/';

/**
 * Everything `about:preferences` needs from the browser window hosting it.
 *
 * The page can't source these itself: `treeTabs` is a `useLocalStorage` value
 * that only syncs across *documents*, so a second copy of the hook in this
 * component would silently diverge from the one driving the tab strip in the
 * same window. The rest are window-scoped actions.
 */
export interface PreferencesProps {
  /** Vertical (tree) tabs, shared with the window's own tab strip. */
  treeTabs: boolean;
  onTreeTabsChange: (value: boolean) => void;
  /** Open a URL in a new tab (the Chrome Web Store link). */
  onOpenUrl: (url: string) => void;
  /** Whether extensions/userscripts apply here (never in a private window). */
  showExtensions: boolean;
  /** The userscript library, or null when the bridge is absent. */
  userscripts: Userscript[] | null;
  onSetUserscriptEnabled: (id: string, enabled: boolean) => void;
  onRemoveUserscript: (script: Userscript) => void;
  onAddUserscript: () => void;
  /** Whether to offer "Clear browsing data" (hidden in private windows). */
  showClearData: boolean;
  onClearBrowsingData: () => void;
}

/**
 * The browser's settings page, rendered over a blank tab's surface when the
 * tab's URL is `about:preferences` (see `src/lib/internalPages.ts`).
 *
 * This is where the bulky, infrequent controls live — extensions, userscripts,
 * tab layout, privacy. The overflow menu keeps only what you reach for mid-
 * browse, so it can't outgrow a short window and get clipped.
 */
export function PreferencesPage(props: PreferencesProps) {
  const {
    treeTabs,
    onTreeTabsChange,
    showExtensions,
    showClearData,
    onClearBrowsingData,
  } = props;

  return (
    // Opaque, like the new-tab page: the surface underneath is a white
    // about:blank that would otherwise wash out the gradient in dark mode.
    <div className="absolute inset-0 overflow-auto bg-background bg-gradient-to-b from-background to-muted/30 px-6 py-12 text-foreground">
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <header className="flex items-center gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/20">
            <Settings className="size-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Preferences for this browser, saved on this device.
            </p>
          </div>
        </header>

        <PreferencesSection
          title="Tabs"
          description="How open tabs are laid out in every window."
        >
          <SettingRow
            htmlFor="prefs-vertical-tabs"
            label="Vertical tabs"
            description="Show tabs in a sidebar, nested under the tab that opened them."
          >
            <Switch
              id="prefs-vertical-tabs"
              checked={treeTabs}
              onCheckedChange={onTreeTabsChange}
            />
          </SettingRow>
        </PreferencesSection>

        {showClearData && (
          <PreferencesSection
            title="Privacy"
            description="Your browsing history is encrypted to your Nostr account; cookies and cache stay on this device."
          >
            <SettingRow
              label="Clear browsing data"
              description="Remove saved history, cookies and site data, or the cache."
            >
              <Button variant="secondary" onClick={onClearBrowsingData}>
                Clear data…
              </Button>
            </SettingRow>
          </PreferencesSection>
        )}

        {showExtensions && <ExtensionsSection {...props} />}
      </div>
    </div>
  );
}

/** A titled card grouping related settings. */
function PreferencesSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-6 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

/** One labelled setting: text on the left, its control on the right. */
function SettingRow({
  htmlFor,
  label,
  description,
  children,
}: {
  /** Id of the control, when it's one a `<label>` can point at. */
  htmlFor?: string;
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0 space-y-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="text-sm">
            {label}
          </Label>
        ) : (
          <p className="text-sm font-medium">{label}</p>
        )}
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * Installed Chrome extensions (with per-item uninstall and a Web Store link)
 * plus the userscript library. Refreshes its extension list on mount — the
 * page is a tab, so that's on open and on every reload.
 */
function ExtensionsSection({
  onOpenUrl,
  userscripts,
  onSetUserscriptEnabled,
  onRemoveUserscript,
  onAddUserscript,
}: PreferencesProps) {
  const crx = getCrxBridge();
  const { toast } = useToast();
  const [extensions, setExtensions] = useState<CrxExtension[] | null>(null);

  const refresh = useCallback(async () => {
    if (!crx) return;
    try {
      setExtensions(await crx.listExtensions());
    } catch {
      setExtensions([]);
    }
  }, [crx]);

  useEffect(() => {
    // refresh() only setState()s after an await (an async IPC round-trip), so
    // this can't cascade synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  const uninstall = async (extension: CrxExtension) => {
    if (!crx) return;
    try {
      await crx.uninstallExtension(extension.id);
      toast({ title: `${extension.name} removed` });
      refresh();
    } catch {
      toast({
        title: `Couldn't remove ${extension.name}`,
        variant: 'destructive',
      });
    }
  };

  return (
    <PreferencesSection
      title="Extensions"
      description="Extensions run on the sites you browse in this app."
    >
      {crx &&
        (extensions === null ? null : extensions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No extensions installed yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {extensions.map((extension) => (
              <li
                key={extension.id}
                className="flex items-center gap-3 rounded-md px-1 py-1.5"
              >
                <ExtensionIcon id={extension.id} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{extension.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {extension.version}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${extension.name}`}
                  title={`Remove ${extension.name}`}
                  onClick={() => uninstall(extension)}
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-md text-foreground/60',
                    'hover:bg-destructive/10 hover:text-destructive',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ))}

      {crx && (
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => onOpenUrl(WEB_STORE_URL)}
        >
          Browse the Chrome Web Store
        </Button>
      )}

      {userscripts !== null && (
        <UserscriptsSection
          scripts={userscripts}
          onSetEnabled={onSetUserscriptEnabled}
          onRemove={onRemoveUserscript}
          onAdd={onAddUserscript}
        />
      )}
    </PreferencesSection>
  );
}

/** Extension icon via the crx:// protocol, with a glyph fallback. */
function ExtensionIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary">
        <Puzzle className="size-4 text-muted-foreground" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={crxIconUrl(id, 32)}
      alt=""
      aria-hidden
      className="size-7 shrink-0 rounded-md"
      onError={() => setFailed(true)}
    />
  );
}
