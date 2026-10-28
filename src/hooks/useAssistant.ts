import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AssistantError,
  assistantApi,
  getAssistantBridge,
  modelKey,
  type AgentInfo,
  type AssistantEvent,
  type AssistantStatus,
  type FormInfo,
  type FormValue,
  type ModelInfo,
  type ModelRef,
  type PermissionDecision,
  type PermissionRequest,
  type PromptAttachment,
  type SessionInfo,
  linkedIconPaths,
  packageIconPath,
  PROJECT_ICON_PATHS,
  worktreeMainCheckout,
} from '@/lib/assistant';
import { getFsBridge, localFileUrl, type FsEntry } from '@/lib/fs';
import { agentColor } from '@/lib/agentColors';
import { useAppContext } from '@/hooks/useAppContext';
import { useIsDark } from '@/hooks/useIsDark';

const STATUS_KEY = ['assistant', 'status'] as const;
const MODEL_STORAGE_KEY = 'din.assistant.model';

export const assistantKeys = {
  all: ['assistant'] as const,
  sessions: ['assistant', 'sessions'] as const,
  active: ['assistant', 'active'] as const,
  session: (id: string) => ['assistant', 'session', id] as const,
  messages: (id: string) => ['assistant', 'messages', id] as const,
  permissions: (id: string) => ['assistant', 'permissions', id] as const,
  forms: (id: string) => ['assistant', 'forms', id] as const,
  inbox: (id: string) => ['assistant', 'inbox', id] as const,
  models: ['assistant', 'models'] as const,
  agents: ['assistant', 'agents'] as const,
  commands: (directory: string) => ['assistant', 'commands', directory] as const,
  integrations: ['assistant', 'integrations'] as const,
};

function requireBridge() {
  const bridge = getAssistantBridge();
  if (!bridge) throw new Error('Assistant bridge unavailable');
  return bridge;
}

/** Whether OpenCode is installed, running, and connected. Pushed, never polled. */
export function useAssistantStatus() {
  const bridge = getAssistantBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!bridge) return;
    return bridge.onStatus((status) => queryClient.setQueryData(STATUS_KEY, status));
  }, [bridge, queryClient]);

  return useQuery<AssistantStatus>({
    queryKey: STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: bridge !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/** The server is up and the shell may talk to it. */
export function useAssistantReady(): boolean {
  const { data } = useAssistantStatus();
  return Boolean(data?.enabled && data.running);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const eventListeners = new Set<(event: AssistantEvent) => void>();
let unsubscribeBridge: (() => void) | null = null;

/** Hear the server's events. One bridge subscription feeds every listener. */
export function subscribeAssistantEvents(listener: (event: AssistantEvent) => void): () => void {
  eventListeners.add(listener);
  if (!unsubscribeBridge) {
    unsubscribeBridge =
      getAssistantBridge()?.onEvent((event) => {
        for (const l of [...eventListeners]) l(event);
      }) ?? null;
  }
  return () => {
    eventListeners.delete(listener);
    if (eventListeners.size === 0 && unsubscribeBridge) {
      unsubscribeBridge();
      unsubscribeBridge = null;
    }
  };
}

/** How long a burst of events for one session is gathered before refetching. */
const REFRESH_DELAY_MS = 150;

const SESSION_LIST_EVENTS = /^session\.(created|deleted|updated|renamed|moved|archived|unarchived|execution\.)/;

/**
 * Keep the assistant's queries current from the server's events: a session's
 * messages refetch as it works (text arrives a sentence or so at a time, so
 * the transcript follows along), the session list as sessions start, end and
 * get titled, and the pending requests as the agent asks and is answered.
 * Mounted once, by AssistantHost.
 */
export function useAssistantEventSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const later = (key: string, run: () => void) => {
      if (timers.has(key)) return;
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          run();
        }, REFRESH_DELAY_MS),
      );
    };
    const refresh = (queryKey: readonly unknown[]) =>
      later(JSON.stringify(queryKey), () => void queryClient.invalidateQueries({ queryKey }));

    const off = subscribeAssistantEvents((event) => {
      if (event.type === 'din.connected' || event.type === 'din.disconnected') {
        void queryClient.invalidateQueries({ queryKey: assistantKeys.all });
        return;
      }
      const { sessionID } = event;
      if (event.type.startsWith('permission.') || event.type.startsWith('form.')) {
        if (sessionID) {
          refresh(assistantKeys.permissions(sessionID));
          refresh(assistantKeys.forms(sessionID));
        }
        return;
      }
      if (!event.type.startsWith('session.')) {
        if (/^(model|provider|integration|config)\./.test(event.type)) {
          refresh(assistantKeys.models);
          refresh(assistantKeys.integrations);
        }
        return;
      }
      if (sessionID) {
        refresh(assistantKeys.messages(sessionID));
        if (event.type.startsWith('session.inbox.')) refresh(assistantKeys.inbox(sessionID));
      }
      if (SESSION_LIST_EVENTS.test(event.type)) {
        refresh(assistantKeys.sessions);
        refresh(assistantKeys.active);
        if (sessionID) {
          refresh(assistantKeys.session(sessionID));
          // A session that stops has nothing left to ask.
          if (event.type.startsWith('session.execution.')) {
            refresh(assistantKeys.permissions(sessionID));
            refresh(assistantKeys.forms(sessionID));
            refresh(assistantKeys.inbox(sessionID));
          }
        }
      }
    });
    return () => {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useAssistantSessions() {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.sessions,
    queryFn: () => assistantApi.sessions(),
    enabled: ready,
    staleTime: 30_000,
  });
}

