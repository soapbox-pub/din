/**
 * Typed access to the assistant bridge exposed by the Electron preload
 * (`window.assistant`, see electron/preload.cjs + electron/assistant.mts),
 * and the slice of OpenCode's v2 server API that Din uses.
 *
 * OpenCode is the agent: it keeps sessions, runs their tools, and asks
 * before doing what its rules say to ask about. Its background server is
 * shared with the TUI in a Terminal, so sessions started in either show up
 * in both. The main process holds the server's credentials and passes
 * requests through (`request`) along with its events (`onEvent`). Absent
 * outside the Electron shell.
 */

export interface AssistantStatus {
  enabled: boolean;
  binary: string | null;
  version: string | null;
  running: boolean;
  connected: boolean;
  installing: boolean;
  error: string | null;
}

/**
 * One server event, slimmed by the main process: its type, the session it's
 * about, and its data for the kinds the shell reads (permission requests,
 * forms, sessions starting and ending). `din.connected` and
 * `din.disconnected` are the stream's own.
 */
export interface AssistantEvent {
  type: string;
  sessionID?: string;
  data?: Record<string, unknown>;
}

type Reply = { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string };

export interface AssistantBridge {
  status(): Promise<AssistantStatus>;
  setEnabled(enabled: boolean): Promise<AssistantStatus>;
  install(): Promise<void>;
  restart(): Promise<void>;
  recentModels(): Promise<{ providerID: string; modelID: string }[]>;
  request(method: string, path: string, body?: unknown): Promise<Reply>;
  onStatus(callback: (status: AssistantStatus) => void): () => void;
  onEvent(callback: (event: AssistantEvent) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    assistant?: AssistantBridge;
  }
}

/** The assistant bridge, or undefined outside the Electron shell. */
export function getAssistantBridge(): AssistantBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.assistant;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanAssistantError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

// ---------------------------------------------------------------------------
// The server's types, as far as Din reads them.
// ---------------------------------------------------------------------------

export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface SessionInfo {
  id: string;
  parentID?: string;
  /** The same for every worktree of a repository (its root commit). */
  projectID?: string;
  title?: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: TokenUsage;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
  time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number };
  location: { directory: string };
}

/** A failure the server reports (a provider refusing a key, a tool crashing). */
export interface StructuredError {
  type?: string;
  message?: string;
}

export interface ToolContent {
  type: 'text' | 'file';
  text?: string;
  uri?: string;
  mime?: string;
  name?: string | null;
}

export type ToolState =
  | { status: 'streaming'; input: string }
  | { status: 'running'; input: Record<string, unknown>; metadata?: Record<string, unknown> }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      content: ToolContent[];
      metadata?: Record<string, unknown>;
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      error: StructuredError;
      content?: ToolContent[];
      metadata?: Record<string, unknown>;
    };

export type AssistantContent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; time?: { created: number; completed?: number } }
  | { type: 'tool'; id: string; name: string; state: ToolState; time: { created: number; ran?: number; completed?: number } };

export interface PromptFile {
  mime: string;
  name?: string;
  source?: { type: 'inline' } | { type: 'uri'; uri: string };
}

interface MessageBase {
  id: string;
  time: { created: number; completed?: number };
}

export type SessionMessage =
  | (MessageBase & { type: 'user'; text: string; files?: PromptFile[] })
  | (MessageBase & {
      type: 'assistant';
      agent: string;
      model: ModelRef;
      content: AssistantContent[];
      finish?: string;
      error?: StructuredError;
      retry?: { attempt: number; at: number; error: StructuredError };
      time: { created: number; streamed?: number; completed?: number };
    })
  | (MessageBase & { type: 'synthetic' | 'system'; text: string; description?: string })
  | (MessageBase & { type: 'skill'; name: string; text: string })
  | (MessageBase & { type: 'shell'; command: string; status: string; output?: { output: string } })
  | (MessageBase & { type: 'agent-switched'; agent: string })
  | (MessageBase & { type: 'model-switched'; model: ModelRef })
  | (MessageBase & { type: 'location-switched'; location: { directory: string } })
  | (MessageBase & { type: 'compaction'; status: 'running' | 'completed' | 'failed'; summary?: string })
  | (MessageBase & { type: 'idle'; outcome: 'succeeded' | 'failed' | 'interrupted'; error?: StructuredError });

