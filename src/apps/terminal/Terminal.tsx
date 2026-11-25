import { memo, type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { SquareTerminal } from 'lucide-react';
import { getPtyBridge } from '@/lib/pty';
import { moveItem } from '@/hooks/useDragReorder';
import { useDin, useMediaQuery, useSnapped, useWindowAccent, useWindowFocused, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { restoredState, saveState, windowLaunch } from '@/shared/launch';
import { TabStrip } from '@/shared/TabStrip';
import { dinWindowMove } from '@/shared/dinWindowMove';
import { adoptedTab, hasAdoptedTab, useDinTabTransfer } from '@/shared/dinTabTransfer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import {
  GLASS_ALPHA,
  paneNotifications,
  paneSession,
  paneSessions,
  paneTitle,
  terminalTheme,
  useTerminalLook,
  type PaneHandover,
  type PaneHost,
  type PaneLabel,
  type TabShortcut,
  type TerminalApp,
} from '@/shared/terminal/session';

let nextSessionId = 0;
const newSessionId = () => `term-${nextSessionId++}`;

let nextTabId = 0;
const newTabId = () => `termtab-${nextTabId++}`;

let nextSplitId = 0;
const newSplitId = () => `split-${nextSplitId++}`;

/** Split axis: 'row' places panes side by side, 'column' stacks them. */
type SplitDir = 'row' | 'column';

/**
 * A tab's pane layout is a binary tree (Tilix-style): leaves are terminal
 * sessions, inner nodes are splits with a draggable ratio.
 */
interface LeafNode {
  type: 'leaf';
  paneId: string;
  /** Working directory to start the shell in (inherited from the source pane). */
  initialCwd?: string;
  /** A terminal app (htop) the pane runs in place of a shell. */
  app?: TerminalApp;
  /** The running pty this pane takes over (its tab came from another window). */
  handover?: PaneHandover;
}
interface SplitNode {
  type: 'split';
  id: string;
  dir: SplitDir;
  /** Fraction of the split's space given to child `a` (0..1). */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}
type LayoutNode = LeafNode | SplitNode;

/** A tab moving between windows (useDinTabTransfer's payload). */
interface TabPayload {
  layout: LayoutNode;
  activePaneId: string;
}

function isTabPayload(value: unknown): value is TabPayload {
  if (typeof value !== 'object' || value === null) return false;
  const { layout, activePaneId } = value as Partial<TabPayload>;
  return typeof activePaneId === 'string' && typeof layout === 'object' && layout !== null
    && (layout.type === 'leaf' || layout.type === 'split');
}

/** A tab from another window, with ids of this window's own. */
function tabFromPayload(payload: TabPayload): TermTab {
  let activePaneId = '';
  const renumber = (node: LayoutNode): LayoutNode => {
    if (node.type === 'split') return { ...node, id: newSplitId(), a: renumber(node.a), b: renumber(node.b) };
    const paneId = newSessionId();
    if (node.paneId === payload.activePaneId) activePaneId = paneId;
    return { ...node, paneId };
  };
  const layout = renumber(payload.layout);
  return { id: newTabId(), layout, activePaneId: activePaneId || firstPaneId(layout) };
}

/** What a window keeps for Din to reopen it with (its navigation state). */
interface SavedTerminal {
  tabs: TabPayload[];
  /** Index of the selected tab. */
  active: number;
}

/** The tabs of a window Din reopened, from what it saved, or null. */
function restoredTabs(state: unknown): { tabs: TermTab[]; active: number } | null {
  if (typeof state !== 'object' || state === null) return null;
  const { tabs, active } = state as Partial<SavedTerminal>;
  if (!Array.isArray(tabs)) return null;
  // Saved panes never carry a pty to take over.
  const fresh = (node: LayoutNode): LayoutNode =>
    node.type === 'split' ? { ...node, a: fresh(node.a), b: fresh(node.b) } : { ...node, handover: undefined };
  const list = tabs.filter(isTabPayload).map((t) => tabFromPayload({ ...t, layout: fresh(t.layout) }));
  if (list.length === 0) return null;
  return { tabs: list, active: typeof active === 'number' && active >= 0 && active < list.length ? active : 0 };
}

/** One terminal tab: its identity and pane layout. */
interface TermTab {
  id: string;
  layout: LayoutNode;
  /** The pane that holds (or should hold) keyboard focus. */
  activePaneId: string;
}

/** Replace the leaf `paneId` with a split of itself and a new pane. */
function splitLeaf(
  node: LayoutNode,
  paneId: string,
  dir: SplitDir,
  newPaneId: string,
  cwd?: string,
): LayoutNode {
  if (node.type === 'leaf') {
    if (node.paneId !== paneId) return node;
    return {
      type: 'split',
      id: newSplitId(),
      dir,
      ratio: 0.5,
      a: node,
      b: { type: 'leaf', paneId: newPaneId, initialCwd: cwd },
    };
  }
  return {
    ...node,
    a: splitLeaf(node.a, paneId, dir, newPaneId, cwd),
    b: splitLeaf(node.b, paneId, dir, newPaneId, cwd),
  };
}

/** Remove a leaf; its sibling takes the split's place. Null when empty. */
function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === 'leaf') return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

function setSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    a: setSplitRatio(node.a, splitId, ratio),
    b: setSplitRatio(node.b, splitId, ratio),
  };
}

function firstPaneId(node: LayoutNode): string {
  return node.type === 'leaf' ? node.paneId : firstPaneId(node.a);
}

/** A rectangle in fractions (0..1) of the tab's area. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
interface LeafBox {
  paneId: string;
  initialCwd?: string;
  app?: TerminalApp;
  handover?: PaneHandover;
  rect: Rect;
}
interface DividerBox {
  splitId: string;
  dir: SplitDir;
  /** The whole split's rect — the divider drags within it. */
  rect: Rect;
  /** Boundary position as a fraction of the whole tab. */
  pos: number;
}

/** Walk the layout tree computing each pane's rect and each divider. */
function flattenLayout(
  node: LayoutNode,
  rect: Rect,
  leaves: LeafBox[],
  dividers: DividerBox[],
): void {
  if (node.type === 'leaf') {
    leaves.push({ paneId: node.paneId, initialCwd: node.initialCwd, app: node.app, handover: node.handover, rect });
    return;
  }
  if (node.dir === 'row') {
    const aw = rect.width * node.ratio;
    flattenLayout(node.a, { ...rect, width: aw }, leaves, dividers);
    flattenLayout(
      node.b,
      { ...rect, left: rect.left + aw, width: rect.width - aw },
      leaves,
      dividers,
    );
    dividers.push({ splitId: node.id, dir: 'row', rect, pos: rect.left + aw });
  } else {
    const ah = rect.height * node.ratio;
    flattenLayout(node.a, { ...rect, height: ah }, leaves, dividers);
    flattenLayout(
      node.b,
      { ...rect, top: rect.top + ah, height: rect.height - ah },
      leaves,
      dividers,
    );
    dividers.push({ splitId: node.id, dir: 'column', rect, pos: rect.top + ah });
  }
}

/**
 * Terminal - a real interactive shell on the underlying OS.
 *
 * Rendered with xterm.js; each pane owns one pty session over `din.system.pty`
 * (the `pty` permission; see src/lib/pty.ts). Sessions run as the
 * unprivileged OS user and die with the window. Multiple tabs share one window: all sessions stay
 * mounted (their xterm state survives) and only the active tab is visible.
 * Ctrl+PageUp/PageDown switch tabs, Ctrl+(Shift+)T opens one and Ctrl+Shift+W
 * closes one (gnome-terminal/Tilix bindings); when a shell exits its pane
 * closes, and closing the last tab closes the window. A command that ran for
 * a while and finishes out of sight posts a notification.
 * Within a tab, right-click offers Tilix-style tiling: split a pane right or
 * down into a tree of terminals with draggable dividers.
 * Tabs move between Terminal windows (dragged, torn off, or from the tab's
 * menu) with their shells still running: each pty is handed over
 * (din.system.pty.release/adopt) along with its screen and scrollback.
 * Outside the Electron shell (plain-browser dev) there is no bridge, so a
 * fallback notice renders instead.
 *
 * Launch params: `{ cwd }` starts the first shell in a folder, `{ app,
 * appName }` runs a terminal app (htop) in the first pane.
 */
/** A window's first tab: a shell, in a folder (`cwd`), or a terminal app (`app`). */
function firstTab(params: Record<string, unknown>): TermTab {
  const paneId = newSessionId();
  // Files' "Open in Terminal" starts the first shell in a given folder.
  const initialCwd = typeof params.cwd === 'string' ? params.cwd : undefined;
  // The apps menu opens terminal apps (htop) here, running in the first pane.
  const app =
    typeof params.app === 'string'
      ? { id: params.app, name: typeof params.appName === 'string' ? params.appName : params.app }
      : undefined;
  return { id: newTabId(), layout: { type: 'leaf', paneId, initialCwd, app }, activePaneId: paneId };
}

