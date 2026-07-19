import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { RotateCw, SquareTerminal } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { getPtyBridge } from '@/lib/pty';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { TabStrip } from '@/components/desktop/TabStrip';
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
 * Fixed terminal palette (terminals keep their own colors regardless of the
 * OS theme). Roughly the default
 * "Tango dark" palette with a slightly brighter foreground for contrast.
 */
const TERMINAL_THEME = {
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

let nextSessionId = 0;
const newSessionId = () => `term-${nextSessionId++}`;

let nextTabId = 0;
const newTabId = () => `termtab-${nextTabId++}`;

let nextSplitId = 0;
const newSplitId = () => `split-${nextSplitId++}`;

/**
 * Terminal font size ("zoom"), shared across every pane and tab and persisted
 * so it survives restarts. Tilix-style Ctrl/Cmd+scroll and Ctrl/Cmd +/-/0
 * mutate it through {@link setSharedFontSize}; live sessions subscribe via
 * {@link fontSizeListeners} and refit when it changes.
 */
const FONT_SIZE_KEY = 'din.terminal.fontSize';
const DEFAULT_FONT_SIZE = 13;
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

/** One terminal tab: its identity, tab label, and pane layout. */
interface TermTab {
  id: string;
  /** Sequential number shown in the tab (1-based, stable per tab). */
  index: number;
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
    leaves.push({ paneId: node.paneId, initialCwd: node.initialCwd, rect });
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
 * Rendered with xterm.js; each pane owns one pty session over the `window.pty`
 * bridge (see src/lib/pty.ts). Sessions run as the unprivileged OS user and
 * die with the window. Multiple tabs share one window: all sessions stay
 * mounted (their xterm state survives) and only the active tab is visible.
 * Within a tab, right-click offers Tilix-style tiling: split a pane right or
 * down into a tree of terminals with draggable dividers.
 * Outside the Electron shell (plain-browser dev) there is no bridge, so a
 * fallback notice renders instead.
 */
export function Terminal({ windowId }: AppComponentProps) {
  const bridge = getPtyBridge();
  const { close: closeWindow } = useWindowActions();
  const setTitlebar = useWindowTitlebar();

  const [tabs, setTabs] = useState<TermTab[]>(() => {
    const paneId = newSessionId();
    return [
      { id: newTabId(), index: 1, layout: { type: 'leaf', paneId }, activePaneId: paneId },
    ];
  });
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  // Counter so each new tab gets a stable, increasing "Terminal N" label.
  const nextIndex = useRef(2);
  // Tracks last known CWD per pane, updated via OSC 7 from each shell.
  const panesCwd = useRef<Map<string, string>>(new Map());

  const handleCwdChange = useCallback((paneId: string, cwd: string) => {
    panesCwd.current.set(paneId, cwd);
  }, []);

  const openTab = useCallback(() => {
    const paneId = newSessionId();
    const activeTab = tabs.find((t) => t.id === activeId);
    const initialCwd = activeTab ? panesCwd.current.get(activeTab.activePaneId) : undefined;
    const tab: TermTab = {
      id: newTabId(),
      index: nextIndex.current++,
      layout: { type: 'leaf', paneId, initialCwd },
      activePaneId: paneId,
    };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, [tabs, activeId]);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((ts) => {
        const index = ts.findIndex((t) => t.id === id);
        if (index === -1) return ts;
        const next = ts.filter((t) => t.id !== id);
        // Closing the last tab closes the terminal window.
        if (next.length === 0) {
          closeWindow(windowId);
          return ts;
        }
        setActiveId((current) =>
          current === id ? next[Math.max(0, index - 1)].id : current,
        );
        return next;
      });
    },
    [closeWindow, windowId],
  );

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
            closeWindow(windowId);
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
    [closeWindow, windowId],
  );

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId && t.activePaneId !== paneId ? { ...t, activePaneId: paneId } : t,
      ),
    );
  }, []);

  const resizeSplit = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((ts) =>
      ts.map((t) =>
        t.id === tabId ? { ...t, layout: setSplitRatio(t.layout, splitId, ratio) } : t,
      ),
    );
  }, []);

  // Publish the tab strip into the window title bar (Chrome-style), so tabs
  // share a line with the window controls. Cleared on unmount.
  useEffect(() => {
    if (!bridge) return;
    setTitlebar(
      <TabStrip
        tabs={tabs.map((t) => ({
          id: t.id,
          title: `Terminal ${t.index}`,
          icon: <SquareTerminal className="size-3.5" />,
        }))}
        activeId={activeId}
        label="Terminal tabs"
        newTabLabel="New terminal"
        onActivate={setActiveId}
        onClose={closeTab}
        onNew={openTab}
      />,
    );
    return () => setTitlebar(null);
  }, [bridge, tabs, activeId, closeTab, openTab, setTitlebar]);

  if (!bridge) {
    return (
      <div className="grid h-full w-full place-items-center p-6">
        <div className="max-w-sm rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <SquareTerminal className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="text-sm text-muted-foreground">
            Terminal needs the Electron shell to run an OS shell. Run{' '}
            <code className="rounded bg-foreground/10 px-1 py-0.5">make dev</code> or
            boot the VM; the bridge is not available in a plain browser.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-[#0a0a0a]">
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
          onResizeSplit={resizeSplit}
          onCwdChange={handleCwdChange}
        />
      ))}
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
  onResizeSplit,
  onCwdChange,
}: {
  tab: TermTab;
  active: boolean;
  onSplit: (tabId: string, paneId: string, dir: SplitDir) => void;
  onClosePane: (tabId: string, paneId: string) => void;
  onFocusPane: (tabId: string, paneId: string) => void;
  onResizeSplit: (tabId: string, splitId: string, ratio: number) => void;
  onCwdChange: (paneId: string, cwd: string) => void;
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
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
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
            onSplit={handleSplit}
            onClose={handleClose}
            onCwdChange={onCwdChange}
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
              'bg-white/15 transition-colors group-hover:bg-white/40',
              d.dir === 'row' ? 'h-full w-px' : 'h-px w-full',
            )}
          />
        </div>
      ))}
    </div>
  );
});