/**
 * A message sent while the agent works, waiting in the session's inbox until
 * the agent takes it (`steer`: at its next step; `queue`: once it's done).
 * Only the user's own are typed; the inbox also holds the server's.
 */
export interface QueuedMessage {
  id: string;
  sessionID: string;
  type: 'user';
  delivery: 'steer' | 'queue';
  time: { created: number };
  payload: { text: string; files?: { mime: string; name?: string }[] };
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  /** What the agent wants to do: `edit`, `bash`, `external_directory`, … */
  action: string;
  /** What it wants to do it to: paths, commands, URLs. */
  resources: string[];
  /** The patterns "always" would save. */
  save?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

export type PermissionDecision = 'once' | 'always' | 'reject';

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: { key: string; op: 'eq' | 'neq'; value: string | number | boolean }[];
}

export type FormField =
  | (FormFieldBase & {
      type: 'string';
      placeholder?: string;
      default?: string;
      options?: FormOption[];
      custom?: boolean;
      maxLength?: number;
    })
  | (FormFieldBase & { type: 'number' | 'integer'; default?: number; minimum?: number; maximum?: number })
  | (FormFieldBase & { type: 'boolean'; default?: boolean })
  | (FormFieldBase & {
      type: 'multiselect';
      options: FormOption[];
      default?: string[];
      custom?: boolean;
      minItems?: number;
      maxItems?: number;
    })
  | (FormFieldBase & { type: 'external'; url: string });

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
}

export type FormValue = string | number | boolean | string[];

export interface ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  status: 'alpha' | 'beta' | 'deprecated' | 'active';
  enabled: boolean;
  time: { released: number };
  limit: { context: number; output: number };
  /** Where requests go; the provider's icon comes from its site. */
  settings?: { baseURL?: string };
  /** US dollars per million tokens, cheapest tier first. */
  cost?: { input: number; output: number }[];
}

export interface AgentInfo {
  id: string;
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  hidden?: boolean;
  description?: string;
}

export type IntegrationMethod =
  | { type: 'key'; label?: string }
  | { type: 'env'; names: string[] }
  | { type: 'oauth'; id: string; label: string }
  | { type: 'command'; id: string; label: string; command: string[] }
  | { type: 'external'; id: string; label: string };

export type IntegrationConnection =
  | { type: 'env'; name: string }
  | { type: 'credential'; id: string; label: string; method: string };

export interface IntegrationInfo {
  id: string;
  name: string;
  methods: IntegrationMethod[];
  connections: IntegrationConnection[];
}

export interface OAuthAttempt {
  attemptID: string;
  url: string;
  instructions: string;
  /** `auto`: the provider calls back on its own; `code`: the user pastes one. */
  mode: 'auto' | 'code';
}

export type OAuthStatus = { status: 'pending' } | { status: 'complete' } | { status: 'failed'; message: string } | { status: 'expired' };

