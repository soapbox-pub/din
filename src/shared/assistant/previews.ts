import { createContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMessage } from '@/lib/assistant';

/*
 * Previews: the pages the agent showed beside a conversation with its
 * `preview` tool (os/opencode/plugins/preview.ts), each a tab in the side
 * pane. They're read from the conversation itself, so a conversation has
 * its tabs again after a restart; closing one is remembered here until the
 * agent shows that page again.
 */

/** What a preview shows: a server on this computer, or an HTML file framed through a URL for its folder. */
export type PreviewTarget = { kind: 'server'; url: string } | { kind: 'file'; path: string };

export interface Preview {
  /** The page, as the agent named it (normalized): what tells tabs apart. */
  uri: string;
  target: PreviewTarget;
  title: string;
  /** The latest call that showed it. */
  callID: string;
  /** When that call finished. */
  at: number;
}

/**
 * Showing a page the agent previewed in its tab beside the conversation,
 * where there's a pane for it (the Assistant); with none, a turn shows no
 * cards for its previews.
 */
export const PreviewOpenContext = createContext<((uri: string) => void) | null>(null);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a tool call is the preview tool's (by Claude Code, through OpenCode's MCP server, too). */
export function isPreviewTool(name: string): boolean {
  return name === 'preview' || name.endsWith('__preview');
}

/** The page a `uri` names, or null for one the pane can't show. */
export function previewTarget(uri: string): (PreviewTarget & { uri: string }) | null {
  const raw = uri.trim();
  if (raw.startsWith('/')) return previewTarget(`file://${raw}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return { kind: 'server', url: url.href, uri: url.href };
  if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path.startsWith('/') || path.includes('\0')) return null;
  return { kind: 'file', path, uri: url.href };
}

/** A page's name for its tab when the agent gave none: a file's name, a server's host and path. */
export function previewLabel(target: PreviewTarget): string {
  if (target.kind === 'file') return target.path.split('/').pop() || target.path;
  const url = new URL(target.url);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

/** The pages a conversation's preview calls showed, in the order first shown, each with its latest call. */
export function previewsOf(messages: readonly SessionMessage[] | undefined): Preview[] {
  const byUri = new Map<string, Preview>();
  for (const message of messages ?? []) {
    if (message.type !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'tool' || !isPreviewTool(part.name) || part.state.status !== 'completed') continue;
      const { input } = part.state;
      const target = typeof input.uri === 'string' ? previewTarget(input.uri) : null;
      if (!target) continue;
      const { uri, ...rest } = target;
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 80) : previewLabel(rest);
      const at = part.time.completed ?? part.time.created;
      const prev = byUri.get(uri);
      byUri.set(uri, { uri, target: rest, title, callID: part.id, at: Math.max(at, prev?.at ?? 0) });
    }
  }
  return [...byUri.values()];
}

// ---------------------------------------------------------------------------
// Closed tabs
// ---------------------------------------------------------------------------

const CLOSED_KEY = 'din.assistant.closed-previews';
/** How many conversations' closed tabs are kept. */
const CLOSED_SESSIONS = 100;

type Closed = Record<string, string[]>;

function loadClosed(): Closed {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Closed = {};
    for (const [session, calls] of Object.entries(value)) {
      if (Array.isArray(calls)) out[session] = calls.filter((c): c is string => typeof c === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function saveClosed(closed: Closed): void {
  const entries = Object.entries(closed).filter(([, calls]) => calls.length > 0).slice(-CLOSED_SESSIONS);
  if (entries.length === 0) localStorage.removeItem(CLOSED_KEY);
  else localStorage.setItem(CLOSED_KEY, JSON.stringify(Object.fromEntries(entries)));
}

/**
 * A conversation's open previews, and closing one. A tab closed stays
 * closed until the agent shows its page again (a newer call). `onShown`
 * hears of each page the agent shows while the conversation is open, not
 * those it showed before.
 */
export function useSessionPreviews(
  sessionID: string | null,
  messages: readonly SessionMessage[] | undefined,
  onShown: (preview: Preview) => void,
): { previews: Preview[]; close: (uri: string) => void; reopen: (uri: string) => void } {
  const all = useMemo(() => previewsOf(messages), [messages]);
  const [closed, setClosed] = useState(loadClosed);
  useEffect(() => saveClosed(closed), [closed]);
  const closedCalls = useMemo(() => new Set(sessionID ? (closed[sessionID] ?? []) : []), [closed, sessionID]);
  const previews = useMemo(() => all.filter((p) => !closedCalls.has(p.callID)), [all, closedCalls]);

  // The calls already seen, by conversation: those there when its messages
  // first came are old news, and so are any older that come later (earlier
  // messages loaded).
  const seen = useRef(new Map<string, { since: number; calls: Set<string> }>());
  const shown = useRef(onShown);
  useEffect(() => {
    shown.current = onShown;
  });
  useEffect(() => {
    if (!sessionID || !messages) return;
    const known = seen.current.get(sessionID);
    if (!known) {
      // The server runs on this computer, so its clock is this one.
      const since = Math.max(Date.now(), ...all.map((p) => p.at));
      seen.current.set(sessionID, { since, calls: new Set(all.map((p) => p.callID)) });
      return;
    }
    for (const preview of all) {
      if (known.calls.has(preview.callID)) continue;
      known.calls.add(preview.callID);
      if (preview.at > known.since) shown.current(preview);
    }
  }, [sessionID, messages, all]);

  const close = (uri: string) => {
    const preview = all.find((p) => p.uri === uri);
    if (!sessionID || !preview) return;
    setClosed((prev) => {
      const { [sessionID]: calls = [], ...rest } = prev;
      return { ...rest, [sessionID]: [...calls.filter((c) => all.some((p) => p.callID === c)), preview.callID] };
    });
  };

  /** Bring a closed tab back (its card in the transcript). */
  const reopen = (uri: string) => {
    const preview = all.find((p) => p.uri === uri);
    if (!sessionID || !preview || !closedCalls.has(preview.callID)) return;
    setClosed((prev) => ({ ...prev, [sessionID]: (prev[sessionID] ?? []).filter((c) => c !== preview.callID) }));
  };

  return { previews, close, reopen };
}