/**
 * A single terminal session: one xterm instance bound to one pty. Mounted for
 * the lifetime of its pane. Memoized so another pane's state change doesn't
 * re-run this one's effects. Right-click opens a context menu with clipboard
 * actions and Tilix-style split/close-pane actions.
 */
const TerminalSession = memo(function TerminalSession({
  paneId,
  active,
  focused,
  initialCwd,
  onSplit,
  onClose,
  onCwdChange,
}: {
  paneId: string;
  /** Whether the owning tab is visible. */
  active: boolean;
  /** Whether this pane should hold keyboard focus within its tab. */
  focused: boolean;
  /** Working directory to start the shell in on first spawn (and restarts). */
  initialCwd?: string;
  onSplit: (paneId: string, dir: SplitDir) => void;
  onClose: (paneId: string) => void;
  onCwdChange: (paneId: string, cwd: string) => void;
}) {
  const bridge = getPtyBridge();
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** Bumped to tear down the old session/terminal and start fresh. */
  const [epoch, setEpoch] = useState(0);
  /** Tracks the shell's current working directory via OSC 7; also used for restarts. */
  const cwdRef = useRef<string | undefined>(initialCwd);
  /** Always-fresh reference to onCwdChange so the effect closure never goes stale. */
  const onCwdChangeRef = useRef(onCwdChange);
  useLayoutEffect(() => {
    onCwdChangeRef.current = onCwdChange;
  });

  const restart = useCallback(() => {
    setExitCode(null);
    setEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!bridge || !container) return;

    let disposed = false;
    let sessionId: number | null = null;
    /** Output that raced ahead of the spawn() ack, keyed by session id. */
    const pending: Array<{ id: number; data: Uint8Array }> = [];

    const term = new XTerm({
      cursorBlink: true,
      fontSize: currentFontSize,
      fontFamily:
        "ui-monospace, 'Noto Sans Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(container);

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
    let contextLosses = 0;
    const loadWebgl = () => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
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
      } catch (error) {
        console.warn('Terminal: WebGL renderer unavailable, falling back to DOM renderer', error);
      }
    };
    loadWebgl();

    // OSC 7 ("file://host/path") is emitted by zsh/bash/fish on every
    // directory change when the shell is configured to do so (or when using
    // a terminal-aware prompt theme). Capture it to track the pane's CWD so
    // new tabs and splits can inherit it.
    const oscHandler = term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === 'file:') {
          const cwd = decodeURIComponent(url.pathname);
          cwdRef.current = cwd;
          onCwdChangeRef.current(paneId, cwd);
        }
      } catch {
        // ignore malformed OSC 7 payloads
      }
      return true;
    });

    fit.fit();
    termRef.current = term;

    // Zoom: keep this session's font size synced with the shared (persisted)
    // value and refit so cols/rows track the new glyph metrics.
    const applyFontSize = (size: number) => {
      if (disposed) return;
      term.options.fontSize = size;
      fit.fit();
    };
    fontSizeListeners.add(applyFontSize);

    // Ctrl/Cmd + scroll wheel zooms (Tilix-style). Capture phase + stopPropagation
    // so xterm's own wheel handler doesn't also scroll the buffer while zooming.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      setSharedFontSize(currentFontSize + (e.deltaY < 0 ? 1 : -1));
    };
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });

    // Ctrl/Cmd +/-/0 keyboard zoom. Returning false stops xterm from also
    // sending the keystroke to the shell.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
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

    // The WebGL glyph atlas can silently corrupt (glyphs render as black
    // boxes) after GPU resets or OS suspend/resume — a known Chromium/driver
    // issue. clearTextureAtlas() forces every glyph to be re-rasterized, so
    // run it whenever the app regains focus or becomes visible again.
    const clearAtlas = () => {
      if (!disposed) term.clearTextureAtlas();
    };
    const onVisibilityChange = () => {
      if (!document.hidden) clearAtlas();
    };
    window.addEventListener('focus', clearAtlas);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const offData = bridge.onData((id, data) => {
      if (sessionId === null) {
        pending.push({ id, data });
      } else if (id === sessionId) {
        term.write(data);
      }
    });
    const offExit = bridge.onExit((id, code) => {
      if (id === sessionId) setExitCode(code);
    });

    term.onData((data) => {
      if (sessionId !== null) bridge.write(sessionId, data);
    });
    term.onResize(({ cols, rows }) => {
      if (sessionId !== null) bridge.resize(sessionId, cols, rows);
    });

    bridge
      .spawn({ cols: term.cols, rows: term.rows }, cwdRef.current)
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
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!disposed) term.write(`Failed to start shell: ${message}\r\n`);
      });

    // Refit on any container size change (window resize/maximize, pane
    // splits, divider drags). The rAF hop coalesces bursts and avoids
    // "ResizeObserver loop" warnings; the resulting term.onResize event
    // forwards the new size to the pty.
    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!disposed) fit.fit();
      });
    });
    observer.observe(container);

    // Focus the terminal on click anywhere in its area.
    const focus = () => term.focus();
    container.addEventListener('mousedown', focus);

    return () => {
      disposed = true;
      observer.disconnect();
      fontSizeListeners.delete(applyFontSize);
      container.removeEventListener('wheel', onWheel, { capture: true });
      container.removeEventListener('mousedown', focus);
      window.removeEventListener('focus', clearAtlas);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      offData();
      offExit();
      oscHandler.dispose();
      if (sessionId !== null) bridge.kill(sessionId);
      fitRef.current = null;
      termRef.current = null;
      term.dispose();
    };
  }, [bridge, epoch, paneId]);

  // When this pane's tab becomes active, refit (its container had zero size
  // while hidden, so xterm's cached dimensions are stale) and re-rasterize
  // the glyph atlas in case it corrupted while the tab was in the background.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.clearTextureAtlas();
    });
  }, [active]);

  // Keep keyboard focus on the tab's active pane (new splits focus the new
  // pane; closing a pane moves focus to a survivor).
  useEffect(() => {
    if (active && focused) termRef.current?.focus();
  }, [active, focused]);

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
          {exitCode !== null && (
            <div className="absolute inset-0 grid place-items-center bg-background/80">
              <div className="rounded-xl border border-border/60 bg-popover px-6 py-5 text-center shadow-lg">
                <p className="mb-3 text-sm text-muted-foreground">
                  Session ended{exitCode !== 0 ? ` (exit code ${exitCode})` : ''}.
                </p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={restart}
                    className="inline-flex items-center gap-2 rounded-lg bg-foreground/10 px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <RotateCw className="size-4" aria-hidden />
                    New session
                  </button>
                  <button
                    type="button"
                    onClick={() => onClose(paneId)}
                    className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
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