export function useAssistantSession(sessionID: string | null) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.session(sessionID ?? ''),
    queryFn: () => assistantApi.session(sessionID!),
    enabled: ready && sessionID !== null,
    staleTime: 30_000,
  });
}

/** Several sessions by id, `gone` for the ones the server no longer has. */
export function useSessionsByID(sessionIDs: string[]): { session?: SessionInfo; gone: boolean }[] {
  const ready = useAssistantReady();
  return useQueries({
    queries: sessionIDs.map((sessionID) => ({
      queryKey: assistantKeys.session(sessionID),
      queryFn: () => assistantApi.session(sessionID),
      enabled: ready,
      staleTime: 30_000,
    })),
    combine: (results) =>
      results.map((r) => ({
        session: r.data,
        gone: r.error instanceof AssistantError && r.error.status === 404,
      })),
  });
}

/** The ids of the sessions working right now. */
export function useActiveSessions() {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.active,
    queryFn: () => assistantApi.active(),
    enabled: ready,
    staleTime: 30_000,
  });
}

export function useSessionMessages(sessionID: string | null) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.messages(sessionID ?? ''),
    queryFn: () => assistantApi.messages(sessionID!),
    enabled: ready && sessionID !== null,
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) =>
      // Keep the transcript up while it refetches, but never show another
      // session's.
      previousQuery?.queryKey[2] === sessionID ? previous : undefined,
  });
}

export function useSessionPermissions(sessionID: string | null) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.permissions(sessionID ?? ''),
    queryFn: () => assistantApi.permissions(sessionID!),
    enabled: ready && sessionID !== null,
    staleTime: 30_000,
  });
}

export function useSessionForms(sessionID: string | null) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.forms(sessionID ?? ''),
    queryFn: () => assistantApi.forms(sessionID!),
    enabled: ready && sessionID !== null,
    staleTime: 30_000,
  });
}

/** Messages sent while the agent works that it hasn't taken yet. */
export function useSessionInbox(sessionID: string | null) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.inbox(sessionID ?? ''),
    queryFn: () => assistantApi.inbox(sessionID!),
    enabled: ready && sessionID !== null,
    staleTime: 30_000,
  });
}

/**
 * Everything the agent is waiting on the user for, across the sessions
 * working now: permission requests and questions (forms).
 */
export function usePendingRequests(): { permissions: PermissionRequest[]; forms: FormInfo[] } {
  const ready = useAssistantReady();
  const { data: active = [] } = useActiveSessions();
  const permissions = useQueries({
    queries: active.map((id) => ({
      queryKey: assistantKeys.permissions(id),
      queryFn: () => assistantApi.permissions(id),
      enabled: ready,
      staleTime: 30_000,
    })),
    combine: flatten<PermissionRequest>,
  });
  const forms = useQueries({
    queries: active.map((id) => ({
      queryKey: assistantKeys.forms(id),
      queryFn: () => assistantApi.forms(id),
      enabled: ready,
      staleTime: 30_000,
    })),
    combine: flatten<FormInfo>,
  });
  return useMemo(() => ({ permissions, forms }), [permissions, forms]);
}

/** One list from many queries' (structurally shared, so stable while unchanged). */
function flatten<T>(results: { data?: T[] }[]): T[] {
  return results.flatMap((result) => result.data ?? []);
}

