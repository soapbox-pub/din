import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Code,
  Globe,
  MonitorDown,
  Plus,
  Puzzle,
  RotateCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveNavigation, sanitizeUrl } from '@/lib/sanitizeUrl';
import { getCrxBridge, isAllowedTabUrl, crxIconUrl, type CrxExtension } from '@/lib/crx';
import { getDevtoolsBridge } from '@/lib/devtools';
import { consumeTabCommands } from '@/lib/browserTabBus';
import { consumeInspectorDock } from '@/lib/inspectorBus';
import { isWebviewAvailable } from '@/lib/isElectron';
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
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { useToast } from '@/hooks/useToast';
import {
  BrowserView,
  type BrowserViewHandle,
} from '@/components/desktop/apps/BrowserView';
import { DevToolsPane } from '@/components/desktop/apps/DevToolsPane';
import {
  InspectorToolbar,
  type DockMode,
} from '@/components/desktop/apps/InspectorToolbar';
import { findDevicePreset, type DevicePreset } from '@/lib/devicePresets';

const HOME_URL = 'https://en.wikipedia.org/wiki/Main_Page';
const WEB_STORE_URL = 'https://chromewebstore.google.com/';

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
  /** URL the surface was mounted with (fixed for the surface's lifetime). */
  initialSrc: string;
  /** Address bar text (user-editable). */
  address: string;
  /** Last committed URL. */
  url: string;
  title: string | null;
  favicon: string | null;
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

