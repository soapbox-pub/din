import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Bookmark as BookmarkGlyph,
  Library,
  Puzzle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileCode,
  FolderOpen,
  Globe,
  History,
  MonitorDown,
  Plus,
  Printer,
  RotateCw,
  Search,
  Settings,
  ShieldAlert,
  SquarePlus,
  Trash2,
  VenetianMask,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolButtonClass, toolIcon } from '@/shared/appChromeStyles';
import { PillButton, StatusPill, ToolButton } from '@/shared/appChrome';
import { getTorBridge, isOnionUrl, torState, type TorStatus } from '@/lib/tor';
import { useTorStatus } from '@/hooks/useTor';
import { useSiteLocations } from '@/hooks/useSiteLocations';
import { NsiteIcon } from '@/components/icons/NsiteIcon';
import { OnionIcon } from '@/components/icons/OnionIcon';
import {
  resolveNavigation,
  sanitizeImageUrl,
  sanitizeUrl,
  viewSourceUrl,
} from '@/lib/sanitizeUrl';
import { canonicalHostOfUrl, nsiteAppId, nsiteAppUrl } from '@/lib/nsiteApps';
import { getNsiteStore } from '@/lib/nsiteStore';
import { ensureNsiteAppInfo } from '@/lib/nsiteAppInfo';
import { pickBestIcon, type IconCandidate } from '@/lib/appIcon';
import {
  internalPageTitle,
  isInternalUrl,
  EXTENSIONS_URL,
  extensionAddressOf,
  PREFERENCES_URL,
  BOOKMARKS_URL,
} from '@/lib/internalPages';
import { addBookmark, bookmarksOfUrl, getBookmarks, isBookmarkableUrl } from '@/lib/browserBookmarks';
import { useBookmarkFiles, useBookmarksBarShown } from '@/hooks/useBrowserBookmarks';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { BookmarkStarButton, BookmarksBar } from '@/components/desktop/apps/BrowserBookmarks';
import type { BookmarkOpeners } from '@/components/desktop/apps/bookmarkMenus';
import { BookmarksPage, type BookmarksPageProps } from '@/components/desktop/apps/BookmarksPage';
import { getCrxBridge, isAllowedTabUrl } from '@/lib/crx';
import { getUserscriptsBridge, isUserscriptUrl } from '@/lib/userscripts';
import { getDevtoolsBridge } from '@/lib/devtools';
import { getMonitorsBridge } from '@/lib/monitors';
import { findGuest } from '@/platform/guest';
import {
  getBrowserBridge,
  type BrowserBridge,
  type CertificateErrorInfo,
  type DownloadInfo,
  type FindResult,
} from '@/lib/browser';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { consumeTabCommands, consumeBrowserHotkeys } from '@/lib/browserTabBus';
import { consumeInspectorDock } from '@/lib/inspectorBus';
import { onFullscreenMonitor } from '@/lib/pageFullscreen';
import { isWebviewAvailable } from '@/lib/isElectron';
import type { AppComponentProps } from '@/lib/apps';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowAccent } from '@/contexts/WindowAccentContext';
import { useWindowChrome } from '@/contexts/WindowChromeContext';
import { normalizeThemeColor, themeColorTokens, untintedSource, untintedTokens } from '@/lib/themeColor';
import { useToast } from '@/hooks/useToast';
import { useNsiteIcon } from '@/hooks/useNsiteIcon';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { moveItem, useDragReorder } from '@/hooks/useDragReorder';
import { useTabTransfer, type TabTransfer, type TabTransferOptions } from '@/hooks/useTabTransfer';
import { parkedTab } from '@/lib/tabTransfer';
import { parentPath } from '@/lib/fs';
import { appForFile } from '@/lib/fileTypes';
import { isProgram } from '@/lib/nativeApps';
import {
  claimBrowserSession,
  forgetBrowserWindow,
  restoredBrowserWindow,
  restoredWindowParam,
  saveBrowserWindow,
  type SavedWindow,
} from '@/lib/browserSession';
import { saveWindowState, wasRestored, windowStateOf } from '@/lib/windowSession';
import { TabContextMenu } from '@/shared/TabContextMenu';
import {
  newTabButtonClass,
  tabClass,
  tabCloseClass,
  tabContentClass,
  tabIconClass,
  tabListClass,
  tabRaisedClass,
  tabTitleClass,
} from '@/shared/tabStyles';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { BarsStaggeredIcon } from '@/components/icons/BarsStaggeredIcon';
import {
  completionSources,
  historyDestination,
  historyDisplayUrl,
  inlineCompletion,
  isSuggestedSite,
  matchHistory,
  topSites,
  useBrowserHistory,
  type TopSite,
  type BrowserHistoryEntry,
} from '@/hooks/useBrowserHistory';
import {
  BrowserView,
  WEBBROWSER_PRIVATE_PARTITION,
  WEBBROWSER_TOR_PARTITION,
  type BrowserViewHandle,
  type LoadErrorInfo,
} from '@/components/desktop/apps/BrowserView';
import { DevToolsPane } from '@/components/desktop/apps/DevToolsPane';
import { AdblockButton } from '@/components/desktop/apps/AdblockButton';
import { PopupBlockedButton } from '@/components/desktop/apps/PopupBlockedButton';
import { SignerSiteButton } from '@/components/desktop/apps/SignerSiteButton';
import { PasswordsSiteButton } from '@/components/desktop/apps/PasswordsSiteButton';
import { SiteInfoButton } from '@/components/desktop/apps/SiteInfoButton';
import { useUserscripts } from '@/hooks/useUserscripts';
import { USERSCRIPT_INSTALL_APP_ID, userscriptInstallParams } from '@/lib/webPopup';
import {
  PreferencesPage,
  type PreferencesProps,
} from '@/components/desktop/apps/PreferencesPage';
import {
  InspectorToolbar,
  type DockMode,
} from '@/components/desktop/apps/InspectorToolbar';
import { NostrPage } from '@/components/desktop/apps/NostrPage';
import { ExtensionsPage, type ExtensionsPageProps } from '@/components/desktop/apps/ExtensionsPage';
import { isExtensionCatalogLoaded, loadExtensionCatalog, subscribeExtensionCatalog } from '@/lib/extensionCatalog';
import { isNostrUri, type NostrHandler } from '@/lib/nostrUri';
import { findDevicePreset, type DevicePreset } from '@/lib/devicePresets';
import { cleanPrintingError, printPage } from '@/lib/printing';

const HOME_URL = 'https://en.wikipedia.org/wiki/Main_Page';

/**
 * Chrome tint for private ("incognito") windows: a fixed dark indigo used for
 * the toolbar and window accent regardless of the page's own theme color, so a
 * private window always reads as private (a browser keeps incognito chrome
 * dark no matter the site). Fed through the same theme-color pipeline as a
 * page's reported color.
 */
const PRIVATE_CHROME_COLOR = '#2a2540';

/**
 * A blank new tab. The underlying surface loads about:blank (a real,
 * loadable page - unlike chrome://newtab, which is Chrome-internal and
 * won't load in an Electron <webview> or the iframe fallback); the custom
 * NewTabPage React component is rendered over it, and the address bar starts
 * empty and focused so the user can just type. Not treated as a "real" URL
 * anywhere - the address bar shows nothing for it and navigate events for it
 * are coerced back to empty (see onTabEvent / createTab).
 */
const NEW_TAB_URL = 'about:blank';

/**
 * What a tab's surface should actually load for a given tab URL. Internal
 * pages (about:preferences) are React overlays with nothing behind them, so
 * their surface parks on about:blank — which also stops whatever page the tab
 * was showing, rather than leaving it running, invisible, under the overlay.
 */
function surfaceUrl(url: string): string {
  return isInternalUrl(url) ? NEW_TAB_URL : url;
}

/** Devtools pane sizing (px): default, minimum, and minimum page size. */
const DEVTOOLS_DEFAULT_HEIGHT = 288;
const DEVTOOLS_DEFAULT_WIDTH = 400;
const DEVTOOLS_MIN_SIZE = 120;
const PAGE_MIN_SIZE = 96;

/** Page zoom steps for Ctrl+= / Ctrl+- (Chrome's). */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

/** How many closed tabs Ctrl+Shift+T can bring back, per window. */
const CLOSED_TABS_LIMIT = 25;

let nextTabId = 0;
const newTabId = () => `tab-${nextTabId++}`;
/** Where a tab falls in opening order, from its id. */
const tabSeq = (id: string) => Number(id.slice('tab-'.length));

/** One browser tab: UI state plus its rendering surface's identity. */
interface Tab {
  id: string;
  /**
   * The tab that opened this one (target=_blank, window.open,
   * chrome.tabs.create), or null for a top-level tab. Drives the tree-tabs
   * sidebar; harmless (unused) in the horizontal strip.
   */
  parentId: string | null;
  /** URL the surface was mounted with (fixed for the surface's lifetime). */
  initialSrc: string;
  /**
   * Whether the surface runs in Tor's session (WEBBROWSER_TOR_PARTITION):
   * the tab is on an onion site. Going to or from one mounts a new surface.
   */
  tor: boolean;
  /** Address bar text (user-editable). */
  address: string;
  /** Last committed URL. */
  url: string;
  title: string | null;
  favicon: string | null;
  /** Page-reported `<meta name="theme-color">` (raw; webview mode only). */
  themeColor: string | null;
  loading: boolean;
  /** The <webview> guest's WebContents id (null in the iframe fallback). */
  wcId: number | null;
  canBack: boolean;
  canForward: boolean;
  /** Manual history for the iframe fallback (webview keeps its own). */
  history: string[];
  cursor: number;
  /** chrome.tabs.create request to answer once the guest attaches. */
  pendingRequestId: number | null;
  /** Where the tab's inspector is docked (webview mode only). */
  dock: DockMode;
  /** Id of the undocked devtools window, when dock === 'window'. */
  undockedWindowId: string | null;
  /** Selected device-emulation preset id, or null when not emulating. */
  deviceId: string | null;
  /** Page zoom (Ctrl+= / Ctrl+- / Ctrl+0); 1 is 100%. */
  zoom: number;
  /** Pinned tabs sit, icon-only, before all the others and have no close button. */
  pinned: boolean;
  /**
   * A restored tab that hasn't been looked at yet: it has no surface, so
   * reopening the browser doesn't load every page at once. Cleared when the
   * tab is first selected.
   */
  dormant: boolean;
}

function createTab(
  url: string,
  pendingRequestId: number | null = null,
  parentId: string | null = null,
  tor = isOnionUrl(url),
): Tab {
  // A blank new tab shows an empty address bar (ready to type), even though
  // its surface loads about:blank.
  const blank = url === NEW_TAB_URL;
  // An internal page (about:preferences) is chrome UI painted over a parked
  // surface, so the tab keeps the internal URL while the surface loads blank.
  const internal = isInternalUrl(url);
  return {
    id: newTabId(),
    parentId,
    initialSrc: blank || internal ? NEW_TAB_URL : url,
    tor,
    address: blank ? '' : url,
    url: blank ? '' : url,
    title: null,
    favicon: null,
    themeColor: null,
    loading: false,
    wcId: null,
    canBack: false,
    canForward: false,
    history: [url],
    cursor: 0,
    pendingRequestId,
    dock: 'closed',
    undockedWindowId: null,
    deviceId: null,
    zoom: 1,
    pinned: false,
    dormant: false,
  };
}