export function useAssistantModels() {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.models,
    queryFn: async () => {
      const [models, fallback, recent] = await Promise.all([
        assistantApi.models(),
        assistantApi.defaultModel().catch(() => null),
        requireBridge()
          .recentModels()
          .catch(() => []),
      ]);
      return { models: models.filter((m) => m.enabled && m.status !== 'deprecated'), fallback, recent };
    },
    enabled: ready,
    staleTime: 5 * 60_000,
  });
}

/** Every agent that isn't hidden, subagents too. */
function useVisibleAgents<T = AgentInfo[]>(select?: (agents: AgentInfo[]) => T) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.agents,
    queryFn: async () => (await assistantApi.agents()).filter((agent) => !agent.hidden),
    select,
    enabled: ready,
    staleTime: 5 * 60_000,
  });
}

const primaryAgents = (agents: AgentInfo[]) => agents.filter((agent) => agent.mode !== 'subagent');

/** The agents a conversation can be switched to. */
export function useAssistantAgents() {
  return useVisibleAgents(primaryAgents);
}

/** An agent's color for Din's light or dark theme, as OpenCode's terminal shows it. */
export function useAgentColor(): (agent: string) => string | undefined {
  const { data: agents } = useVisibleAgents();
  const dark = useIsDark();
  return useCallback((agent: string) => (agents ? agentColor(agents, agent, dark) : undefined), [agents, dark]);
}

/** The slash commands the server offers in a folder (its project can add its own). */
export function useAssistantCommands(directory: string | undefined) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.commands(directory ?? ''),
    queryFn: () => assistantApi.commands(directory),
    enabled: ready && directory !== undefined,
    staleTime: 60_000,
  });
}

export function useAssistantIntegrations(enabled = true) {
  const ready = useAssistantReady();
  return useQuery({
    queryKey: assistantKeys.integrations,
    queryFn: () => assistantApi.integrations(),
    enabled: ready && enabled,
    staleTime: 60_000,
  });
}

/** The user's home folder, where conversations start unless Settings says otherwise. */
export function useHomeDirectory(): string | undefined {
  const fs = getFsBridge();
  const { data } = useQuery({
    queryKey: ['fs', 'homedir'],
    queryFn: () => fs!.homedir(),
    enabled: fs !== undefined,
    staleTime: Infinity,
  });
  return data;
}

/**
 * For each folder that is a git worktree, the main checkout it belongs to,
 * so a project's conversations can go under one name however many
 * worktrees they ran in. Folders that aren't worktrees are left out.
 */
export function useMainCheckouts(directories: string[]): Map<string, string> {
  const fs = getFsBridge();
  return useQueries({
    queries: directories.map((directory) => ({
      queryKey: ['fs', 'git-main-checkout', directory],
      queryFn: async () => {
        const file = await fs!.readFile(`${directory.replace(/\/+$/, '')}/.git`, 4096).catch(() => null);
        return file ? worktreeMainCheckout(new TextDecoder().decode(file.data)) : null;
      },
      enabled: fs !== undefined,
      staleTime: Infinity,
    })),
    combine: (results) =>
      new Map(directories.flatMap((directory, i) => (results[i].data ? [[directory, results[i].data] as const] : []))),
  });
}

/**
 * For each project folder with a favicon, a URL for it: the icon its
 * `package.json` names, else the one its `index.html` links, else the first
 * of the usual places that has one.
 * Folders without one are left out.
 *
 * It looks in folder listings rather than stat'ing each guess, since every
 * failed call logs an error in the main process.
 */
