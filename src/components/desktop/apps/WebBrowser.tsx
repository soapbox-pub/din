import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Code,
  EllipsisVertical,
  Globe,
  History,
  MonitorDown,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  ShieldAlert,
  SquarePlus,
  Trash2,
  VenetianMask,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveNavigation, sanitizeImageUrl, sanitizeUrl } from '@/lib/sanitizeUrl';
import { pickBestIcon, type IconCandidate } from '@/lib/appIcon';
import { getCrxBridge, isAllowedTabUrl, crxIconUrl, type CrxExtension } from '@/lib/crx';
import {
  getUserscriptsBridge,
  isUserscriptUrl,
  type Userscript,
} from '@/lib/userscripts';
import { getDevtoolsBridge } from '@/lib/devtools';
import {
  getBrowserBridge,
  type BrowserBridge,
  type CertificateErrorInfo,
  type FindResult,
} from '@/lib/browser';
import { getShellShortcuts } from '@/lib/shellShortcuts';
import { consumeTabCommands, consumeBrowserHotkeys } from '@/lib/browserTabBus';
import { consumeInspectorDock } from '@/lib/inspectorBus';
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
import { Switch } from '@/components/ui/switch';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useWindowAccent } from '@/contexts/WindowAccentContext';
import { isDarkThemeColor, normalizeThemeColor } from '@/lib/themeColor';
import { useToast } from '@/hooks/useToast';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import {
  bareUrl,
  matchHistory,
  useBrowserHistory,
  type BrowserHistoryEntry,
} from '@/hooks/useBrowserHistory';
import {
  BrowserView,
  WEBBROWSER_PRIVATE_PARTITION,
  type BrowserViewHandle,
} from '@/components/desktop/apps/BrowserView';
import { Separator } from '@/components/ui/separator';
import { DevToolsPane } from '@/components/desktop/apps/DevToolsPane';
import { useUserscripts } from '@/hooks/useUserscripts';
import {
  UserscriptsSection,
  UserscriptInstallDialog,
  type UserscriptInstallRequest,
} from '@/components/desktop/apps/UserscriptManager';
import {
  InspectorToolbar,
  type DockMode,
} from '@/components/desktop/apps/InspectorToolbar';
import { findDevicePreset, type DevicePreset } from '@/lib/devicePresets';

const HOME_URL = 'https://en.wikipedia.org/wiki/Main_Page';
const WEB_STORE_URL = 'https://chromewebstore.google.com/';

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

/** Devtools pane sizing (px): default, minimum, and minimum page size. */
const DEVTOOLS_DEFAULT_HEIGHT = 288;
const DEVTOOLS_DEFAULT_WIDTH = 400;
const DEVTOOLS_MIN_SIZE = 120;
const PAGE_MIN_SIZE = 96;

let nextTabId = 0;
const newTabId = () => `tab-${nextTabId++}`;

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
}

function createTab(
  url: string,
  pendingRequestId: number | null = null,
  parentId: string | null = null,
): Tab {
  // A blank new tab shows an empty address bar (ready to type), even though
  // its surface loads about:blank.
  const blank = url === NEW_TAB_URL;
  return {
    id: newTabId(),
    parentId,
    initialSrc: url,
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
  };
}