export function Terminal() {
  const din = useDin();
  const params = windowLaunch().params;
  const bridge = getPtyBridge();
  const { dark, selection, glass } = useTerminalLook();
  // The whole window is the terminal's color: the header's tokens follow its
  // palette, and the accent carries it to the window controls and to the
  // menu bar over a fullscreen window. On glass the accent has alpha, so the
  // window is frosted glass of the terminal's color, black or white (solid
  // while maximized or snapped), and the page and its cells are clear over it.
  const palette = terminalTheme(dark, selection, false);
  const surface = {
    // A color, not the `background` shorthand: glass-sheen's light is the
    // background's image.
    backgroundColor: glass ? 'transparent' : palette.background,
    '--background': palette.background,
    '--foreground': palette.foreground,
    '--muted-foreground': dark ? 'rgb(229 229 229 / 0.7)' : 'rgb(31 35 40 / 0.7)',
  } as CSSProperties;
  useWindowAccent(glass ? `${palette.background}${GLASS_ALPHA}` : palette.background);
  // Liquid glass's light on it (glass-sheen), while it's glass: not while
  // maximized or snapped, when the window is solid.
  const maximized = useMediaQuery('(display-state: maximized)');
  const snapped = useSnapped();
  const sheen = glass && !maximized && !snapped ? 'glass-sheen' : undefined;
  const closeWindow = useCallback(() => window.close(), []);

  // A window opened for a tab torn off another one starts empty, and gets
  // the tab.
  const adopting = hasAdoptedTab();
  // Reopened by Din on starting again, it has the tabs it had, in the
  // folders they were in (with fresh shells: the old ones died with Din).
  const [initial] = useState(() => {
    if (adopting) return { tabs: [], active: 0 };
    return (restoredState() !== null && restoredTabs(restoredState())) || { tabs: [firstTab(params)], active: 0 };
  });
  const [tabs, setTabs] = useState<TermTab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(() => tabs[initial.active]?.id ?? tabs[0]?.id ?? '');
  const adoptStarted = useRef(false);
  useEffect(() => {
    if (!adopting || adoptStarted.current) return;
    adoptStarted.current = true;
    void adoptedTab().then((payload) => {
      const tab = isTabPayload(payload) ? tabFromPayload(payload) : firstTab({});
      setTabs([tab]);
      setActiveId(tab.id);
    });
  }, [adopting, din]);
  const tabsRef = useRef(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  });
  // Tracks last known CWD per pane, updated via OSC 7 from each shell.
  const panesCwd = useRef<Map<string, string>>(new Map());
  // What each pane's tab is named after.
  const [labels, setLabels] = useState<Record<string, PaneLabel>>({});

  const updateLabel = useCallback((paneId: string, patch: PaneLabel | null) => {
    setLabels((ls) => {
      if (patch === null) {
        if (!(paneId in ls)) return ls;
        const { [paneId]: _, ...rest } = ls;
        return rest;
      }
      const current = ls[paneId];
      if (current && Object.entries(patch).every(([k, v]) => current[k as keyof PaneLabel] === v)) return ls;
      return { ...ls, [paneId]: { ...current, ...patch } };
    });
  }, []);

  const handleCwdChange = useCallback((paneId: string, cwd: string) => {
    panesCwd.current.set(paneId, cwd);
    updateLabel(paneId, { cwd });
  }, [updateLabel]);

  // Kept for when Din reopens the window: each tab's panes, where they are.
  useEffect(() => {
    if (tabs.length === 0) return;
    const keep = (node: LayoutNode): LayoutNode =>
      node.type === 'split'
        ? { ...node, a: keep(node.a), b: keep(node.b) }
        : { type: 'leaf', paneId: node.paneId, initialCwd: panesCwd.current.get(node.paneId) ?? node.initialCwd, app: node.app };
    const saved: SavedTerminal = {
      tabs: tabs.map((t) => ({ layout: keep(t.layout), activePaneId: t.activePaneId })),
      active: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
    };
    saveState(saved);
  }, [din, tabs, activeId, labels]);

  const openTab = useCallback(() => {
    const paneId = newSessionId();
    const activeTab = tabs.find((t) => t.id === activeId);
    const initialCwd = activeTab ? panesCwd.current.get(activeTab.activePaneId) : undefined;
    const tab: TermTab = {
      id: newTabId(),
      layout: { type: 'leaf', paneId, initialCwd },
      activePaneId: paneId,
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, [tabs, activeId]);

  /**
   * Remove a tab. Removing the last closes the window, a moment later when
   * the tab is moving (so it's posted to its new window first).
   */
  const dropTab = useCallback(
    (id: string, moving: boolean) => {
      setTabs((ts) => {
        const index = ts.findIndex((t) => t.id === id);
        if (index === -1) return ts;
        const next = ts.filter((t) => t.id !== id);
        // Closing the last tab closes the terminal window.
        if (next.length === 0) {
          if (moving) setTimeout(closeWindow, 0);
          else closeWindow();
          return ts;
        }
        setActiveId((current) =>
          current === id ? next[Math.max(0, index - 1)].id : current,
        );
        return next;
      });
    },
    [closeWindow],
  );
  const closeTab = useCallback((id: string) => dropTab(id, false), [dropTab]);

  /** Hand a tab to another window: its ptys keep running, its screens come along. */
  const takeTab = useCallback(
    async (id: string): Promise<TabPayload | undefined> => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return undefined;
      const handOver = async (node: LayoutNode): Promise<LayoutNode> => {
        if (node.type === 'split') {
          const [a, b] = await Promise.all([handOver(node.a), handOver(node.b)]);
          return { ...node, a, b };
        }
        // A pane with no live pty (or one that fails to let go) starts a
        // fresh shell where it was.
        const handover = await paneSessions.get(node.paneId)?.release().catch(() => undefined);
        return { ...node, initialCwd: panesCwd.current.get(node.paneId) ?? node.initialCwd, handover };
      };
      const layout = await handOver(tab.layout);
      dropTab(id, true);
      return { layout, activePaneId: tab.activePaneId };
    },
    [dropTab],
  );

  const receiveTab = useCallback((payload: unknown, index: number) => {
    if (!isTabPayload(payload)) return;
    const tab = tabFromPayload(payload);
    setTabs((ts) => [...ts.slice(0, index), tab, ...ts.slice(index)]);
    setActiveId(tab.id);
  }, []);

  const splitPane = useCallback((tabId: string, paneId: string, dir: SplitDir) => {
    const newPaneId = newSessionId();
    const cwd = panesCwd.current.get(paneId);
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId
          ? { ...t, layout: splitLeaf(t.layout, paneId, dir, newPaneId, cwd), activePaneId: newPaneId }
          : t,
      ),
    );
  }, []);

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      setTabs((ts) => {
        const index = ts.findIndex((t) => t.id === tabId);
        if (index === -1) return ts;
        const layout = removeLeaf(ts[index].layout, paneId);
        // Closing a tab's last pane closes the tab (and maybe the window).
        if (layout === null) {
          const next = ts.filter((t) => t.id !== tabId);
          if (next.length === 0) {
            closeWindow();
            return ts;
          }
          setActiveId((current) =>
            current === tabId ? next[Math.max(0, index - 1)].id : current,
          );
          return next;
        }
        return ts.map((t) =>
          t.id === tabId
            ? {
                ...t,
                layout,
                activePaneId:
                  t.activePaneId === paneId ? firstPaneId(layout) : t.activePaneId,
              }
            : t,
        );
      });
    },
    [closeWindow],
  );

  // Tab shortcuts originate inside xterm sessions (which swallow every
  // keystroke), so panes dispatch through a stable callback backed by a ref
  // that always sees the latest tabs/activeId — session effects never re-run.
  const shortcutRef = useRef<(action: TabShortcut) => void>(() => {});
  useLayoutEffect(() => {
    shortcutRef.current = (action) => {
      switch (action) {
        case 'new-tab':
          openTab();
          break;
        case 'close-tab':
          closeTab(activeId);
          break;
        case 'next-tab':
        case 'prev-tab': {
          const index = tabs.findIndex((t) => t.id === activeId);
          if (index === -1) return;
          const delta = action === 'next-tab' ? 1 : -1;
          setActiveId(tabs[(index + delta + tabs.length) % tabs.length].id);
          break;
        }
      }
    };
  });
  const onTabShortcut = useCallback((action: TabShortcut) => shortcutRef.current(action), []);

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t,
      ),
    );
  }, []);

  /** Bring a pane into view: its tab, its window (a notification was clicked). */
  const revealPane = useCallback(
    (tabId: string, paneId: string) => {
      setActiveId(tabId);
      focusPane(tabId, paneId);
      window.focus();
    },
    [focusPane],
  );

  const resizeSplit = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId ? { ...t, layout: setSplitRatio(t.layout, splitId, ratio) } : t,
      ),
    );
  }, []);

  // Each tab is named after its focused pane, and the window after its tab.
  const activeTab = tabs.find((t) => t.id === activeId);
  const title = activeTab ? paneTitle(labels[activeTab.activePaneId]) : null;
  useWindowTitle(title);

  const transfer = useDinTabTransfer(
    {
      din,
      label: (id) => {
        const tab = tabsRef.current.find((t) => t.id === id);
        return tab ? paneTitle(labels[tab.activePaneId]) : 'Terminal';
      },
      take: takeTab,
      receive: receiveTab,
    },
    tabs.length,
  );

  // The tab strip shares a line with the window controls (Chrome-style), in
  // the window's own header (a `custom` frame).
  const headerRef = useRef<HTMLDivElement>(null);
  const header = (
    <WindowDragRegion
      ref={headerRef}
      className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-2"
    >
      {bridge ? (
        <div className="flex min-w-0 flex-1 items-center self-stretch">
          <TabStrip
            tabs={tabs.map((t) => ({
              id: t.id,
              title: paneTitle(labels[t.activePaneId]),
              icon: <SquareTerminal className="size-3.5" />,
            }))}
            activeId={activeId}
            label="Terminal tabs"
            newTabLabel="New terminal"
            onActivate={setActiveId}
            onClose={closeTab}
            onNew={openTab}
            onMove={(id, to) => setTabs((ts) => moveItem(ts, id, to))}
            transfer={transfer}
            moveWindow={tabs.length === 1 ? dinWindowMove(din) : undefined}
          />
        </div>
      ) : (
        <span className="flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium">Terminal</span>
      )}
      <WindowControls />
    </WindowDragRegion>
  );

  if (!bridge) {
    return (
      <div className={cn('flex h-full w-full flex-col rounded-[inherit] text-foreground', sheen)} style={surface}>
        {header}
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-sm rounded-xl px-8 py-12 text-center">
            <SquareTerminal className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
            <p className="text-sm text-muted-foreground">
              Terminal needs the Electron shell to run an OS shell. Run{' '}
              <code className="rounded bg-foreground/10 px-1 py-0.5">make dev</code> or
              boot the VM; the bridge is not available in a plain browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full w-full flex-col rounded-[inherit] text-foreground', sheen)} style={surface}>
      {header}
      {/* overflow-clip: background tabs park outside it (see TerminalTab). */}
      <div className="relative min-h-0 w-full flex-1 overflow-clip rounded-b-[inherit]">
        {/* All tabs stay mounted so background tabs keep their scrollback
            and running programs; only the active one is visible. */}
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSplit={splitPane}
            onClosePane={closePane}
            onFocusPane={focusPane}
            onRevealPane={revealPane}
            onResizeSplit={resizeSplit}
            onCwdChange={handleCwdChange}
            onLabel={updateLabel}
            onTabShortcut={onTabShortcut}
            header={headerRef}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One tab's tiled pane layout: renders every pane of the split tree at its
 * computed rect (a flat list of absolutely-positioned siblings, so splitting
 * never remounts an existing session) plus a draggable divider per split.
 */
const TerminalTab = memo(function TerminalTab({
  tab,
  active,
  onSplit,
  onClosePane,
  onFocusPane,
  onRevealPane,
  onResizeSplit,
  onCwdChange,
  onLabel,
  onTabShortcut,
  header,
}: {
  tab: TermTab;
  active: boolean;
  onSplit: (tabId: string, paneId: string, dir: SplitDir) => void;
  onClosePane: (tabId: string, paneId: string) => void;
  onFocusPane: (tabId: string, paneId: string) => void;
  onRevealPane: (tabId: string, paneId: string) => void;
  onResizeSplit: (tabId: string, splitId: string, ratio: number) => void;
  onCwdChange: (paneId: string, cwd: string) => void;
  onLabel: (paneId: string, label: PaneLabel | null) => void;
  onTabShortcut: (action: TabShortcut) => void;
  /** The window's header, whose clicks hand focus back to the terminal. */
  header: React.RefObject<HTMLDivElement | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  const { leaves, dividers } = useMemo(() => {
    const leaves: LeafBox[] = [];
    const dividers: DividerBox[] = [];
    flattenLayout(tab.layout, { left: 0, top: 0, width: 1, height: 1 }, leaves, dividers);
    // Stable render order (splits reorder the tree walk); keys prevent
    // remounts either way, sorting also avoids DOM moves.
    leaves.sort((a, b) => a.paneId.localeCompare(b.paneId));
    return { leaves, dividers };
  }, [tab.layout]);

  const handleSplit = useCallback(
    (paneId: string, dir: SplitDir) => onSplit(tab.id, paneId, dir),
    [onSplit, tab.id],
  );
  const handleClose = useCallback(
    (paneId: string) => onClosePane(tab.id, paneId),
    [onClosePane, tab.id],
  );
  const handleReveal = useCallback(
    (paneId: string) => onRevealPane(tab.id, paneId),
    [onRevealPane, tab.id],
  );

  const startDividerDrag = (d: DividerBox) => (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container || e.button !== 0) return;
    e.preventDefault();
    const bounds = container.getBoundingClientRect();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const frac =
        d.dir === 'row'
          ? ((ev.clientX - bounds.left) / bounds.width - d.rect.left) / d.rect.width
          : ((ev.clientY - bounds.top) / bounds.height - d.rect.top) / d.rect.height;
      onResizeSplit(tab.id, d.splitId, Math.min(0.9, Math.max(0.1, frac)));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      // visibility (not display:none) keeps xterm's layout measurements valid
      // for background tabs, matching how minimized windows stay mounted.
      // Shifted past the window's clip too: xterm pauses rendering while its
      // screen doesn't intersect the viewport (an IntersectionObserver, which
      // ignores visibility), so a TUI streaming into a background tab parses
      // its output but no longer repaints, and repaints once on return.
      style={
        active
          ? undefined
          : { visibility: 'hidden', pointerEvents: 'none', transform: 'translateX(calc(-100% - 1px))' }
      }
    >
      {leaves.map((leaf) => (
        <div
          key={leaf.paneId}
          className="absolute"
          style={{
            left: `${leaf.rect.left * 100}%`,
            top: `${leaf.rect.top * 100}%`,
            width: `${leaf.rect.width * 100}%`,
            height: `${leaf.rect.height * 100}%`,
          }}
          onMouseDownCapture={() => onFocusPane(tab.id, leaf.paneId)}
        >
          <TerminalSession
            paneId={leaf.paneId}
            active={active}
            focused={tab.activePaneId === leaf.paneId}
            initialCwd={leaf.initialCwd}
            app={leaf.app}
            handover={leaf.handover}
            onSplit={handleSplit}
            onClose={handleClose}
            onReveal={handleReveal}
            onCwdChange={onCwdChange}
            onLabel={onLabel}
            onTabShortcut={onTabShortcut}
            header={header}
          />
        </div>
      ))}
      {dividers.map((d) => (
        <div
          key={d.splitId}
          role="separator"
          aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
          className={cn(
            'group absolute z-10 grid place-items-center',
            d.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize',
          )}
          style={
            d.dir === 'row'
              ? {
                  left: `calc(${d.pos * 100}% - 3px)`,
                  top: `${d.rect.top * 100}%`,
                  height: `${d.rect.height * 100}%`,
                  width: 6,
                }
              : {
                  top: `calc(${d.pos * 100}% - 3px)`,
                  left: `${d.rect.left * 100}%`,
                  width: `${d.rect.width * 100}%`,
                  height: 6,
                }
          }
          onPointerDown={startDividerDrag(d)}
        >
          <div
            className={cn(
              'bg-black/15 transition-colors group-hover:bg-black/40 dark:bg-white/15 dark:group-hover:bg-white/40',
              d.dir === 'row' ? 'h-full w-px' : 'h-px w-full',
            )}
          />
        </div>
      ))}
    </div>
  );
});


/**
 * A single terminal pane, showing its session (see PaneSession). Memoized so
 * another pane's state change doesn't re-run this one's effects. Right-click
 * opens a context menu with clipboard actions and Tilix-style
 * split/close-pane actions.
 */
const TerminalSession = memo(function TerminalSession({
  paneId,
  active,
  focused,
  initialCwd,
  app,
  handover,
  onSplit,
  onClose,
  onReveal,
  onCwdChange,
  onLabel,
  onTabShortcut,
  header,
}: {
  paneId: string;
  /** Whether the owning tab is visible. */
  active: boolean;
  /** Whether this pane should hold keyboard focus within its tab. */
  focused: boolean;
  /** Working directory to start the shell in on first spawn. */
  initialCwd?: string;
  /** A terminal app to run in place of the shell on first spawn. */
  app?: TerminalApp;
  /** A running pty to take over on first attach, from another window. */
  handover?: PaneHandover;
  onSplit: (paneId: string, dir: SplitDir) => void;
  onClose: (paneId: string) => void;
  /** Bring this pane into view. */
  onReveal: (paneId: string) => void;
  onCwdChange: (paneId: string, cwd: string) => void;
  onLabel: (paneId: string, label: PaneLabel | null) => void;
  onTabShortcut: (action: TabShortcut) => void;
  header: React.RefObject<HTMLDivElement | null>;
}) {
  const din = useDin();
  const bridge = getPtyBridge();
  const openUrl = useCallback((url: string) => window.open(url), []);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const initialCwdRef = useRef(initialCwd);
  const appRef = useRef(app);
  const handoverRef = useRef(handover);
  const isTop = useWindowFocused();
  const isTopRef = useRef(isTop);
  // Always-fresh callbacks for the (long-lived) session.
  const host = useRef<PaneHost>({
    onCwdChange,
    onLabel,
    onClose,
    onReveal,
    onTabShortcut,
    openUrl,
    visible: false,
  });
  useLayoutEffect(() => {
    isTopRef.current = isTop;
    host.current = {
      onCwdChange,
      onLabel,
      onClose,
      onReveal,
      onTabShortcut,
      openUrl,
      visible: active && isTop,
    };
  });

  // Seeing the pane is seeing its command finish: that notification goes.
  useEffect(() => {
    if (active && isTop) paneNotifications.get(paneId)?.close();
  }, [paneId, active, isTop]);

  useEffect(() => {
    const container = containerRef.current;
    if (!bridge || !container) return;
    const session = paneSession(din, bridge, paneId, initialCwdRef.current, appRef.current, handoverRef.current);
    termRef.current = session.term;
    fitRef.current = session.fit;
    const detach = session.attach(container, host);
    return () => {
      detach();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [din, bridge, paneId]);

  // When this pane's tab becomes active, refit (its container had zero size
  // while hidden, so xterm's cached dimensions are stale).
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
    });
  }, [active]);

  // Keep keyboard focus on the tab's active pane (new splits focus the new
  // pane; closing a pane moves focus to a survivor), and restore it whenever
  // the window comes to the front (un-minimize, raise from the dock).
  useEffect(() => {
    if (active && focused && isTop) termRef.current?.focus();
  }, [active, focused, isTop]);

  // Clicking the title bar (empty space, the tab strip) of an already-raised
  // window moves focus off the terminal; hand it back once the click lands.
  // Skipped if the click minimized or closed the window.
  useEffect(() => {
    if (!active || !focused) return;
    const el = header.current;
    if (!el) return;
    const onPointerUp = () => {
      requestAnimationFrame(() => {
        if (isTopRef.current) termRef.current?.focus();
      });
    };
    el.addEventListener('pointerup', onPointerUp);
    return () => el.removeEventListener('pointerup', onPointerUp);
  }, [active, focused, header]);

  const copySelection = useCallback(() => {
    const text = termRef.current?.getSelection();
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  }, []);

  const pasteClipboard = useCallback(() => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) termRef.current?.paste(text);
      })
      .catch(() => {});
  }, []);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative h-full w-full">
          {/* xterm.css paints its viewport black, under the cells; clear,
              so cells clear on glass (terminalTheme) show the window's glass,
              and opaque ones cover it as before. */}
          <div ref={containerRef} className="h-full w-full pl-2 pt-1 [&_.xterm-viewport]:bg-transparent!" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-44"
        // Return focus to the terminal (not the wrapper div) after the menu
        // closes, so e.g. Paste lands keystrokes in the shell immediately.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          termRef.current?.focus();
        }}
      >
        <ContextMenuItem onSelect={copySelection}>Copy</ContextMenuItem>
        <ContextMenuItem onSelect={pasteClipboard}>Paste</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onSplit(paneId, 'row')}>
          Split right
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSplit(paneId, 'column')}>
          Split down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(paneId)}>Close pane</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