/** Pinned tabs first, otherwise in the same order. */
function pinnedFirst(tabs: Tab[]): Tab[] {
  const firstUnpinned = tabs.findIndex((t) => !t.pinned);
  if (firstUnpinned === -1 || !tabs.slice(firstUnpinned).some((t) => t.pinned)) return tabs;
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** Rebuild a window's tabs from its saved session. Only the selected one loads. */
function restoreTabs(saved: SavedWindow): { tabs: Tab[]; activeId: string } {
  const created = saved.tabs.map((s, i) => ({
    ...createTab(s.url || NEW_TAB_URL),
    title: s.title,
    favicon: s.favicon,
    pinned: s.pinned,
    dormant: i !== saved.active,
  }));
  const tabs = created.map((tab, i) => {
    const parent = saved.tabs[i].parent;
    return { ...tab, parentId: parent !== null ? created[parent]?.id ?? null : null };
  });
  return { tabs: pinnedFirst(tabs), activeId: (tabs[saved.active] ?? tabs[0]).id };
}

/** What a window's tabs look like on disk. Blank tabs aren't worth keeping. */
function saveTabs(tabs: Tab[], activeId: string): SavedWindow {
  const kept = tabs.filter((t) => t.url !== '');
  const index = new Map(kept.map((t, i) => [t.id, i]));
  return {
    tabs: kept.map((t) => ({
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      pinned: t.pinned,
      parent: t.parentId !== null ? index.get(t.parentId) ?? null : null,
    })),
    active: Math.max(0, kept.findIndex((t) => t.id === activeId)),
  };
}

/**
 * What a tab carries to another browser window. Its page loads afresh there:
 * a <webview> can't move between windows without losing its guest.
 */
interface TabTransferPayload {
  url: string;
  title: string | null;
  favicon: string | null;
  themeColor: string | null;
}

function isTabTransferPayload(value: unknown): value is TabTransferPayload {
  return typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string';
}

/** A tab rebuilt from one that moved over from another window. */
function adoptTab(payload: TabTransferPayload): Tab {
  return {
    ...createTab(payload.url || NEW_TAB_URL),
    title: payload.title,
    favicon: payload.favicon,
    themeColor: payload.themeColor,
  };
}

/** Events a tab surface reports up to the browser. */
type TabEvent =
  | { kind: 'loading'; value: boolean }
  | { kind: 'title'; value: string }
  | { kind: 'favicon'; value: string | null }
  | { kind: 'themeColor'; value: string | null }
  | { kind: 'navigate'; url: string; canBack: boolean; canForward: boolean }
  | { kind: 'loadError'; value: LoadErrorInfo }
  | { kind: 'webContentsId'; value: number };

/**
 * A tabbed web browser.
 *
 * Rendering surfaces are abstracted by <BrowserView>: an Electron <webview>
 * when available (loads any site, native history, Chrome extension support)
 * with a sandboxed <iframe> fallback in a plain browser. Only https URLs are
 * user-navigable (see `resolveNavigation`); chrome-extension:// pages are
 * additionally allowed when opened by the extension system.
 *
 * Inside the Electron shell, browser tabs are tracked by the Chrome extension
 * system (electron-chrome-extensions, see electron/main.cjs): the toolbar
 * shows extension actions (<browser-action-list>), an extensions menu manages
 * installs, and extension tab commands arrive via the browserTabBus.
 *
 * Each tab can dock Chrome DevTools below the page (webview mode only):
 * toggled from the toolbar, F12 / Ctrl+Shift+I, or the context menu's
 * "Inspect" - see the devtools bridge (src/lib/devtools.ts).
 */
export function WebBrowser({ windowId, params }: AppComponentProps) {
  // A private ("incognito") window: its tabs render in a non-persistent
  // session (see WEBBROWSER_PRIVATE_PARTITION), nothing is written to browsing
  // history, extensions are hidden, and the chrome is tinted private. Opened
  // via the browser menu's "New private window" (open('web-browser',
  // { private: true })).
  const isPrivate = params?.private === true;
  // Session partition threaded to every tab surface. Normal windows use the
  // BrowserView default (the shared persistent browser session); private
  // windows use the ephemeral private partition.
  const tabPartition = isPrivate ? WEBBROWSER_PRIVATE_PARTITION : undefined;
  // Actions only: subscribing to window state here would re-render the whole
  // browser (tab strip, toolbar, every BrowserView host) on every desktop
  // commit. The one thing that needs window state - reconciling undocked
  // DevTools windows - lives in <UndockedDevToolsReconciler /> below.
  const { close: closeWindow, open: openWindow, focus: focusWindow } =
    useWindowActions();
  const setTitlebar = useWindowTitlebar();
  const [initial] = useState(() => {
    // A window opened for a tab dragged out of another one.
    const adopted = parkedTab(params);
    if (isTabTransferPayload(adopted)) {
      const tab = adoptTab(adopted);
      return { tabs: [tab], activeId: tab.id, otherWindows: [] };
    }
    // Reopening the browser brings back the tabs it had (see browserSession);
    // a window Din reopened on starting again, the tabs it had itself.
    // The other browser windows Din reopened come back on their own.
    const restored = wasRestored(windowId);
    const passed =
      restoredWindowParam(params) ?? (restored ? restoredBrowserWindow(windowStateOf(windowId)) : null);
    const claim = isPrivate
      ? null
      : passed
        ? { window: passed, others: [] }
        : claimBrowserSession(windowId);
    // A window saved with only blank tabs kept none of them (saveTabs).
    if (claim && claim.window.tabs.length > 0) {
      return { ...restoreTabs(claim.window), otherWindows: restored ? [] : claim.others };
    }
    const tab = createTab(NEW_TAB_URL);
    return { tabs: [tab], activeId: tab.id, otherWindows: claim && !restored ? claim.others : [] };
  });
  const [tabs, setTabs] = useState<Tab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  // Tab surfaces render in the order their tabs opened, not in tab order:
  // reordering the tabs would otherwise move their <webview>s around the
  // DOM, and a moved <webview> loses its guest page.
  const surfaceTabs = useMemo(
    () => [...tabs].sort((a, b) => tabSeq(a.id) - tabSeq(b.id)),
    [tabs],
  );
  const views = useRef(new Map<string, BrowserViewHandle>());
  // The address/search input, for Ctrl+L and focusing fresh blank tabs.
  const addressRef = useRef<HTMLInputElement>(null);
  // Mirror of `tabs` for event handlers that need the current list without
  // re-subscribing on every state change.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // Mirror of `activeId` for event handlers that read it without
  // re-subscribing (extension tab commands parent new tabs off the active).
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  // Keep this window's tabs on file so reopening the browser restores them.
  useEffect(() => {
    if (isPrivate) return;
    const saved = saveTabs(tabs, activeId);
    saveBrowserWindow(windowId, saved);
    saveWindowState(windowId, saved);
  }, [isPrivate, windowId, tabs, activeId]);
  useEffect(() => {
    if (!isPrivate) return () => forgetBrowserWindow(windowId);
  }, [isPrivate, windowId]);
  // Din quit with more than one browser window open: the rest come back in
  // windows of their own.
  const restoredOthers = useRef(false);
  useEffect(() => {
    if (restoredOthers.current) return;
    restoredOthers.current = true;
    for (const saved of initial.otherWindows) openWindow('web-browser', { restoreSession: saved });
  }, [initial, openWindow]);
  // A restored tab loads its page the first time it's selected.
  useEffect(() => {
    if (tabsRef.current.some((t) => t.id === activeId && t.dormant)) {
      setTabs((ts) => ts.map((t) => (t.id === activeId ? { ...t, dormant: false } : t)));
    }
  }, [activeId]);
  // Tree-tabs mode: a vertical sidebar of tabs nested by opener, shared
  // across every browser window (a plain browser preference).
  const [treeTabs, setTreeTabs] = useLocalStorage('din:browser:tree-tabs', false);
  // Collapsed subtrees in the tree sidebar (by tab id).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const crx = getCrxBridge();
  // A nostr: link to an extension opens on about:extensions once the catalog
  // on disk says it is one (extensionAddressOf), so read it, and draw again
  // when it's in.
  useSyncExternalStore(subscribeExtensionCatalog, isExtensionCatalogLoaded);
  useEffect(() => {
    if (crx) void loadExtensionCatalog();
  }, [crx]);
  const devtools = getDevtoolsBridge();
  const userscriptsBridge = getUserscriptsBridge();
  // The userscript library: persisted per-device, synced to the injector in
  // the main process. The bridge's absence hides all userscript UI.
  const {
    scripts: userscriptList,
    remove: removeUserscript,
    setEnabled: setUserscriptEnabled,
  } = useUserscripts();
  // Whether the "Clear browsing data" dialog is open (non-private windows).
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const { toast } = useToast();
  const webviewMode = isWebviewAvailable();
  // Persistent browsing history; it and the suggested sites feed address-bar
  // autocomplete.
  const {
    history: browsingHistory,
    suggestions: addressSuggestions,
    recordVisit,
    recordTitle,
    recordFavicon,
    clearHistory,
    removeSuggestions,
  } = useBrowserHistory();
  // The https address each tab was last sent to, and whether the user typed
  // it, until its load commits. A server redirect commits somewhere else
  // (fastmail.com → app.fastmail.com), so the address that was typed is
  // recorded too, or it could never autocomplete.
  const typedUrls = useRef(new Map<string, { url: string; typed: boolean }>());
  // For navigateTab, which resolves a typed site to the address visited (or
  // the suggested site's).
  const historyRef = useRef(addressSuggestions);
  useEffect(() => {
    historyRef.current = addressSuggestions;
  }, [addressSuggestions]);
  // Bookmarks, on this device only. The bar shows under every page when the
  // user asked for it, and on the new-tab page anyway, as Chrome's does.
  const { user } = useCurrentUser();
  const bookmarksOwner = user?.pubkey ?? 'local';
  const [bookmarksBarShown, setBookmarksBarShown] = useBookmarksBarShown();
  const { importFile: importBookmarks, exportFile: exportBookmarks } = useBookmarkFiles();
  // The tab whose star popover is open (Ctrl+D opens it too); switching tabs closes it.
  const [starTab, setStarTab] = useState<string | null>(null);
  const newTabSites = useMemo(
    () => topSites(browsingHistory, NEW_TAB_LINKS, NEW_TAB_SITE_COUNT),
    [browsingHistory],
  );
  // One docked-pane size per browser window, shared across tabs (like desktop
  // browsers): height for bottom docking, width for right docking. Resized by
  // dragging the pane's separator.
  const [devtoolsHeight, setDevtoolsHeight] = useState(DEVTOOLS_DEFAULT_HEIGHT);
  const [devtoolsWidth, setDevtoolsWidth] = useState(DEVTOOLS_DEFAULT_WIDTH);
  // The dock position to restore to when reopening the inspector.
  const lastDock = useRef<Exclude<DockMode, 'closed'>>('bottom');
  // Context-menu "Inspect" coordinates awaiting a tab's devtools to open.
  const pendingInspect = useRef(new Map<string, { x: number; y: number }>());
  // Pages of recently closed tabs, newest last, for Ctrl+Shift+T.
  const closedTabs = useRef<string[]>([]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  useWindowTitle(activeTab.title ?? hostnameOf(activeTab.url) ?? (isPrivate ? 'Private window' : 'New tab'));
  // The onion service the page names, offered while there's a Tor to reach
  // it, and the nsite it names.
  const torStatus = useTorStatus();
  const siteLocations = useSiteLocations(activeTab.wcId);
  const onionLocation = torStatus?.port != null ? siteLocations.onion : null;

  const updateTab = useCallback(
    (id: string, patch: Partial<Tab> | ((tab: Tab) => Partial<Tab>)) => {
      setTabs((ts) =>
        ts.map((t) =>
          t.id === id
            ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) }
            : t,
        ),
      );
    },
    [],
  );

  // Set when a tab is brought to the front (switched to, or opened in the
  // foreground), so it takes keyboard focus once it is visible (see the effect
  // below). Otherwise focus stays in the hidden tab's page.
  const focusOnActivate = useRef(false);

  const openTab = useCallback(
    (
      url: string,
      activate = true,
      pendingRequestId: number | null = null,
      parentId: string | null = null,
      tor?: boolean,
    ) => {
      const tab = createTab(url, pendingRequestId, parentId, tor);
      setTabs((ts) => [...ts, tab]);
      if (activate) {
        focusOnActivate.current = true;
        setActiveId(tab.id);
      }
      return tab.id;
    },
    [],
  );

  /**
   * Pin or unpin a tab. Either way it lands where the pinned tabs meet the
   * rest, like Chrome; a pinned tab leaves the tree it was in.
   */
  const togglePin = useCallback((id: string) => {
    setTabs((ts) => {
      const tab = ts.find((t) => t.id === id);
      if (!tab) return ts;
      const rest = ts.filter((t) => t.id !== id);
      const at = rest.filter((t) => t.pinned).length;
      const moved = { ...tab, pinned: !tab.pinned, parentId: tab.pinned ? tab.parentId : null };
      return [...rest.slice(0, at), moved, ...rest.slice(at)];
    });
  }, []);

  /** Focus (and select) the address bar - Ctrl+L / clicking a blank tab. */
  const focusAddress = useCallback(() => {
    const input = addressRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  /** Switch to a tab the way the user does: its page gets keyboard focus. */
  const selectTab = useCallback((id: string) => {
    if (id === activeIdRef.current) return;
    focusOnActivate.current = true;
    setActiveId(id);
  }, []);

  // Focus the tab just switched to (or sent somewhere typed), after the
  // commit that makes its surface visible (a hidden <webview> can't take
  // focus). A blank tab focuses the address bar instead, ready to type.
  useEffect(() => {
    if (!focusOnActivate.current) return;
    focusOnActivate.current = false;
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    if (tab.url === '') focusAddress();
    else if (!isInternalUrl(tab.url)) views.current.get(tab.id)?.focus();
  }, [activeId, tabs, focusAddress]);

  /**
   * Open a fresh blank tab and drop the cursor in the empty address bar,
   * ready to type (the new-tab button and Ctrl+T). Focus waits a frame for
   * the address bar to reflect the newly-activated tab.
   */
  const openNewTab = useCallback(() => {
    openTab(NEW_TAB_URL);
    requestAnimationFrame(focusAddress);
  }, [openTab, focusAddress]);

  /**
   * Close a tab. `remember` keeps its page for Ctrl+Shift+T (off when the tab
   * is moving to another window rather than going away).
   */
  const closeTab = useCallback(
    (id: string, remember = true) => {
      views.current.delete(id);
      pendingInspect.current.delete(id);
      const ts = tabsRef.current;
      const closed = ts.find((t) => t.id === id);
      if (remember && closed?.url) {
        closedTabs.current.push(closed.url);
        if (closedTabs.current.length > CLOSED_TABS_LIMIT) closedTabs.current.shift();
      }
      // Tear down the tab's inspector side-effects: an undocked devtools
      // window and any active device emulation.
      if (closed?.undockedWindowId) closeWindow(closed.undockedWindowId);
      if (closed?.wcId != null && (closed.deviceId || closed.dock !== 'closed')) {
        devtools?.emulate(closed.wcId, null).catch(() => {});
      }
      const index = ts.findIndex((t) => t.id === id);
      if (index === -1) return;
      const next = ts
        .filter((t) => t.id !== id)
        // Promote the closed tab's children to its parent, so a subtree
        // survives when its root is closed (Firefox-style). No-op in the
        // horizontal strip, which ignores parentId.
        .map((t) => (t.parentId === id ? { ...t, parentId: closed?.parentId ?? null } : t));
      if (next.length === 0) {
        // Closing the last tab closes the browser window.
        closeWindow(windowId);
        return;
      }
      setCollapsed((c) => {
        if (!c.has(id)) return c;
        const copy = new Set(c);
        copy.delete(id);
        return copy;
      });
      // Closing several at once each sees the ones before gone.
      tabsRef.current = next;
      setTabs(next);
      if (id === activeIdRef.current) focusOnActivate.current = true;
      setActiveId((current) =>
        current === id ? next[Math.max(0, index - 1)].id : current,
      );
    },
    [closeWindow, windowId, devtools],
  );

  /** Bring back the most recently closed tab's page (Ctrl+Shift+T). */
  const reopenTab = useCallback(() => {
    const url = closedTabs.current.pop();
    if (url) openTab(url);
  }, [openTab]);

  /** Open a copy of a tab's page just after it. */
  const duplicateTab = useCallback((id: string) => {
    const original = tabsRef.current.find((t) => t.id === id);
    if (!original) return;
    const tab = createTab(original.url || NEW_TAB_URL, null, original.parentId);
    setTabs((ts) => {
      const index = ts.findIndex((t) => t.id === id);
      return pinnedFirst([...ts.slice(0, index + 1), tab, ...ts.slice(index + 1)]);
    });
    focusOnActivate.current = true;
    setActiveId(tab.id);
  }, []);

  // A new-tab tile's right-click menu opens its site in a background tab, or
  // in a window of its own.
  const openTabInBackground = useCallback((url: string) => void openTab(url, false), [openTab]);
  const openInNewWindow = useCallback(
    (url: string) =>
      openWindow('web-browser', {
        restoreSession: { tabs: [{ url, title: null, favicon: null, pinned: false, parent: null }], active: 0 },
      }),
    [openWindow],
  );

  // What a tab's right-click menu offers beyond pinning, moving and closing.
  // Closing the others (or those after it) spares pinned tabs, like Chrome.
  const tabMenu = useMemo<BrowserTabMenu>(
    () => ({
      newTab: openNewTab,
      reopen: reopenTab,
      reload: (id) => views.current.get(id)?.reload(),
      duplicate: duplicateTab,
      closeOthers: (id) =>
        tabsRef.current.filter((t) => t.id !== id && !t.pinned).forEach((t) => closeTab(t.id)),
      closeToRight: (id) => {
        const ts = tabsRef.current;
        ts.slice(ts.findIndex((t) => t.id === id) + 1)
          .filter((t) => !t.pinned)
          .forEach((t) => closeTab(t.id));
      },
    }),
    [openNewTab, reopenTab, duplicateTab, closeTab],
  );

  /** Hand a tab to another window, which loads its page again. */
  const takeTab = useCallback(
    (id: string): TabTransferPayload | undefined => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return undefined;
      closeTab(id, false);
      return { url: tab.url, title: tab.title, favicon: tab.favicon, themeColor: tab.themeColor };
    },
    [closeTab],
  );

  const receiveTab = useCallback((payload: unknown, index: number) => {
    if (!isTabTransferPayload(payload)) return;
    const tab = adoptTab(payload);
    setTabs((ts) => pinnedFirst([...ts.slice(0, index), tab, ...ts.slice(index)]));
    setActiveId(tab.id);
  }, []);

  const windowTitle = activeTab.title ?? hostnameOf(activeTab.url) ?? (isPrivate ? 'Private window' : 'New tab');
  // Tabs move only among windows of the same kind: private tabs stay private.
  const transfer = useMemo<TabTransferOptions>(
    () => ({
      windowId,
      appId: 'web-browser',
      params: isPrivate ? { private: true } : undefined,
      group: isPrivate ? 'web-browser:private' : 'web-browser',
      title: windowTitle,
      take: takeTab,
      receive: receiveTab,
    }),
    [windowId, isPrivate, windowTitle, takeTab, receiveTab],
  );

  // A browser that opens on a blank tab drops the cursor in the address bar so
  // the user can type a destination straight away. Runs once on mount.
  useEffect(() => {
    if (tabsRef.current.find((t) => t.id === activeIdRef.current)?.url === '') focusAddress();
  }, [focusAddress]);

  // Publish the tab strip into the window's title bar so tabs share a line
  // with the window controls (Chrome-style). Cleared on unmount to restore
  // the default title. In tree-tabs mode the tabs live in a body sidebar
  // instead, so the title bar keeps its default (page) title.
  useEffect(() => {
    if (treeTabs) {
      setTitlebar(null);
      return;
    }
    setTitlebar(
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={selectTab}
        onCloseTab={closeTab}
        onTogglePin={togglePin}
        onNewTab={openNewTab}
        onMoveTab={(id, to) => setTabs((ts) => pinnedFirst(moveItem(ts, id, to)))}
        transfer={transfer}
        menu={tabMenu}
      />,
    );
    return () => setTitlebar(null);
  }, [treeTabs, tabs, activeId, selectTab, closeTab, togglePin, openNewTab, transfer, tabMenu, setTitlebar]);

  /** Collapse/expand a subtree in the tree sidebar. */
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((c) => {
      const copy = new Set(c);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }, []);

  /**
   * Drag-and-drop a tree-sidebar tab to a new spot. `position` is relative to
   * the target row: 'before'/'after' make the dragged tab a sibling of the
   * target (adopting its parent) placed just before/after it, while 'inside'
   * nests the dragged tab as the target's first child. The tab's own subtree
   * follows it (descendants track it by parentId). Dropping onto itself or
   * into its own subtree is rejected, so the tree can never form a cycle.
   * Sibling order is driven by array order, so we splice the dragged tab out
   * and reinsert it next to the target.
   */
  const moveTab = useCallback(
    (dragId: string, targetId: string, position: DropZone) => {
      if (dragId === targetId) return;
      setTabs((ts) => {
        const dragged = ts.find((t) => t.id === dragId);
        const target = ts.find((t) => t.id === targetId);
        if (!dragged || !target) return ts;
        // Reject drops into the dragged tab's own subtree (would orphan a
        // cycle). Walk the target's ancestors looking for the dragged tab.
        const byId = new Map(ts.map((t) => [t.id, t]));
        for (
          let cur: Tab | undefined = target;
          cur?.parentId != null;
          cur = byId.get(cur.parentId) ?? undefined
        ) {
          if (cur.parentId === dragId) return ts;
        }
        const newParent = position === 'inside' ? targetId : target.parentId;
        const moved: Tab = { ...dragged, parentId: newParent };
        const without = ts.filter((t) => t.id !== dragId);
        const targetIndex = without.findIndex((t) => t.id === targetId);
        // 'before' lands at the target's index; 'after' and 'inside' (first
        // child) both land immediately past it.
        const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
        return [...without.slice(0, insertAt), moved, ...without.slice(insertAt)];
      });
      // Reveal the child when nesting into a collapsed subtree.
      if (position === 'inside') {
        setCollapsed((c) => {
          if (!c.has(targetId)) return c;
          const copy = new Set(c);
          copy.delete(targetId);
          return copy;
        });
      }
    },
    [],
  );

  /**
   * Drop a tree-sidebar tab on the empty space below the list: back to the
   * top level, at the end. The escape hatch that pulls a tab (with its
   * subtree) out of whatever group it's nested in.
   */
  const moveTabToEnd = useCallback((dragId: string) => {
    setTabs((ts) => {
      const dragged = ts.find((t) => t.id === dragId);
      if (!dragged) return ts;
      return [...ts.filter((t) => t.id !== dragId), { ...dragged, parentId: null }];
    });
  }, []);

  // The color that drives the window/toolbar chrome: a private window is
  // always tinted with the fixed private color (so it stays visibly private
  // whatever the site reports); a normal window follows the active page's
  // theme color, Safari style.
  const chromeColor = isPrivate ? PRIVATE_CHROME_COLOR : activeTab.themeColor;

  // Tint the window chrome with the chrome color, opaque (a page's alpha
  // would make the window frosted, which is for Din's apps). The Window
  // sanitizes it too; null restores the default. A layout effect, so the
  // title bar and the menu bar repaint in the same frame as the toolbar on a
  // tab switch.
  const setAccent = useWindowAccent();
  useLayoutEffect(() => {
    setAccent(normalizeThemeColor(chromeColor));
    return () => setAccent(null);
  }, [chromeColor, setAccent]);

  /** Register/unregister a tab surface's imperative handle. */
  const registerView = useCallback((id: string, handle: BrowserViewHandle | null) => {
    if (handle) views.current.set(id, handle);
    else views.current.delete(id);
  }, []);

  // Untrusted-TLS interstitials, keyed by the offending tab guest's wcId. The
  // main process rejects the load of a self-signed / private-CA host and
  // reports it here (webview mode only; see src/lib/browser.ts).
  const browserBridge = useMemo(() => getBrowserBridge(), []);

  // As the address bar's text changes, connect to wherever Enter would go,
  // so the connection is (partly) up by the time it's pressed, as Chrome's
  // omnibox does. Per keystroke, no waiting: typing is about as fast as a
  // TLS handshake. Repeats are cheap: Chromium does nothing for an origin
  // it already has a connection to. Never from a private window, which
  // would leave a trace.
  const predictNavigation = useMemo(() => {
    if (isPrivate || !browserBridge) return undefined;
    return (text: string) => {
      const url = resolveNavigation(historyDestination(historyRef.current, text) ?? text);
      if (url && /^https?:\/\//i.test(url) && !isOnionUrl(url)) browserBridge.preconnect(url);
    };
  }, [isPrivate, browserBridge]);
  const [certErrors, setCertErrors] = useState<Map<number, CertificateErrorInfo>>(
    () => new Map(),
  );
  const clearCertError = useCallback((wcId: number | null) => {
    if (wcId === null) return;
    setCertErrors((prev) => {
      if (!prev.has(wcId)) return prev;
      const next = new Map(prev);
      next.delete(wcId);
      return next;
    });
  }, []);

  // Network-level load failures (DNS, connection refused, timeout, ...), keyed
  // by tab id. Reported by the tab surface's did-fail-load; a branded error
  // page is shown over the surface until the next load starts (see
  // LoadErrorPage). Distinct from certErrors, which are keyed by wcId because
  // they originate in the main process.
  const [loadErrors, setLoadErrors] = useState<Map<string, LoadErrorInfo>>(
    () => new Map(),
  );
  const clearLoadError = useCallback((id: string) => {
    setLoadErrors((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Active/recent downloads for this window's tabs, newest first. Every
  // download is saved to ~/Downloads by the main process; the shelf gives the
  // otherwise-silent save visible feedback plus open / show-in-folder actions.
  const [downloads, setDownloads] = useState<DownloadInfo[]>([]);
  const dismissDownload = useCallback((id: number) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // --- Find-in-page (Ctrl+F) ----------------------------------------------
  // The find bar's state. The query is shared across tabs (Firefox-style);
  // switching tabs re-issues the current query in the newly active tab.
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  // Mirror of findText for handlers that must not re-subscribe per keystroke.
  const findTextRef = useRef('');
  const [findResult, setFindResult] = useState<Pick<
    FindResult,
    'matches' | 'activeMatchOrdinal'
  > | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);

  /** Issue a find query against the active tab (empty text clears it). */
  const queryFind = useCallback(
    (text: string, opts?: { forward?: boolean; findNext?: boolean }) => {
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (tab?.wcId == null || !browserBridge) return;
      browserBridge.findInPage(tab.wcId, text, opts).catch(() => {});
    },
    [browserBridge],
  );

  const changeFindText = useCallback(
    (text: string) => {
      findTextRef.current = text;
      setFindText(text);
      queryFind(text);
    },
    [queryFind],
  );

  /**
   * Open (or re-focus) the find bar - Ctrl+F. Webview mode only. Opens
   * already searching, Chrome-style: pre-filled with the page's current
   * selection when there is one, otherwise re-running any existing query so
   * a re-opened bar never sits stale waiting for Enter.
   */
  const openFind = useCallback(() => {
    if (!webviewMode || !browserBridge) return;
    setFindOpen(true);
    // Wait a frame for the bar to mount, then drop the cursor in.
    requestAnimationFrame(() => {
      const input = findInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    const view = views.current.get(activeIdRef.current);
    const existing = findTextRef.current;
    view
      ?.getSelectionText()
      .then((selection) => {
        const text = selection.trim().slice(0, 200);
        if (text) {
          // Don't clobber anything the user typed while the selection was
          // being fetched.
          if (findTextRef.current !== existing) return;
          changeFindText(text);
        } else if (existing) {
          queryFind(existing);
        }
      })
      .catch(() => {
        if (existing) queryFind(existing);
      });
  }, [webviewMode, browserBridge, queryFind, changeFindText]);

  /** Close the find bar and clear the active tab's highlight. */
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (tab?.wcId != null) browserBridge?.stopFindInPage(tab.wcId).catch(() => {});
  }, [browserBridge]);

  /**
   * Reset the shared find query and hide the bar. Called when the active tab
   * commits a navigation: the matches belonged to the previous page, so a bar
   * left open would sit showing stale results (and re-running the old query
   * against unrelated content). Clearing the query text too means a re-opened
   * bar starts fresh rather than resurrecting the last page's search.
   */
  const resetFind = useCallback(() => {
    if (findTextRef.current) {
      findTextRef.current = '';
      setFindText('');
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
      if (tab?.wcId != null) browserBridge?.stopFindInPage(tab.wcId).catch(() => {});
    }
    setFindResult(null);
    setFindOpen(false);
  }, [browserBridge]);

  // Match counts stream back from the main process; display them when they
  // belong to the active tab.
  useEffect(() => {
    if (!browserBridge) return;
    return browserBridge.onFindResult((result) => {
      const tab = tabsRef.current.find((t) => t.wcId === result.wcId);
      if (!tab || tab.id !== activeIdRef.current) return;
      setFindResult({
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
      });
    });
  }, [browserBridge]);

  // Switching tabs while the bar is open re-issues the query in the new tab
  // (an empty query just clears that tab's highlight).
  useEffect(() => {
    if (!findOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFindResult(null);
    queryFind(findText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const onTabEvent = useCallback(
    (id: string, event: TabEvent) => {
      switch (event.kind) {
        case 'loading':
          updateTab(id, { loading: event.value });
          // A fresh load starting (including a retry) clears any stale
          // load-error page; a genuine failure re-reports via 'loadError'
          // after this, since did-start-loading precedes did-fail-load.
          if (event.value) clearLoadError(id);
          break;
        case 'title': {
          updateTab(id, { title: event.value || null });
          // Join the title onto the history entry for the tab's current URL.
          // Private windows and Tor tabs never touch browsing history.
          const tab = tabsRef.current.find((t) => t.id === id);
          if (!isPrivate && !tab?.tor && tab?.url && event.value) recordTitle(tab.url, event.value);
          break;
        }
        case 'favicon': {
          const tab = tabsRef.current.find((t) => t.id === id);
          // A Tor tab's icon would be fetched by the shell, outside Tor: it
          // keeps its glyph.
          if (tab?.tor) break;
          updateTab(id, { favicon: event.value });
          if (!isPrivate && tab?.url) recordFavicon(tab.url, event.value);
          break;
        }
        case 'themeColor':
          updateTab(id, { themeColor: event.value });
          break;
        case 'navigate':
          updateTab(id, (tab) => {
            // The surface under an internal page is parked at about:blank, and
            // its own commit must not overwrite the URL the chrome navigated
            // to. Any *other* commit does supersede it - that's how going back
            // out of about:preferences lands on the real page again.
            if (event.url === NEW_TAB_URL && isInternalUrl(tab.url)) {
              return { canBack: event.canBack, canForward: event.canForward };
            }
            return {
              url: event.url === NEW_TAB_URL ? '' : event.url,
              address: event.url === NEW_TAB_URL ? '' : event.url,
              canBack: event.canBack,
              canForward: event.canForward,
            };
          });
          // A committed navigation means the load succeeded, so any pending
          // certificate warning for this tab no longer applies (a rejected
          // load never commits). Clear it.
          clearCertError(tabsRef.current.find((t) => t.id === id)?.wcId ?? null);
          // A committed navigation also supersedes any load-error page.
          clearLoadError(id);
          // The new page invalidates the find-in-page results; clear the bar
          // (only when it's the foreground tab navigating - a background tab's
          // redirect shouldn't disturb the search the user is looking at).
          if (id === activeIdRef.current) resetFind();
          // Webview mode sees every committed navigation here (link clicks,
          // redirects, back/forward); recordVisit ignores non-https URLs
          // (about:blank, chrome-extension://). The iframe fallback never
          // fires this event - it records in navigateTab / go instead.
          // Private windows and Tor tabs keep no history.
          if (!isPrivate && !tabsRef.current.find((t) => t.id === id)?.tor) {
            const sent = typedUrls.current.get(id);
            typedUrls.current.delete(id);
            if (sent && sent.url !== event.url) recordVisit(sent.url, sent.typed);
            recordVisit(event.url, sent?.typed);
          }
          break;
        case 'loadError':
          typedUrls.current.delete(id);
          // Ignore the error for a URL the tab has already navigated past
          // (a late did-fail-load for a superseded load); otherwise show it.
          setLoadErrors((prev) => new Map(prev).set(id, event.value));
          updateTab(id, { loading: false });
          break;
        case 'webContentsId': {
          // Answer any pending chrome.tabs.create request now that the
          // guest attached and its WebContents id is known.
          const tab = tabsRef.current.find((t) => t.id === id);
          if (tab?.pendingRequestId != null) {
            crx?.resolveCreateTab(tab.pendingRequestId, event.value);
          }
          updateTab(id, { wcId: event.value, pendingRequestId: null });
          break;
        }
      }
    },
    [updateTab, crx, recordVisit, recordTitle, recordFavicon, clearCertError, clearLoadError, resetFind, isPrivate],
  );

  // Retry a failed load: re-request the failed URL through the tab's surface.
  // did-start-loading then clears the error page; if it fails again,
  // did-fail-load re-reports. loadURL (a fresh navigation) works from the
  // error page, unlike reload().
  const retryLoad = useCallback((id: string) => {
    const info = loadErrors.get(id);
    if (!info) return;
    views.current.get(id)?.loadURL(info.url);
  }, [loadErrors]);

  // Surface untrusted-TLS reports from the main process on the offending tab.
  useEffect(() => {
    if (!browserBridge) return;
    return browserBridge.onCertificateError((info) => {
      setCertErrors((prev) => new Map(prev).set(info.wcId, info));
    });
  }, [browserBridge]);

  // Track downloads started by this window's own tabs (the initiating guest's
  // wcId routes each report to the right browser window). Updates replace the
  // matching entry in place; the newest sit at the front, capped so a long
  // session's shelf can't grow unbounded.
  useEffect(() => {
    if (!browserBridge) return;
    return browserBridge.onDownload((info) => {
      if (!tabsRef.current.some((t) => t.wcId === info.wcId)) return;
      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === info.id);
        if (idx === -1) return [info, ...prev].slice(0, 20);
        const next = prev.slice();
        next[idx] = info;
        return next;
      });
    });
  }, [browserBridge]);

  // Proceed past a certificate warning: pin the cert; the main process then
  // reloads the tab (a browser-initiated navigation - reloading the
  // chrome-error page through the <webview> element is blocked by Blink).
  const trustCertificate = useCallback(
    async (info: CertificateErrorInfo) => {
      if (!browserBridge) return;
      try {
        await browserBridge.trustCertificate(
          info.host,
          info.fingerprint,
          info.wcId,
          info.url,
        );
      } catch {
        return;
      }
      clearCertError(info.wcId);
    },
    [browserBridge, clearCertError],
  );

  // Dismiss a certificate warning without trusting (back off the failed host).
  const dismissCertError = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      clearCertError(tab?.wcId ?? null);
      views.current.get(tabId)?.goBack();
    },
    [clearCertError],
  );

  // Report the active tab to the extension system (drives chrome.tabs'
  // notion of "active" and per-tab extension action state).
  const lastReportedWcId = useRef<number | null>(null);
  useEffect(() => {
    if (!crx) return;
    const wcId = activeTab?.wcId ?? null;
    if (wcId !== null && wcId !== lastReportedWcId.current) {
      lastReportedWcId.current = wcId;
      crx.tabActivated(wcId);
    }
  }, [crx, activeTab?.wcId, activeId]);

  // Consume extension-initiated tab commands (chrome.tabs.*, target=_blank).
  useEffect(() => {
    return consumeTabCommands((command) => {
      switch (command.type) {
        case 'create': {
          const url =
            command.url && isAllowedTabUrl(command.url) ? command.url : HOME_URL;
          // The command carries no opener, but chrome.tabs.create /
          // window.open come from the foreground tab; nest the new tab under
          // it (drives the tree sidebar, ignored by the horizontal strip).
          openTab(url, command.active, command.requestId, activeIdRef.current);
          // A foreground tab request raises the desktop window too -
          // otherwise the new tab opens invisibly while the browser sits
          // buried under other windows (or minimized).
          if (command.active) focusWindow(windowId);
          break;
        }
        case 'open': {
          // A nostr: link's preview is an internal page, but one a page may
          // open: it only shows what the link names.
          if (!isAllowedTabUrl(command.url) && !isNostrUri(command.url)) break;
          const existing = tabsRef.current;
          // When a page spawns the link (middle-click, target=_blank,
          // window.open) the command carries its opener's WebContents id;
          // nest the new tab under that parent so the tree sidebar shows the
          // relationship (ignored by the horizontal strip). Desktop-initiated
          // opens (terminal/desktop link clicks) carry no opener and stay
          // top-level.
          const opener = command.openerWcId != null ? existing.find((t) => t.wcId === command.openerWcId) : undefined;
          const parentId = opener?.id ?? null;
          // What a Tor tab opens stays in Tor, clearnet or not: a page that
          // could open a tab outside it could learn its visitor's address.
          const tor = opener?.tor || isOnionUrl(command.url);
          // Middle-click / Ctrl+Cmd-click and "Open link in new tab" open in
          // the background: spawn the tab but leave the current one focused and
          // don't raise the window. Plain target=_blank / window.open stay in
          // the foreground.
          const background = command.background === true;
          // A fresh browser holds a single blank placeholder tab. Load the
          // link straight into it rather than stacking a new tab on top; only
          // spawn a separate tab once there's real browsing to preserve. (A
          // background open still has to fill the sole blank tab - there's
          // nothing to sit behind.)
          const soloBlank =
            existing.length === 1 &&
            existing[0].initialSrc === NEW_TAB_URL &&
            existing[0].url === '';
          if (soloBlank) {
            const tab = createTab(command.url, null, null, tor);
            setTabs([tab]);
            focusOnActivate.current = true;
            setActiveId(tab.id);
          } else {
            openTab(command.url, !background, null, parentId, tor);
          }
          // A foreground link opened in this window (target=_blank, a desktop
          // link click) must bring it forward - the user clicked expecting to
          // look at the result, not to hunt for the window. Background opens
          // deliberately leave the window where it is.
          if (!background || soloBlank) focusWindow(windowId);
          break;
        }
        case 'select': {
          const tab = tabsRef.current.find((t) => t.wcId === command.wcId);
          if (tab) setActiveId(tab.id);
          break;
        }
        case 'close': {
          const tab = tabsRef.current.find((t) => t.wcId === command.wcId);
          if (tab) closeTab(tab.id);
          break;
        }
      }
    }, (wcId) => tabsRef.current.some((t) => t.wcId === wcId), false, () => onFullscreenMonitor(windowId));
  }, [openTab, closeTab, focusWindow, windowId]);

  /**
   * Move a tab's inspector to a dock position, or close it ('closed').
   * Handles opening/closing the undocked window and detaching the CDP
   * session when the inspector is dismissed. Docked <-> docked transitions
   * keep the same DevToolsPane mounted, so no CDP churn.
   */
  const setDock = useCallback(
    (id: string, mode: DockMode) => {
      if (!devtools) return;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || tab.dock === mode) return;
      if (mode !== 'closed') lastDock.current = mode;

      // Leaving the undocked window: close it.
      if (tab.dock === 'window' && tab.undockedWindowId) {
        closeWindow(tab.undockedWindowId);
      }

      if (mode === 'closed') {
        pendingInspect.current.delete(id);
        // Ask main to close so the target detaches cleanly; the pane unmounts
        // with the state change.
        if (tab.wcId !== null) devtools.close(tab.wcId).catch(() => {});
        updateTab(id, { dock: 'closed', undockedWindowId: null });
        return;
      }

      if (mode === 'window') {
        // Undock into its own desktop window, hosting a DevToolsPane for this
        // tab. Closing the docked pane first detaches cleanly; the window's
        // pane reopens the session against its own host.
        if (tab.wcId !== null) devtools.close(tab.wcId).catch(() => {});
        const winId =
          tab.wcId !== null
            ? openWindow('devtools', { targetWcId: tab.wcId }) ?? null
            : null;
        updateTab(id, { dock: 'window', undockedWindowId: winId });
        return;
      }

      // Docked (bottom / right).
      updateTab(id, { dock: mode, undockedWindowId: null });
    },
    [devtools, updateTab, closeWindow, openWindow],
  );

  /** Toggle a tab's inspector open (to its last dock) / closed. */
  const toggleDevtools = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      setDock(id, tab.dock === 'closed' ? lastDock.current : 'closed');
    },
    [setDock],
  );

  /** A tab's devtools finished opening; run any pending "Inspect" request. */
  const onDevtoolsReady = useCallback(
    (id: string) => {
      if (!devtools) return;
      const pending = pendingInspect.current.get(id);
      if (!pending) return;
      pendingInspect.current.delete(id);
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab?.wcId != null) {
        devtools.inspect(tab.wcId, pending.x, pending.y).catch(() => {});
      }
    },
    [devtools],
  );

  // Consume devtools commands from the main process: toggle shortcuts
  // pressed inside guests (keyboard focus lives there, invisible to the
  // shell), context-menu "Inspect" clicks, and close notifications. Every
  // browser window subscribes; commands carry the tab's WebContents id, so
  // only the owning window acts.
  useEffect(() => {
    if (!devtools) return;
    return devtools.onCommand((command) => {
      const tab = tabsRef.current.find((t) => t.wcId === command.wcId);
      if (!tab) return;
      switch (command.type) {
        case 'toggle':
          toggleDevtools(tab.id);
          break;
        case 'inspect': {
          setActiveId(tab.id);
          // From the tab's top-left, measured now: opening the pane moves it.
          const zoom = getMonitorsBridge()?.zoomFactor() ?? 1;
          const rect = findGuest(command.wcId)?.getBoundingClientRect();
          const at = { x: command.x - (rect?.left ?? 0) * zoom, y: command.y - (rect?.top ?? 0) * zoom };
          if (tab.dock !== 'closed' && tab.wcId !== null) {
            devtools.inspect(tab.wcId, at.x, at.y).catch(() => {});
          } else {
            pendingInspect.current.set(tab.id, at);
            setDock(tab.id, lastDock.current);
          }
          break;
        }
        case 'closed':
          // Devtools closed from the other side (frontend close button, tab
          // died) - or an echo of our own close; either way, reconcile. Not
          // fired for undocked windows (they close via the window manager).
          pendingInspect.current.delete(tab.id);
          if (tab.dock !== 'window') {
            updateTab(tab.id, { dock: 'closed' });
          }
          break;
      }
    });
  }, [devtools, toggleDevtools, setDock, updateTab]);

  /** Apply/clear a tab's device emulation whenever its selection changes. */
  const setDevice = useCallback(
    (id: string, deviceId: string | null) => {
      if (!devtools) return;
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || tab.wcId === null) return;
      updateTab(id, { deviceId });
      const preset = deviceId ? findDevicePreset(deviceId) : null;
      if (preset) {
        devtools
          .emulate(tab.wcId, {
            width: preset.width,
            height: preset.height,
            deviceScaleFactor: preset.deviceScaleFactor,
            mobile: preset.mobile,
            userAgent: preset.userAgent,
          })
          .catch(() => {});
      } else {
        devtools.emulate(tab.wcId, null).catch(() => {});
      }
    },
    [devtools, updateTab],
  );

  // Reconcile when an undocked devtools window is closed from its own title
  // bar: its DevToolsPane unmounts and detaches silently (no 'closed'
  // command), so watch the window manager and reset the tab to 'closed' when
  // its window disappears. Isolated in a null-rendering child so only it
  // subscribes to window state (see the comment on useWindowActions above).
  // (Rendered near the bottom of this component's JSX.)

  // Re-dock requests from an undocked DevTools window (its dock controls live
  // in a separate component tree). Route by the inspected tab's WebContents
  // id, so only the browser window that owns the tab acts.
  useEffect(() => {
    return consumeInspectorDock(({ targetWcId, mode }) => {
      const tab = tabsRef.current.find((t) => t.wcId === targetWcId);
      if (tab) setDock(tab.id, mode);
    });
  }, [setDock]);

  /** Fetch a .user.js file (in main - the shell can't read cross-origin)
   * and open the install review dialog. */
  const promptUserscriptInstall = useCallback(
    (url: string) => {
      if (!userscriptsBridge) return;
      userscriptsBridge
        .fetchText(url)
        .then((code) => openWindow(USERSCRIPT_INSTALL_APP_ID, userscriptInstallParams(code, url)))
        .catch((error: unknown) => {
          toast({
            title: "Couldn't download userscript",
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          });
        });
    },
    [userscriptsBridge, toast, openWindow],
  );

  // *.user.js navigations intercepted by the main process (in-page link
  // clicks, window.open). Every browser window subscribes; only the one
  // owning the navigating tab prompts.
  useEffect(() => {
    if (!userscriptsBridge) return;
    return userscriptsBridge.onInstallRequested(({ url, wcId }) => {
      if (!tabsRef.current.some((t) => t.wcId === wcId)) return;
      promptUserscriptInstall(url);
    });
  }, [userscriptsBridge, promptUserscriptInstall]);


  /** `typed`: the user asked for `raw` in the address bar or new-tab page's search box. */
  const navigateTab = useCallback(
    (id: string, raw: string, typed = false) => {
      const resolved = resolveNavigation(historyDestination(historyRef.current, raw) ?? raw);
      if (!resolved) return;
      // A .user.js address is a script install, not a page visit (mirrors
      // the main process's will-navigate intercept for link clicks).
      if (userscriptsBridge && isUserscriptUrl(resolved)) {
        promptUserscriptInstall(resolved);
        return;
      }
      // Going somewhere typed hands the keyboard to the page, like Chrome,
      // so the scroll keys work on it rather than in the address bar.
      if (typed && id === activeIdRef.current) focusOnActivate.current = true;
      // A surface's session is fixed, so going to or from an onion site
      // mounts a new one in the other session, with a history of its own.
      const tor = isOnionUrl(resolved);
      const moving = tabsRef.current.find((t) => t.id === id)?.tor !== tor;
      updateTab(id, (tab) => {
        const trimmed = tab.history.slice(0, tab.cursor + 1);
        return {
          address: resolved,
          url: resolved,
          title: null,
          favicon: null,
          themeColor: null,
          history: [...trimmed, resolved],
          cursor: trimmed.length,
          ...(moving
            ? { tor, initialSrc: surfaceUrl(resolved), wcId: null, canBack: false, canForward: false }
            : {}),
        };
      });
      if (moving) clearLoadError(id);
      else views.current.get(id)?.loadURL(surfaceUrl(resolved));
      // The iframe fallback emits no navigate events, so record here (never
      // in a private window).
      if (!webviewMode && !isPrivate && !tor) recordVisit(resolved, typed);
      if (webviewMode && resolved.startsWith('https://')) {
        typedUrls.current.set(id, { url: resolved, typed });
      }
      else typedUrls.current.delete(id);
    },
    [updateTab, clearLoadError, webviewMode, recordVisit, userscriptsBridge, promptUserscriptInstall, isPrivate],
  );

  // A page went to or from an onion site, which the main process stopped so
  // the tab can load it in the other session.
  useEffect(() => {
    return getTorBridge()?.onMoveTab(({ wcId, url }) => {
      const tab = tabsRef.current.find((t) => t.wcId === wcId);
      if (tab) navigateTab(tab.id, url);
    });
  }, [navigateTab]);

  const navigate = useCallback(
    (raw: string, typed?: boolean) => navigateTab(activeId, raw, typed),
    [navigateTab, activeId],
  );

  /**
   * Show the settings page, reusing this window's existing preferences tab if
   * it has one — the way every browser treats its settings tab. An empty tab
   * is navigated in place rather than stranded behind a new one.
   */
  const openInternalPage = useCallback((url: string) => {
    const existing = tabsRef.current.find((t) => t.url === url);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const active = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (active && active.url === '') {
      navigateTab(active.id, url);
      return;
    }
    openTab(url);
  }, [navigateTab, openTab]);
  const openPreferences = useCallback(() => openInternalPage(PREFERENCES_URL), [openInternalPage]);
  /** about:extensions, the same way. */
  const openExtensions = useCallback(() => openInternalPage(EXTENSIONS_URL), [openInternalPage]);
  /** about:bookmarks, the same way. */
  const openBookmarks = useCallback(() => openInternalPage(BOOKMARKS_URL), [openInternalPage]);

  /**
   * Bookmark the page in front (onto the bookmarks bar, unless it's
   * bookmarked already) and open the star's popover to name and file it:
   * the star, and Ctrl+D.
   */
  const bookmarkPage = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeIdRef.current);
    if (!tab || !isBookmarkableUrl(tab.url)) return;
    if (!bookmarksOfUrl(getBookmarks(bookmarksOwner), tab.url).length) {
      addBookmark(bookmarksOwner, { url: tab.url, title: tab.title, icon: tab.favicon });
    }
    setStarTab(tab.id);
  }, [bookmarksOwner]);

  // Where bookmarks open: the bookmarks bar and about:bookmarks.
  const bookmarkOpeners = useMemo<BookmarkOpeners>(
    () => ({
      open: (url) => navigateTab(activeIdRef.current, url),
      openInNewTab: (url, background) => void openTab(url, !background, null, activeIdRef.current),
      openInNewWindow: isPrivate ? undefined : openInNewWindow,
    }),
    [navigateTab, openTab, openInNewWindow, isPrivate],
  );
  // What about:bookmarks renders; memoized like `preferences` below.
  const bookmarksPage = useMemo<BookmarksPageProps>(
    () => ({ openers: bookmarkOpeners, onImport: importBookmarks, onExport: exportBookmarks }),
    [bookmarkOpeners, importBookmarks, exportBookmarks],
  );

  /** Move a tab through its history by `delta` (-1 back, +1 forward). */
  const goTab = useCallback(
    (id: string, delta: number) => {
      const view = views.current.get(id);
      if (!view) return;
      if (webviewMode) {
        // The guest owns its history; state syncs via `navigate` events.
        if (delta < 0) view.goBack();
        else view.goForward();
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      const target = tab.cursor + delta;
      if (target < 0 || target >= tab.history.length) return;
      const url = tab.history[target];
      view.loadURL(surfaceUrl(url));
      updateTab(id, { cursor: target, address: url, url, title: null, favicon: null, themeColor: null });
      if (!isPrivate && !tab.tor) recordVisit(url);
    },
    [updateTab, webviewMode, recordVisit, isPrivate],
  );

  const go = useCallback(
    (delta: number) => goTab(activeId, delta),
    [goTab, activeId],
  );

  /** Reload a tab; `force` bypasses the cache (Ctrl+Shift+R / Shift+F5). */
  const reloadTab = useCallback((id: string, force: boolean) => {
    const view = views.current.get(id);
    if (!view) return;
    if (force) view.reloadIgnoringCache();
    else view.reload();
  }, []);

  /**
   * Show a tab's page source in a new tab beside it (Ctrl+U), the way Chrome
   * does. Pages with no source to show (blank tabs, internal and extension
   * pages, a source view itself) are left alone. Webview mode only: the
   * iframe fallback can't load view-source: URLs.
   */
  const viewSource = useCallback(
    (id: string) => {
      if (!webviewMode) return;
      const tab = tabsRef.current.find((t) => t.id === id);
      const url = tab && viewSourceUrl(tab.url);
      if (url) openTab(url, true, null, id);
    },
    [webviewMode, openTab],
  );

  /** Open Din's print dialog for a tab (Ctrl+P with focus in the toolbar). */
  const printTab = useCallback(
    (id: string) => {
      const wcId = tabsRef.current.find((t) => t.id === id)?.wcId;
      if (!webviewMode || wcId == null) return;
      printPage(wcId).catch((error) =>
        toast({ title: 'Couldn’t print', description: cleanPrintingError(error), variant: 'destructive' }),
      );
    },
    [webviewMode, toast],
  );

  /** Activate the next/previous tab (Ctrl+Tab / Ctrl+Shift+Tab), wrapping. */
  const cycleTab = useCallback((backward: boolean) => {
    const ts = tabsRef.current;
    if (ts.length < 2) return;
    const index = ts.findIndex((t) => t.id === activeIdRef.current);
    const next = (index + (backward ? -1 : 1) + ts.length) % ts.length;
    selectTab(ts[next].id);
  }, [selectTab]);

  /** Activate a tab by 1-based position; 9 jumps to the last tab (Chrome). */
  const gotoTabDigit = useCallback((digit: number) => {
    const ts = tabsRef.current;
    const tab = digit === 9 ? ts[ts.length - 1] : ts[digit - 1];
    if (tab) selectTab(tab.id);
  }, [selectTab]);

  /** Step a tab's page zoom in (+1) or out (-1), or reset it (0). */
  const zoomTab = useCallback(
    (id: string, direction: -1 | 0 | 1) => {
      updateTab(id, (tab) => {
        if (direction === 0) return { zoom: 1 };
        const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
        const next = steps.find((z) => (direction > 0 ? z > tab.zoom : z < tab.zoom));
        return { zoom: next ?? tab.zoom };
      });
    },
    [updateTab],
  );

  /**
   * The browser keys that aren't about one tab's page: windows, reopening a
   * closed tab, clearing data. Shared by both hotkey sources below; returns
   * whether it handled the action.
   */
  const runWindowHotkey = useCallback(
    (action: string): boolean => {
      switch (action) {
        case 'reopen-tab':
          reopenTab();
          return true;
        case 'new-window':
          openWindow('web-browser');
          return true;
        case 'new-private-window':
          openWindow('web-browser', { private: true });
          return true;
        case 'close-window':
          closeWindow(windowId);
          return true;
        case 'clear-data':
          if (!isPrivate) setClearDataOpen(true);
          return true;
        case 'bookmark-page':
          bookmarkPage();
          return true;
        case 'bookmarks-bar':
          setBookmarksBarShown(!bookmarksBarShown);
          return true;
        case 'bookmarks':
          openBookmarks();
          return true;
        default:
          return false;
      }
    },
    [reopenTab, openWindow, closeWindow, windowId, isPrivate, bookmarkPage, setBookmarksBarShown, bookmarksBarShown, openBookmarks],
  );

  const canBack = webviewMode ? activeTab.canBack : activeTab.cursor > 0;
  const canForward = webviewMode
    ? activeTab.canForward
    : activeTab.cursor < activeTab.history.length - 1;

  // What about:preferences renders. Memoized because TabSurface is memo()'d
  // and this arrives as one object; a fresh literal each render would defeat
  // that and re-render the settings surface on every keystroke in the
  // address bar.
  const preferences = useMemo<PreferencesProps>(
    () => ({
      treeTabs,
      onTreeTabsChange: setTreeTabs,
      showClearData: !isPrivate,
      onClearBrowsingData: () => setClearDataOpen(true),
      onOpenBookmarks: openBookmarks,
      onImportBookmarks: importBookmarks,
      onExportBookmarks: exportBookmarks,
    }),
    [treeTabs, setTreeTabs, isPrivate, openBookmarks, importBookmarks, exportBookmarks],
  );

  // What about:extensions needs to manage the installed ones, memoized for
  // the same reason.
  const installedExtensions = useMemo<ExtensionsPageProps['installed']>(
    () => ({
      onOpenUrl: (url) => openTab(url),
      userscripts: userscriptsBridge ? userscriptList : null,
      onSetUserscriptEnabled: setUserscriptEnabled,
      onRemoveUserscript: (script) => {
        removeUserscript(script.id);
        toast({ title: `${script.name} removed` });
      },
      onAddUserscript: () => openWindow(USERSCRIPT_INSTALL_APP_ID, userscriptInstallParams('')),
    }),
    [openTab, userscriptsBridge, userscriptList, setUserscriptEnabled, removeUserscript, toast],
  );

  // Tint the toolbar with the active tab's theme color, matching the title
  // bar (the Window tints it from the same value via useWindowAccent). The
  // theme tokens are mapped with `@theme inline`, so overriding them locally
  // re-themes every toolbar control to keep contrast on the arbitrary color.
  const accent = normalizeThemeColor(chromeColor);
  // The same tokens the title bar takes (themeColorTokens), for everything
  // that sits on the tinted window: the toolbar, the bookmarks bar and the
  // tree of tabs, so none of it keeps the theme's text over the page's color.
  const chromeTokens = accent ? (themeColorTokens(accent) as React.CSSProperties) : undefined;
  const toolbarTint = accent ? ({ backgroundColor: accent, ...chromeTokens } as React.CSSProperties) : undefined;

  // F12 / Ctrl+Shift+I while focus is in the shell's chrome (address bar,
  // buttons). The same shortcut inside a page arrives as a `toggle` command
  // from the main process instead (see the devtools.onCommand effect).
  // Ctrl+T / Ctrl+W / Ctrl+L never reach here: the desktop's global handler
  // (DesktopHotkeys) captures them and routes them via the hotkey bus below.
  const onToolbarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!devtools) return;
      const toggle =
        e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i');
      if (!toggle) return;
      e.preventDefault();
      toggleDevtools(activeId);
    },
    [devtools, toggleDevtools, activeId],
  );

  // Browser hotkeys pressed while this window is focused (keyboard focus in
  // the shell DOM): routed here by DesktopHotkeys, scoped by window id.
  useEffect(() => {
    return consumeBrowserHotkeys((hotkey) => {
      if (hotkey.windowId !== windowId) return;
      if (runWindowHotkey(hotkey.action)) return;
      switch (hotkey.action) {
        case 'new-tab':
          openNewTab();
          break;
        case 'close-tab':
          closeTab(activeIdRef.current);
          break;
        case 'focus-address':
          focusAddress();
          break;
        case 'find':
          openFind();
          break;
        case 'view-source':
          viewSource(activeIdRef.current);
          break;
        case 'print':
          printTab(activeIdRef.current);
          break;
        case 'reload':
          reloadTab(activeIdRef.current, false);
          break;
        case 'force-reload':
          reloadTab(activeIdRef.current, true);
          break;
        case 'cycle-tab':
          cycleTab(hotkey.backward === true);
          break;
        case 'goto-tab':
          if (hotkey.digit) gotoTabDigit(hotkey.digit);
          break;
        case 'back':
          goTab(activeIdRef.current, -1);
          break;
        case 'forward':
          goTab(activeIdRef.current, 1);
          break;
        case 'zoom-in':
          zoomTab(activeIdRef.current, 1);
          break;
        case 'zoom-out':
          zoomTab(activeIdRef.current, -1);
          break;
        case 'zoom-reset':
          zoomTab(activeIdRef.current, 0);
          break;
        case 'fullscreen':
          views.current.get(activeIdRef.current)?.toggleFullscreen();
          break;
      }
    });
  }, [
    windowId,
    runWindowHotkey,
    zoomTab,
    openNewTab,
    closeTab,
    focusAddress,
    openFind,
    viewSource,
    printTab,
    reloadTab,
    cycleTab,
    gotoTabDigit,
    goTab,
  ]);

  // The same shortcuts pressed inside a page: forwarded by the main process
  // with the guest's WebContents id (focus lives in the guest, invisible to
  // the shell). Every browser window subscribes; only the one owning the tab
  // acts.
  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge) return;
    return bridge.onShortcut((shortcut) => {
      // Window cycling, the apps menu, the assistant, the System Monitor, the
      // security options and screenshot keys are desktop-wide; DesktopHotkeys and the
      // WindowSwitcher own them.
      if (
        shortcut.action === 'cycle-windows' ||
        shortcut.action === 'apps-menu' ||
        shortcut.action === 'assistant' ||
        shortcut.action === 'assistant-released' ||
        shortcut.action === 'dictation' ||
        shortcut.action === 'system-monitor' ||
        shortcut.action === 'security-options' ||
        shortcut.action === 'focus-area' ||
        shortcut.action === 'super-key' ||
        shortcut.action === 'alt-released' ||
        shortcut.action === 'screenshot' ||
        shortcut.action === 'screenshot-area' ||
        shortcut.action === 'wm' ||
        shortcut.action === 'history' ||
        shortcut.action === 'workspace-step'
      ) {
        return;
      }
      const sender = tabsRef.current.find((t) => t.wcId === shortcut.wcId);
      if (!sender) return;
      // Keyboard focus can linger in a tab's page after another tab came to
      // the front (a hidden <webview> doesn't give it up). The key still
      // means the tab the user is looking at, never the hidden one.
      const tab = tabsRef.current.find((t) => t.id === activeIdRef.current) ?? sender;
      if (runWindowHotkey(shortcut.action)) return;
      switch (shortcut.action) {
        case 'new-tab':
          openNewTab();
          break;
        case 'close-tab':
          closeTab(tab.id);
          break;
        case 'focus-address':
          focusAddress();
          break;
        case 'find':
          openFind();
          break;
        case 'view-source':
          viewSource(tab.id);
          break;
        case 'reload':
          reloadTab(tab.id, shortcut.force);
          break;
        case 'cycle-tab':
          cycleTab(shortcut.backward);
          break;
        case 'goto-tab':
          gotoTabDigit(shortcut.digit);
          break;
        case 'back':
          goTab(tab.id, -1);
          break;
        case 'forward':
          goTab(tab.id, 1);
          break;
        case 'zoom-in':
          zoomTab(tab.id, 1);
          break;
        case 'zoom-out':
          zoomTab(tab.id, -1);
          break;
        case 'zoom-reset':
          zoomTab(tab.id, 0);
          break;
        case 'fullscreen':
          views.current.get(tab.id)?.toggleFullscreen();
          break;
      }
    });
  }, [
    runWindowHotkey,
    zoomTab,
    openNewTab,
    closeTab,
    focusAddress,
    openFind,
    viewSource,
    reloadTab,
    cycleTab,
    gotoTabDigit,
    goTab,
  ]);

  return (
    <div className="flex h-full w-full flex-col" style={untintedSource as React.CSSProperties} onKeyDown={onToolbarKeyDown}>
      {/* Toolbar: spans the full width across the top, sitting *over* the
          tree-tabs sidebar and the page surface (not beside the tabs). In the
          horizontal-strip mode the tabs live in the title bar, so this is
          simply the toolbar above the surface. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(activeTab.address, true);
        }}
        style={toolbarTint}
        // No background of its own: the title bar, tabs or not, takes the
        // window's, to run on into this one without a seam (see Window).
        data-titlebar-seamless=""
        className="relative flex h-12 shrink-0 items-center gap-1 px-2"
      >
        <NavButton label="Go back" disabled={!canBack} onClick={() => go(-1)}>
          <ArrowLeft {...toolIcon} />
        </NavButton>
        <NavButton label="Go forward" disabled={!canForward} onClick={() => go(1)}>
          <ArrowRight {...toolIcon} />
        </NavButton>
        <NavButton label="Reload page" onClick={() => views.current.get(activeId)?.reload()}>
          <RotateCw className={cn(toolIcon.className, activeTab.loading && 'animate-spin')} strokeWidth={toolIcon.strokeWidth} />
        </NavButton>

        <AddressBar
          inputRef={addressRef}
          tabId={activeId}
          value={activeTab.address}
          history={addressSuggestions}
          onRemove={removeSuggestions}
          onChangeValue={(text) => updateTab(activeId, { address: text })}
          onPredict={predictNavigation}
          onNavigate={navigate}
          onOpenLocation={(url) => openTab(url, true, null, activeId)}
          onionLocation={onionLocation}
          nsiteLocation={siteLocations.nsite}
          end={
            isBookmarkableUrl(activeTab.url) ? (
              <BookmarkStarButton
                url={activeTab.url}
                open={starTab === activeId}
                onOpenChange={(open) => setStarTab(open ? activeId : null)}
                onBookmark={bookmarkPage}
                onOpenManager={openBookmarks}
              />
            ) : null
          }
          site={
            /^(https?|nsite):\/\//i.test(activeTab.url) ? (
              <SiteInfoButton
                url={activeTab.url}
                isPrivate={isPrivate}
                onReload={() => views.current.get(activeId)?.reload()}
              />
            ) : null
          }
        />

        {/* Extension action icons are hidden in private windows (extensions
            don't run in the ephemeral private session). */}
        {crx && !isPrivate && <BrowserActionList tabWcId={activeTab.wcId} />}

        <AdblockButton
          wcId={activeTab.wcId}
          url={activeTab.url}
          onReload={() => views.current.get(activeId)?.reload()}
        />

        <PopupBlockedButton
          wcId={activeTab.wcId}
          url={activeTab.url}
          onOpen={(url) => {
            if (isAllowedTabUrl(url)) openTab(url, true, null, activeId);
          }}
        />

        {/* Private tabs have no window.nostr. */}
        {!isPrivate && <SignerSiteButton url={activeTab.url} />}
        <PasswordsSiteButton url={activeTab.url} wcId={activeTab.wcId} />

        {activeTab.zoom !== 1 && (
          <PillButton
            size="sm"
            onClick={() => zoomTab(activeId, 0)}
            title="Reset zoom (Ctrl+0)"
            aria-label={`Zoom ${Math.round(activeTab.zoom * 100)}%, reset to 100%`}
            className="tabular-nums"
          >
            {activeTab.zoom > 1 ? <ZoomIn aria-hidden /> : <ZoomOut aria-hidden />}
            {Math.round(activeTab.zoom * 100)}%
          </PillButton>
        )}

        {isPrivate && (
          <StatusPill className="h-7 px-2.5 text-xs text-foreground/80" title="Private window: history and cookies are discarded when it closes">
            <VenetianMask className="size-4" strokeWidth={1.75} aria-hidden />
            Private
          </StatusPill>
        )}

        {!activeTab.tor && <InstallSiteButton
          url={activeTab.url}
          pageTitle={activeTab.title}
          favicon={activeTab.favicon}
          themeColor={activeTab.themeColor}
          collectIcons={() =>
            views.current.get(activeTab.id)?.collectIcons() ?? Promise.resolve([])
          }
          collectNostrHandler={() =>
            views.current.get(activeTab.id)?.collectNostrHandler() ?? Promise.resolve(null)
          }
        />}

        {/* One overflow menu gathers the browser's less-frequent *actions*:
            new/private windows, find-in-page, page source, developer tools,
            clearing data.
            Anything with a body to it - extensions, userscripts, preferences -
            lives on the settings page this menu links to, so the menu stays
            short enough that a small window can't clip it. */}
        <BrowserMenu
          showFind={webviewMode}
          findDisabled={activeTab.wcId === null}
          onFind={openFind}
          viewSourceDisabled={viewSourceUrl(activeTab.url) === null}
          onViewSource={() => viewSource(activeId)}
          printDisabled={activeTab.wcId === null}
          onPrint={() => printTab(activeId)}
          hasDevtools={!!devtools}
          devtoolsActive={activeTab.dock !== 'closed'}
          devtoolsDisabled={activeTab.wcId === null}
          onToggleDevtools={() => toggleDevtools(activeId)}
          onNewWindow={() => openWindow('web-browser')}
          onNewPrivateWindow={() => openWindow('web-browser', { private: true })}
          showClearData={!isPrivate}
          onClearBrowsingData={() => setClearDataOpen(true)}
          onOpenPreferences={openPreferences}
          onOpenBookmarks={openBookmarks}
          bookmarksBarShown={bookmarksBarShown}
          onToggleBookmarksBar={() => setBookmarksBarShown(!bookmarksBarShown)}
          showExtensions={!isPrivate && (!!crx || !!userscriptsBridge)}
          onOpenExtensions={openExtensions}
        />

        {activeTab.loading && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-ink-accent"
          />
        )}
      </form>

      {(bookmarksBarShown || activeTab.url === '') && (
        <BookmarksBar
          openers={bookmarkOpeners}
          onOpenManager={openBookmarks}
          onImport={() => void importBookmarks()}
          style={toolbarTint}
        />
      )}

      {/* Body: the tree-tabs sidebar (when enabled) beside the page surface,
          both sitting below the full-width toolbar. In the horizontal-strip
          mode the tabs live in the title bar, so this is just the surface. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {treeTabs && (
          <TreeTabStrip
            tabs={tabs}
            activeId={activeId}
            collapsed={collapsed}
            onActivate={selectTab}
            onCloseTab={closeTab}
            onTogglePin={togglePin}
            onNewTab={openNewTab}
            onToggleCollapsed={toggleCollapsed}
            onMoveTab={moveTab}
            onMoveTabToEnd={moveTabToEnd}
            transfer={transfer}
            menu={tabMenu}
            style={chromeTokens}
          />
        )}

        {/* Tab surfaces: all stay mounted so background tabs keep their state;
            only the active one is visible. (visibility, not display:none -
            Electron <webview>s misbehave when display is toggled.) */}
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
        {surfaceTabs.filter((tab) => !tab.dormant || tab.id === activeId).map((tab) => (
          <TabSurface
            key={tab.tor ? `${tab.id}:tor` : tab.id}
            id={tab.id}
            initialSrc={tab.initialSrc}
            zoom={tab.zoom}
            partition={tab.tor ? WEBBROWSER_TOR_PARTITION : tabPartition}
            isPrivate={isPrivate}
            active={tab.id === activeId}
            // A blank tab (empty url) shows the custom new-tab page overlaid
            // on its (about:blank) surface until the user navigates.
            isNewTab={tab.url === ''}
            // Only blank tabs get the live list, so a history write doesn't
            // re-render every other (memoized) surface.
            topSites={tab.url === '' ? newTabSites : NO_SITES}
            // Non-null only for the settings tab, where it both selects the
            // about:preferences overlay and supplies what it renders.
            preferences={tab.url === PREFERENCES_URL ? preferences : null}
            bookmarksPage={tab.url === BOOKMARKS_URL ? bookmarksPage : null}
            nostrUri={isNostrUri(tab.url) && !extensionAddressOf(tab.url) ? tab.url : null}
            // about:extensions, or a nostr: link to one extension on it.
            extensionsPage={tab.url === EXTENSIONS_URL || extensionAddressOf(tab.url) ? tab.url : null}
            installedExtensions={installedExtensions}
            onNavigate={navigateTab}
            onPredict={predictNavigation}
            onOpenTab={openTabInBackground}
            onOpenWindow={isPrivate ? undefined : openInNewWindow}
            // Only render a docked pane for bottom/right; 'window' hosts its
            // own pane in a separate desktop window.
            dock={tab.dock === 'bottom' || tab.dock === 'right' ? tab.dock : null}
            deviceId={tab.deviceId}
            devtoolsWcId={tab.wcId}
            devtoolsHeight={devtoolsHeight}
            devtoolsWidth={devtoolsWidth}
            device={tab.deviceId ? findDevicePreset(tab.deviceId) ?? null : null}
            onDevtoolsResizeHeight={setDevtoolsHeight}
            onDevtoolsResizeWidth={setDevtoolsWidth}
            onDevtoolsReady={onDevtoolsReady}
            onSetDock={setDock}
            onSelectDevice={setDevice}
            onRegister={registerView}
            onEvent={onTabEvent}
            certError={tab.wcId != null ? certErrors.get(tab.wcId) ?? null : null}
            onTrustCertificate={trustCertificate}
            onDismissCertError={dismissCertError}
            loadError={loadErrors.get(tab.id) ?? null}
            onRetryLoad={retryLoad}
          />
        ))}
        {findOpen && webviewMode && (
          <FindBar
            inputRef={findInputRef}
            text={findText}
            result={findResult}
            onChangeText={changeFindText}
            onNext={() => queryFind(findText, { forward: true, findNext: true })}
            onPrev={() => queryFind(findText, { forward: false, findNext: true })}
            onClose={closeFind}
          />
        )}
        </div>
      </div>

      {downloads.length > 0 && (
        <DownloadShelf
          downloads={downloads}
          bridge={browserBridge}
          onDismiss={dismissDownload}
          onClearAll={() => setDownloads([])}
        />
      )}


      <ClearBrowsingDataDialog
        open={clearDataOpen}
        onOpenChange={setClearDataOpen}
        bridge={browserBridge}
        onClearHistory={clearHistory}
      />

      <UndockedDevToolsReconciler tabsRef={tabsRef} updateTab={updateTab} />
    </div>
  );
}