/** Events a tab surface reports up to the browser. */
type TabEvent =
  | { kind: 'loading'; value: boolean }
  | { kind: 'title'; value: string }
  | { kind: 'favicon'; value: string | null }
  | { kind: 'themeColor'; value: string | null }
  | { kind: 'navigate'; url: string; canBack: boolean; canForward: boolean }
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
  const [tabs, setTabs] = useState<Tab[]>(() => [createTab(NEW_TAB_URL)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
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
  // Tree-tabs mode: a vertical sidebar of tabs nested by opener, shared
  // across every browser window (a plain browser preference).
  const [treeTabs, setTreeTabs] = useLocalStorage('din:browser:tree-tabs', false);
  // Collapsed subtrees in the tree sidebar (by tab id).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const crx = getCrxBridge();
  const devtools = getDevtoolsBridge();
  const userscriptsBridge = getUserscriptsBridge();
  // The userscript library: persisted per-device, synced to the injector in
  // the main process. The bridge's absence hides all userscript UI.
  const {
    scripts: userscriptList,
    install: installUserscript,
    remove: removeUserscript,
    setEnabled: setUserscriptEnabled,
  } = useUserscripts();
  // A pending userscript install prompt (source + origin) for the dialog.
  const [scriptInstall, setScriptInstall] = useState<UserscriptInstallRequest | null>(null);
  // Whether the "Clear browsing data" dialog is open (non-private windows).
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const { toast } = useToast();
  const webviewMode = isWebviewAvailable();
  // Persistent browsing history (feeds address-bar autocomplete).
  const { history: browsingHistory, recordVisit, recordTitle, clearHistory } =
    useBrowserHistory();
  // One docked-pane size per browser window, shared across tabs (like desktop
  // browsers): height for bottom docking, width for right docking. Resized by
  // dragging the pane's separator.
  const [devtoolsHeight, setDevtoolsHeight] = useState(DEVTOOLS_DEFAULT_HEIGHT);
  const [devtoolsWidth, setDevtoolsWidth] = useState(DEVTOOLS_DEFAULT_WIDTH);
  // The dock position to restore to when reopening the inspector.
  const lastDock = useRef<Exclude<DockMode, 'closed'>>('bottom');
  // Context-menu "Inspect" coordinates awaiting a tab's devtools to open.
  const pendingInspect = useRef(new Map<string, { x: number; y: number }>());

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];

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

  const openTab = useCallback(
    (
      url: string,
      activate = true,
      pendingRequestId: number | null = null,
      parentId: string | null = null,
    ) => {
      const tab = createTab(url, pendingRequestId, parentId);
      setTabs((ts) => [...ts, tab]);
      if (activate) setActiveId(tab.id);
      return tab.id;
    },
    [],
  );

  /** Focus (and select) the address bar - Ctrl+L / clicking a blank tab. */
  const focusAddress = useCallback(() => {
    const input = addressRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  /**
   * Open a fresh blank tab and drop the cursor in the empty address bar,
   * ready to type (the new-tab button and Ctrl+T). Focus waits a frame for
   * the address bar to reflect the newly-activated tab.
   */
  const openNewTab = useCallback(() => {
    openTab(NEW_TAB_URL);
    requestAnimationFrame(focusAddress);
  }, [openTab, focusAddress]);

  const closeTab = useCallback(
    (id: string) => {
      views.current.delete(id);
      pendingInspect.current.delete(id);
      const ts = tabsRef.current;
      const closed = ts.find((t) => t.id === id);
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
      setTabs(next);
      setActiveId((current) =>
        current === id ? next[Math.max(0, index - 1)].id : current,
      );
    },
    [closeWindow, windowId, devtools],
  );

  // The browser opens on a blank tab; drop the cursor in the address bar so
  // the user can type a destination straight away. Runs once on mount.
  useEffect(() => {
    focusAddress();
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
        onActivate={setActiveId}
        onCloseTab={closeTab}
        onNewTab={openNewTab}
      />,
    );
    return () => setTitlebar(null);
  }, [treeTabs, tabs, activeId, closeTab, openNewTab, setTitlebar]);

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

  // Tint the window chrome with the chrome color. The Window sanitizes the raw
  // value; null restores the default.
  const setAccent = useWindowAccent();
  useEffect(() => {
    setAccent(chromeColor);
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
          break;
        case 'title': {
          updateTab(id, { title: event.value || null });
          // Join the title onto the history entry for the tab's current URL.
          // Private windows never touch browsing history.
          const tab = tabsRef.current.find((t) => t.id === id);
          if (!isPrivate && tab?.url && event.value) recordTitle(tab.url, event.value);
          break;
        }
        case 'favicon':
          updateTab(id, { favicon: event.value });
          break;
        case 'themeColor':
          updateTab(id, { themeColor: event.value });
          break;
        case 'navigate':
          updateTab(id, {
            url: event.url === NEW_TAB_URL ? '' : event.url,
            address: event.url === NEW_TAB_URL ? '' : event.url,
            canBack: event.canBack,
            canForward: event.canForward,
          });
          // A committed navigation means the load succeeded, so any pending
          // certificate warning for this tab no longer applies (a rejected
          // load never commits). Clear it.
          clearCertError(tabsRef.current.find((t) => t.id === id)?.wcId ?? null);
          // Webview mode sees every committed navigation here (link clicks,
          // redirects, back/forward); recordVisit ignores non-https URLs
          // (about:blank, chrome-extension://). The iframe fallback never
          // fires this event - it records in navigateTab / go instead.
          // Private windows keep no history.
          if (!isPrivate) recordVisit(event.url);
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
    [updateTab, crx, recordVisit, recordTitle, clearCertError, isPrivate],
  );

  // Surface untrusted-TLS reports from the main process on the offending tab.
  useEffect(() => {
    if (!browserBridge) return;
    return browserBridge.onCertificateError((info) => {
      setCertErrors((prev) => new Map(prev).set(info.wcId, info));
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
          if (!isAllowedTabUrl(command.url)) break;
          const existing = tabsRef.current;
          // A fresh browser holds a single blank placeholder tab. Load the
          // link straight into it rather than stacking a new tab on top; only
          // spawn a separate tab once there's real browsing to preserve.
          // Either way the link is a top-level tab, never nested under
          // whatever happens to be active (unlike chrome.tabs.create above).
          const soloBlank =
            existing.length === 1 &&
            existing[0].initialSrc === NEW_TAB_URL &&
            existing[0].url === '';
          if (soloBlank) {
            const tab = createTab(command.url);
            setTabs([tab]);
            setActiveId(tab.id);
          } else {
            openTab(command.url, true, null, null);
          }
          // A link opened in this window (target=_blank, a desktop link
          // click) must bring it forward - the user clicked expecting to
          // look at the result, not to hunt for the window.
          focusWindow(windowId);
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
    }, (wcId) => tabsRef.current.some((t) => t.wcId === wcId));
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
        case 'inspect':
          setActiveId(tab.id);
          if (tab.dock !== 'closed' && tab.wcId !== null) {
            devtools.inspect(tab.wcId, command.x, command.y).catch(() => {});
          } else {
            pendingInspect.current.set(tab.id, { x: command.x, y: command.y });
            setDock(tab.id, lastDock.current);
          }
          break;
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
        .then((code) => setScriptInstall({ code, url }))
        .catch((error: unknown) => {
          toast({
            title: "Couldn't download userscript",
            description: error instanceof Error ? error.message : undefined,
            variant: 'destructive',
          });
        });
    },
    [userscriptsBridge, toast],
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

  /** Install from the review dialog; closes it and toasts on success. */
  const installUserscriptFromDialog = useCallback(
    (code: string, downloadUrl?: string) => {
      try {
        const script = installUserscript(code, downloadUrl);
        setScriptInstall(null);
        toast({
          title: `${script.name} installed`,
          description: 'It runs on matching pages from their next load.',
        });
      } catch (error) {
        toast({
          title: "Couldn't install userscript",
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
      }
    },
    [installUserscript, toast],
  );

  const navigateTab = useCallback(
    (id: string, raw: string) => {
      const resolved = resolveNavigation(raw);
      if (!resolved) return;
      // A .user.js address is a script install, not a page visit (mirrors
      // the main process's will-navigate intercept for link clicks).
      if (userscriptsBridge && isUserscriptUrl(resolved)) {
        promptUserscriptInstall(resolved);
        return;
      }
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
        };
      });
      views.current.get(id)?.loadURL(resolved);
      // The iframe fallback emits no navigate events, so record here (never
      // in a private window).
      if (!webviewMode && !isPrivate) recordVisit(resolved);
    },
    [updateTab, webviewMode, recordVisit, userscriptsBridge, promptUserscriptInstall, isPrivate],
  );

  const navigate = useCallback(
    (raw: string) => navigateTab(activeId, raw),
    [navigateTab, activeId],
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
      view.loadURL(url);
      updateTab(id, { cursor: target, address: url, url, title: null, favicon: null, themeColor: null });
      if (!isPrivate) recordVisit(url);
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

  /** Activate the next/previous tab (Ctrl+Tab / Ctrl+Shift+Tab), wrapping. */
  const cycleTab = useCallback((backward: boolean) => {
    const ts = tabsRef.current;
    if (ts.length < 2) return;
    const index = ts.findIndex((t) => t.id === activeIdRef.current);
    const next = (index + (backward ? -1 : 1) + ts.length) % ts.length;
    setActiveId(ts[next].id);
  }, []);

  /** Activate a tab by 1-based position; 9 jumps to the last tab (Chrome). */
  const gotoTabDigit = useCallback((digit: number) => {
    const ts = tabsRef.current;
    const tab = digit === 9 ? ts[ts.length - 1] : ts[digit - 1];
    if (tab) setActiveId(tab.id);
  }, []);

  const canBack = webviewMode ? activeTab.canBack : activeTab.cursor > 0;
  const canForward = webviewMode
    ? activeTab.canForward
    : activeTab.cursor < activeTab.history.length - 1;

  // Tint the toolbar with the active tab's theme color, matching the title
  // bar (the Window tints it from the same value via useWindowAccent). The
  // theme tokens are mapped with `@theme inline`, so overriding them locally
  // re-themes every toolbar control to keep contrast on the arbitrary color.
  const accent = normalizeThemeColor(chromeColor);
  const accentDark = accent !== null && isDarkThemeColor(accent);
  const toolbarTint = accent
    ? ({
        backgroundColor: accent,
        '--foreground': accentDark ? '#ffffff' : '#000000',
        '--muted-foreground': accentDark
          ? 'rgb(255 255 255 / 0.7)'
          : 'rgb(0 0 0 / 0.6)',
        '--border': accentDark ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.15)',
        '--secondary': accentDark ? 'rgb(255 255 255 / 0.15)' : 'rgb(0 0 0 / 0.06)',
      } as React.CSSProperties)
    : undefined;

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
      }
    });
  }, [
    windowId,
    openNewTab,
    closeTab,
    focusAddress,
    openFind,
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
      // Window cycling and screenshot keys are desktop-wide; DesktopHotkeys owns them.
      if (
        shortcut.action === 'cycle-windows' ||
        shortcut.action === 'screenshot' ||
        shortcut.action === 'screenshot-area'
      ) {
        return;
      }
      const tab = tabsRef.current.find((t) => t.wcId === shortcut.wcId);
      if (!tab) return;
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
      }
    });
  }, [
    openNewTab,
    closeTab,
    focusAddress,
    openFind,
    reloadTab,
    cycleTab,
    gotoTabDigit,
    goTab,
  ]);

  return (
    <div className="flex h-full w-full flex-col" onKeyDown={onToolbarKeyDown}>
      {/* Toolbar: spans the full width across the top, sitting *over* the
          tree-tabs sidebar and the page surface (not beside the tabs). In the
          horizontal-strip mode the tabs live in the title bar, so this is
          simply the toolbar above the surface. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(activeTab.address);
        }}
        style={toolbarTint}
        className={cn(
          'relative flex shrink-0 items-center gap-1 border-b px-2 py-1.5',
          // The overridden --border already carries its own alpha; the
          // default keeps the token at 60%.
          accent ? 'border-border' : 'border-border/60 bg-background/50',
        )}
      >
        <NavButton label="Go back" disabled={!canBack} onClick={() => go(-1)}>
          <ArrowLeft className="size-4" />
        </NavButton>
        <NavButton label="Go forward" disabled={!canForward} onClick={() => go(1)}>
          <ArrowRight className="size-4" />
        </NavButton>
        <NavButton label="Reload page" onClick={() => views.current.get(activeId)?.reload()}>
          <RotateCw className={cn('size-4', activeTab.loading && 'animate-spin')} />
        </NavButton>

        <AddressBar
          inputRef={addressRef}
          tabId={activeId}
          value={activeTab.address}
          history={browsingHistory}
          onChangeValue={(text) => updateTab(activeId, { address: text })}
          onNavigate={navigate}
        />

        {/* Extension action icons are hidden in private windows (extensions
            don't run in the ephemeral private session). */}
        {crx && !isPrivate && <BrowserActionList tabWcId={activeTab.wcId} />}

        {isPrivate && (
          <span
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-secondary/60 px-2.5 py-1 text-xs font-medium text-foreground/80"
            title="Private window - history and cookies are discarded when it closes"
          >
            <VenetianMask className="size-3.5" aria-hidden />
            Private
          </span>
        )}

        <InstallSiteButton
          url={activeTab.url}
          pageTitle={activeTab.title}
          favicon={activeTab.favicon}
          themeColor={activeTab.themeColor}
          collectIcons={() =>
            views.current.get(activeTab.id)?.collectIcons() ?? Promise.resolve([])
          }
        />

        {/* One overflow menu gathers the browser's less-frequent controls:
            new/private windows, find-in-page, developer tools, extensions,
            and settings. */}
        <BrowserMenu
          showExtensions={!isPrivate && (!!crx || !!userscriptsBridge)}
          onOpenUrl={(url) => openTab(url)}
          userscripts={userscriptsBridge ? userscriptList : null}
          onSetUserscriptEnabled={setUserscriptEnabled}
          onRemoveUserscript={(script) => {
            removeUserscript(script.id);
            toast({ title: `${script.name} removed` });
          }}
          onAddUserscript={() => setScriptInstall({ code: '' })}
          treeTabs={treeTabs}
          onTreeTabsChange={setTreeTabs}
          showFind={webviewMode}
          findDisabled={activeTab.wcId === null}
          onFind={openFind}
          hasDevtools={!!devtools}
          devtoolsActive={activeTab.dock !== 'closed'}
          devtoolsDisabled={activeTab.wcId === null}
          onToggleDevtools={() => toggleDevtools(activeId)}
          onNewWindow={() => openWindow('web-browser')}
          onNewPrivateWindow={() => openWindow('web-browser', { private: true })}
          showClearData={!isPrivate}
          onClearBrowsingData={() => setClearDataOpen(true)}
        />

        {activeTab.loading && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary"
          />
        )}
      </form>

      {/* Body: the tree-tabs sidebar (when enabled) beside the page surface,
          both sitting below the full-width toolbar. In the horizontal-strip
          mode the tabs live in the title bar, so this is just the surface. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {treeTabs && (
          <TreeTabStrip
            tabs={tabs}
            activeId={activeId}
            collapsed={collapsed}
            onActivate={setActiveId}
            onCloseTab={closeTab}
            onNewTab={openNewTab}
            onToggleCollapsed={toggleCollapsed}
            onMoveTab={moveTab}
            onMoveTabToEnd={moveTabToEnd}
          />
        )}

        {/* Tab surfaces: all stay mounted so background tabs keep their state;
            only the active one is visible. (visibility, not display:none -
            Electron <webview>s misbehave when display is toggled.) */}
        <div className="relative min-w-0 flex-1 overflow-hidden bg-white">
        {tabs.map((tab) => (
          <TabSurface
            key={tab.id}
            id={tab.id}
            initialSrc={tab.initialSrc}
            partition={tabPartition}
            isPrivate={isPrivate}
            active={tab.id === activeId}
            // A blank tab (empty url) shows the custom new-tab page overlaid
            // on its (about:blank) surface until the user navigates.
            isNewTab={tab.url === ''}
            onNavigate={navigateTab}
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

      <UserscriptInstallDialog
        request={scriptInstall}
        onOpenChange={(open) => {
          if (!open) setScriptInstall(null);
        }}
        onInstall={installUserscriptFromDialog}
      />

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
 */
function AddressBar({
  inputRef,
  tabId,
  value,
  history,
  onChangeValue,
  onNavigate,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** Active tab id; switching tabs dismisses the dropdown. */
  tabId: string;
  value: string;
  history: BrowserHistoryEntry[];
  onChangeValue: (text: string) => void;
  onNavigate: (raw: string) => void;
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    } else if (e.key === 'Escape' && show) {
      e.preventDefault();
      dismiss();
      onChangeValue(typed);
    } else if (e.key === 'Enter') {
      // The surrounding form submits the current value; just close.
      dismiss();
    }
  };

  return (
    <div className="relative flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/80" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        inputMode="url"
        role="combobox"
        aria-label="Address and search bar"
        aria-expanded={show}
        aria-autocomplete="list"
        aria-controls="address-bar-suggestions"
        aria-activedescendant={
          highlighted >= 0 ? `address-bar-suggestion-${highlighted}` : undefined
        }
        value={value}
        onChange={(e) => {
          const text = e.target.value;
          setTyped(text);
          setHighlighted(-1);
          setOpen(text.trim().length > 0);
          onChangeValue(text);
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={dismiss}
        placeholder="Search or type a URL"
        spellCheck={false}
        autoComplete="off"
        className="h-8 w-full rounded-full border border-border/60 bg-secondary/80 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
      {show && (
        <ul
          id="address-bar-suggestions"
          role="listbox"
          aria-label="History suggestions"
          // Keep focus in the input so item clicks land before blur closes.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-border/60 bg-popover py-1 text-popover-foreground shadow-lg"
        >
          {suggestions.map((entry, i) => (
            <li
              key={entry.url}
              id={`address-bar-suggestion-${i}`}
              role="option"
              aria-selected={i === highlighted}
              onClick={() => {
                dismiss();
                onNavigate(entry.url);
              }}
              className={cn(
                'flex cursor-default items-center gap-2.5 px-3 py-1.5 text-sm',
                i === highlighted
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50',
              )}
            >
              <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 max-w-[50%] truncate">
                {entry.title ?? hostnameOf(entry.url) ?? entry.url}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {bareUrl(entry.url)}
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
      className="absolute right-3 top-2 z-30 flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover px-1.5 py-1 text-popover-foreground shadow-lg"
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
          'h-7 w-44 rounded-md bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground',
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
        <ChevronUp className="size-4" />
      </FindBarButton>
      <FindBarButton label="Next match" disabled={!text} onClick={onNext}>
        <ChevronDown className="size-4" />
      </FindBarButton>
      <FindBarButton label="Close find bar" onClick={onClose}>
        <X className="size-4" />
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
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md text-foreground/80',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
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
  onNewTab,
}: {
  tabs: Tab[];
  activeId: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onCloseTab(tab.id)}
        />
      ))}
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={onNewTab}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md text-foreground/70',
          'hover:bg-foreground/10 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** A single tab in the tab strip. */
function TabButton({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const label = tab.title ?? hostnameOf(tab.url) ?? 'New tab';
  const icon = tab.favicon ? sanitizeImageUrl(tab.favicon) : null;

  return (
    <div
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
        // Middle-click closes, like every browser.
        if (e.button === 1) onClose();
      }}
      title={label}
      className={cn(
        'group flex h-7 w-44 min-w-0 shrink-0 cursor-default items-center gap-2 rounded-md border px-2.5 text-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-border/60 bg-background text-foreground shadow-sm'
          : 'border-transparent bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {icon ? (
        <img src={icon} alt="" aria-hidden className="size-4 shrink-0 rounded-sm" />
      ) : (
        <Globe className="size-4 shrink-0 opacity-60" aria-hidden />
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
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
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
  onNewTab,
  onToggleCollapsed,
  onMoveTab,
  onMoveTabToEnd,
}: {
  tabs: Tab[];
  activeId: string;
  collapsed: Set<string>;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onToggleCollapsed: (id: string) => void;
  onMoveTab: (dragId: string, targetId: string, position: DropZone) => void;
  onMoveTabToEnd: (dragId: string) => void;
}) {
  const rows = useMemo(() => flattenTabTree(tabs, collapsed), [tabs, collapsed]);
  // The tab currently being dragged, or null. Shared across rows so a row can
  // tell whether it's a valid drop target (and skip itself).
  const [dragId, setDragId] = useState<string | null>(null);
  // A drag is hovering the trailing (move-to-top-level) drop zone.
  const [endHover, setEndHover] = useState(false);
  return (
    <div
      role="tablist"
      aria-label="Browser tabs"
      aria-orientation="vertical"
      className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border/60 bg-background/40 p-1.5"
    >
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
          onActivate={() => onActivate(tab.id)}
          onClose={() => onCloseTab(tab.id)}
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
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-dashed border-border/60 px-2 text-xs text-muted-foreground',
          'hover:border-border hover:bg-foreground/5 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Plus className="size-4 shrink-0" />
        <span className="truncate">New tab</span>
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
              className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-primary"
            />
          )}
        </div>
      )}
    </div>
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
  onActivate,
  onClose,
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
  onActivate: () => void;
  onClose: () => void;
  onToggleCollapsed: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (position: DropZone) => void;
}) {
  const label = tab.title ?? hostnameOf(tab.url) ?? 'New tab';
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
        'group relative flex h-7 min-w-0 cursor-default items-center gap-1.5 rounded-md border pr-1.5 text-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        dragging && 'opacity-40',
        dropZone === 'inside' && 'ring-2 ring-inset ring-primary',
        active
          ? 'border-border bg-background text-foreground shadow-sm'
          : 'border-border/50 bg-background/30 text-muted-foreground hover:border-border hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {/* Sibling drop indicators: a bar in the gap above / below the row. */}
      {dropZone === 'before' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 -top-[3px] h-0.5 rounded-full bg-primary"
        />
      )}
      {dropZone === 'after' && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 -bottom-[3px] h-0.5 rounded-full bg-primary"
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
          className="absolute start-0.5 top-1/2 grid size-4 -translate-y-1/2 place-items-center rounded text-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          className="size-4 shrink-0 rounded-sm"
        />
      ) : (
        <Globe className="size-4 shrink-0 opacity-60" aria-hidden />
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
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
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
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-auto bg-muted/95 p-6 backdrop-blur-sm">
      <div className="w-full max-w-md space-y-5 rounded-xl border bg-background p-6 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="size-5" />
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

        <dl className="space-y-1.5 rounded-lg bg-muted/60 p-3 text-xs">
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

const TabSurface = memo(function TabSurface({
  id,
  initialSrc,
  partition,
  isPrivate,
  active,
  isNewTab,
  onNavigate: onNavigateToUrl,
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
}: {
  id: string;
  initialSrc: string;
  /** Session partition for this tab's surface (private windows override it). */
  partition?: string;
  /** Whether this tab lives in a private window (styles the new-tab page). */
  isPrivate: boolean;
  active: boolean;
  /** Show the custom new-tab page over the surface (blank tab). */
  isNewTab: boolean;
  /** Navigate this tab to a URL/search (from the new-tab page). */
  onNavigate: (id: string, raw: string) => void;
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
            ? 'overflow-hidden rounded-[1.75rem] border-4 border-foreground/80 bg-white shadow-2xl'
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
          onLoadStart={onLoadStart}
          onLoadEnd={onLoadEnd}
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
          onNavigate={(raw) => onNavigateToUrl(id, raw)}
        />
      )}
      {/* Untrusted-TLS warning, over the failed page until the user decides. */}
      {certError && (
        <CertificateWarning
          info={certError}
          onProceed={() => onTrustCertificate(certError)}
          onBack={() => onDismissCertError(id)}
        />
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
              'hover:bg-primary/40 motion-safe:transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

/** Quick links shown on the new-tab page. Icon URLs were resolved from each
 * site's web-app manifest (the best of manifest icons, apple-touch-icon, and
 * favicon); the brand color backs a monogram tile if an icon fails to load. */
const NEW_TAB_LINKS: { label: string; url: string; icon: string; color: string }[] = [
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
];

/** One quick-link tile: the site's real app icon, degrading to a
 * brand-colored monogram if the image fails (offline, moved, blocked). */
function NewTabTile({
  link,
  onNavigate,
}: {
  link: (typeof NEW_TAB_LINKS)[number];
  onNavigate: (url: string) => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onNavigate(link.url)}
      className="group flex flex-col items-center gap-2 rounded-xl p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {failed ? (
        <span
          aria-hidden
          className="grid size-12 place-items-center rounded-2xl text-lg font-semibold text-white shadow-sm transition-transform group-hover:scale-105"
          style={{ backgroundColor: link.color }}
        >
          {link.label[0]}
        </span>
      ) : (
        <img
          src={link.icon}
          alt=""
          aria-hidden
          draggable={false}
          onError={() => setFailed(true)}
          className="size-12 rounded-2xl object-cover shadow-sm transition-transform group-hover:scale-105"
        />
      )}
      <span className="w-full truncate text-center text-xs text-muted-foreground">
        {link.label}
      </span>
    </button>
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
  onNavigate,
}: {
  isPrivate: boolean;
  onNavigate: (raw: string) => void;
}) {
  const [query, setQuery] = useState('');

  return (
    // The opaque bg-background matters: the gradient's translucent end would
    // otherwise blend with the white about:blank surface underneath, fading
    // to near-white even in dark mode.
    <div className="absolute inset-0 flex flex-col items-center overflow-auto bg-background bg-gradient-to-b from-background to-muted/30 px-6 py-16 text-foreground">
      <div className="flex w-full max-w-xl flex-col items-center">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className={cn(
              'grid size-14 place-items-center rounded-2xl ring-1',
              isPrivate
                ? 'bg-foreground/10 text-foreground/80 ring-foreground/15'
                : 'bg-primary/10 text-primary ring-primary/20',
            )}
          >
            {isPrivate ? (
              <VenetianMask className="size-7" aria-hidden />
            ) : (
              <Globe className="size-7" aria-hidden />
            )}
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
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
            onNavigate(query);
          }}
          className="relative w-full"
        >
          <Search
            className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground/80"
            aria-hidden
          />
          <input
            type="text"
            inputMode="url"
            aria-label="Search or type a URL"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoComplete="off"
            className="h-12 w-full rounded-full border border-border/60 bg-background/80 pl-12 pr-4 text-base shadow-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </form>

        {/* Quick links are omitted in private windows - a curated dashboard of
            sites clashes with the point of an ephemeral window. */}
        {!isPrivate && (
          <div className="mt-10 grid w-full grid-cols-3 gap-4 sm:grid-cols-6">
            {NEW_TAB_LINKS.map((link) => (
              <NewTabTile key={link.url} link={link} onNavigate={onNavigate} />
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
 * The browser's overflow menu (the toolbar's ⋮ button): one popover that
 * gathers the controls that don't each warrant a toolbar button - opening a
 * new or private window, toggling developer tools, managing extensions and
 * userscripts, and per-browser settings (vertical tabs). Consolidating them
 * here keeps the toolbar to the essentials (navigation + address bar).
 */
function BrowserMenu({
  showExtensions,
  onOpenUrl,
  userscripts,
  onSetUserscriptEnabled,
  onRemoveUserscript,
  onAddUserscript,
  treeTabs,
  onTreeTabsChange,
  showFind,
  findDisabled,
  onFind,
  hasDevtools,
  devtoolsActive,
  devtoolsDisabled,
  onToggleDevtools,
  onNewWindow,
  onNewPrivateWindow,
  showClearData,
  onClearBrowsingData,
}: {
  /** Show the extensions + userscripts section (hidden in private windows). */
  showExtensions: boolean;
  onOpenUrl: (url: string) => void;
  /** Installed userscripts, or null when the userscript bridge is absent. */
  userscripts: Userscript[] | null;
  onSetUserscriptEnabled: (id: string, enabled: boolean) => void;
  onRemoveUserscript: (script: Userscript) => void;
  onAddUserscript: () => void;
  treeTabs: boolean;
  onTreeTabsChange: (value: boolean) => void;
  /** Show the find-in-page item (webview mode). */
  showFind: boolean;
  findDisabled: boolean;
  onFind: () => void;
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
}) {
  const [open, setOpen] = useState(false);
  /** Run an action and dismiss the menu. */
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Browser menu"
          title="Menu"
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
            'hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            open && 'bg-foreground/10 text-foreground',
          )}
        >
          <EllipsisVertical className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 p-0">
        <div className="p-1">
          <BrowserMenuItem
            icon={SquarePlus}
            label="New window"
            onClick={() => run(onNewWindow)}
          />
          <BrowserMenuItem
            icon={VenetianMask}
            label="New private window"
            onClick={() => run(onNewPrivateWindow)}
          />
          {showFind && (
            <BrowserMenuItem
              icon={Search}
              label="Find in page…"
              shortcut="Ctrl+F"
              disabled={findDisabled}
              onClick={() => run(onFind)}
            />
          )}
          {hasDevtools && (
            <BrowserMenuItem
              icon={Code}
              label="Developer tools"
              shortcut="F12"
              active={devtoolsActive}
              disabled={devtoolsDisabled}
              onClick={() => run(onToggleDevtools)}
            />
          )}
          {showClearData && (
            <BrowserMenuItem
              icon={Trash2}
              label="Clear browsing data…"
              onClick={() => run(onClearBrowsingData)}
            />
          )}
        </div>

        {showExtensions && (
          <>
            <Separator />
            <div className="p-3">
              <ExtensionsSection
                onOpenUrl={(url) => run(() => onOpenUrl(url))}
                userscripts={userscripts}
                onSetUserscriptEnabled={onSetUserscriptEnabled}
                onRemoveUserscript={onRemoveUserscript}
                onAddUserscript={() => run(onAddUserscript)}
              />
            </div>
          </>
        )}

        <Separator />
        <div className="space-y-3 p-3">
          <h3 className="text-sm font-medium">Settings</h3>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor="browser-vertical-tabs" className="text-sm">
                Vertical tabs
              </Label>
              <p className="text-xs text-muted-foreground">
                Show tabs in a sidebar, nested under the tab that opened them.
              </p>
            </div>
            <Switch
              id="browser-vertical-tabs"
              checked={treeTabs}
              onCheckedChange={onTreeTabsChange}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A single action row in the {@link BrowserMenu}. */
function BrowserMenuItem({
  icon: Icon,
  label,
  shortcut,
  active,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** Right-aligned shortcut hint (e.g. "F12"). */
  shortcut?: string;
  /** Toggle-item state (e.g. developer tools while its pane is open). */
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground',
        'hover:bg-accent hover:text-accent-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        active && 'bg-accent/60',
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      {shortcut && <span className="text-xs text-muted-foreground">{shortcut}</span>}
    </button>
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
            description="Signs you out of most sites and clears their stored data."
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
 * The extensions + userscripts body of the {@link BrowserMenu}: installed
 * Chrome extensions (with per-item uninstall and a Chrome Web Store link) plus
 * the userscript library (enable toggles, removal, manual add). Refreshes its
 * extension list each time it mounts - i.e. whenever the menu opens.
 */
function ExtensionsSection({
  onOpenUrl,
  userscripts,
  onSetUserscriptEnabled,
  onRemoveUserscript,
  onAddUserscript,
}: {
  onOpenUrl: (url: string) => void;
  userscripts: Userscript[] | null;
  onSetUserscriptEnabled: (id: string, enabled: boolean) => void;
  onRemoveUserscript: (script: Userscript) => void;
  onAddUserscript: () => void;
}) {
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
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Extensions</h3>
        <p className="text-xs text-muted-foreground">
          Extensions run on the sites you browse in this app.
        </p>
      </div>

      {crx &&
        (extensions === null ? null : extensions.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No extensions installed yet.
          </p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {extensions.map((extension) => (
              <li key={extension.id} className="flex items-center gap-2 rounded-md px-1 py-1">
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
                    'grid size-7 shrink-0 place-items-center rounded-md text-foreground/60',
                    'hover:bg-destructive/10 hover:text-destructive',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  <Trash2 className="size-3.5" />
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
    </div>
  );
}

/** Extension icon via the crx:// protocol, with a glyph fallback. */
function ExtensionIcon({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary">
        <Puzzle className="size-3.5 text-muted-foreground" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={crxIconUrl(id, 32)}
      alt=""
      aria-hidden
      className="size-6 shrink-0 rounded-md"
      onError={() => setFailed(true)}
    />
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
  themeColor,
  collectIcons,
}: {
  url: string;
  pageTitle: string | null;
  favicon: string | null;
  themeColor: string | null;
  collectIcons: () => Promise<IconCandidate[]>;
}) {
  const { installWebApp, findWebAppByUrl } = useInstalledApps();
  const { open: openApp } = useWindowActions();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  // The best icon resolved from the page's link/manifest hints (prefers SVG),
  // filled in asynchronously when the popover opens. Null until resolved, so
  // the preview shows the reported-favicon baseline in the meantime.
  const [resolvedIcon, setResolvedIcon] = useState<string | null>(null);

  const site = useMemo(() => {
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
  }, [url, favicon]);

  const installed = site ? findWebAppByUrl(site.url) : undefined;
  // Prefer the higher-quality icon resolved from the page's hints, falling
  // back to the reported-favicon baseline until (or unless) that resolves.
  const effectiveIcon = resolvedIcon ?? site?.icon ?? '';

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setName(pageTitle ?? site?.hostname ?? '');
    setResolvedIcon(null);
    if (site) {
      const forSite = site.url;
      collectIcons()
        .then((candidates) => setResolvedIcon(pickBestIcon(candidates, forSite, favicon)))
        .catch(() => {
          /* Leave the baseline icon in place. */
        });
    }
  };

  const install = () => {
    if (!site) return;
    // Capture the page's theme color (normalized) so the installed app's
    // window opens pre-tinted instead of flashing default chrome.
    const webApp = installWebApp({
      name,
      url: site.url,
      icon: effectiveIcon,
      themeColor: normalizeThemeColor(themeColor) ?? undefined,
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
              <AppIcon icon={effectiveIcon} className="size-8 shrink-0" />
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
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent',
        pressed && 'bg-foreground/10 text-foreground',
      )}
    >
      {children}
    </button>
  );
}

