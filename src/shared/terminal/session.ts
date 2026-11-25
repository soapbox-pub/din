import { Terminal as XTerm, type ILink } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import type { PtyBridge } from '@/lib/pty';
import { useLayoutEffect } from 'react';
import type { Din } from '@/sdk';
import { useDinTheme, useMediaQuery } from '@/sdk/react';
import '@xterm/xterm/css/xterm.css';

/**
 * A terminal: one xterm.js instance bound to one shell over `din.system.pty`
 * (the `pty` permission; see src/lib/pty.ts), kept outside React so
 * re-renders never touch the shell. The Terminal app tiles these into tabs
 * and splits; the Assistant keeps one under each conversation.
 */
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
export const selectionOf = (tokens: Record<string, string> | undefined) =>
  tokens?.selection && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(tokens.selection) ? tokens.selection : undefined;

export const terminalTheme = (dark: boolean, selection = currentSelection, glass = currentGlass) => {
  const palette = dark ? DARK_THEME : LIGHT_THEME;
  return {
    ...palette,
    ...(selection ? { selectionBackground: selection } : {}),
    // On glass the cells are clear, and the window's tinted glass shows
    // through them. Still the palette's color with no alpha, so a program
    // asking for the background (OSC 11) hears the same light or dark.
    ...(glass ? { background: `${palette.background}00` } : {}),
  };
};

/**
 * Whether Din's windows are glass (Settings → Themes' Liquid or Frosted),
 * so the terminal is too, its color laid over the glass, or solid (Solid,
 * Reduce transparency, Increase contrast), the terminal's own color.
 */
export const isGlass = (tokens: Record<string, string> | undefined) => {
  const material = tokens?.['glass-material']?.trim();
  return material === 'liquid' || material === 'frosted';
};

/**
 * How much of the terminal's color the window's frosted glass is, as a hex
 * alpha on its accent: black glass in the dark, white in the light, enough
 * to keep text on it readable whatever's behind.
 */
export const GLASS_ALPHA = 'c0';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Whether Din is dark right now (prefers-color-scheme, which follows the
 * Light/Dark/System setting and a custom theme's own background alike).
 * Sessions live outside React, so the window sets it here and they repaint
 * when it changes.
 */
let currentDark = matchMedia(DARK_QUERY).matches;
/** Selected text's color on the desktop, which the terminal's selection takes too. */
let currentSelection = selectionOf(window.din?.theme.current.tokens);
/** Whether the window is glass, which the terminal's cells are clear over. */
let currentGlass = isGlass(window.din?.theme.current.tokens);
const darkListeners = new Set<(dark: boolean, schemeChanged: boolean) => void>();

/** Keeps the window's terminals in step with Din's look; what it is now. */
export function useTerminalLook(): { dark: boolean; selection: string | undefined; glass: boolean } {
  const theme = useDinTheme();
  const dark = useMediaQuery(DARK_QUERY);
  const selection = selectionOf(theme.tokens);
  const glass = isGlass(theme.tokens);
  useLayoutEffect(() => setDinLook(dark, selection, glass), [dark, selection, glass]);
  return { dark, selection, glass };
}

function setDinLook(dark: boolean, selection: string | undefined, glass: boolean) {
  if (dark === currentDark && selection === currentSelection && glass === currentGlass) return;
  const schemeChanged = dark !== currentDark;
  currentDark = dark;
  currentSelection = selection;
  currentGlass = glass;
  for (const listener of darkListeners) listener(dark, schemeChanged);
}

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
export const paneNotifications = new Map<string, Notification>();

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


/** A native app whose desktop entry says Terminal=true. */
export interface TerminalApp {
  id: string;
  name: string;
}

/** A pane's pty on its way to another window, and what its screen showed. */
export interface PaneHandover {
  /** From din.system.pty.release. */
  token: string;
  /** The screen and scrollback, as SerializeAddon writes them. */
  screen: string;
  cols: number;
  rows: number;
  cwd?: string;
  command?: string;
}

/** What a pane's tab is named after: its last command, else its directory. */
export interface PaneLabel {
  command?: string;
  cwd?: string;
}

export function paneTitle(label: PaneLabel | undefined): string {
  if (label?.command) return label.command;
  const cwd = label?.cwd;
  if (cwd) return cwd === '/' ? '/' : cwd.slice(cwd.lastIndexOf('/') + 1) || '/';
  return 'Terminal';
}

/** Tab-management actions triggered by keyboard shortcuts inside a pane. */
export type TabShortcut = 'next-tab' | 'prev-tab' | 'new-tab' | 'close-tab';

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

/** Where a pane's session sends its events: the pane mounted for it now. */
export interface PaneHost {
  onCwdChange: (paneId: string, cwd: string) => void;
  onLabel: (paneId: string, label: PaneLabel | null) => void;
  onClose: (paneId: string) => void;
  onReveal: (paneId: string) => void;
  /** Tab shortcuts, for a window with tabs of terminals; without it, the keys go to the shell. */
  onTabShortcut?: (action: TabShortcut) => void;
  openUrl: (url: string) => void;
  /** Whether the user can see the pane: its tab showing, its window on top. */
  visible: boolean;
}

/**
 * A pane's terminal: one xterm instance bound to one pty, kept outside React
 * so re-renders never touch the shell. Detaching it kills the shell.
 */
export interface PaneSession {
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
  /** The shell's folder as it last said (OSC 7), else the one it started in. */
  cwd: () => string | undefined;
}

/** How a session looks, besides Din's light or dark. */
export interface PaneOptions {
  /**
   * Clear cells always, over whatever the pane is painted (the Assistant's
   * content pane), rather than only on glass.
   */
  clear?: boolean;
}

export const paneSessions = new Map<string, PaneSession>();

/** The session for a pane: the one it already has, or a new shell (or app). */
export function paneSession(
  din: Din,
  bridge: PtyBridge,
  paneId: string,
  initialCwd: string | undefined,
  app: TerminalApp | undefined,
  handover: PaneHandover | undefined,
  options: PaneOptions = {},
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
  const theme = (dark: boolean) => terminalTheme(dark, currentSelection, options.clear || currentGlass);

  const term = new XTerm({
    cursorBlink: true,
    fontSize: currentFontSize,
    fontFamily:
      "ui-monospace, 'Noto Sans Mono', 'DejaVu Sans Mono', Menlo, Consolas, 'Symbols Nerd Font Mono', monospace",
    scrollback: 5000,
    theme: theme(currentDark),
    // Clear cells on glass (terminalTheme); the renderer needs to know first.
    allowTransparency: true,
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
    term.options.theme = theme(dark);
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
    const tabs = host?.current.onTabShortcut;
    if (tabs && !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      e.preventDefault();
      tabs(e.key === 'PageUp' ? 'prev-tab' : 'next-tab');
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
    if (tabs && isLetterKey(e, 't')) {
      e.preventDefault();
      tabs('new-tab');
      return false;
    }
    if (tabs && e.shiftKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      tabs('close-tab');
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
    cwd: () => cwd,
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