/**
 * Watches the window manager and resets a tab's DevTools to 'closed' when
 * its undocked DevTools window disappears (closed from its own title bar:
 * the pane unmounts and detaches silently, with no 'closed' command).
 *
 * Renders nothing. Kept as a separate component because it's the browser's
 * only consumer of window STATE - subscribing in WebBrowser itself would
 * re-render the entire browser tree on every desktop window commit.
 */
function UndockedDevToolsReconciler({
  tabsRef,
  updateTab,
}: {
  tabsRef: React.RefObject<Tab[]>;
  updateTab: (id: string, patch: Partial<Tab>) => void;
}) {
  const { windows } = useWindowManager();

  useEffect(() => {
    for (const tab of tabsRef.current) {
      if (
        tab.dock === 'window' &&
        tab.undockedWindowId &&
        !windows.some((w) => w.id === tab.undockedWindowId)
      ) {
        updateTab(tab.id, { dock: 'closed', undockedWindowId: null });
      }
    }
  }, [windows, tabsRef, updateTab]);

  return null;
}

/**
 * The address/search input plus its history-autocomplete dropdown.
 *
 * The visible value is the active tab's `address` (owned by the parent);
 * this component separately tracks the text the user actually *typed*, so
 * arrowing through suggestions can rewrite the visible value (like desktop
 * browsers do) while matching stays anchored to the typed text, which is
 * restored on Escape or when the highlight wraps back around. Enter submits
 * the surrounding form with whatever the value is - a highlighted
 * suggestion's URL or the raw typed text - so navigation itself stays in the
 * parent's onSubmit.
 *
 * Typing forward at the end of the line also completes inline, Chrome-style:
 * the rest of the best-matching history URL is appended and left *selected*,
 * so Enter takes it and the next keystroke (or Backspace) discards it. The
 * completion is written straight to the DOM node rather than awaited from a
 * re-render, because re-completing to the value the input already had ("redd"
 * -> "reddit.com" when it was already "reddit.com") is a no-op state update
 * that React bails out of, which would leave the box uncompleted.
 *
 * Shift+Delete takes the highlighted suggestion, or the inline completion,
 * out of the suggestions, as in Chrome.
 */
