import type { ReactNode } from 'react';
import { Settings, X } from 'lucide-react';
import { getAdblockBridge } from '@/lib/adblock';
import { useAdblockSettings } from '@/hooks/useAdblock';
import { getPopupsBridge } from '@/lib/popups';
import { usePopupSettings } from '@/hooks/usePopups';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

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
  /** Whether to offer "Clear browsing data" (hidden in private windows). */
  showClearData: boolean;
  onClearBrowsingData: () => void;
}

/**
 * The browser's settings page, rendered over a blank tab's surface when the
 * tab's URL is `about:preferences` (see `src/lib/internalPages.ts`).
 *
 * This is where the bulky, infrequent controls live — tab layout, ad and
 * pop-up blocking, privacy; extensions and userscripts are on
 * about:extensions. The overflow menu keeps only what you reach for
 * mid-browse, so it can't outgrow a short window and get clipped.
 */
export function PreferencesPage(props: PreferencesProps) {
  const {
    treeTabs,
    onTreeTabsChange,
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

        <AdblockSection />

        <PopupsSection />

        {showClearData && (
          <PreferencesSection
            title="Privacy"
            description="Your browsing history, cookies and cache stay on this device."
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
      </div>
    </div>
  );
}

/**
 * The built-in ad blocker: on/off for every site, and the sites the user
 * turned it off for from the toolbar's shield. Absent outside the Electron
 * shell, where nothing blocks.
 */
function AdblockSection() {
  const bridge = getAdblockBridge();
  const settings = useAdblockSettings();
  if (!bridge || !settings) return null;

  return (
    <PreferencesSection
      title="Ad blocker"
      description="Blocks ads and trackers with EasyList, EasyPrivacy, and uBlock Origin's filters, updated every few days."
    >
      <SettingRow
        htmlFor="prefs-adblock"
        label="Block ads and trackers"
        description="Applies to every window, private ones included."
      >
        <Switch
          id="prefs-adblock"
          checked={settings.enabled}
          onCheckedChange={(enabled) => {
            bridge.setEnabled(enabled).catch(() => {});
          }}
        />
      </SettingRow>
      {settings.allowlist.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Allowed on these sites</p>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {[...settings.allowlist].sort().map((site) => (
              <AllowlistRow
                key={site}
                site={site}
                ariaLabel={`Block ads on ${site} again`}
                action="Block ads here again"
                onRemove={() => {
                  bridge.setSiteAllowed(site, false).catch(() => {});
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </PreferencesSection>
  );
}

/**
 * The sites allowed to open pop-ups without a click, from the toolbar's
 * blocked pop-up button. Absent until there's one, and outside the Electron
 * shell.
 */
function PopupsSection() {
  const bridge = getPopupsBridge();
  const settings = usePopupSettings();
  if (!bridge || !settings || settings.allowlist.length === 0) return null;

  return (
    <PreferencesSection
      title="Pop-ups"
      description="Sites need a click to open a new window, except these."
    >
      <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
        {[...settings.allowlist].sort().map((site) => (
          <AllowlistRow
            key={site}
            site={site}
            ariaLabel={`Block pop-ups on ${site} again`}
            action="Block pop-ups here again"
            onRemove={() => {
              bridge.setSiteAllowed(site, false).catch(() => {});
            }}
          />
        ))}
      </ul>
    </PreferencesSection>
  );
}

/** A site on an allowlist, with a button (and right-click item) to take it off. */
function AllowlistRow({
  site,
  ariaLabel,
  action,
  onRemove,
}: {
  site: string;
  ariaLabel: string;
  action: string;
  onRemove: () => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center justify-between gap-4 px-3 py-2">
          <span className="min-w-0 truncate text-sm">{site}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            aria-label={ariaLabel}
            title={action}
            onClick={onRemove}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onRemove}>{action}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  children: ReactNode;
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
  children: ReactNode;
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