export function useProjectIcons(roots: string[]): Map<string, string> {
  const fs = getFsBridge();
  return useQueries({
    queries: roots.map((root) => ({
      queryKey: ['fs', 'project-icon', root],
      queryFn: async () => {
        const dir = root.replace(/\/+$/, '');
        const listings = new Map<string, Promise<FsEntry[]>>();
        const list = (path: string) => {
          let listing = listings.get(path);
          if (!listing) {
            listing = fs!.readdir(`${dir}${path && `/${path}`}`).then((l) => l.entries, () => []);
            listings.set(path, listing);
          }
          return listing;
        };
        // The entry at a path relative to the project, listing only folders known to exist.
        const entry = async (path: string): Promise<FsEntry | undefined> => {
          const parts = path.split('/');
          let parent = '';
          for (const [i, name] of parts.entries()) {
            const found = (await list(parent)).find((e) => e.name === name);
            if (!found || i === parts.length - 1) return found;
            if (found.kind !== 'directory') return undefined;
            parent = parent ? `${parent}/${name}` : name;
          }
        };

        const read = async (path: string) => (await entry(path))?.kind === 'file'
          ? await fs!.readFile(`${dir}/${path}`, 65536).then((f) => new TextDecoder().decode(f.data), () => null)
          : null;
        const pkg = await read('package.json');
        const named = pkg ? packageIconPath(pkg) : null;
        const page = await read('index.html');
        const linked = page ? linkedIconPaths(page) : [];
        for (const path of [...new Set([...(named ? [named] : []), ...linked, ...PROJECT_ICON_PATHS])]) {
          const found = await entry(path);
          if (found?.kind === 'file' && found.size) return localFileUrl(`${dir}/${path}`);
        }
        return null;
      },
      enabled: fs !== undefined,
      staleTime: Infinity,
    })),
    combine: (results) =>
      new Map(roots.flatMap((root, i) => (results[i].data ? [[root, results[i].data] as const] : []))),
  });
}

/**
 * For each folder a conversation worked in, its project's favicon: a
 * worktree's comes from its main checkout. Folders without one are left out.
 */
export function useDirectoryIcons(directories: string[]): Map<string, string> {
  const mains = useMainCheckouts(directories);
  const roots = directories.map((d) => mains.get(d) ?? d);
  const icons = useProjectIcons([...new Set(roots)]);
  return new Map(directories.flatMap((d, i) => {
    const icon = icons.get(roots[i]);
    return icon ? [[d, icon] as const] : [];
  }));
}

/** The folder new conversations work in. */
export function useAssistantDirectory(): string | undefined {
  const { config } = useAppContext();
  const home = useHomeDirectory();
  return config.assistantDirectory.trim() || home;
}

// ---------------------------------------------------------------------------
// The model new conversations use
// ---------------------------------------------------------------------------

function readStoredModel(): ModelRef | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, providerID } = parsed as Record<string, unknown>;
    return typeof id === 'string' && typeof providerID === 'string' ? { id, providerID } : null;
  } catch {
    return null;
  }
}

const modelListeners = new Set<() => void>();

/**
 * The model new conversations start with: the one last picked in Din, else
 * the one OpenCode's own interface used last, else the server's default.
 * Only models a connected provider offers count.
 */
export function usePreferredModel(): {
  model: ModelInfo | null;
  setModel: (model: ModelRef) => void;
  models: ModelInfo[];
  isLoading: boolean;
} {
  const { data, isLoading } = useAssistantModels();
  const [stored, setStored] = useState(readStoredModel);

  useEffect(() => {
    const listener = () => setStored(readStoredModel());
    modelListeners.add(listener);
    return () => {
      modelListeners.delete(listener);
    };
  }, []);

  const setModel = useCallback((model: ModelRef) => {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ id: model.id, providerID: model.providerID }));
    for (const listener of modelListeners) listener();
  }, []);

  const models = useMemo(() => data?.models ?? [], [data]);
  const model = useMemo(() => {
    const byKey = new Map(models.map((m) => [modelKey(m), m]));
    const candidates: string[] = [
      ...(stored ? [modelKey(stored)] : []),
      ...(data?.recent ?? []).map((r) => `${r.providerID}/${r.modelID}`),
      ...(data?.fallback ? [modelKey(data.fallback)] : []),
    ];
    for (const key of candidates) {
      const found = byKey.get(key);
      if (found) return found;
    }
    return models[0] ?? null;
  }, [models, stored, data]);

  return { model, setModel, models, isLoading };
}

// ---------------------------------------------------------------------------
// What the user is following
// ---------------------------------------------------------------------------

/**
 * Conversations Din started or wrote in this session. When one finishes Din
 * says so; the ones a Terminal's OpenCode runs have their own window to
 * watch.
 */
const dinSessions = new Set<string>();

export function isDinSession(sessionID: string): boolean {
  return dinSessions.has(sessionID);
}

let viewedSession: string | null = null;

/** The conversation the Assistant window shows, if any. */
export function getViewedSession(): string | null {
  return viewedSession;
}