function AddressBar({
  inputRef,
  tabId,
  value,
  history,
  onRemove,
  onChangeValue,
  onPredict,
  onNavigate,
  onOpenLocation,
  onionLocation,
  nsiteLocation,
  site,
  end,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Active tab id; switching tabs dismisses the dropdown. */
  tabId: string;
  value: string;
  /** History plus suggested sites, to match against. */
  history: BrowserHistoryEntry[];
  /** Take entries out of the suggestions (Shift+Delete). */
  onRemove: (entries: BrowserHistoryEntry[]) => void;
  onChangeValue: (text: string) => void;
  /** Where Enter would go now changed (the user typed or arrowed); lets the browser connect ahead. */
  onPredict?: (text: string) => void;
  onNavigate: (raw: string, typed?: boolean) => void;
  /** Open the onion service or nsite the page names, in a new tab beside it. */
  onOpenLocation: (url: string) => void;
  /** The onion service the page names (Onion-Location), offered at the end of the bar. */
  onionLocation?: string | null;
  /** The nsite the page names (Nsite-Location), offered at the end of the bar. */
  nsiteLocation?: string | null;
  /** The page's site info button, shown in place of the search icon. */
  site?: React.ReactNode;
  /** At the end of the bar, after the badges: the bookmark star. */
  end?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  /** Keyboard highlight: -1 is the raw typed text, 0.. a suggestion. */
  const [highlighted, setHighlighted] = useState(-1);
  const [typed, setTyped] = useState('');

  const suggestions = useMemo(
    () => (open ? matchHistory(history, typed) : []),
    [open, history, typed],
  );
  const show = open && suggestions.length > 0;

  const dismiss = useCallback(() => {
    setOpen(false);
    setHighlighted(-1);
  }, []);

  // Switching tabs swaps the value out from under the dropdown; dismiss it.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
    setHighlighted(-1);
  }, [tabId]);

  /**
   * Append the completion of `text` (if any) to the input and select the
   * appended tail, keeping the parent's value in sync either way.
   */
  const complete = (input: HTMLInputElement, text: string) => {
    const completed = inlineCompletion(history, text);
    if (completed) {
      input.value = completed;
      input.setSelectionRange(text.length, completed.length);
    }
    onChangeValue(completed ?? text);
    onPredict?.(completed ?? text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'End') {
      // Accepting the completion makes it part of what the user "typed", so
      // the dropdown and Escape stop reaching back past it.
      const input = e.currentTarget;
      if (input.selectionEnd === input.value.length && input.selectionStart !== input.selectionEnd) {
        setTyped(input.value);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!show) return;
      e.preventDefault();
      // Wrap through -1 (the typed text) at either end, Chrome-style.
      const count = suggestions.length;
      let next = highlighted + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < -1) next = count - 1;
      else if (next >= count) next = -1;
      setHighlighted(next);
      onChangeValue(next === -1 ? typed : suggestions[next].url);
      onPredict?.(next === -1 ? typed : suggestions[next].url);
    } else if (e.key === 'Delete' && e.shiftKey) {
      // Chrome's Shift+Delete: forget the highlighted suggestion, or with
      // none highlighted, what the inline completion offered.
      const input = e.currentTarget;
      let removing: BrowserHistoryEntry[] = [];
      if (show && highlighted >= 0) removing = [suggestions[highlighted]];
      else if (
        input.selectionStart !== input.selectionEnd &&
        input.selectionEnd === input.value.length &&
        input.selectionStart === typed.length
      ) {
        removing = completionSources(history, input.value);
      }
      if (!removing.length) return;
      e.preventDefault();
      onRemove(removing);
      setHighlighted(-1);
      onChangeValue(typed);
      onPredict?.(typed);
    } else if (e.key === 'Escape' && show) {
      e.preventDefault();
      dismiss();
      onChangeValue(typed);
    } else if (e.key === 'Enter') {
      // The surrounding form submits the current value; just close.
      dismiss();
    }
  };

  // Typing hides it, along with the site's icon.
  const showOnion = !!onionLocation && !open;
  const showNsite = !!nsiteLocation && !open;
  const badgeClass = cn(
    'flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors',
    'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
    'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95',
  );

  return (
    <div className="relative flex-1">
      {/* While the user types, the box is a search box; otherwise its icon
          speaks for the page that's open. */}
      {open || !site ? (
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} aria-hidden />
      ) : (
        site
      )}
      <input
        ref={inputRef}
        type="text"
        inputMode="url"
        role="combobox"
        aria-label="Address and search bar"
        aria-expanded={show}
        aria-autocomplete="both"
        aria-controls="address-bar-suggestions"
        aria-activedescendant={
          highlighted >= 0 ? `address-bar-suggestion-${highlighted}` : undefined
        }
        value={value}
        onChange={(e) => {
          const input = e.currentTarget;
          const text = input.value;
          const native = e.nativeEvent as InputEvent;
          // Only complete when the user is adding text at the end of the
          // line: deleting, or editing mid-string, must leave it alone (so
          // Backspace really does get you from "reddit.com" back to "red"),
          // and a half-composed IME sequence isn't a URL yet.
          const forward =
            !native.isComposing &&
            !(native.inputType ?? '').startsWith('delete') &&
            input.selectionStart === text.length &&
            input.selectionEnd === text.length;

          setTyped(text);
          setHighlighted(-1);
          setOpen(text.trim().length > 0);
          if (forward) complete(input, text);
          else {
            onChangeValue(text);
            onPredict?.(text);
          }
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={dismiss}
        placeholder="Search or type a URL"
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-9 w-full rounded-full bg-foreground/[0.06] pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground glass-control focus-visible:bg-background focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/60',
          // Room for what sits at the end: each badge, and the star.
          [
            ['pr-3', 'pr-9'],
            ['pr-20', 'pr-28'],
            ['pr-36', 'pr-44'],
          ][Number(showOnion) + Number(showNsite)][end ? 1 : 0],
        )}
      />
      {(showOnion || showNsite || end) && (
        // Keep a click from selecting the address first.
        <div
          className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1"
          onMouseDown={(e) => e.preventDefault()}
        >
          {showNsite && (
            <button
              type="button"
              onClick={() => onOpenLocation(nsiteLocation)}
              title={`Open this site's nsite in a new tab: ${nsiteLocation}`}
              aria-label="Open this site's nsite in a new tab"
              className={cn(
                badgeClass,
                'text-success hover:bg-foreground/[0.07]',
              )}
            >
              <NsiteIcon className="size-3.5" />
              nsite
            </button>
          )}
          {showOnion && (
            <button
              type="button"
              onClick={() => onOpenLocation(onionLocation)}
              title={`Open this site's onion service in a new tab: ${hostnameOf(onionLocation) ?? onionLocation}`}
              aria-label="Open this site's onion service in a new tab"
              className={cn(
                badgeClass,
                'text-foreground hover:bg-foreground/[0.07]',
              )}
            >
              <OnionIcon className="size-3.5" />
              onion
            </button>
          )}
          {end}
        </div>
      )}
      {show && (
        <ul
          id="address-bar-suggestions"
          role="listbox"
          aria-label="Suggestions"
          // Keep focus in the input so item clicks land before blur closes.
          onMouseDown={(e) => e.preventDefault()}
          // Din's glass, under the page-tinted toolbar: the theme's text on it.
          style={untintedTokens as React.CSSProperties}
          className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl glass-surface p-1.5 text-popover-foreground shadow-lg"
        >
          {suggestions.map((entry, i) => (
            <li
              key={entry.url}
              id={`address-bar-suggestion-${i}`}
              role="option"
              aria-selected={i === highlighted}
              onClick={() => {
                dismiss();
                onNavigate(entry.url, true);
              }}
              className={cn(
                'flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-sm',
                i === highlighted ? 'bg-selected text-foreground' : 'hover:bg-foreground/5',
              )}
            >
              {isSuggestedSite(entry) ? (
                <Globe className="size-4.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
              ) : (
                <History className="size-4.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
              )}
              <span className="min-w-0 max-w-[50%] truncate">
                {entry.title ?? hostnameOf(entry.url) ?? entry.url}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {historyDisplayUrl(entry)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The find-in-page bar (Ctrl+F): a floating box at the top-right of the page
 * area, Chrome-style. Queries run against the active tab's guest through the
 * browser bridge (Chromium's findInPage); match counts stream back via
 * onFindResult. Enter / Shift+Enter step through matches; Escape closes.
 */
function FindBar({
  inputRef,
  text,
  result,
  onChangeText,
  onNext,
  onPrev,
  onClose,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  text: string;
  result: { matches: number; activeMatchOrdinal: number } | null;
  onChangeText: (text: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}) {
  const noMatches = text.length > 0 && result !== null && result.matches === 0;
  return (
    <div
      role="search"
      aria-label="Find in page"
      className="absolute right-3 top-2 z-30 flex items-center gap-1 rounded-2xl glass-surface p-1.5 text-popover-foreground shadow-lg"
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => onChangeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in page"
        aria-label="Find in page"
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-8 w-48 rounded-full bg-foreground/[0.06] px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60',
          noMatches && 'text-destructive',
        )}
      />
      <span
        aria-live="polite"
        className={cn(
          'min-w-9 shrink-0 text-center text-xs',
          noMatches ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {text && result ? `${result.activeMatchOrdinal}/${result.matches}` : ''}
      </span>
      <FindBarButton label="Previous match" disabled={!text} onClick={onPrev}>
        <ChevronUp className="size-4.5" strokeWidth={1.75} />
      </FindBarButton>
      <FindBarButton label="Next match" disabled={!text} onClick={onNext}>
        <ChevronDown className="size-4.5" strokeWidth={1.75} />
      </FindBarButton>
      <FindBarButton label="Close find bar" onClick={onClose}>
        <X className="size-4.5" strokeWidth={1.75} />
      </FindBarButton>
    </div>
  );
}

/** A small icon button inside the {@link FindBar}. */
function FindBarButton({
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
    <ToolButton size="sm" label={label} onClick={onClick} disabled={disabled}>
      {children}
    </ToolButton>
  );
}

/**
 * The browser's tab strip, rendered into the window title bar so tabs sit on
 * the same line as the window controls. The surrounding <header> is the drag
 * handle; tab buttons and the new-tab button handle their own clicks, and
 * dragging empty space still moves the window.
 */
function TabStrip({
  tabs,
  activeId,
  onActivate,
  onCloseTab,
  onTogglePin,
  onNewTab,
  onMoveTab,
  transfer,
  menu,
}: {
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onTogglePin: (id: string) => void;
  onNewTab: () => void;
  /** Move a tab to a new index; tabs are dragged to reorder them. */
  onMoveTab: (id: string, toIndex: number) => void;
  /** Let tabs move between browser windows (see useTabTransfer). */
  transfer: TabTransferOptions;
  menu: BrowserTabMenu;
}) {
  const tabTransfer = useTabTransfer(transfer, tabs.length);
  const chrome = useWindowChrome();
  const reorder = useDragReorder({
    ids: tabs.map((t) => t.id),
    onMove: onMoveTab,
    tearOff: tabTransfer.tearOff,
    // A window's only tab moves the window, like Chrome's.
    moveWindow: tabs.length === 1 ? chrome : undefined,
  });
  // Tabs shrink to fit the strip, like Chrome's. Closing one with the mouse
  // holds the others at their current width until the pointer leaves the
  // strip, so the next tab's close button slides under the cursor.
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Past the minimum tab width the strip scrolls; keep the active tab in view.
  // (By hand: scrollIntoView would also scroll the desktop's clipped ancestors.)
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab) return;
    const start = tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    const end = start + tab.offsetWidth;
    if (start < list.scrollLeft) list.scrollLeft = start;
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
  }, [activeId, tabs.length]);
  return (
    <StripContextMenu menu={menu}>
      <div
        ref={(el) => {
          listRef.current = el;
          tabTransfer.setList(el);
        }}
        role="tablist"
        aria-label="Browser tabs"
        onPointerLeave={() => setLockedWidth(null)}
        onWheel={(e) => {
          // There's no scrollbar, so the wheel scrolls the tabs sideways.
          if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
        className={tabListClass}
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            dragging={reorder.draggingId === tab.id}
            transfer={tabTransfer}
            menu={tabMenuProps(menu, tab, tabs, true)}
            lockedWidth={lockedWidth}
            ref={(el) => reorder.register(tab.id, el)}
            onPointerDown={(e) => reorder.onPointerDown(tab.id, e)}
            onActivate={() => onActivate(tab.id)}
            onClose={(width) => {
              if (width !== undefined) setLockedWidth(width);
              onCloseTab(tab.id);
            }}
            onTogglePin={() => onTogglePin(tab.id)}
          />
        ))}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={onNewTab}
          className={newTabButtonClass}
        >
          {/* 15px with a 1px stroke, centered as 16px: its lines land on whole pixels, so it's crisp. */}
          <Plus className="mr-px mb-px size-[15px]" strokeWidth={1.6} />
        </button>
      </div>
    </StripContextMenu>
  );
}

/** What a browser tab's right-click menu can do, beyond pinning, moving and closing it. */
interface BrowserTabMenu {
  newTab: () => void;
  reopen: () => void;
  reload: (id: string) => void;
  duplicate: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
}

type TabMenuExtras = Pick<
  React.ComponentProps<typeof TabContextMenu>,
  'onNew' | 'onReopen' | 'items' | 'onCloseOthers' | 'canCloseOthers' | 'onCloseToRight' | 'canCloseToRight'
>;

/**
 * The browser's items in a tab's right-click menu. `toRight` offers "Close
 * tabs to the right", which only reads as such in the horizontal strip.
 */
function tabMenuProps(menu: BrowserTabMenu, tab: Tab, tabs: Tab[], toRight: boolean): TabMenuExtras {
  const index = tabs.findIndex((t) => t.id === tab.id);
  return {
    onNew: menu.newTab,
    onReopen: menu.reopen,
    items: (
      <>
        <ContextMenuItem onSelect={() => menu.reload(tab.id)}>Reload</ContextMenuItem>
        <ContextMenuItem onSelect={() => menu.duplicate(tab.id)}>Duplicate</ContextMenuItem>
      </>
    ),
    onCloseOthers: () => menu.closeOthers(tab.id),
    canCloseOthers: tabs.some((t) => t.id !== tab.id && !t.pinned),
    onCloseToRight: toRight ? () => menu.closeToRight(tab.id) : undefined,
    canCloseToRight: tabs.slice(index + 1).some((t) => !t.pinned),
  };
}

/**
 * The right-click menu for a tab strip's empty space. The strip sits in the
 * window's title bar, which has a menu of its own; this one wins.
 */
function StripContextMenu({ menu, children }: { menu: BrowserTabMenu; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(e) => e.stopPropagation()}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={menu.newTab}>New tab</ContextMenuItem>
        <ContextMenuItem onSelect={menu.reopen}>Reopen closed tab</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A tab's favicon, or its glyph while it has none. */
function TabIcon({ tab, icon, className }: { tab: Tab; icon: string | null; className?: string }) {
  return icon ? (
    <img src={icon} alt="" aria-hidden draggable={false} className={cn('size-4 shrink-0', className)} />
  ) : (
    <TabGlyph tab={tab} className={cn('size-4 shrink-0 opacity-60', className)} />
  );
}

/** A single tab in the tab strip. */
function TabButton({
  tab,
  active,
  dragging,
  transfer,
  menu,
  lockedWidth = null,
  ref,
  onPointerDown,
  onActivate,
  onClose,
  onTogglePin,
}: {
  tab: Tab;
  active: boolean;
  dragging: boolean;
  transfer: TabTransfer;
  menu: TabMenuExtras;
  /** Hold an unpinned tab at this width instead of fitting it to the strip. */
  lockedWidth?: number | null;
  ref?: React.Ref<HTMLDivElement>;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  onActivate: () => void;
  /** Close the tab; given the tab's width when the mouse closed it. */
  onClose: (width?: number) => void;
  onTogglePin: () => void;
}) {
  const label = tabLabel(tab);
  const icon = tab.favicon ? sanitizeImageUrl(tab.favicon) : null;
  const widthOf = (el: Element) => el.closest('[role="tab"]')?.getBoundingClientRect().width;

  return (
    <TabContextMenu
      tabId={tab.id}
      transfer={transfer}
      onClose={() => onClose()}
      pinned={tab.pinned}
      onTogglePin={onTogglePin}
      {...menu}
    >
      <div
        ref={ref}
        onPointerDown={onPointerDown}
        role="tab"
        aria-selected={active}
        aria-label={label}
        tabIndex={0}
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate();
          }
        }}
        onAuxClick={(e) => {
          // Middle-click closes, like every browser - except a pinned tab,
          // which is pinned so it doesn't go away by accident.
          if (e.button === 1 && !tab.pinned) onClose(widthOf(e.currentTarget));
        }}
        onMouseUp={(e) => {
          // No primary-selection paste into whatever takes focus next.
          if (e.button === 1) e.preventDefault();
        }}
        title={label}
        style={!tab.pinned && lockedWidth !== null ? { flex: `0 0 ${lockedWidth}px` } : undefined}
        className={cn(
          // Unpinned tabs shrink from 13rem as the strip fills, and are
          // containers so their contents can collapse once they get narrow.
          tab.pinned
            ? 'w-9 shrink-0'
            : cn('@container basis-52 shrink', active ? 'min-w-10' : 'min-w-9'),
          tabClass({ active, dragging }),
        )}
      >
        {/* Too narrow for its title, a tab shows just its icon, like Safari's. */}
        {tab.pinned ? (
          <TabIcon tab={tab} icon={icon} />
        ) : (
          <>
            <span className={tabContentClass}>
              <TabIcon tab={tab} icon={icon} className={tabIconClass} />
              <span className={tabTitleClass(true)}>{label}</span>
            </span>
            <button
              type="button"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(e.detail > 0 ? widthOf(e.currentTarget) : undefined);
              }}
              className={tabCloseClass}
            >
              <X className="size-3" />
            </button>
          </>
        )}
      </div>
    </TabContextMenu>
  );
}

