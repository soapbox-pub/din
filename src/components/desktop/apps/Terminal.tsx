import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { RotateCw, SquareTerminal } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { getPtyBridge } from '@/lib/pty';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { TabStrip } from '@/components/desktop/TabStrip';
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

/** One terminal tab: its identity plus a tab label. */
interface TermTab {
  id: string;
  /** Sequential number shown in the tab (1-based, stable per tab). */
  index: number;
}

/**
 * Terminal - a real interactive shell on the underlying OS.
 *
 * Rendered with xterm.js; each tab owns one pty session over the `window.pty`
 * bridge (see src/lib/pty.ts). Sessions run as the unprivileged OS user and
 * die with the window. Multiple tabs share one window: all sessions stay
 * mounted (their xterm state survives) and only the active one is visible.
 * Outside the Electron shell (plain-browser dev) there is no bridge, so a
 * fallback notice renders instead.
 */
export function Terminal({ windowId }: AppComponentProps) {
  const bridge = getPtyBridge();
  const { close: closeWindow } = useWindowManager();
  const setTitlebar = useWindowTitlebar();

  const [tabs, setTabs] = useState<TermTab[]>(() => [
    { id: newSessionId(), index: 1 },
  ]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  // Counter so each new tab gets a stable, increasing "Terminal N" label.
  const nextIndex = useRef(2);

  const openTab = useCallback(() => {
    const tab = { id: newSessionId(), index: nextIndex.current++ };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  }, []);

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
      {/* All sessions stay mounted so background tabs keep their scrollback
          and running programs; only the active one is visible. */}
      {tabs.map((tab) => (
        <TerminalSession
          key={tab.id}
          active={tab.id === activeId}
          onClose={() => closeTab(tab.id)}
        />
      ))}
    </div>
  );
}

/**
 * A single terminal session: one xterm instance bound to one pty. Mounted for
 * the lifetime of its tab. Memoized so another tab's state change doesn't
 * re-run this one's effects.
 */
const TerminalSession = memo(function TerminalSession({
  active,
  onClose,
}: {
  active: boolean;
  onClose: () => void;
}) {
  const bridge = getPtyBridge();
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  /** Bumped to tear down the old session/terminal and start fresh. */
  const [epoch, setEpoch] = useState(0);

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
      fontSize: 13,
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
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (error) {
      console.warn('Terminal: WebGL renderer unavailable, falling back to DOM renderer', error);
    }

    fit.fit();

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
      .spawn({ cols: term.cols, rows: term.rows })
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

    // Refit on any container size change (window resize/maximize). The rAF
    // hop coalesces bursts and avoids "ResizeObserver loop" warnings; the
    // resulting term.onResize event forwards the new size to the pty.
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
      container.removeEventListener('mousedown', focus);
      offData();
      offExit();
      if (sessionId !== null) bridge.kill(sessionId);
      fitRef.current = null;
      term.dispose();
    };
  }, [bridge, epoch]);

  // When this tab becomes active, refit (its container had zero size while
  // hidden, so xterm's cached dimensions are stale) and take focus.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return (
    <div
      className="absolute inset-0"
      // visibility (not display:none) keeps xterm's layout measurements valid
      // for background tabs, matching how minimized windows stay mounted.
      style={active ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
    >
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
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Close tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