/** Called by the Assistant window as it shows and stops showing one. */
export function useMarkViewedSession(sessionID: string): void {
  useEffect(() => {
    viewedSession = sessionID;
    return () => {
      if (viewedSession === sessionID) viewedSession = null;
    };
  }, [sessionID]);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function invalidateSession(queryClient: QueryClient, sessionID: string) {
  void queryClient.invalidateQueries({ queryKey: assistantKeys.messages(sessionID) });
  void queryClient.invalidateQueries({ queryKey: assistantKeys.inbox(sessionID) });
  void queryClient.invalidateQueries({ queryKey: assistantKeys.session(sessionID) });
  void queryClient.invalidateQueries({ queryKey: assistantKeys.sessions });
  void queryClient.invalidateQueries({ queryKey: assistantKeys.active });
}

export interface StartConversation {
  text: string;
  files?: PromptAttachment[];
  model?: ModelRef | null;
  agent?: string;
  directory?: string;
  /** Begin with this slash command, `text` being what follows it. */
  command?: string;
}

/** Start a conversation with its first message; resolves with the new session. */
export function useStartConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ text, files, model, agent, directory, command }: StartConversation) => {
      const session = await assistantApi.create({ directory, model: model ?? undefined, agent });
      dinSessions.add(session.id);
      if (command) await assistantApi.command(session.id, command, text, files);
      else await assistantApi.prompt(session.id, text, files);
      return session;
    },
    onSuccess: (session) => invalidateSession(queryClient, session.id),
  });
}

/** Send a message, or with `command`, run that slash command with `text` after it. */
export function useSendPrompt(sessionID: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ text, files, command }: { text: string; files?: PromptAttachment[]; command?: string }) => {
      dinSessions.add(sessionID!);
      return command
        ? assistantApi.command(sessionID!, command, text, files)
        : assistantApi.prompt(sessionID!, text, files);
    },
    onSuccess: () => sessionID && invalidateSession(queryClient, sessionID),
  });
}

export function useCompactSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionID: string) => assistantApi.compact(sessionID),
    onSuccess: (_data, sessionID) => invalidateSession(queryClient, sessionID),
  });
}

export function useInterruptSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionID: string) => assistantApi.interrupt(sessionID),
    onSuccess: (_data, sessionID) => invalidateSession(queryClient, sessionID),
  });
}

export function useBackgroundSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionID: string) => assistantApi.background(sessionID),
    onSuccess: (_data, sessionID) => invalidateSession(queryClient, sessionID),
  });
}

export function useCancelQueued() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionID, id }: { sessionID: string; id: string }) => assistantApi.cancelQueued(sessionID, id),
    onSuccess: (_data, { sessionID }) => void queryClient.invalidateQueries({ queryKey: assistantKeys.inbox(sessionID) }),
  });
}

export function useRenameSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionID, title }: { sessionID: string; title: string }) => assistantApi.rename(sessionID, title),
    onSuccess: (_data, { sessionID }) => invalidateSession(queryClient, sessionID),
  });
}

export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionID: string) => assistantApi.remove(sessionID),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.active });
    },
  });
}

export function useSwitchModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionID, model }: { sessionID: string; model: ModelRef }) =>
      assistantApi.switchModel(sessionID, model),
    onSuccess: (_data, { sessionID }) => invalidateSession(queryClient, sessionID),
  });
}

export function useSwitchAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionID, agent }: { sessionID: string; agent: string }) =>
      assistantApi.switchAgent(sessionID, agent),
    onSuccess: (_data, { sessionID }) => invalidateSession(queryClient, sessionID),
  });
}

export function useReplyPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      decision,
      message,
    }: {
      request: PermissionRequest;
      decision: PermissionDecision;
      message?: string;
    }) => assistantApi.replyPermission(request.sessionID, request.id, decision, message),
    onSuccess: (_data, { request }) => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.permissions(request.sessionID) });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.messages(request.sessionID) });
    },
  });
}

export function useReplyForm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ form, answer }: { form: FormInfo; answer: Record<string, FormValue> | null }) =>
      answer ? assistantApi.replyForm(form.sessionID, form.id, answer) : assistantApi.cancelForm(form.sessionID, form.id),
    onSuccess: (_data, { form }) => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.forms(form.sessionID) });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.messages(form.sessionID) });
    },
  });
}

/** Turn the assistant on or off: the server starts, or Din stops following it. */
export function useSetAssistantEnabled() {
  const { updateConfig } = useAppContext();
  return useCallback(
    (enabled: boolean) => updateConfig((current) => ({ ...current, assistantEnabled: enabled })),
    [updateConfig],
  );
}