/**
 * Where a dragged tab lands relative to the row it's dropped on: as a sibling
 * just 'before' or 'after' it, or nested 'inside' as its first child.
 */
type DropZone = 'before' | 'after' | 'inside';

/** A tab plus its position in the tree sidebar. */
interface TreeRow {
  tab: Tab;
  depth: number;
  hasChildren: boolean;
}

/**
 * Flatten the flat tab list into depth-first sidebar order using each tab's
 * `parentId`. Tabs whose parent is missing (closed, or opened in another
 * window) fall back to roots, so every tab is always reachable. Descendants
 * of a collapsed tab are omitted.
 */
function flattenTabTree(tabs: Tab[], collapsed: Set<string>): TreeRow[] {
  const ids = new Set(tabs.map((t) => t.id));
  const childrenOf = new Map<string | null, Tab[]>();
  for (const tab of tabs) {
    const key = tab.parentId && ids.has(tab.parentId) ? tab.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(tab);
    else childrenOf.set(key, [tab]);
  }
  const rows: TreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const tab of childrenOf.get(parentId) ?? []) {
      const hasChildren = childrenOf.has(tab.id);
      rows.push({ tab, depth, hasChildren });
      if (hasChildren && !collapsed.has(tab.id)) walk(tab.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/**
 * The tree-tabs sidebar: a vertical list of tabs nested by their opener,
 * with collapsible subtrees. Rendered in the browser body (not the title
 * bar) beside the toolbar + surfaces column.
 */
function TreeTabStrip({
  tabs,
  activeId,
  collapsed,
  onActivate,
  onCloseTab,
  onTogglePin,
  onNewTab,
  onToggleCollapsed,
  onMoveTab,
  onMoveTabToEnd,
  transfer,
  menu,
  style,
}: {
  tabs: Tab[];
  activeId: string;
  collapsed: Set<string>;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onTogglePin: (id: string) => void;
  onNewTab: () => void;
  onToggleCollapsed: (id: string) => void;
  onMoveTab: (dragId: string, targetId: string, position: DropZone) => void;
  onMoveTabToEnd: (dragId: string) => void;
  /**
   * Let tabs move between browser windows. Only from the context menu here:
   * the sidebar's drag and drop stays within the window.
   */
  transfer: TabTransferOptions;
  menu: BrowserTabMenu;
  /** The tinted window's tokens, when a page has colored it. */
  style?: React.CSSProperties;
}) {
  const tabTransfer = useTabTransfer(transfer, tabs.length);
  // Pinned tabs sit in a row of icons above the tree, outside it.
  const pinned = useMemo(() => tabs.filter((t) => t.pinned), [tabs]);
  const rows = useMemo(
    () => flattenTabTree(tabs.filter((t) => !t.pinned), collapsed),
    [tabs, collapsed],
  );
  // The tab currently being dragged, or null. Shared across rows so a row can
  // tell whether it's a valid drop target (and skip itself).
  const [dragId, setDragId] = useState<string | null>(null);
  // A drag is hovering the trailing (move-to-top-level) drop zone.
  const [endHover, setEndHover] = useState(false);
  return (
    <StripContextMenu menu={menu}>
      <div
        role="tablist"
        aria-label="Browser tabs"
        aria-orientation="vertical"
        style={style}
        className="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto px-2 pb-2 text-foreground [&>*]:shrink-0"
      >
        {pinned.length > 0 && (
          <div className="flex shrink-0 flex-wrap gap-1 pb-1">
            {pinned.map((tab) => (
              <TabButton
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                dragging={false}
                transfer={tabTransfer}
                menu={tabMenuProps(menu, tab, tabs, false)}
                onActivate={() => onActivate(tab.id)}
                onClose={() => onCloseTab(tab.id)}
                onTogglePin={() => onTogglePin(tab.id)}
              />
            ))}
          </div>
        )}
        {rows.map(({ tab, depth, hasChildren }) => (
          <TreeTabRow
            key={tab.id}
            tab={tab}
            depth={depth}
            hasChildren={hasChildren}
            collapsed={collapsed.has(tab.id)}
            active={tab.id === activeId}
            dragging={dragId === tab.id}
            dragActive={dragId !== null}
            transfer={tabTransfer}
            menu={tabMenuProps(menu, tab, tabs, false)}
            onActivate={() => onActivate(tab.id)}
            onClose={() => onCloseTab(tab.id)}
            onPin={() => onTogglePin(tab.id)}
            onToggleCollapsed={() => onToggleCollapsed(tab.id)}
            onDragStart={() => setDragId(tab.id)}
            onDragEnd={() => setDragId(null)}
            onDrop={(position) => {
              if (dragId) onMoveTab(dragId, tab.id, position);
              setDragId(null);
            }}
          />
        ))}
        {/* The new-tab button sits at the bottom of the tab list (Firefox-style). */}
        <button
          type="button"
          aria-label="New tab"
          title="New tab"
          onClick={onNewTab}
          className={cn(
            'flex h-8 shrink-0 items-center gap-2 rounded-lg px-2 text-[13px] text-muted-foreground',
            'hover:bg-foreground/5 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        >
          <Plus className="size-4.5 shrink-0" strokeWidth={1.75} />
          <span className="truncate">New Tab</span>
        </button>
        {/* Trailing drop zone (only during a drag): dropping in the empty space
            below the list moves the tab back to the top level, at the end - the
            way out of a group when there's no row left to drop 'before'. */}
        {dragId !== null && (
          <div
            className="relative min-h-8 flex-1"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setEndHover(true);
            }}
            onDragLeave={() => setEndHover(false)}
            onDrop={(e) => {
              e.preventDefault();
              setEndHover(false);
              if (dragId) onMoveTabToEnd(dragId);
              setDragId(null);
            }}
          >
            {endHover && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-ink-accent"
              />
            )}
          </div>
        )}
      </div>
    </StripContextMenu>
  );
}

/** A single row in the tree-tabs sidebar. */
function TreeTabRow({
  tab,
  depth,
  hasChildren,
  collapsed,
  active,
  dragging,
  dragActive,
  transfer,
  menu,
  onActivate,
  onClose,
  onPin,
  onToggleCollapsed,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  tab: Tab;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  active: boolean;
  /** This row is the one being dragged. */
  dragging: boolean;
  /** Some row (this one or another) is being dragged. */
  dragActive: boolean;
  transfer: TabTransfer;
  menu: TabMenuExtras;
  onActivate: () => void;
  onClose: () => void;
  onPin: () => void;
  onToggleCollapsed: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (position: DropZone) => void;
}) {
  const label = tabLabel(tab);
  const icon = tab.favicon ? sanitizeImageUrl(tab.favicon) : null;
  // The drop indicator to draw while another tab hovers over this row, or
  // null. The top/bottom thirds re-order (sibling before/after), the middle
  // nests (child); on an expanded parent the bottom zone also nests, since
  // that slot visually belongs to the first child (see onDragOver).
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  // Each nesting level shifts the whole row right - narrowing it - so depth
  // reads directly off the layout. Parents additionally reserve a small
  // gutter inside the row for the disclosure chevron (absolutely positioned
  // below, out of the flex flow); childless rows keep their label flush.
  const gutter = hasChildren ? 20 : 6;

  const onDragOver = (e: React.DragEvent) => {
    // Not a valid target: no drag in progress, or this is the dragged row.
    if (!dragActive || dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientY - rect.top;
    // The slot just below an expanded parent is visually the first-child
    // slot ('after' would silently land past the whole subtree), so the
    // bottom zone nests there too. Dropping after the subtree is done via
    // the last descendant's bottom zone or the strip's trailing drop zone.
    const expandedParent = hasChildren && !collapsed;
    const zone: DropZone =
      offset < rect.height * 0.3
        ? 'before'
        : offset > rect.height * 0.7 && !expandedParent
          ? 'after'
          : 'inside';
    setDropZone((z) => (z === zone ? z : zone));
  };

  return (
    <TabContextMenu
      tabId={tab.id}
      transfer={transfer}
      onClose={onClose}
      pinned={false}
      onTogglePin={onPin}
      {...menu}
    >
      <div
        role="tab"
        aria-selected={active}
        aria-label={label}
        tabIndex={0}
        draggable
        onClick={onActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate();
          }
        }}
        onAuxClick={(e) => {
          // Middle-click closes, like every browser.
          if (e.button === 1) onClose();
        }}
        onMouseUp={(e) => {
          // No primary-selection paste into whatever takes focus next.
          if (e.button === 1) e.preventDefault();
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          // Firefox needs data set for a drag to actually start.
          e.dataTransfer.setData('text/plain', tab.id);
          onDragStart();
        }}
        onDragEnd={() => {
          setDropZone(null);
          onDragEnd();
        }}
        onDragOver={onDragOver}
        onDragLeave={() => setDropZone(null)}
        onDrop={(e) => {
          e.preventDefault();
          const zone = dropZone;
          setDropZone(null);
          if (zone) onDrop(zone);
        }}
        title={label}
        style={{ marginInlineStart: depth * 14, paddingInlineStart: gutter }}
        className={cn(
          'group relative flex h-8 min-w-0 cursor-default items-center gap-2 rounded-lg pr-1.5 text-[13px] transition-[background-color,color] duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          dragging && 'opacity-40',
          dropZone === 'inside' && 'ring-2 ring-inset ring-ring/60',
          active
            ? tabRaisedClass
            : 'text-foreground/80 hover:bg-foreground/5 hover:text-foreground',
        )}
      >
        {/* Sibling drop indicators: a bar in the gap above / below the row. */}
        {dropZone === 'before' && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 -top-[3px] h-0.5 rounded-full bg-ink-accent"
          />
        )}
        {dropZone === 'after' && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-1 -bottom-[3px] h-0.5 rounded-full bg-ink-accent"
          />
        )}
        {/* Disclosure chevron: sits in the row's gutter, out of the flex flow,
            so it never steals width from the label. Only parents show it. */}
        {hasChildren && (
          <button
            type="button"
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed();
            }}
            className="absolute start-0.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded text-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', !collapsed && 'rotate-90')}
            />
          </button>
        )}
        {icon ? (
          <img
            src={icon}
            alt=""
            aria-hidden
            draggable={false}
            className="size-4 shrink-0"
          />
        ) : (
          <TabGlyph tab={tab} className="size-4 shrink-0 opacity-60" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full text-foreground/60',
            'opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100',
            active && 'opacity-100',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        >
          <X className="size-3" />
        </button>
      </div>
    </TabContextMenu>
  );
}

