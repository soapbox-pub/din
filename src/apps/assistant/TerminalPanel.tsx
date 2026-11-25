import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { getPtyBridge } from '@/lib/pty';
import { useDin, useWindowFocused } from '@/sdk/react';
import { useAssistantHost } from '@/shared/assistant/host';
import { paneNotifications, paneSession, useTerminalLook, type PaneHost, type PaneSession } from '@/shared/terminal/session';

/**
 * The terminal under a conversation, across the bottom of the Assistant's
 * content pane: a shell in the conversation's folder, one for each tab.
 * Hiding it (Ctrl+`, the folder under the composer) leaves its shell
 * running, as switching tabs does; the shell ending, or Close Terminal,
 * puts it away for good. Its cells are clear, over the pane's own color.
 */

/** What marks a terminal's element, for the window's shortcuts to leave its keys to the shell. */
export const TERMINAL_ATTRIBUTE = 'data-assistant-terminal';

const HEIGHT_KEY = 'din.assistant.terminal-height';
const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 96;
/** Room the conversation keeps above it, at the least. */
const KEEP_ABOVE = 160;

function loadHeight(): number {
  const height = Number(localStorage.getItem(HEIGHT_KEY));
  return height >= MIN_HEIGHT ? height : DEFAULT_HEIGHT;
}

/** A tab's terminal, as the window knows it. */
export interface TerminalTab {
  /** The tab's id, which its shell is kept under. */
  id: string;
  /** Where its shell starts. */
  directory: string | undefined;
}

export function TerminalPanel({
  terminals,
  shownId,
  onClose,
  onReveal,
  container,
}: {
  /** Every tab with a shell running, hidden or not. */
  terminals: TerminalTab[];
  /** The tab whose terminal shows, if one does. */
  shownId: string | null;
  /** Its shell ended, or Close Terminal: the tab has no terminal now. */
  onClose: (id: string) => void;
  /** A notification was clicked: show that tab's terminal. */
  onReveal: (id: string) => void;
  /** The content pane it's at the bottom of, for the most it may take. */
  container: React.RefObject<HTMLElement | null>;
}) {
  useTerminalLook();
  const [height, setHeight] = useState(loadHeight);
  useEffect(() => (height === DEFAULT_HEIGHT ? localStorage.removeItem(HEIGHT_KEY) : localStorage.setItem(HEIGHT_KEY, String(height))), [height]);
  const clamp = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(h, (container.current?.clientHeight ?? 640) - KEEP_ABOVE)));
  const [resizing, setResizing] = useState(false);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: PointerEvent) => setHeight(clamp(startHeight + startY - ev.clientY));
    const up = () => {
      setResizing(false);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  if (terminals.length === 0) return null;
  const shown = shownId !== null && terminals.some((t) => t.id === shownId);
  return (
    // Hidden ones stay mounted below it, out of sight, their shells running.
    <div className="relative shrink-0" style={{ height: shown ? height : 0, maxHeight: `calc(100% - ${KEEP_ABOVE}px)` }}>
      {shown && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the terminal"
          aria-valuenow={height}
          aria-valuemin={MIN_HEIGHT}
          tabIndex={0}
          title="Drag to resize, double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => setHeight(clamp(DEFAULT_HEIGHT))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setHeight((h) => clamp(h + 24));
            else if (e.key === 'ArrowDown') setHeight((h) => clamp(h - 24));
            else return;
            e.preventDefault();
          }}
          className="group absolute inset-x-0 -top-1 z-10 grid h-2 cursor-row-resize touch-none place-items-center focus-visible:outline-none"
        >
          <div className="h-px w-full bg-border/60 transition-colors group-hover:bg-ring/60 group-focus-visible:h-0.5 group-focus-visible:bg-ring/60" />
        </div>
      )}
      {terminals.map((t) => (
        <div
          key={t.id}
          className="absolute inset-x-0 top-0"
          style={
            t.id === shownId
              ? { bottom: 0, pointerEvents: resizing ? 'none' : undefined }
              : { height, visibility: 'hidden', pointerEvents: 'none', transform: 'translateY(100vh)' }
          }
        >
          <AssistantTerminal tab={t} shown={t.id === shownId} onClose={onClose} onReveal={onReveal} />
        </div>
      ))}
    </div>
  );
}

const AssistantTerminal = memo(function AssistantTerminal({
  tab,
  shown,
  onClose,
  onReveal,
}: {
  tab: TerminalTab;
  shown: boolean;
  onClose: (id: string) => void;
  onReveal: (id: string) => void;
}) {
  const din = useDin();
  const bridge = getPtyBridge();
  const { openApp } = useAssistantHost();
  const paneId = `assistant-${tab.id}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<PaneSession | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const directory = useRef(tab.directory);
  const focused = useWindowFocused();
  const host = useRef<PaneHost>({
    onCwdChange: () => {},
    onLabel: () => {},
    onClose: () => onClose(tab.id),
    onReveal: () => onReveal(tab.id),
    openUrl: (url) => window.open(url),
    visible: false,
  });
  useLayoutEffect(() => {
    host.current = { ...host.current, onClose: () => onClose(tab.id), onReveal: () => onReveal(tab.id), visible: shown && focused };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!bridge || !container) return;
    const session = paneSession(din, bridge, paneId, directory.current, undefined, undefined, { clear: true });
    sessionRef.current = session;
    termRef.current = session.term;
    fitRef.current = session.fit;
    const detach = session.attach(container, host);
    return () => {
      detach();
      sessionRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [din, bridge, paneId]);

  // Shown again: fit it to the pane as it is now, and give it the keyboard.
  useEffect(() => {
    if (!shown) return;
    paneNotifications.get(paneId)?.close();
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
  }, [shown, paneId]);

  const copy = () => {
    const text = termRef.current?.getSelection();
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  };
  const paste = () => {
    navigator.clipboard.readText().then((text) => text && termRef.current?.paste(text)).catch(() => {});
  };

  if (!bridge) {
    return (
      <div className="grid h-full place-items-center border-t border-border/60 p-4 text-sm text-muted-foreground">
        The terminal needs Din’s system bridge, which a plain browser doesn’t have.
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div {...{ [TERMINAL_ATTRIBUTE]: '' }} className="h-full w-full">
          {/* xterm.css paints its viewport black; clear, so the pane shows through. */}
          <div ref={containerRef} className="h-full w-full pt-2 pl-4 [&_.xterm-viewport]:bg-transparent!" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          termRef.current?.focus();
        }}
      >
        <ContextMenuItem onSelect={copy}>Copy</ContextMenuItem>
        <ContextMenuItem onSelect={paste}>Paste</ContextMenuItem>
        <ContextMenuItem onSelect={() => termRef.current?.clear()}>Clear</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => openApp('terminal', { cwd: sessionRef.current?.cwd() ?? tab.directory })}>
          Open in Terminal
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onClose(tab.id)}>Close Terminal</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
