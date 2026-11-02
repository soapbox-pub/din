import { memo, type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import { SquareTerminal } from 'lucide-react';
import { getPtyBridge, type PtyBridge } from '@/lib/pty';
import { moveItem } from '@/hooks/useDragReorder';
import type { Din } from '@/sdk';
import { useDin, useDinTheme, useWindowAccent, useWindowState, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
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
import '@xterm/xterm/css/xterm.css';

/**
 * Dark palette, roughly "Tango dark" with a slightly brighter foreground for
 * contrast.
 */
const DARK_THEME = {
  background: '#0a0a0a',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#4a5568',
  black: '#171717',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#d4d4d4',
  brightBlack: '#525252',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

/**
 * Light palette, after GitHub Light: every color, "white" included, stays
 * readable on the white background.
 */
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: '#b6d6fd',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#4d2d00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

/** The desktop's selection color, when it's one xterm reads (`#rrggbb` or `#rrggbbaa`). */
const selectionOf = (tokens: Record<string, string> | undefined) =>
  tokens?.selection && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(tokens.selection) ? tokens.selection : undefined;

const terminalTheme = (dark: boolean, selection = currentSelection) => {
  const palette = dark ? DARK_THEME : LIGHT_THEME;
  return selection ? { ...palette, selectionBackground: selection } : palette;
};

/**
 * Whether Din is dark right now (din.theme, which follows the Light/Dark/System
 * setting and a custom theme's own background alike). Sessions live outside
 * React, so the window sets it here and they repaint when it changes.
 */
let currentDark = window.din?.theme.current.scheme === 'dark';
/** Selected text's color on the desktop, which the terminal's selection takes too. */
let currentSelection = selectionOf(window.din?.theme.current.tokens);
const darkListeners = new Set<(dark: boolean, schemeChanged: boolean) => void>();

function setDinLook(dark: boolean, selection: string | undefined) {
  if (dark === currentDark && selection === currentSelection) return;
  const schemeChanged = dark !== currentDark;
  currentDark = dark;
  currentSelection = selection;
  for (const listener of darkListeners) listener(dark, schemeChanged);
}

let nextSessionId = 0;
const newSessionId = () => `term-${nextSessionId++}`;

let nextTabId = 0;
const newTabId = () => `termtab-${nextTabId++}`;

let nextSplitId = 0;
const newSplitId = () => `split-${nextSplitId++}`;

/**
 * Matches http/https URLs printed in terminal output (e.g. a dev server's
 * "Local: http://localhost:8080/"). Deliberately conservative: stops at
 * whitespace and characters that commonly wrap a URL in prose, so the match
 * doesn't swallow a trailing bracket or quote.
 */
const TERMINAL_URL_REGEX = /https?:\/\/[^\s"'`<>()[\]{}]+/g;

/** The largest OSC 52 copy accepted, in base64 characters (about 1 MB of text). */
const MAX_OSC52_BYTES = 1_400_000;

/**
 * Terminal font size ("zoom"), shared across every pane and tab and persisted
 * so it survives restarts. Tilix-style Ctrl/Cmd+scroll and Ctrl/Cmd +/-/0
 * mutate it through {@link setSharedFontSize}; live sessions subscribe via
 * {@link fontSizeListeners} and refit when it changes.
 */
const FONT_SIZE_KEY = 'din.terminal.fontSize';
const DEFAULT_FONT_SIZE = 16;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 40;

const clampFontSize = (size: number) =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));

const loadFontSize = (): number => {
  try {
    const raw = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (Number.isFinite(raw) && raw >= MIN_FONT_SIZE && raw <= MAX_FONT_SIZE) return raw;
  } catch {
    // localStorage unavailable — fall back to the default.
  }
  return DEFAULT_FONT_SIZE;
};

let currentFontSize = loadFontSize();
const fontSizeListeners = new Set<(size: number) => void>();

const setSharedFontSize = (size: number) => {
  const clamped = clampFontSize(size);
  if (clamped === currentFontSize) return;
  currentFontSize = clamped;
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(clamped));
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  for (const listener of fontSizeListeners) listener(clamped);
};

/** Commands that run at least this long notify when they finish out of sight. */
const NOTIFY_AFTER_SECONDS = 10;
/** Each pane's "finished" notification, while it's up. */
const paneNotifications = new Map<string, Notification>();

/** "45s", "2m 14s", "1h 3m". */
function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Whether a key event is the given Latin letter. Layouts without Latin
 * letters (Cyrillic, Greek, ...) fall back to the physical key, so Ctrl+C
 * still copies on them, the way elementary's terminal matches keycodes.
 */
const isLetterKey = (e: KeyboardEvent, letter: string) =>
  /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() === letter : e.code === `Key${letter.toUpperCase()}`;

/** Split axis: 'row' places panes side by side, 'column' stacks them. */
type SplitDir = 'row' | 'column';

/** A native app whose desktop entry says Terminal=true. */
interface TerminalApp {
  id: string;
  name: string;
}

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

/** A pane's pty on its way to another window, and what its screen showed. */
interface PaneHandover {
  /** From din.system.pty.release. */
  token: string;
  /** The screen and scrollback, as SerializeAddon writes them. */
  screen: string;
  cols: number;
  rows: number;
  cwd?: string;
  command?: string;
}

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

/** What a window keeps for Din to reopen it with (din.app.saveState). */
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

/** Tab-management actions triggered by keyboard shortcuts inside a pane. */
type TabShortcut = 'next-tab' | 'prev-tab' | 'new-tab' | 'close-tab';

/** One terminal tab: its identity and pane layout. */
interface TermTab {
  id: string;
  layout: LayoutNode;
  /** The pane that holds (or should hold) keyboard focus. */
  activePaneId: string;
}

/** What a pane's tab is named after: its last command, else its directory. */
interface PaneLabel {
  command?: string;
  cwd?: string;
}

function paneTitle(label: PaneLabel | undefined): string {
  if (label?.command) return label.command;
  const cwd = label?.cwd;
  if (cwd) return cwd === '/' ? '/' : cwd.slice(cwd.lastIndexOf('/') + 1) || '/';
  return 'Terminal';
}

/** Replace the leaf `paneId` with a split of itself and a new pane. */
/**
 * xterm's WebGL renderer calls generateMipmap() after every glyph-atlas
 * upload. On some drivers (ANGLE's GL backend on amdgpu) that fails with
 * "allocateMipmapLevelsForGeneration: Unexpected driver error", leaving the
 * texture mipmap-incomplete under the default NEAREST_MIPMAP_LINEAR min
 * filter, so every glyph on the page samples as a black box. Glyphs are drawn
 * at 1:1 scale and never need mipmaps: replace the call on this terminal's
 * context with plain LINEAR filtering, which is complete without them.
 */
function disableAtlasMipmaps(container: HTMLElement) {
  for (const canvas of container.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')) {
    const gl = canvas.getContext('webgl2');
    if (!gl) continue;
    gl.generateMipmap = (target) => {
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    };
  }
}

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
  const params = din.app.launch.params;
  const bridge = getPtyBridge();
  const theme = useDinTheme();
  const dark = theme.scheme === 'dark';
  const selection = selectionOf(theme.tokens);
  useLayoutEffect(() => setDinLook(dark, selection), [dark, selection]);
  // The whole window is the terminal's color: the header's tokens follow its
  // palette, and the accent carries it to the window controls and to the
  // menu bar over a fullscreen window.
  const palette = terminalTheme(dark);
  const surface = {
    background: palette.background,
    '--background': palette.background,
    '--foreground': palette.foreground,
    '--muted-foreground': dark ? 'rgb(229 229 229 / 0.7)' : 'rgb(31 35 40 / 0.7)',
  } as CSSProperties;
  useWindowAccent(palette.background);
  const closeWindow = useCallback(() => window.close(), []);

  // A window opened for a tab torn off another one starts empty, and gets
  // the tab.
  const adopting = hasAdoptedTab(din);
  // Reopened by Din on starting again, it has the tabs it had, in the
  // folders they were in (with fresh shells: the old ones died with Din).
  const [initial] = useState(() => {
    if (adopting) return { tabs: [], active: 0 };
    return (din.app.launch.state !== null && restoredTabs(din.app.launch.state)) || { tabs: [firstTab(params)], active: 0 };
  });
  const [tabs, setTabs] = useState<TermTab[]>(initial.tabs);
  const [activeId, setActiveId] = useState<string>(() => tabs[initial.active]?.id ?? tabs[0]?.id ?? '');
  const adoptStarted = useRef(false);
  useEffect(() => {
    if (!adopting || adoptStarted.current) return;
    adoptStarted.current = true;
    void adoptedTab(din).then((payload) => {
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
    din.app.saveState(saved);
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
      className="flex h-10 shrink-0 items-center gap-2 pr-3 pl-2"
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
      <div className="flex h-full w-full flex-col rounded-[inherit] text-foreground" style={surface}>
        {header}
        <div className="grid flex-1 place-items-center p-6">
          <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
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
    <div className="flex h-full w-full flex-col rounded-[inherit] text-foreground" style={surface}>
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

/** Where a pane's session sends its events: the pane mounted for it now. */
interface PaneHost {
  onCwdChange: (paneId: string, cwd: string) => void;
  onLabel: (paneId: string, label: PaneLabel | null) => void;
  onClose: (paneId: string) => void;
  onReveal: (paneId: string) => void;
  onTabShortcut: (action: TabShortcut) => void;
  openUrl: (url: string) => void;
  /** Whether the user can see the pane: its tab showing, its window on top. */
  visible: boolean;
}

/**
 * A pane's terminal: one xterm instance bound to one pty, kept outside React
 * so re-renders never touch the shell. Detaching it kills the shell.
 */
interface PaneSession {
  term: XTerm;
  fit: FitAddon;
  /** Show the terminal in a pane's container. Returns the detach fn. */
  attach: (container: HTMLElement, host: { current: PaneHost }) => () => void;
  /**
   * Let go of the pty for another window to adopt, with the screen as it
   * stands; detaching afterwards leaves the shell running. Undefined when
   * there's no live pty to hand over.
   */
  release: () => Promise<PaneHandover | undefined>;
}

const paneSessions = new Map<string, PaneSession>();

/** The session for a pane: the one it already has, or a new shell (or app). */
function paneSession(
  din: Din,
  bridge: PtyBridge,
  paneId: string,
  initialCwd: string | undefined,
  app: TerminalApp | undefined,
  handover: PaneHandover | undefined,
): PaneSession {
  const existing = paneSessions.get(paneId);
  if (existing) return existing;

  let disposed = false;
  let sessionId: number | null = null;
  let exited = false;
  let host: { current: PaneHost } | null = null;
  /** Output that raced ahead of the spawn() ack, keyed by session id. */
  const pending: Array<{ id: number; data: Uint8Array }> = [];
  /** Tracks the shell's current working directory via OSC 7. */
  let cwd = handover?.cwd ?? initialCwd;
  /** The command the pane's tab is named after. */
  let command: string | undefined = handover?.command ?? app?.name;

  const term = new XTerm({
    cursorBlink: true,
    fontSize: currentFontSize,
    fontFamily:
      "ui-monospace, 'Noto Sans Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace",
    scrollback: 5000,
    theme: terminalTheme(currentDark),
    // The graphemes addon needs the proposed `unicode` API.
    allowProposedApi: true,
    // A moved pane starts at its old size, so its screen lands as it was
    // drawn; fitting reflows it to this window afterwards.
    ...(handover ? { cols: handover.cols, rows: handover.rows } : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  // Treat grapheme clusters (skin tones, ZWJ sequences, flags) as one
  // double-width cell, so emoji like 👍🏽 and 🇺🇸 render whole.
  term.loadAddon(new UnicodeGraphemesAddon());

  // Prefer the WebGL renderer: the default DOM renderer draws box-drawing
  // and block glyphs straight from the font, leaving gaps and misaligned
  // borders in TUI apps. WebGL synthesizes those glyphs pixel-perfectly
  // (customGlyphs). Falls back to the DOM renderer when WebGL is
  // unavailable (e.g. software rendering disabled).
  //
  // The browser can also reclaim the GL context later (context-count
  // limits, GPU resets, suspend/resume), after which cells paint as black
  // boxes. Recreate the addon on context loss; after repeated losses give
  // up and let xterm fall back to the DOM renderer.
  //
  // A GPU reset also wipes the glyph atlas: its pages are accelerated 2D
  // canvases, and xterm shares one atlas between every terminal with the
  // same font settings. xterm still believes the glyphs are drawn, so every
  // cell (in old and new tabs alike) paints as a blank block. Clear the
  // atlas whenever a context comes back or a replacement addon loads, so
  // glyphs are rasterized again. The addon restores the GL context itself
  // when it returns within 3 s and only reports a loss after that.
  let contextLosses = 0;
  let reloadFailures = 0;
  let currentWebgl: WebglAddon | null = null;
  const onContextRestored = () => {
    requestAnimationFrame(() => currentWebgl?.clearTextureAtlas());
  };
  const loadWebgl = () => {
    if (disposed || !term.element) return;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (currentWebgl === webgl) currentWebgl = null;
        webgl.dispose();
        contextLosses += 1;
        if (disposed) return;
        if (contextLosses <= 3) {
          requestAnimationFrame(loadWebgl);
        } else {
          console.warn('Terminal: WebGL context lost repeatedly, falling back to DOM renderer');
          term.refresh(0, term.rows - 1);
        }
      });
      term.loadAddon(webgl);
      currentWebgl = webgl;
      disableAtlasMipmaps(term.element);
      if (contextLosses > 0) webgl.clearTextureAtlas();
    } catch (error) {
      // Right after a GPU reset the restarted GPU process may not hand out
      // contexts yet. Keep trying for a while before settling for DOM.
      if (contextLosses > 0 && reloadFailures < 10) {
        reloadFailures += 1;
        setTimeout(loadWebgl, 2000);
        return;
      }
      console.warn('Terminal: WebGL renderer unavailable, falling back to DOM renderer', error);
    }
  };

  // OSC 7 ("file://host/path") is emitted by zsh/bash/fish on every
  // directory change when the shell is configured to do so (or when using
  // a terminal-aware prompt theme). Capture it to track the pane's CWD so
  // new tabs and splits can inherit it.
  const oscHandler = term.parser.registerOscHandler(7, (data) => {
    try {
      const url = new URL(data);
      if (url.protocol === 'file:') {
        cwd = decodeURIComponent(url.pathname);
        host?.current.onCwdChange(paneId, cwd);
      }
    } catch {
      // ignore malformed OSC 7 payloads
    }
    return true;
  });

  // OSC 52 ("Pc;base64") is how programs without a clipboard tool of their
  // own copy: tmux, vim, TUIs like opencode, and anything over SSH. Writes
  // go on Din's clipboard; reads ("?") are ignored, since answering them
  // would hand the clipboard to whatever is running in the terminal.
  const clipboardHandler = term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    if (payload === '?' || payload.length > MAX_OSC52_BYTES) return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // ignore malformed OSC 52 payloads
    }
    return true;
  });

  // Linkify http/https URLs in the output. xterm has no link detection of
  // its own; this provider scans each line for URLs and, on Ctrl/Cmd+click
  // (Tilix/VS Code convention — a plain click still selects text), routes
  // the URL through the desktop's opener so it lands in the Web Browser (or
  // an installed web app that owns the origin).
  const linkProvider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      TERMINAL_URL_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TERMINAL_URL_REGEX.exec(text)) !== null) {
        // Drop trailing punctuation that's more likely sentence than URL.
        const url = match[0].replace(/[.,;:!?]+$/, '');
        if (!url) continue;
        const startX = match.index + 1; // xterm columns are 1-based
        links.push({
          text: url,
          range: {
            start: { x: startX, y: lineNumber },
            end: { x: startX + url.length - 1, y: lineNumber },
          },
          activate: (event, href) => {
            if (event.ctrlKey || event.metaKey) host?.current.openUrl(href);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  // Zoom: keep this session's font size synced with the shared (persisted)
  // value and refit so cols/rows track the new glyph metrics.
  const applyFontSize = (size: number) => {
    if (disposed) return;
    term.options.fontSize = size;
    fit.fit();
  };
  fontSizeListeners.add(applyFontSize);

  // Light or dark, following Din. Programs can ask for the background
  // (OSC 11, which xterm answers from the theme), and ones that turn on
  // mode 2031 (Neovim, Helix) are told when it flips, so they switch too:
  // DSR 997, "1" for dark, "2" for light. DSR 996 asks for it outright.
  let reportScheme = false;
  const schemeReport = () => `\x1b[?997;${currentDark ? 1 : 2}n`;
  const setReportScheme = (on: boolean) => (params: (number | number[])[]) => {
    if (params.includes(2031)) reportScheme = on;
    return false;
  };
  const schemeHandlers = [
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, setReportScheme(true)),
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, setReportScheme(false)),
    term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, (params) => {
      if (params[0] !== 2031) return false;
      term.input(`\x1b[?2031;${reportScheme ? 1 : 2}$y`, false);
      return true;
    }),
    term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params[0] !== 996) return false;
      term.input(schemeReport(), false);
      return true;
    }),
  ];
  const applyDark = (dark: boolean, schemeChanged: boolean) => {
    if (disposed) return;
    term.options.theme = terminalTheme(dark);
    if (reportScheme && schemeChanged) term.input(schemeReport(), false);
  };
  darkListeners.add(applyDark);

  // Ctrl/Cmd +/-/0 keyboard zoom and gnome-terminal/Tilix-style tab
  // shortcuts: Ctrl+PageUp/PageDown switch tabs, Ctrl+T or Ctrl+Shift+T
  // opens one, Ctrl+Shift+W closes the current one. Copy and paste work
  // like elementary's terminal ("natural copy/paste"): Ctrl+C copies when
  // there's a selection and is ^C otherwise, Ctrl+V pastes when the
  // clipboard has text and is ^V otherwise; Shift works too. Returning
  // false stops xterm from also sending the keystroke to the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
    if (!e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      host?.current.onTabShortcut(e.key === 'PageUp' ? 'prev-tab' : 'next-tab');
      return false;
    }
    if (isLetterKey(e, 'c') && term.hasSelection()) {
      e.preventDefault();
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    if (isLetterKey(e, 'v')) {
      e.preventDefault();
      navigator.clipboard
        .readText()
        .catch(() => '')
        .then((text) => {
          if (disposed) return;
          if (text) term.paste(text);
          else if (sessionId !== null && !e.shiftKey) bridge.write(sessionId, '\x16');
        });
      return false;
    }
    if (isLetterKey(e, 't')) {
      e.preventDefault();
      host?.current.onTabShortcut('new-tab');
      return false;
    }
    if (e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      host?.current.onTabShortcut('close-tab');
      return false;
    }
    switch (e.key) {
      case '+':
      case '=':
        setSharedFontSize(currentFontSize + 1);
        return false;
      case '-':
      case '_':
        setSharedFontSize(currentFontSize - 1);
        return false;
      case '0':
        setSharedFontSize(DEFAULT_FONT_SIZE);
        return false;
      default:
        return true;
    }
  });

  const offData = bridge.onData((id, data) => {
    if (sessionId === null) {
      pending.push({ id, data });
    } else if (id === sessionId) {
      term.write(data);
    }
  });
  const offExit = bridge.onExit((id) => {
    // The shell ended (Ctrl+D, `exit`, crash): close the pane right away —
    // no interstitial. Closing a tab's last pane closes the tab, and the
    // last tab closes the window. A pane between windows closes on arrival.
    if (id !== sessionId) return;
    exited = true;
    host?.current.onClose(paneId);
  });
  // Like elementary's terminal: a long command finishing out of sight
  // (another tab, a window in front, minimized) says so. Clicking the
  // notification brings this pane back.
  // The tab is named after the command running in it, or the last one.
  const offCommandStart =
    bridge.onCommandStart?.((id, started) => {
      if (id !== sessionId || !started) return;
      command = started;
      host?.current.onLabel(paneId, { command });
    }) ?? (() => {});
  const offCommandDone = bridge.onCommandDone((id, done) => {
    if (id !== sessionId) return;
    if (done.command) {
      command = done.command;
      host?.current.onLabel(paneId, { command });
    }
    if (done.seconds < NOTIFY_AFTER_SECONDS || host?.current.visible) return;
    const notification = new Notification(done.command || 'Command', {
      body: `Finished after ${formatDuration(done.seconds)}`,
      tag: paneId,
    });
    paneNotifications.set(paneId, notification);
    notification.onclick = () => host?.current.onReveal(paneId);
    notification.onclose = () => {
      if (paneNotifications.get(paneId) === notification) paneNotifications.delete(paneId);
    };
  });

  term.onData((data) => {
    if (sessionId !== null) bridge.write(sessionId, data);
  });
  term.onResize(({ cols, rows }) => {
    if (sessionId !== null) bridge.resize(sessionId, cols, rows);
  });

  // A pane from another window shows what it showed there, then takes over
  // its pty (whose output since waits in main, and follows the screen).
  if (handover) term.write(handover.screen);
  const pty = din.system.pty;

  const spawn = () => {
    const started = handover && pty
      ? pty.adopt(handover.token)
      : bridge.spawn({ cols: term.cols, rows: term.rows }, cwd, app?.id);
    started
      .then((id) => {
        if (disposed) {
          bridge.kill(id);
          return;
        }
        sessionId = id;
        for (const event of pending) {
          if (event.id === id) term.write(event.data);
        }
        pending.length = 0;
        if (handover) {
          // Tell it this window's size. A full-screen program (htop, vim)
          // redraws on SIGWINCH, which only comes when the size changes, so
          // one gets a nudge first.
          if (term.buffer.active.type === 'alternate') bridge.resize(id, term.cols, Math.max(1, term.rows - 1));
          bridge.resize(id, term.cols, term.rows);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed) term.write(`\r\nFailed to start ${app?.name ?? 'shell'}: ${message}\r\n`);
      });
  };

  const dispose = () => {
    disposed = true;
    paneSessions.delete(paneId);
    fontSizeListeners.delete(applyFontSize);
    darkListeners.delete(applyDark);
    for (const handler of schemeHandlers) handler.dispose();
    offData();
    offExit();
    offCommandStart();
    offCommandDone();
    oscHandler.dispose();
    clipboardHandler.dispose();
    linkProvider.dispose();
    if (sessionId !== null) bridge.kill(sessionId);
    term.dispose();
  };

  const release = async (): Promise<PaneHandover | undefined> => {
    if (sessionId === null || exited || disposed || !pty) return undefined;
    const id = sessionId;
    const token = await pty.release(id);
    // Its output up to now has arrived (main holds the rest for the adopter);
    // let xterm finish parsing it, then copy the screen.
    sessionId = null;
    await new Promise<void>((resolve) => term.write('', resolve));
    return { token, screen: serializer.serialize(), cols: term.cols, rows: term.rows, cwd, command };
  };

  const session: PaneSession = {
    term,
    fit,
    release,
    attach(container, h) {
      host = h;
      if (term.element) {
        container.appendChild(term.element);
        fit.fit();
      } else {
        term.open(container);
        loadWebgl();
        fit.fit();
        spawn();
      }
      // A pane mounted again (development's double effects) learns what it knew.
      if (cwd) h.current.onCwdChange(paneId, cwd);
      if (command) h.current.onLabel(paneId, { command });
      if (exited) h.current.onClose(paneId);

      // Ctrl/Cmd + scroll wheel zooms (Tilix-style). Capture phase +
      // stopPropagation so xterm's own wheel handler doesn't also scroll the
      // buffer while zooming.
      const onWheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        e.stopPropagation();
        setSharedFontSize(currentFontSize + (e.deltaY < 0 ? 1 : -1));
      };
      container.addEventListener('wheel', onWheel, { passive: false, capture: true });

      // Refit on any container size change (window resize/maximize, pane
      // splits, divider drags). The rAF hop coalesces bursts and avoids
      // "ResizeObserver loop" warnings; the resulting term.onResize event
      // forwards the new size to the pty.
      let attached = true;
      const observer = new ResizeObserver(() => {
        requestAnimationFrame(() => {
          if (attached && host === h && !disposed) fit.fit();
        });
      });
      observer.observe(container);

      // Focus the terminal on click anywhere in its area.
      const focus = () => term.focus();
      container.addEventListener('mousedown', focus);
      container.addEventListener('webglcontextrestored', onContextRestored, true);

      return () => {
        attached = false;
        observer.disconnect();
        container.removeEventListener('wheel', onWheel, { capture: true });
        container.removeEventListener('mousedown', focus);
        container.removeEventListener('webglcontextrestored', onContextRestored, true);
        if (host !== h) return;
        host = null;
        h.current.onLabel(paneId, null);
        dispose();
      };
    },
  };
  paneSessions.set(paneId, session);
  return session;
}

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
  const isTop = useWindowState().focused;
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
          <div ref={containerRef} className="h-full w-full pl-2 pt-1" />
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