/**
 * One tab's rendering surface. Memoized so unrelated tab-state updates (e.g.
 * another tab's title changing) don't re-render every surface. All callbacks
 * derive from stable props, so effect subscriptions inside BrowserView stay
 * put across renders.
 *
 * Layout (webview mode only):
 *  - When the tab's inspector is docked, the surface splits into page +
 *    DevTools pane, laid out as a column (dock 'bottom') or row (dock
 *    'right'), separated by a draggable divider that resizes the pane.
 *  - When a device preset is selected, the page is centered in a framed
 *    viewport of the device's CSS dimensions (the actual metrics/user-agent
 *    override is applied over CDP; this is just the visual frame + scroll).
 */
/**
 * Full-surface interstitial shown when a tab's TLS certificate can't be
 * trusted (self-signed / private-CA host). Mirrors a browser's "your
 * connection isn't private" page: the risky "proceed" path is gated behind a
 * second confirm so it can't be hit by a stray click.
 */
function CertificateWarning({
  info,
  onProceed,
  onBack,
}: {
  info: CertificateErrorInfo;
  onProceed: () => void;
  onBack: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const code = info.error.replace(/^net::/, '');
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-2xl bg-card p-6 clay">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <ShieldAlert className="size-5" strokeWidth={1.75} />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold leading-tight">
              Your connection isn't private
            </h2>
            <p className="text-sm text-muted-foreground">
              Din couldn't verify the identity of{' '}
              <span className="break-all font-medium text-foreground">{info.host}</span>.
              Its security certificate isn't trusted (self-signed or issued by a
              private authority).
            </p>
          </div>
        </div>

        <dl className="space-y-1.5 rounded-xl bg-foreground/[0.04] p-3 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Error</dt>
            <dd className="font-mono">{code}</dd>
          </div>
          <div className="flex min-w-0 justify-between gap-3">
            <dt className="shrink-0 text-muted-foreground">Fingerprint</dt>
            <dd className="truncate font-mono" title={info.fingerprint}>
              {info.fingerprint}
            </dd>
          </div>
        </dl>

        {!confirming ? (
          <div className="flex flex-col gap-2">
            <Button className="w-full" onClick={onBack}>
              Back to safety
            </Button>
            <Button
              variant="ghost"
              className="w-full text-muted-foreground"
              onClick={() => setConfirming(true)}
            >
              Proceed anyway
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Only continue if you trust this host and expected a private
              certificate. An attacker could be impersonating{' '}
              <span className="break-all font-medium text-foreground">{info.host}</span>{' '}
              to steal your data. Din will remember this certificate next time.
            </p>
            <div className="flex flex-col gap-2">
              <Button variant="destructive" className="w-full" onClick={onProceed}>
                Trust this certificate and continue
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Map a failed load to a friendly headline + explanation. Falls back to a
 * generic message carrying Chromium's raw error string for anything unmapped.
 * An onion site's failure is mostly Tor's, so it says where Tor stands.
 */
function describeLoadError(info: LoadErrorInfo, tor: TorStatus | null): {
  title: string;
  detail: string;
  offline: boolean;
} {
  let host: string | null = null;
  try {
    host = new URL(info.url).host || null;
  } catch {
    // Malformed URL: fall back to the generic "this site" phrasing.
  }
  if (isOnionUrl(info.url) && info.errorDescription !== 'ERR_INTERNET_DISCONNECTED') {
    switch (tor ? torState(tor) : 'missing') {
      case 'off':
        return {
          title: 'Tor is turned off',
          detail: 'Onion sites open through Tor. Turn it on in Settings → Wi-Fi, and this page loads once Tor connects.',
          offline: false,
        };
      case 'missing':
        return {
          title: "Tor isn't running",
          detail: 'Onion sites open through Tor. Start Tor or Tor Browser, and this page loads once Din finds it.',
          offline: false,
        };
      case 'connecting':
        return {
          title: 'Tor is still connecting',
          detail: `This page loads once Tor has connected${tor?.progress != null ? ` (${tor.progress}% so far)` : ''}.`,
          offline: false,
        };
      case 'ready':
        return {
          title: "This onion site can't be reached",
          detail: `${host ?? 'The site'} didn't answer through Tor. It may be offline, or the address may be wrong.`,
          offline: false,
        };
    }
  }
  switch (info.errorDescription) {
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return {
        title: "This site can't be reached",
        detail: `We couldn't find the server for ${host ?? 'this address'}. Check the address for typos.`,
        offline: false,
      };
    case 'ERR_INTERNET_DISCONNECTED':
      return {
        title: "You're offline",
        detail: 'There is no internet connection. Check your network and try again.',
        offline: true,
      };
    case 'ERR_CONNECTION_REFUSED':
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_CONNECTION_FAILED':
      return {
        title: "This site can't be reached",
        detail: `${host ?? 'The server'} refused to connect.`,
        offline: false,
      };
    case 'ERR_CONNECTION_TIMED_OUT':
    case 'ERR_TIMED_OUT':
      return {
        title: 'This site took too long to respond',
        detail: `${host ?? 'The server'} didn't respond in time. It may be down or too busy.`,
        offline: false,
      };
    case 'ERR_ADDRESS_UNREACHABLE':
    case 'ERR_NETWORK_CHANGED':
      return {
        title: "This site can't be reached",
        detail: `The network path to ${host ?? 'the server'} is unavailable.`,
        offline: false,
      };
    default:
      return {
        title: "This page couldn't load",
        detail: `Something went wrong loading ${host ?? 'this page'}.`,
        offline: false,
      };
  }
}

/**
 * Full-surface interstitial shown when a tab's main-frame load fails at the
 * network level (DNS failure, connection refused, timeout, offline, ...).
 * Chromium would otherwise show its own generic error page; this branded one
 * offers a Retry that re-requests the failed URL.
 */
export function LoadErrorPage({
  info,
  onRetry,
}: {
  info: LoadErrorInfo;
  onRetry: () => void;
}) {
  const tor = useTorStatus();
  const onion = isOnionUrl(info.url);
  const { title, detail, offline } = describeLoadError(info, tor);
  const code = info.errorDescription || `Error ${info.errorCode}`;
  const Icon = offline ? WifiOff : onion ? OnionIcon : Globe;

  // An onion site that failed for want of Tor loads once Tor is ready.
  const torReady = !!tor && torState(tor) === 'ready';
  const wasReady = useRef(torReady);
  useEffect(() => {
    if (onion && torReady && !wasReady.current) onRetry();
    wasReady.current = torReady;
  }, [onion, torReady, onRetry]);

  // A page that failed while offline loads once the network is back, after a
  // moment for DNS to come up with it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOnline = () => {
      clearTimeout(timer);
      timer = setTimeout(onRetry, 1000);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
      clearTimeout(timer);
    };
  }, [onRetry]);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-background p-6">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-foreground/10 text-foreground/75 clay">
          <Icon className="size-7" strokeWidth={1.5} />
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold leading-tight">{title}</h2>
          <p className="text-sm text-muted-foreground">{detail}</p>
          {info.url && (
            <p className="break-all font-mono text-xs text-muted-foreground">
              {info.url}
            </p>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <Button onClick={onRetry} className="min-w-32">
            <RotateCw className="size-4.5" strokeWidth={1.75} />
            Reload
          </Button>
          <span className="font-mono text-xs text-muted-foreground">{code}</span>
        </div>
      </div>
    </div>
  );
}

/** Human-readable byte size (e.g. "2.4 MB"). */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * A Chrome-style shelf pinned to the bottom of the browser, listing this
 * window's downloads. Files are already being saved to ~/Downloads by the
 * main process; the shelf makes that visible and offers open / show-in-folder
 * once a download completes.
 */
function DownloadShelf({
  downloads,
  bridge,
  onDismiss,
  onClearAll,
}: {
  downloads: DownloadInfo[];
  bridge: BrowserBridge | undefined;
  onDismiss: (id: number) => void;
  onClearAll: () => void;
}) {
  return (
    <div role="region" aria-label="Downloads" className="flex h-14 shrink-0 items-center gap-2 bg-background px-2">
      <Download className="ml-1 size-4.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {downloads.map((d) => (
          <DownloadChip
            key={d.id}
            download={d}
            bridge={bridge}
            onDismiss={() => onDismiss(d.id)}
            onClearAll={onClearAll}
          />
        ))}
      </div>
      <PillButton size="sm" onClick={onClearAll}>
        Clear All
      </PillButton>
    </div>
  );
}

