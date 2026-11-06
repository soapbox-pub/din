import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { getAdblockBridge } from '@/lib/adblock';
import { useAdblockSettings } from '@/hooks/useAdblock';
import { getPopupsBridge } from '@/lib/popups';
import { usePopupSettings } from '@/hooks/usePopups';
import { useBookmarksBarShown } from '@/hooks/useBrowserBookmarks';
import { PillButton, ToolButton } from '@/shared/appChrome';
import { SettingsSubHeading } from '@/shared/settingsSection';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { settingsGroup } from '@/shared/settingsChromeStyles';

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
  /** Open about:bookmarks. */
  onOpenBookmarks: () => void;
  /** Import a bookmarks.html file, or export every bookmark to one. */
  onImportBookmarks: () => void;
  onExportBookmarks: () => void;
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
    onOpenBookmarks,
    onImportBookmarks,
    onExportBookmarks,
  } = props;
  const [barShown, setBarShown] = useBookmarksBarShown();

  return (
    // Opaque: the surface underneath is a white about:blank.
    <div className="absolute inset-0 overflow-auto bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 [&>*]:shrink-0">
        <header className="px-1">
          <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold tracking-tight">Browser Settings</h1>
          <p className="text-sm text-muted-foreground">Preferences for the Web Browser, saved on this device.</p>
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

        <PreferencesSection
          title="Bookmarks"
          description="Saved on this device. Bring them from another browser, or take them to one, as a bookmarks.html file."
        >
          <SettingRow
            htmlFor="prefs-bookmarks-bar"
            label="Always show bookmarks bar"
            description="Show it under every page, not only on new tabs (Ctrl+Shift+B)."
          >
            <Switch id="prefs-bookmarks-bar" checked={barShown} onCheckedChange={setBarShown} />
          </SettingRow>
          <div className="flex flex-wrap gap-2 px-4 py-3">
            <PillButton size="sm" onClick={onOpenBookmarks}>
              Manage Bookmarks
            </PillButton>
            <PillButton size="sm" onClick={onImportBookmarks}>
              Import…
            </PillButton>
            <PillButton size="sm" onClick={onExportBookmarks}>
              Export…
            </PillButton>
          </div>
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
              <PillButton size="sm" onClick={onClearBrowsingData}>
                Clear Data…
              </PillButton>
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
      after={
        settings.allowlist.length > 0 && (
          <>
            <p className="px-1 text-xs font-semibold text-muted-foreground">Allowed on these sites</p>
            <ul className={settingsGroup}>
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
          </>
        )
      }
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
        <div className="flex items-center justify-between gap-4 py-1.5 pr-2 pl-4">
          <span className="min-w-0 truncate text-sm">{site}</span>
          <ToolButton size="sm" label={ariaLabel} title={action} onClick={onRemove}>
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </ToolButton>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onRemove}>{action}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A titled group of settings: its heading and what it's for, then its rows parted by inset hairlines. */
function PreferencesSection({
  title,
  description,
  after,
  children,
}: {
  title: string;
  description?: string;
  /** Below the rows, outside their group (a list of sites). */
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 [&>*]:shrink-0">
      <div className="px-1">
        <SettingsSubHeading className="mt-0 px-0">{title}</SettingsSubHeading>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className={settingsGroup}>{children}</div>
      {after}
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
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className="cursor-pointer text-sm">
            {label}
          </Label>
        ) : (
          <p className="text-sm">{label}</p>
        )}
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
