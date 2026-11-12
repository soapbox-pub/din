import { useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { getAdblockBridge } from '@/lib/adblock';
import { useAdblockSettings } from '@/hooks/useAdblock';
import { getPopupsBridge } from '@/lib/popups';
import { usePopupSettings } from '@/hooks/usePopups';
import {
  choiceOf,
  describeChoice,
  formatSpent,
  getSiteLimitsBridge,
  LIMIT_CHOICES,
  limitOfChoice,
  type LimitChoice,
  type SiteLimit,
} from '@/lib/siteLimits';
import { useSiteLimitSettings } from '@/hooks/useSiteLimits';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

        <SiteLimitsSection />

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

/**
 * Sites the user limited for their own sake (electron/site-limits.mts): each
 * with its limit and its time today, changed or lifted here as from the site's
 * info in the address bar, and a field to limit one without visiting it.
 */
function SiteLimitsSection() {
  const bridge = getSiteLimitsBridge();
  const settings = useSiteLimitSettings();
  const [site, setSite] = useState('');
  const [choice, setChoice] = useState<LimitChoice>('pause');
  const [error, setError] = useState<string | null>(null);
  if (!bridge || !settings) return null;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const limit = limitOfChoice(choice);
    if (!site.trim() || !limit) return;
    bridge.set(site.trim(), limit).then(
      () => {
        setSite('');
        setError(null);
      },
      () => setError('Enter a website’s address, like reddit.com.'),
    );
  };

  return (
    <PreferencesSection
      title="Site limits"
      description="Keep yourself off sites that eat your time, in every window and installed app. A limit covers the site’s subdomains, and time counts while it’s on screen."
      after={
        settings.limits.length > 0 && (
          <ul className={settingsGroup}>
            {settings.limits.map((limit) => (
              <SiteLimitRow
                key={limit.site}
                limit={limit}
                seconds={settings.usage[limit.site]?.seconds ?? 0}
                onChange={(next) => {
                  bridge.set(limit.site, limitOfChoice(next)).catch(() => {});
                }}
              />
            ))}
          </ul>
        )
      }
    >
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Input
          aria-label="Website to limit"
          aria-invalid={!!error}
          placeholder="reddit.com"
          value={site}
          onChange={(e) => {
            setSite(e.target.value);
            setError(null);
          }}
          className="h-9 min-w-40 flex-1"
        />
        <Select value={choice} onValueChange={(v) => setChoice(v as LimitChoice)}>
          <SelectTrigger aria-label="Limit" size="sm" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMIT_CHOICES.filter((c) => c !== 'none').map((c) => (
              <SelectItem key={c} value={c}>
                {describeChoice(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <PillButton size="sm" type="submit" disabled={!site.trim()}>
          Add
        </PillButton>
        {error && <p className="w-full text-xs text-destructive">{error}</p>}
      </form>
    </PreferencesSection>
  );
}

/** A limited site: its limit (to change), its time today, and a way (and right-click item) to lift it. */
function SiteLimitRow({
  limit,
  seconds,
  onChange,
}: {
  limit: SiteLimit;
  seconds: number;
  onChange: (choice: string) => void;
}) {
  const current = choiceOf(limit);
  const choices = LIMIT_CHOICES.includes(current) ? LIMIT_CHOICES : [...LIMIT_CHOICES, current];
  const id = `site-limit-${limit.site}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li className="flex items-center gap-4 py-1.5 pr-2 pl-4">
          <div className="min-w-0 flex-1">
            <label htmlFor={id} className="block truncate text-sm">{limit.site}</label>
            <p className="truncate text-xs text-muted-foreground">{formatSpent(seconds)} today</p>
          </div>
          <Select value={current} onValueChange={onChange}>
            <SelectTrigger id={id} size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((c) => (
                <SelectItem key={c} value={c}>
                  {describeChoice(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToolButton size="sm" label={`Remove the limit on ${limit.site}`} title="Remove limit" onClick={() => onChange('none')}>
            <X className="size-4" strokeWidth={1.75} aria-hidden />
          </ToolButton>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={() => onChange('none')}>Remove limit</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