/** One download's chip in the shelf: name, progress, and completed actions. */
function DownloadChip({
  download,
  bridge,
  onDismiss,
  onClearAll,
}: {
  download: DownloadInfo;
  bridge: BrowserBridge | undefined;
  onDismiss: () => void;
  onClearAll: () => void;
}) {
  const { open } = useWindowActions();
  const { state, filename, receivedBytes, totalBytes, savePath } = download;
  const done = state === 'completed';
  // Open and show-in-folder use Din's own apps, as Files does; only programs
  // (Windows's, AppImages) go to the main process, which runs them.
  const openFile = () => {
    if (isProgram(filename)) bridge?.openDownload(savePath).catch(() => {});
    else open(appForFile(filename), { path: savePath });
  };
  const showInFolder = () => open('file-browser', { path: parentPath(savePath), select: filename });
  const failed = state === 'cancelled' || state === 'interrupted';
  const pct =
    totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null;
  const subtitle = done
    ? formatBytes(receivedBytes)
    : failed
      ? state === 'cancelled'
        ? 'Canceled'
        : 'Failed'
      : pct !== null
        ? `${pct}% of ${formatBytes(totalBytes)}`
        : formatBytes(receivedBytes);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="flex min-w-0 max-w-64 shrink-0 items-center gap-2 rounded-xl bg-card py-1 pr-1 pl-1.5 clay">
          <span
            aria-hidden
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full',
              failed ? 'bg-destructive/10 text-destructive' : done ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-foreground/75 clay',
            )}
          >
            <Download className="size-4" strokeWidth={1.75} />
          </span>
          <button
            type="button"
            className="min-w-0 flex-1 text-left disabled:cursor-default"
            disabled={!done}
            onClick={() => {
              if (done) openFile();
            }}
            title={done ? `Open ${filename}` : filename}
          >
            <div className="truncate text-xs font-medium">{filename}</div>
            <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>
            {!done && !failed && pct !== null && (
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-foreground/10">
                <div
                  className="h-full bg-pigment transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </button>
          {done && (
            <ToolButton size="sm" label="Show in Folder" onClick={showInFolder}>
              <FolderOpen className="size-4" strokeWidth={1.75} />
            </ToolButton>
          )}
          <ToolButton size="sm" label="Dismiss" onClick={onDismiss}>
            <X className="size-4" strokeWidth={1.75} />
          </ToolButton>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {done && <ContextMenuItem onSelect={openFile}>Open</ContextMenuItem>}
        {done && <ContextMenuItem onSelect={showInFolder}>Show in Folder</ContextMenuItem>}
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(download.url).catch(() => {})}>
          Copy Link
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDismiss}>Dismiss</ContextMenuItem>
        <ContextMenuItem onSelect={onClearAll}>Clear All</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const TabSurface = memo(function TabSurface({
  id,
  initialSrc,
  zoom,
  partition,
  isPrivate,
  active,
  isNewTab,
  topSites: sites,
  preferences,
  bookmarksPage,
  nostrUri,
  extensionsPage,
  installedExtensions,
  onNavigate: onNavigateToUrl,
  onPredict,
  onOpenTab,
  onOpenWindow,
  dock,
  deviceId,
  devtoolsWcId,
  devtoolsHeight,
  devtoolsWidth,
  device,
  onDevtoolsResizeHeight,
  onDevtoolsResizeWidth,
  onDevtoolsReady,
  onSetDock,
  onSelectDevice,
  onRegister,
  onEvent,
  certError,
  onTrustCertificate,
  onDismissCertError,
  loadError,
  onRetryLoad,
}: {
  id: string;
  initialSrc: string;
  /** The tab's page zoom; 1 is 100%. */
  zoom: number;
  /** Session partition for this tab's surface (private windows override it). */
  partition?: string;
  /** Whether this tab lives in a private window (styles the new-tab page). */
  isPrivate: boolean;
  active: boolean;
  /** Show the custom new-tab page over the surface (blank tab). */
  isNewTab: boolean;
  /** Tiles for the new-tab page. */
  topSites: TopSite[];
  /** Settings to render over the surface, or null for a non-settings tab. */
  preferences: PreferencesProps | null;
  /** about:bookmarks' props for the bookmarks tab, or null for any other. */
  bookmarksPage: BookmarksPageProps | null;
  /** The nostr: link this tab previews, or null. */
  nostrUri: string | null;
  /** The URL of the about:extensions page (or a nostr: link to an extension) this tab shows, or null. */
  extensionsPage: string | null;
  /** What about:extensions needs to manage the installed ones. */
  installedExtensions: ExtensionsPageProps['installed'];
  /** Navigate this tab to a URL/search (from the new-tab page). */
  onNavigate: (id: string, raw: string, typed?: boolean) => void;
  /** Where the new-tab page would go changed (see predictNavigation). */
  onPredict?: (raw: string) => void;
  /** Open a URL in a new background tab / a new window (from the new-tab page). */
  onOpenTab: (url: string) => void;
  onOpenWindow?: (url: string) => void;
  /** Docked pane position, or null when not docked in this surface. */
  dock: 'bottom' | 'right' | null;
  /** Selected device preset id, or null. */
  deviceId: string | null;
  /** The guest to inspect (the tab's own WebContents id), or null. */
  devtoolsWcId: number | null;
  devtoolsHeight: number;
  devtoolsWidth: number;
  /** Selected device preset for the responsive view, or null. */
  device: DevicePreset | null;
  onDevtoolsResizeHeight: (height: number) => void;
  onDevtoolsResizeWidth: (width: number) => void;
  onDevtoolsReady: (id: string) => void;
  onSetDock: (id: string, mode: DockMode) => void;
  onSelectDevice: (id: string, deviceId: string | null) => void;
  onRegister: (id: string, handle: BrowserViewHandle | null) => void;
  onEvent: (id: string, event: TabEvent) => void;
  /** Pending untrusted-TLS warning for this tab, or null. */
  certError: CertificateErrorInfo | null;
  /** Proceed past the warning: pin the cert and reload. */
  onTrustCertificate: (info: CertificateErrorInfo) => void;
  /** Dismiss the warning without trusting. */
  onDismissCertError: (id: string) => void;
  /** Pending network-level load failure for this tab, or null. */
  loadError: LoadErrorInfo | null;
  /** Retry the failed load. */
  onRetryLoad: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  const onLoadStart = useCallback(
    () => onEvent(id, { kind: 'loading', value: true }),
    [id, onEvent],
  );
  const onLoadEnd = useCallback(
    () => onEvent(id, { kind: 'loading', value: false }),
    [id, onEvent],
  );
  const onLoadError = useCallback(
    (info: LoadErrorInfo) => onEvent(id, { kind: 'loadError', value: info }),
    [id, onEvent],
  );
  const onTitleChange = useCallback(
    (title: string) => onEvent(id, { kind: 'title', value: title }),
    [id, onEvent],
  );
  const onFaviconChange = useCallback(
    (favicons: string[]) => onEvent(id, { kind: 'favicon', value: favicons[0] ?? null }),
    [id, onEvent],
  );
  const onThemeColorChange = useCallback(
    (color: string | null) => onEvent(id, { kind: 'themeColor', value: color }),
    [id, onEvent],
  );
  const onNavigate = useCallback(
    (url: string, canBack: boolean, canForward: boolean) =>
      onEvent(id, { kind: 'navigate', url, canBack, canForward }),
    [id, onEvent],
  );
  const onWebContentsId = useCallback(
    (wcId: number) => onEvent(id, { kind: 'webContentsId', value: wcId }),
    [id, onEvent],
  );
  const ref = useCallback(
    (handle: BrowserViewHandle | null) => onRegister(id, handle),
    [id, onRegister],
  );
  const onReady = useCallback(() => onDevtoolsReady(id), [id, onDevtoolsReady]);

  const docked = dock !== null && devtoolsWcId !== null;
  const side = dock === 'right';

  /** Clamp a pane size so both page and devtools stay usable. */
  const clampSize = useCallback(
    (size: number, vertical: boolean) => {
      const rect = containerRef.current?.getBoundingClientRect();
      const total = rect ? (vertical ? rect.height : rect.width) : undefined;
      const max =
        total === undefined
          ? size
          : Math.max(DEVTOOLS_MIN_SIZE, total - PAGE_MIN_SIZE);
      return Math.min(Math.max(size, DEVTOOLS_MIN_SIZE), max);
    },
    [],
  );

  const paneSize = side ? devtoolsWidth : devtoolsHeight;
  const commitPaneSize = side ? onDevtoolsResizeWidth : onDevtoolsResizeHeight;

  // The page area. A single BrowserView is always mounted (toggling the
  // device frame must not remount it - that would reload the page). When a
  // device preset is active it's wrapped in a fixed-size framed viewport,
  // centered in a scrollable backdrop; otherwise it fills the area.
  const pageArea = (
    <div
      className={cn(
        'relative min-h-0 min-w-0 flex-1',
        device ? 'grid place-items-center overflow-auto bg-muted/40 p-4' : undefined,
      )}
      // While dragging the divider, keep pointer events away from the
      // embedded surfaces so they can't swallow the drag.
      style={resizing ? { pointerEvents: 'none' } : undefined}
    >
      {device && (
        <span className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
          {device.name} &middot; {device.width}&times;{device.height}
          {device.deviceScaleFactor !== 1 && ` @${device.deviceScaleFactor}x`}
        </span>
      )}
      <div
        className={cn(
          device
            ? 'overflow-hidden rounded-[1.75rem] border-4 border-foreground/80 bg-background shadow-2xl'
            : 'absolute inset-0',
        )}
        style={
          device
            ? { width: device.width, height: device.height, maxWidth: '100%' }
            : undefined
        }
      >
        <BrowserView
          ref={ref}
          src={initialSrc}
          partition={partition}
          pageZoom={zoom}
          hidden={!active}
          onLoadStart={onLoadStart}
          onLoadEnd={onLoadEnd}
          onLoadError={onLoadError}
          onTitleChange={onTitleChange}
          onFaviconChange={onFaviconChange}
          onThemeColorChange={onThemeColorChange}
          onNavigate={onNavigate}
          onWebContentsId={onWebContentsId}
        />
      </div>
      {/* The custom new-tab page sits over the (blank) surface until the
          user picks a destination; navigating swaps in the real page. */}
      {isNewTab && (
        <NewTabPage
          isPrivate={isPrivate}
          sites={sites}
          onNavigate={(raw, typed) => onNavigateToUrl(id, raw, typed)}
          onPredict={onPredict}
          onOpenTab={onOpenTab}
          onOpenWindow={onOpenWindow}
        />
      )}
      {/* about:preferences, over the same kind of parked blank surface. */}
      {preferences && <PreferencesPage {...preferences} />}
      {/* about:bookmarks, the same way. */}
      {bookmarksPage && <BookmarksPage {...bookmarksPage} />}
      {/* A nostr: link's preview, the same way. */}
      {nostrUri && <NostrPage uri={nostrUri} />}
      {extensionsPage && (
        <ExtensionsPage key={extensionsPage} initial={extensionAddressOf(extensionsPage)} installed={installedExtensions} />
      )}
      {/* Untrusted-TLS warning, over the failed page until the user decides. */}
      {certError && (
        <CertificateWarning
          info={certError}
          onProceed={() => onTrustCertificate(certError)}
          onBack={() => onDismissCertError(id)}
        />
      )}
      {/* Network-level load error page (a cert warning takes precedence). */}
      {loadError && !certError && (
        <LoadErrorPage info={loadError} onRetry={() => onRetryLoad(id)} />
      )}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className={cn('absolute inset-0 flex', side ? 'flex-row' : 'flex-col')}
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
      {pageArea}

      {docked && (
        <>
          <div
            role="separator"
            aria-orientation={side ? 'vertical' : 'horizontal'}
            aria-label="Resize developer tools"
            tabIndex={0}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.setPointerCapture(e.pointerId);
              setResizing(true);
            }}
            onPointerMove={(e) => {
              if (!resizing) return;
              const rect = containerRef.current?.getBoundingClientRect();
              if (!rect) return;
              // The pane hugs the far edge; its size is the distance from the
              // pointer to that edge (right for 'right', bottom otherwise).
              const next = side
                ? clampSize(rect.right - e.clientX, false)
                : clampSize(rect.bottom - e.clientY, true);
              commitPaneSize(next);
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId);
              setResizing(false);
            }}
            onPointerCancel={() => setResizing(false)}
            onKeyDown={(e) => {
              const grow = side ? 'ArrowLeft' : 'ArrowUp';
              const shrink = side ? 'ArrowRight' : 'ArrowDown';
              if (e.key !== grow && e.key !== shrink) return;
              e.preventDefault();
              const delta = e.key === grow ? 24 : -24;
              commitPaneSize(clampSize(paneSize + delta, !side));
            }}
            className={cn(
              'shrink-0 touch-none bg-background',
              'hover:bg-foreground/[0.07] motion-safe:transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              side
                ? 'w-1.5 cursor-col-resize border-l border-border'
                : 'h-1.5 cursor-row-resize border-t border-border',
              resizing && 'bg-primary/40',
            )}
          />
          <div
            className="flex shrink-0 flex-col overflow-hidden"
            style={{
              [side ? 'width' : 'height']: paneSize,
              ...(resizing ? { pointerEvents: 'none' } : undefined),
            }}
          >
            <InspectorToolbar
              dock={side ? 'right' : 'bottom'}
              deviceId={deviceId}
              onSetDock={(mode) => onSetDock(id, mode)}
              onClose={() => onSetDock(id, 'closed')}
              onSelectDevice={(next) => onSelectDevice(id, next)}
            />
            <div className="min-h-0 flex-1">
              <DevToolsPane targetWcId={devtoolsWcId} onReady={onReady} />
            </div>
          </div>
        </>
      )}
    </div>
  );
});

/** Default sites on the new-tab page, until the user's most-visited sites
 * outrank them (see `topSites`). Icon URLs were resolved from each site's
 * web-app manifest (the best of manifest icons, apple-touch-icon, and
 * favicon); the brand color backs a monogram tile if an icon fails to load. */