function createTab(url: string, pendingRequestId: number | null = null): Tab {
  return {
    id: newTabId(),
    initialSrc: url,
    address: url,
    url,
    title: null,
    favicon: null,
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
export function WebBrowser({ windowId }: AppComponentProps) {
  const { close: closeWindow, open: openWindow, windows } = useWindowManager();
  const setTitlebar = useWindowTitlebar();
  const [tabs, setTabs] = useState<Tab[]>(() => [createTab(HOME_URL)]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const views = useRef(new Map<string, BrowserViewHandle>());
  // Mirror of `tabs` for event handlers that need the current list without
  // re-subscribing on every state change.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  const crx = getCrxBridge();
  const devtools = getDevtoolsBridge();
  const webviewMode = isWebviewAvailable();
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
    (url: string, activate = true, pendingRequestId: number | null = null) => {
      const tab = createTab(url, pendingRequestId);
      setTabs((ts) => [...ts, tab]);
      if (activate) setActiveId(tab.id);
      return tab.id;
    },
    [],
  );

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
      const next = ts.filter((t) => t.id !== id);
      if (next.length === 0) {
        // Closing the last tab closes the browser window.
        closeWindow(windowId);
        return;
      }
      setTabs(next);
      setActiveId((current) =>
        current === id ? next[Math.max(0, index - 1)].id : current,
      );
    },
    [closeWindow, windowId, devtools],
  );

  // Publish the tab strip into the window's title bar so tabs share a line
  // with the window controls (Chrome-style). Cleared on unmount to restore
  // the default title.
  useEffect(() => {
    setTitlebar(
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={setActiveId}
        onCloseTab={closeTab}
        onNewTab={() => openTab(HOME_URL)}
      />,
    );
    return () => setTitlebar(null);
  }, [tabs, activeId, closeTab, openTab, setTitlebar]);

  /** Register/unregister a tab surface's imperative handle. */
  const registerView = useCallback((id: string, handle: BrowserViewHandle | null) => {
    if (handle) views.current.set(id, handle);
    else views.current.delete(id);
  }, []);

  const onTabEvent = useCallback(
    (id: string, event: TabEvent) => {
      switch (event.kind) {
        case 'loading':
          updateTab(id, { loading: event.value });
          break;
        case 'title':
          updateTab(id, { title: event.value || null });
          break;
        case 'favicon':
          updateTab(id, { favicon: event.value });
          break;
        case 'navigate':
          updateTab(id, {
            url: event.url,
            address: event.url,
            canBack: event.canBack,
            canForward: event.canForward,
          });
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
    [updateTab, crx],
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
          openTab(url, command.active, command.requestId);
          break;
        }
        case 'open': {
          if (isAllowedTabUrl(command.url)) openTab(command.url, true);
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
    });
  }, [openTab, closeTab]);

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
  // its window disappears.
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
  }, [windows, updateTab]);

  // Re-dock requests from an undocked DevTools window (its dock controls live
  // in a separate component tree). Route by the inspected tab's WebContents
  // id, so only the browser window that owns the tab acts.
  useEffect(() => {
    return consumeInspectorDock(({ targetWcId, mode }) => {
      const tab = tabsRef.current.find((t) => t.wcId === targetWcId);
      if (tab) setDock(tab.id, mode);
    });
  }, [setDock]);

  const navigate = useCallback(
    (raw: string) => {
      const resolved = resolveNavigation(raw);
      if (!resolved) return;
      updateTab(activeId, (tab) => {
        const trimmed = tab.history.slice(0, tab.cursor + 1);
        return {
          address: resolved,
          url: resolved,
          title: null,
          favicon: null,
          history: [...trimmed, resolved],
          cursor: trimmed.length,
        };
      });
      views.current.get(activeId)?.loadURL(resolved);
    },
    [activeId, updateTab],
  );

  const go = useCallback(
    (delta: number) => {
      const view = views.current.get(activeId);
      if (!view) return;
      if (webviewMode) {
        // The guest owns its history; state syncs via `navigate` events.
        if (delta < 0) view.goBack();
        else view.goForward();
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === activeId);
      if (!tab) return;
      const target = tab.cursor + delta;
      if (target < 0 || target >= tab.history.length) return;
      const url = tab.history[target];
      view.loadURL(url);
      updateTab(activeId, { cursor: target, address: url, url, title: null, favicon: null });
    },
    [activeId, updateTab, webviewMode],
  );

  const canBack = webviewMode ? activeTab.canBack : activeTab.cursor > 0;
  const canForward = webviewMode
    ? activeTab.canForward
    : activeTab.cursor < activeTab.history.length - 1;

  // F12 / Ctrl+Shift+I while focus is in the shell's chrome (address bar,
  // buttons). The same shortcut inside a page arrives as a `toggle` command
  // from the main process instead (see the devtools.onCommand effect).
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

  return (
    <div className="flex h-full w-full flex-col" onKeyDown={onToolbarKeyDown}>
      {/* Toolbar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(activeTab.address);
        }}
        className="relative flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5"
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

        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/80" aria-hidden />
          <input
            type="text"
            inputMode="url"
            aria-label="Address and search bar"
            value={activeTab.address}
            onChange={(e) => updateTab(activeId, { address: e.target.value })}
            onFocus={(e) => e.currentTarget.select()}
            placeholder="Search or type a URL"
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-full border border-border/60 bg-secondary/80 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        {crx && <BrowserActionList tabWcId={activeTab.wcId} />}

        {crx && <ExtensionsMenu onOpenUrl={(url) => openTab(url)} />}

        <InstallSiteButton
          url={activeTab.url}
          pageTitle={activeTab.title}
          favicon={activeTab.favicon}
        />

        {devtools && (
          <NavButton
            label="Developer tools"
            title="Developer tools (F12)"
            pressed={activeTab.dock !== 'closed'}
            disabled={activeTab.wcId === null}
            onClick={() => toggleDevtools(activeId)}
          >
            <Code className="size-4" />
          </NavButton>
        )}

        {activeTab.loading && (
          <span
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary"
          />
        )}
      </form>

      {/* Tab surfaces: all stay mounted so background tabs keep their state;
          only the active one is visible. (visibility, not display:none -
          Electron <webview>s misbehave when display is toggled.) */}
      <div className="relative flex-1 overflow-hidden bg-white">
        {tabs.map((tab) => (
          <TabSurface
            key={tab.id}
            id={tab.id}
            initialSrc={tab.initialSrc}
            active={tab.id === activeId}
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
          />
        ))}
      </div>
    </div>
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
  const icon = tab.favicon ? sanitizeUrl(tab.favicon) : null;

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
const TabSurface = memo(function TabSurface({
  id,
  initialSrc,
  active,
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
}: {
  id: string;
  initialSrc: string;
  active: boolean;
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
          onLoadStart={onLoadStart}
          onLoadEnd={onLoadEnd}
          onTitleChange={onTitleChange}
          onFaviconChange={onFaviconChange}
          onNavigate={onNavigate}
          onWebContentsId={onWebContentsId}
        />
      </div>
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
 * Toolbar menu managing installed Chrome extensions: lists them with
 * uninstall buttons and links to the Chrome Web Store to install more.
 */
function ExtensionsMenu({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const crx = getCrxBridge();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [extensions, setExtensions] = useState<CrxExtension[] | null>(null);

  const refresh = useCallback(async () => {
    if (!crx) return;
    try {
      setExtensions(await crx.listExtensions());
    } catch {
      setExtensions([]);
    }
  }, [crx]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) refresh();
  };

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

  if (!crx) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Extensions"
          title="Extensions"
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
            'hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <Puzzle className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Extensions</h3>
            <p className="text-xs text-muted-foreground">
              Extensions run on the sites you browse in this app.
            </p>
          </div>

          {extensions === null ? null : extensions.length === 0 ? (
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
          )}

          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              setOpen(false);
              onOpenUrl(WEB_STORE_URL);
            }}
          >
            Browse the Chrome Web Store
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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

