import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, MoreHorizontal, Puzzle, RotateCw, Settings, Share, Store, Trash2, X } from 'lucide-react';
import { crxIconUrl, getCrxBridge, type CrxExtension } from '@/lib/crx';
import { EXTENSIONS_URL } from '@/lib/internalPages';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { CRX_EXTENSIONS_KEY, useCrxExtensions } from '@/hooks/useThemePackages';
import { PublishThemePackage, type PublishTarget } from '@/components/desktop/apps/PublishThemePackage';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Userscript } from '@/lib/userscripts';
import { getAdblockBridge } from '@/lib/adblock';
import { useAdblockSettings } from '@/hooks/useAdblock';
import { getPopupsBridge } from '@/lib/popups';
import { usePopupSettings } from '@/hooks/usePopups';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
  /** Open a URL in a new tab (the Chrome Web Store link, about:extensions). */
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

        {showExtensions && <ExtensionsSection {...props} />}
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

/** What each source of an extension is called on its row. */
const SOURCE_LABEL: Partial<Record<CrxExtension['source'], string>> = { local: 'Folder', nostr: 'Nostr' };

/**
 * Installed Chrome extensions, from the Web Store, a folder, or Nostr: each
 * can be reloaded, published to Nostr or removed, from its ⋯ menu or by
 * right-clicking it. Below them, ways to get more, and the userscript
 * library.
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
  const { pickFile } = useFilePicker();
  const queryClient = useQueryClient();
  const { data: extensions } = useCrxExtensions();
  const [publishing, setPublishing] = useState<PublishTarget | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: CRX_EXTENSIONS_KEY });

  const uninstall = async (extension: CrxExtension) => {
    if (!crx) return;
    try {
      await crx.uninstallExtension(extension.id);
      toast({ title: `${extension.name} removed` });
    } catch {
      toast({
        title: `Couldn't remove ${extension.name}`,
        variant: 'destructive',
      });
    }
    refresh();
  };

  const reload = async (extension: CrxExtension) => {
    if (!crx) return;
    try {
      await crx.reloadExtension(extension.id);
      toast({ title: `${extension.name} reloaded` });
    } catch (error) {
      toast({ title: `Couldn't reload ${extension.name}`, description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const loadFolder = async () => {
    if (!crx) return;
    const folder = await pickFile({ title: 'Load an extension from a folder', confirmLabel: 'Load', directory: true }).catch(() => null);
    if (!folder) return;
    try {
      const extension = await crx.loadUnpacked(folder);
      toast({ title: `${extension.name} loaded` });
    } catch (error) {
      toast({ title: 'Couldn’t load that extension', description: cleanError(error), variant: 'destructive' });
    }
    refresh();
  };

  const actions = (extension: CrxExtension): ExtensionAction[] => [
    ...(extension.source === 'local'
      ? [{ label: 'Reload', icon: <RotateCw />, run: () => void reload(extension) }]
      : []),
    {
      label: 'Publish to Nostr…',
      icon: <Share />,
      run: () => setPublishing({ type: 'extension', id: extension.id, name: extension.name, summary: extension.description }),
    },
    { label: 'Remove', icon: <Trash2 />, run: () => void uninstall(extension), destructive: true },
  ];

  return (
    <PreferencesSection
      title="Extensions"
      description="Extensions run on the sites you browse in this app."
    >
      {crx &&
        (extensions == null ? null : extensions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No extensions installed yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {extensions.map((extension) => (
              <ContextMenu key={extension.id}>
                <ContextMenuTrigger asChild>
                  <li
                    className="flex items-center gap-3 rounded-md px-1 py-1.5"
                  >
                    <ExtensionIcon id={extension.id} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm">
                        <span className="truncate">{extension.name}</span>
                        {SOURCE_LABEL[extension.source] && (
                          <Badge variant="secondary" className="shrink-0">{SOURCE_LABEL[extension.source]}</Badge>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" title={extension.path}>
                        {extension.path ? `${extension.version} · ${extension.path}` : extension.version}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0"
                          aria-label={`More for ${extension.name}`}
                          title="More"
                        >
                          <MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        {actions(extension).map((action) => (
                          <ExtensionMenuItem key={action.label} action={action} kind="dropdown" />
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52">
                  {actions(extension).map((action) => (
                    <ExtensionMenuItem key={action.label} action={action} kind="context" />
                  ))}
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </ul>
        ))}

      {crx && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Button variant="secondary" onClick={() => void loadFolder()}>
            <FolderOpen aria-hidden />
            Load from folder…
          </Button>
          <Button variant="secondary" onClick={() => onOpenUrl(EXTENSIONS_URL)}>
            <Puzzle aria-hidden />
            Browse on Nostr
          </Button>
          <Button variant="secondary" onClick={() => onOpenUrl(WEB_STORE_URL)}>
            <Store aria-hidden />
            Chrome Web Store
          </Button>
        </div>
      )}

      {userscripts !== null && (
        <UserscriptsSection
          scripts={userscripts}
          onSetEnabled={onSetUserscriptEnabled}
          onRemove={onRemoveUserscript}
          onAdd={onAddUserscript}
        />
      )}

      <PublishThemePackage
        target={publishing}
        onClose={() => setPublishing(null)}
        onView={{ label: 'View in Extensions', open: (naddr) => onOpenUrl(`nostr:${naddr}`) }}
      />
    </PreferencesSection>
  );
}

interface ExtensionAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  destructive?: boolean;
}

/** One of an extension's actions, in its ⋯ menu or its right-click menu, with a line above Remove. */
function ExtensionMenuItem({ action, kind }: { action: ExtensionAction; kind: 'dropdown' | 'context' }) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {action.destructive && <Separator />}
      <Item variant={action.destructive ? 'destructive' : 'default'} onSelect={action.run}>
        {action.icon}
        {action.label}
      </Item>
    </>
  );
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
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