const NEW_TAB_LINKS: TopSite[] = [
  {
    label: 'Soapbox',
    url: 'https://soapbox.pub/',
    icon: 'https://soapbox.pub/favicon/android-chrome-512x512.png',
    color: '#0482d8',
  },
  {
    label: 'Ditto',
    url: 'https://ditto.pub/',
    icon: 'https://ditto.pub/icon-512.png',
    color: '#7c3aed',
  },
  {
    label: 'NostrHub',
    url: 'https://nostrhub.io/',
    icon: 'https://nostrhub.io/icon-512.png',
    color: '#dc2626',
  },
  {
    label: 'Shakespeare',
    url: 'https://shakespeare.diy/',
    icon: 'https://shakespeare.diy/shakespeare-512x512.png',
    color: '#2b0037',
  },
  {
    label: 'Armada',
    url: 'https://armada.buzz/',
    icon: 'https://armada.buzz/logo-512.png',
    color: '#100b15',
  },
  {
    label: 'Agora',
    url: 'https://agora.spot/',
    icon: 'https://agora.spot/icon-512.png',
    color: '#ff6600',
  },
].map((link) => ({ ...link, appIcon: true }));

/** Two rows of tiles on the new-tab page (one while only defaults qualify). */
const NEW_TAB_SITE_COUNT = 12;
const NO_SITES: TopSite[] = [];

/** A stable color for a site's monogram, hashed from its label. */
function monogramColor(label: string): string {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 40%)`;
}

/** One site tile: a default site's app icon drawn edge to edge, or a visited
 * site's favicon on a plain tile, degrading to a colored monogram if there's
 * no image or it fails (offline, moved, blocked). */
function NewTabTile({
  link,
  onNavigate,
  onPredict,
  onOpenTab,
  onOpenWindow,
}: {
  link: TopSite;
  onNavigate: (url: string) => void;
  /** The pointer is on the tile, so a click may follow: connect ahead. */
  onPredict?: (url: string) => void;
  onOpenTab: (url: string) => void;
  onOpenWindow?: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  // An nsite's icon is the one Din read from its own files.
  const nsiteIcon = useNsiteIcon(link.nsiteHost);
  const raw = link.nsiteHost ? nsiteIcon : link.icon;
  const icon = raw ? sanitizeImageUrl(raw) : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={link.url}
          onClick={() => onNavigate(link.url)}
          onPointerEnter={() => onPredict?.(link.url)}
          className="group flex min-w-0 flex-col items-center gap-2 rounded-xl p-2 outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {failed || !icon ? (
            <span
              aria-hidden
              className="grid size-12 place-items-center rounded-2xl text-lg font-semibold uppercase text-white clay transition-transform motion-safe:group-hover:scale-105"
              style={{ backgroundColor: link.color ?? monogramColor(link.label) }}
            >
              {link.label[0]}
            </span>
          ) : link.appIcon ? (
            <img
              src={icon}
              alt=""
              aria-hidden
              draggable={false}
              onError={() => setFailed(true)}
              className="size-12 rounded-2xl object-cover clay transition-transform motion-safe:group-hover:scale-105"
            />
          ) : (
            <span
              aria-hidden
              className="grid size-12 place-items-center rounded-2xl bg-card clay transition-transform motion-safe:group-hover:scale-105"
            >
              <img
                src={icon}
                alt=""
                draggable={false}
                onError={() => setFailed(true)}
                className="size-7 object-contain"
              />
            </span>
          )}
          <span className="w-full truncate text-center text-[13px] text-foreground/80">
            {link.label}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => onNavigate(link.url)}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenTab(link.url)}>Open in New Tab</ContextMenuItem>
        {onOpenWindow && (
          <ContextMenuItem onSelect={() => onOpenWindow(link.url)}>Open in New Window</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(link.url).catch(() => {})}>
          Copy Link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The browser's new-tab page: a centered search box over quick-link tiles,
 * shown over a blank tab's surface until the user picks a destination.
 * Styled to match the desktop (the search box and address bar both feed the
 * same `resolveNavigation`, so typing here or in the address bar is
 * equivalent).
 */
function NewTabPage({
  isPrivate,
  sites,
  onNavigate,
  onPredict,
  onOpenTab,
  onOpenWindow,
}: {
  isPrivate: boolean;
  /** Most-visited sites, defaults included (see `topSites`). */
  sites: TopSite[];
  /** `typed` when it came from the search box rather than a tile. */
  onNavigate: (raw: string, typed?: boolean) => void;
  /** Where a click or Enter would go changed; lets the browser connect ahead. */
  onPredict?: (raw: string) => void;
  onOpenTab: (url: string) => void;
  onOpenWindow?: (url: string) => void;
}) {
  const [query, setQuery] = useState('');

  return (
    // Opaque: the white about:blank surface is underneath.
    <div className="@container absolute inset-0 flex flex-col items-center overflow-auto bg-background px-6 py-16 text-foreground [&>*]:shrink-0">
      <div className="flex w-full max-w-xl flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className={cn(
              'grid size-14 place-items-center rounded-full',
              isPrivate ? 'bg-foreground/10 text-foreground/80 clay' : 'bg-pigment text-primary-foreground clay-pigment',
            )}
          >
            {isPrivate ? (
              <VenetianMask className="size-7" strokeWidth={1.5} aria-hidden />
            ) : (
              <Globe className="size-7" strokeWidth={1.5} aria-hidden />
            )}
          </div>
          <h1 className="font-[family-name:var(--font-title)] text-4xl font-semibold tracking-tight">
            {isPrivate ? 'Private window' : 'New Tab'}
          </h1>
          {isPrivate && (
            <p className="max-w-sm text-center text-sm text-muted-foreground">
              Pages you open here won't be saved to your history, and cookies
              and site data are discarded when you close the last private
              window.
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onNavigate(query, true);
          }}
          className="relative w-full"
        >
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
            aria-hidden
          />
          <input
            type="text"
            inputMode="url"
            aria-label="Search or type a URL"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onPredict?.(e.target.value);
            }}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoComplete="off"
            className="glass-control h-12 w-full rounded-full bg-foreground/[0.06] pl-12 pr-4 text-base placeholder:text-muted-foreground outline-none focus-visible:bg-background focus-visible:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/60"
          />
        </form>

        {/* Top sites are omitted in private windows - a dashboard of where
            you've been clashes with the point of an ephemeral window. */}
        {!isPrivate && (
          <div className="mt-10 grid w-full grid-cols-3 gap-4 @2xl:grid-cols-6">
            {sites.map((link) => (
              <NewTabTile
                key={link.url}
                link={link}
                onNavigate={onNavigate}
                onPredict={onPredict}
                onOpenTab={onOpenTab}
                onOpenWindow={onOpenWindow}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Hostname of a URL, for tab labels before a title arrives. */
function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * What a tab calls itself in the strip: its page title, else the internal
 * page's own name, else the hostname it's loading, else "New tab".
 */
function tabLabel(tab: Tab): string {
  return (
    tab.title ?? internalPageTitle(tab.url) ?? hostnameOf(tab.url) ?? 'New tab'
  );
}

/**
 * The glyph a tab falls back to without a favicon. Internal pages never get
 * one (nothing loads), so they wear the icon of the thing they are.
 */
function TabGlyph({ tab, className }: { tab: Tab; className?: string }) {
  const Icon = tab.url === PREFERENCES_URL
    ? Settings
    : tab.url === BOOKMARKS_URL
      ? BookmarkGlyph
      : tab.url === EXTENSIONS_URL || extensionAddressOf(tab.url) ? Puzzle : isNostrUri(tab.url) ? AtSign : Globe;
  return <Icon className={className} aria-hidden />;
}

/**
 * The Chrome extension toolbar actions (<browser-action-list>, a custom
 * element injected by electron-chrome-extensions' preload).
 *
 * Its configuration must be set as DOM attributes imperatively: the element
 * only exposes getter properties backed by attributes, and React assigns to
 * properties when they exist (`key in element`), which would bypass the
 * attribute the element actually reads.
 */
function BrowserActionList({ tabWcId }: { tabWcId: number | null }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('partition', 'persist:webbrowser');
    el.setAttribute('alignment', 'bottom right');
    if (tabWcId !== null) el.setAttribute('tab', String(tabWcId));
    else el.removeAttribute('tab');
  }, [tabWcId]);

  return <browser-action-list ref={ref} className="flex shrink-0 items-center" />;
}

/**
 * The browser's overflow menu (the toolbar's menu button): one popover for the
 * controls that don't each warrant a toolbar button - opening a new or private
 * window, find-in-page, page source, developer tools, clearing browsing data -
 * plus a way into the settings page.
 *
 * Deliberately actions-only and one screenful short. Everything with a body to
 * it (extensions, userscripts, preferences) lives on about:preferences
 * instead; when those sections were inline the popover could outgrow a short
 * window and get clipped off the bottom of the screen.
 */
function BrowserMenu({
  showFind,
  findDisabled,
  onFind,
  viewSourceDisabled,
  onViewSource,
  printDisabled,
  onPrint,
  hasDevtools,
  devtoolsActive,
  devtoolsDisabled,
  onToggleDevtools,
  onNewWindow,
  onNewPrivateWindow,
  showClearData,
  onClearBrowsingData,
  onOpenPreferences,
  onOpenBookmarks,
  bookmarksBarShown,
  onToggleBookmarksBar,
  showExtensions,
  onOpenExtensions,
}: {
  /** Show the find-in-page item (webview mode). */
  showFind: boolean;
  findDisabled: boolean;
  onFind: () => void;
  /** No source to show (a blank tab, internal page, or source view). */
  viewSourceDisabled: boolean;
  onViewSource: () => void;
  /** No page to print (a blank or internal tab). */
  printDisabled: boolean;
  onPrint: () => void;
  /** Whether the docked-devtools control is available (webview mode). */
  hasDevtools: boolean;
  devtoolsActive: boolean;
  devtoolsDisabled: boolean;
  onToggleDevtools: () => void;
  onNewWindow: () => void;
  onNewPrivateWindow: () => void;
  /** Show the "Clear browsing data" item (hidden in private windows). */
  showClearData: boolean;
  onClearBrowsingData: () => void;
  /** Open the about:preferences tab. */
  onOpenPreferences: () => void;
  /** Open the about:bookmarks tab. */
  onOpenBookmarks: () => void;
  /** Whether the bookmarks bar shows under every page. */
  bookmarksBarShown: boolean;
  onToggleBookmarksBar: () => void;
  /** Show the Extensions item (extensions never run in private windows). */
  showExtensions: boolean;
  /** Open the about:extensions tab. */
  onOpenExtensions: () => void;
}) {
  const item = (Icon: LucideIcon, label: string, onSelect: () => void, shortcut?: string, disabled?: boolean) => (
    <DropdownMenuItem disabled={disabled} onSelect={onSelect}>
      <Icon aria-hidden />
      {label}
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton label="Browser menu">
          <BarsStaggeredIcon className="size-4.5" />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-72">
        {item(SquarePlus, 'New Window', onNewWindow, 'Ctrl+N')}
        {item(VenetianMask, 'New Private Window', onNewPrivateWindow, 'Ctrl+Shift+N')}
        <DropdownMenuSeparator />
        {item(Library, 'Bookmarks', onOpenBookmarks, 'Ctrl+Shift+O')}
        <DropdownMenuCheckboxItem checked={bookmarksBarShown} onCheckedChange={onToggleBookmarksBar}>
          Show Bookmarks Bar
          <DropdownMenuShortcut>Ctrl+Shift+B</DropdownMenuShortcut>
        </DropdownMenuCheckboxItem>
        {showFind && (
          <>
            <DropdownMenuSeparator />
            {item(Search, 'Find in Page…', onFind, 'Ctrl+F', findDisabled)}
            {item(Printer, 'Print…', onPrint, 'Ctrl+P', printDisabled)}
            {item(FileCode, 'View Page Source', onViewSource, 'Ctrl+U', viewSourceDisabled)}
          </>
        )}
        {hasDevtools && (
          <DropdownMenuCheckboxItem checked={devtoolsActive} disabled={devtoolsDisabled} onCheckedChange={onToggleDevtools}>
            Developer Tools
            <DropdownMenuShortcut>F12</DropdownMenuShortcut>
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuSeparator />
        {showClearData && item(Trash2, 'Clear Browsing Data…', onClearBrowsingData, 'Ctrl+Shift+Del')}
        {showExtensions && item(Puzzle, 'Extensions', onOpenExtensions)}
        {item(Settings, 'Settings', onOpenPreferences)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Clear browsing data" dialog. Purges the app's own address-bar history
 * (encrypted Nostr app data) and/or Chromium-side state for the persistent
 * browser session - cookies + site storage, and the HTTP cache. Only offered
 * in non-private windows; the private session is ephemeral and self-clears
 * when its last window closes.
 *
 * Outside the Electron shell (`dev:browser`) there's no bridge, so the
 * Chromium-side options are disabled; clearing history still works.
 */
function ClearBrowsingDataDialog({
  open,
  onOpenChange,
  bridge,
  onClearHistory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bridge: BrowserBridge | undefined;
  onClearHistory: () => void;
}) {
  const { toast } = useToast();
  const [history, setHistory] = useState(true);
  // The Chromium-side options need the shell bridge; default them off when it's
  // absent so the user can't arm a purge that can't run.
  const [cookies, setCookies] = useState(!!bridge);
  const [cache, setCache] = useState(!!bridge);
  const [clearing, setClearing] = useState(false);

  const nothingSelected = !history && !cookies && !cache;

  const handleClear = async () => {
    setClearing(true);
    try {
      if (history) onClearHistory();
      if (bridge && (cookies || cache)) {
        await bridge.clearBrowsingData({ cookies, cache });
      }
      toast({ title: 'Browsing data cleared' });
      onOpenChange(false);
    } catch {
      toast({
        title: "Couldn't clear browsing data",
        variant: 'destructive',
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clear browsing data</DialogTitle>
          <DialogDescription>
            Choose what to remove. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <ClearDataOption
            id="clear-history"
            label="Browsing history"
            description="Sites in this browser's address-bar suggestions."
            checked={history}
            onCheckedChange={setHistory}
          />
          <ClearDataOption
            id="clear-cookies"
            label="Cookies and site data"
            description="Signs you out of most sites, installed apps too, and clears their stored data."
            checked={cookies}
            onCheckedChange={setCookies}
            disabled={!bridge}
          />
          <ClearDataOption
            id="clear-cache"
            label="Cached files and images"
            description="Frees up space; sites may load more slowly next time."
            checked={cache}
            onCheckedChange={setCache}
            disabled={!bridge}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={clearing}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleClear}
            disabled={nothingSelected || clearing}
          >
            Clear data
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled checkbox row in the {@link ClearBrowsingDataDialog}. */
function ClearDataOption({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-50')}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

/**
 * Toolbar button + popover to install the current site as a desktop app,
 * like installing a PWA on other OSes. An https site becomes a web app; an
 * nsite is installed into the OS-level nsite store by its canonical host, with
 * its name and icon read from its own files (see src/lib/nsiteAppInfo.ts).
 */
function InstallSiteButton({
  url,
  pageTitle,
  favicon,
  themeColor,
  collectIcons,
  collectNostrHandler,
}: {
  url: string;
  pageTitle: string | null;
  favicon: string | null;
  themeColor: string | null;
  collectIcons: () => Promise<IconCandidate[]>;
  collectNostrHandler: () => Promise<NostrHandler | null>;
}) {
  const { installWebApp, findWebAppByUrl, installNsiteApp, findNsiteApp, getApp } =
    useInstalledApps();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // An nsite's own name for itself, so a name the user didn't change isn't
  // saved over it (and later versions of the site can rename the app).
  const [derivedName, setDerivedName] = useState<string | null>(null);
  const nameEdited = useRef(false);
  // nsites can only be installed where Din's nsite store exists.
  const nsiteHost = getNsiteStore() ? canonicalHostOfUrl(url) : null;
  // The best icon resolved from the page's link/manifest hints (prefers SVG),
  // filled in asynchronously when the popover opens. Null until resolved, so
  // the preview shows the reported-favicon baseline in the meantime.
  const [resolvedIcon, setResolvedIcon] = useState<string | null>(null);
  // How the site opens nostr: links, read from its manifest with the icons.
  const [nostrHandler, setNostrHandler] = useState<NostrHandler | null>(null);

  const site = useMemo(() => {
    if (nsiteHost) {
      return {
        url: nsiteAppUrl(nsiteHost),
        hostname: nsiteHost,
        icon: '',
      };
    }
    const safe = sanitizeUrl(url);
    if (!safe) return null;
    const { hostname, origin } = new URL(safe);
    return {
      url: safe,
      hostname,
      // Prefer the favicon the page reported; fall back to the site root's
      // conventional /favicon.ico (AppIcon degrades to a glyph on 404).
      icon: (favicon && sanitizeImageUrl(favicon)) || `${origin}/favicon.ico`,
    };
  }, [url, favicon, nsiteHost]);

  const installed = nsiteHost
    ? findNsiteApp(nsiteHost) && getApp(nsiteAppId(nsiteHost))
    : site
      ? findWebAppByUrl(site.url)
      : undefined;
  // Prefer the higher-quality icon resolved from the page's hints, falling
  // back to the reported-favicon baseline until (or unless) that resolves.
  const effectiveIcon = resolvedIcon ?? site?.icon ?? '';

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setName(pageTitle ?? site?.hostname ?? '');
    setResolvedIcon(null);
    setDerivedName(null);
    nameEdited.current = false;
    const store = getNsiteStore();
    if (nsiteHost && store) {
      store
        .info(nsiteHost)
        .then((summary) => (summary ? ensureNsiteAppInfo(store, summary).then((info) => ({ summary, info })) : null))
        .then((found) => {
          if (!found) return;
          const declared = found.info?.name ?? found.summary.title;
          if (found.info?.icon) setResolvedIcon(found.info.icon);
          if (declared) {
            setDerivedName(declared);
            if (!nameEdited.current) setName(declared);
          }
        })
        .catch(() => {
          /* Leave the page title in place. */
        });
    } else if (site) {
      const forSite = site.url;
      collectIcons()
        .then((candidates) => setResolvedIcon(pickBestIcon(candidates, forSite, favicon)))
        .catch(() => {
          /* Leave the baseline icon in place. */
        });
      setNostrHandler(null);
      collectNostrHandler()
        .then(setNostrHandler)
        .catch(() => {
          /* Installed without one. */
        });
    }
  };

  const install = () => {
    if (!site) return;
    if (nsiteHost) {
      const entry = installNsiteApp(
        nsiteHost,
        name.trim() && name.trim() !== derivedName ? name : undefined,
      );
      if (!entry) return;
      setOpen(false);
      toast({
        title: `${name.trim() || derivedName || site.hostname} installed`,
        description:
          'Find it in the app launcher. Its files are downloading, so it will work offline too.',
      });
      return;
    }
    // Capture the page's theme color (normalized) so the installed app's
    // window opens pre-tinted instead of flashing default chrome.
    const webApp = installWebApp({
      name,
      url: site.url,
      icon: effectiveIcon,
      themeColor: normalizeThemeColor(themeColor) ?? undefined,
      nostr: nostrHandler ?? undefined,
    });
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
            toolButtonClass,
                      )}
        >
          <MonitorDown {...toolIcon} />
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
              <AppIcon icon={effectiveIcon} className="size-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Label htmlFor="install-app-name" className="text-xs">
                  App name
                </Label>
                <Input
                  id="install-app-name"
                  value={name}
                  onChange={(e) => {
                    nameEdited.current = true;
                    setName(e.target.value);
                  }}
                  placeholder={derivedName ?? site.hostname}
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
  title,
  onClick,
  disabled,
  pressed,
  children,
}: {
  label: string;
  /** Tooltip text (defaults to the accessible label). */
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** Toggle-button state (e.g. the devtools button while its pane is open). */
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <ToolButton label={label} title={title ?? label} onClick={onClick} disabled={disabled} pressed={pressed}>
      {children}
    </ToolButton>
  );
}