/** A file attached to a prompt: a path on this computer, or pasted data. */
export interface PromptAttachment {
  uri: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class AssistantError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AssistantError';
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const bridge = getAssistantBridge();
  if (!bridge) throw new AssistantError('The assistant needs Din’s desktop app', 0);
  const reply = await bridge.request(method, path, body);
  if (!reply.ok) throw new AssistantError(reply.message, reply.status);
  return reply.data as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

const id = (value: string) => encodeURIComponent(value);

/** OpenCode's API, the requests Din makes. */
export const assistantApi = {
  /** Top-level sessions (not subagents'), newest first. */
  sessions: async (limit = 60) =>
    (await call<{ data: SessionInfo[] }>('GET', `/api/session${query({ limit, parentID: 'null', order: 'desc' })}`)).data,

  session: async (sessionID: string) =>
    (await call<{ data: SessionInfo }>('GET', `/api/session/${id(sessionID)}`)).data,

  /** The sessions working right now. */
  active: async () => Object.keys((await call<{ data: Record<string, unknown> }>('GET', '/api/session/active')).data),

  /** A session's latest messages, oldest first, and whether there are earlier ones. */
  messages: async (sessionID: string, limit = 150) => {
    const reply = await call<{ data: SessionMessage[] }>(
      'GET',
      `/api/session/${id(sessionID)}/message${query({ limit, order: 'desc' })}`,
    );
    // The server hands out a cursor even on the last page; a full page is
    // what says there may be more.
    return { messages: [...reply.data].reverse(), more: reply.data.length >= limit };
  },

  create: async (options: { directory?: string; model?: ModelRef; agent?: string; title?: string }) =>
    (
      await call<{ data: SessionInfo }>('POST', '/api/session', {
        ...(options.title ? { title: options.title } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.directory ? { location: { directory: options.directory } } : {}),
      })
    ).data,

  prompt: (sessionID: string, text: string, files: PromptAttachment[] = []) =>
    call<unknown>('POST', `/api/session/${id(sessionID)}/prompt`, {
      text,
      ...(files.length > 0 ? { files } : {}),
    }),

  /** The user's messages the agent hasn't taken yet, oldest first. */
  inbox: async (sessionID: string) =>
    (await call<{ data: { type: string }[] }>('GET', `/api/session/${id(sessionID)}/inbox`)).data.filter(
      (item): item is QueuedMessage => item.type === 'user',
    ),

  /** Take back a queued message. One already taken is left alone. */
  cancelQueued: (sessionID: string, inboxID: string) =>
    call<unknown>('DELETE', `/api/session/${id(sessionID)}/inbox/${id(inboxID)}`),

  interrupt: (sessionID: string) => call<unknown>('POST', `/api/session/${id(sessionID)}/interrupt`),

  /**
   * Move the commands and subagents the agent is waiting on to the
   * background, so it carries on while they run (the TUI's Ctrl+B). A no-op
   * when it isn't waiting on any.
   */
  background: (sessionID: string) => call<unknown>('POST', `/api/session/${id(sessionID)}/background`),

  rename: (sessionID: string, title: string) => call<unknown>('PATCH', `/api/session/${id(sessionID)}`, { title }),

  remove: (sessionID: string) => call<unknown>('DELETE', `/api/session/${id(sessionID)}`),

  switchModel: (sessionID: string, model: ModelRef) =>
    call<unknown>('POST', `/api/session/${id(sessionID)}/model`, { model }),

  switchAgent: (sessionID: string, agent: string) =>
    call<unknown>('POST', `/api/session/${id(sessionID)}/agent`, { agent }),

  permissions: async (sessionID: string) =>
    (await call<{ data: PermissionRequest[] }>('GET', `/api/session/${id(sessionID)}/permission`)).data,

  replyPermission: (sessionID: string, requestID: string, decision: PermissionDecision, message?: string) =>
    call<unknown>('POST', `/api/session/${id(sessionID)}/permission/${id(requestID)}/reply`, {
      decision,
      ...(message ? { message } : {}),
    }),

  forms: async (sessionID: string) =>
    (await call<{ data: FormInfo[] }>('GET', `/api/session/${id(sessionID)}/form`)).data,

  replyForm: (sessionID: string, formID: string, answer: Record<string, FormValue>) =>
    call<unknown>('POST', `/api/session/${id(sessionID)}/form/${id(formID)}/reply`, { answer }),

  cancelForm: (sessionID: string, formID: string) =>
    call<unknown>('DELETE', `/api/session/${id(sessionID)}/form/${id(formID)}`),

  models: async () => (await call<{ data: ModelInfo[] }>('GET', '/api/model')).data,

  defaultModel: async () => (await call<{ data: ModelInfo | null }>('GET', '/api/model/default')).data,

  agents: async () => (await call<{ data: AgentInfo[] }>('GET', '/api/agent')).data,

  integrations: async () => (await call<{ data: IntegrationInfo[] }>('GET', '/api/integration')).data,

  connectKey: (integrationID: string, key: string) =>
    call<unknown>('POST', `/api/integration/${id(integrationID)}/connect/key`, { key }),

  connectOAuth: async (integrationID: string, methodID: string) =>
    (
      await call<{ data: OAuthAttempt }>('POST', `/api/integration/${id(integrationID)}/connect/oauth`, {
        methodID,
      })
    ).data,

  oauthStatus: async (integrationID: string, attemptID: string) =>
    (
      await call<{ data: OAuthStatus }>(
        'GET',
        `/api/integration/${id(integrationID)}/connect/oauth/${id(attemptID)}`,
      )
    ).data,

  completeOAuth: (integrationID: string, attemptID: string, code: string) =>
    call<unknown>('POST', `/api/integration/${id(integrationID)}/connect/oauth/${id(attemptID)}/complete`, {
      code,
    }),

  cancelOAuth: (integrationID: string, attemptID: string) =>
    call<unknown>('DELETE', `/api/integration/${id(integrationID)}/connect/oauth/${id(attemptID)}`),

  removeCredential: (credentialID: string) => call<unknown>('DELETE', `/api/credential/${id(credentialID)}`),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function modelKey(model: Pick<ModelRef, 'providerID' | 'id'>): string {
  return `${model.providerID}/${model.id}`;
}

/** The last folder in a path, for a session's subtitle. */
export function directoryName(directory: string, home: string | undefined): string {
  if (home && directory === home) return 'Home';
  return directory.replace(/\/+$/, '').split('/').pop() || directory;
}

/** A path with the home folder shortened to ~. */
export function tildify(directory: string, home: string | undefined): string {
  if (home && (directory === home || directory.startsWith(`${home}/`))) return `~${directory.slice(home.length)}`;
  return directory;
}

/**
 * The main checkout a git worktree belongs to, from the worktree's `.git`
 * file (`gitdir: /repo/.git/worktrees/name`), or null when it says
 * something else.
 */
export function worktreeMainCheckout(gitFile: string): string | null {
  const gitdir = /^gitdir:\s*(.+)$/m.exec(gitFile)?.[1].trim();
  const match = gitdir && /^(\/.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir);
  return match ? match[1] : null;
}

/** Where web projects usually keep a favicon, best first. */
export const PROJECT_ICON_PATHS = [
  'public/favicon.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'public/favicon/favicon.ico',
  'public/icon.svg',
  'static/favicon.svg',
  'static/favicon.png',
  'static/favicon.ico',
  'src/app/favicon.ico',
  'app/favicon.ico',
  'favicon.svg',
  'favicon.ico',
];

/**
 * The local icons an `index.html` links (`<link rel="icon" href="/x.svg">`),
 * as paths relative to the project: each is looked up in `public/`, where
 * Vite serves it from, and then beside the page. Remote
 * icons are left out; the list never goes to the network.
 */
export function linkedIconPaths(html: string): string[] {
  const paths: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1].toLowerCase().split(/\s+/);
    if (!rel?.includes('icon')) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim().replace(/[?#].*$/, '');
    if (!url || /^[a-z][a-z\d+.-]*:|^\/\//i.test(url) || url.split('/').includes('..')) continue;
    const path = url.replace(/^\.?\/+/, '');
    if (path) paths.push(`public/${path}`, path);
  }
  return paths;
}

/** What a session is called before the server has titled it. */
export function sessionTitle(session: Pick<SessionInfo, 'title'>): string {
  return session.title?.trim() || 'New conversation';
}

export function formatCost(cost: number): string {
  if (cost <= 0) return '';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

/** Compact relative time: "now", "5m", "3h", "2d", or a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** A permission request in words, for a prompt or a notification. */
export function describePermission(request: PermissionRequest): { title: string; detail: string } {
  const what = request.resources.join(', ');
  const titles: Record<string, string> = {
    edit: 'Edit files',
    write: 'Write files',
    read: 'Read files',
    bash: 'Run a command',
    shell: 'Run a command',
    external_directory: 'Work outside its folder',
    webfetch: 'Fetch a web page',
    websearch: 'Search the web',
    task: 'Start a helper agent',
    doom_loop: 'Keep repeating itself',
  };
  const title = titles[request.action] ?? request.action.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return { title, detail: request.message?.trim() || what };
}

/** Whether a form field shows, given the answers so far. */
export function fieldVisible(field: FormField, answers: Record<string, FormValue | undefined>): boolean {
  if (field.hidden) return false;
  return (field.when ?? []).every((rule) => {
    const value = answers[rule.key];
    const equal = Array.isArray(value) ? value.includes(String(rule.value)) : value === rule.value;
    return rule.op === 'eq' ? equal : !equal;
  });
}
