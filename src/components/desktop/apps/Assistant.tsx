import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { AssistantUnavailable } from '@/components/desktop/assistant/AssistantUnavailable';
import { ConversationTitleInput, DeleteConversationDialog } from '@/components/desktop/assistant/ConversationActions';
import { Composer, type SlashCommand } from '@/components/desktop/assistant/Composer';
import { ModelPicker } from '@/components/desktop/assistant/ModelPicker';
import { FileLinkBaseContext } from '@/components/desktop/assistant/fileLinks';
import { FormCard, PermissionCard } from '@/components/desktop/assistant/RequestCards';
import { SessionList } from '@/components/desktop/assistant/SessionList';
import { Transcript } from '@/components/desktop/assistant/Transcript';
import { useQuestionHandoff } from '@/components/desktop/assistant/useQuestionHandoff';
import { TabStrip } from '@/components/desktop/TabStrip';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { moveItem } from '@/hooks/useDragReorder';
import {
  useActiveSessions,
  useAgentColor,
  useAssistantAgents,
  useAssistantCommands,
  useAssistantDirectory,
  useAssistantReady,
  useAssistantSession,
  useAssistantSessions,
  useBackgroundSession,
  useCancelQueued,
  useCompactSession,
  useHomeDirectory,
  useInterruptSession,
  useMainCheckouts,
  useMarkViewedSession,
  usePendingRequests,
  usePreferredModel,
  useRenameSession,
  useSendPrompt,
  useSessionForms,
  useSessionInbox,
  useSessionMessages,
  useSessionPermissions,
  useSessionsByID,
  useStartConversation,
  useSwitchAgent,
  useSwitchModel,
} from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import type { AppComponentProps } from '@/lib/apps';
import {
  cleanAssistantError,
  directoryName,
  formatCost,
  modelKey,
  sessionTitle,
  tildify,
  type PromptAttachment,
  type SessionInfo,
} from '@/lib/assistant';
import {
  forgetTabDraft,
  isBlankTab,
  loadAssistantTabs,
  newAssistantTab,
  newConversationDraftKey,
  saveAssistantTabs,
  type AssistantTab,
} from '@/lib/assistantTabs';
import { cn } from '@/lib/utils';

const SUGGESTIONS = [
  'What’s taking up the most space in my home folder?',
  'Write a script that renames my screenshots by date',
  'Explain what this computer is running right now',
];

/** The commands Din runs itself in a conversation, beside the server's. */
const CONVERSATION_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up the model’s context', instant: true },
  { name: 'new', description: 'Start a new conversation in this folder', instant: true },
  { name: 'rename', args: '[title]', description: 'Rename this conversation' },
  { name: 'stop', description: 'Stop the agent', instant: true },
];

/** A new conversation has only the server's: there is nothing yet to compact or rename. */
const NO_COMMANDS: SlashCommand[] = [];

/** Din's commands and then the server's, those it has too left out. */
function useSlashCommands(directory: string | undefined, own: SlashCommand[]): SlashCommand[] {
  const { data: server } = useAssistantCommands(directory);
  return useMemo(
    () => [
      ...own,
      ...(server ?? [])
        .filter((command) => !own.some((c) => c.name === command.name))
        .map((command) => ({ name: command.name, description: command.description })),
    ],
    [own, server],
  );
}

/** Where each conversation was left scrolled, for coming back to its tab. */
const scrollPositions = new Map<string, { top: number; stuck: boolean }>();

const LIST_WIDTH_KEY = 'din.assistant.list-width';
const DEFAULT_LIST_WIDTH = 256;
const MIN_LIST_WIDTH = 192;
const MAX_LIST_WIDTH = 560;

const clampListWidth = (width: number) => Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, width));

function loadListWidth(): number {
  const width = Number(localStorage.getItem(LIST_WIDTH_KEY));
  return width ? clampListWidth(width) : DEFAULT_LIST_WIDTH;
}

/** How many closed tabs Ctrl+Shift+T can bring back. */
const CLOSED_TABS_LIMIT = 20;

interface TabsState {
  tabs: AssistantTab[];
  activeId: string;
}

/** What a tab shows in the strip. */
interface TabInfo {
  id: string;
  title: string;
  state: 'new' | 'idle' | 'running' | 'waiting';
}

/** `tab`, selected, beside the selected one, or in its place when that one is blank. */
function placeTab({ tabs, activeId }: TabsState, tab: AssistantTab): TabsState {
  const index = tabs.findIndex((t) => t.id === activeId);
  const next =
    index !== -1 && isBlankTab(tabs[index])
      ? tabs.map((t, i) => (i === index ? tab : t))
      : [...tabs.slice(0, index + 1), tab, ...tabs.slice(index + 1)];
  return { tabs: next, activeId: tab.id };
}

/** Selects the conversation's tab, opening one for it if it has none. */
function showSession(state: TabsState, sessionID: string): TabsState {
  const open = state.tabs.find((t) => t.sessionID === sessionID);
  return open ? { ...state, activeId: open.id } : placeTab(state, newAssistantTab(sessionID));
}

/** The tabs the window opens with: the ones it had, and what it was opened for. */
function initialTabs(sessionID: string | null, directory: string | null): TabsState {
  const saved = loadAssistantTabs();
  const state = saved
    ? { tabs: saved.tabs, activeId: (saved.tabs[saved.active] ?? saved.tabs[0]).id }
    : { tabs: [], activeId: '' };
  if (sessionID) return showSession(state, sessionID);
  if (directory || state.tabs.length === 0) return placeTab(state, newAssistantTab(null, directory));
  return state;
}

/**
 * Assistant - conversations with OpenCode, the coding agent, through its
 * background server (see src/lib/assistant.ts).
 *
 * Conversations are OpenCode's sessions, so the list includes the ones
 * started from a Terminal too, and they keep working with the window
 * closed: the menu bar's robot shows what's running, and Din notifies when
 * the agent finishes or needs an answer (AssistantHost). The agent asks
 * before what its rules say to ask about; the request shows above the
 * composer.
 *
 * Conversations open in tabs, in the window's title bar, kept across closing
 * the window and restarts (lib/assistantTabs). Only the selected tab is
 * mounted: each conversation polls the server while it is. Opened with
 * `sessionID` (and a fresh `nonce`) in its launch params, it selects that
 * conversation's tab; with `directory` instead (Files' "Open in Assistant"),
 * it opens a new conversation in that folder.
 */
export function Assistant({ windowId, params }: AppComponentProps) {
  const ready = useAssistantReady();
  const requested = typeof params?.sessionID === 'string' ? params.sessionID : null;
  const requestedDirectory = typeof params?.directory === 'string' ? params.directory : null;
  const { close: closeWindow } = useWindowActions();
  const setTitlebar = useWindowTitlebar();
  const [{ tabs, activeId }, setState] = useState(() => initialTabs(requested, requestedDirectory));
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const [closed, setClosed] = useState<AssistantTab[]>([]);
  // The conversation whose title is being edited (Rename, or /rename).
  const [renaming, setRenaming] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [listWidth, setListWidth] = useState(loadListWidth);
  useEffect(() => localStorage.setItem(LIST_WIDTH_KEY, String(listWidth)), [listWidth]);

  // Single-instance: a relaunch (a notification, the menu bar) brings new
  // params without remounting. One with no session asks for a new one.
  // Launch params are merged into the window's old ones, so launchers name
  // both `sessionID` and `directory`, clearing whichever they don't use.
  const nonce = params?.nonce;
  const [launch, setLaunch] = useState({ requested, nonce });
  if (launch.requested !== requested || launch.nonce !== nonce) {
    setLaunch({ requested, nonce });
    setState((prev) =>
      requested ? showSession(prev, requested) : placeTab(prev, newAssistantTab(null, requestedDirectory)),
    );
  }

  useEffect(() => saveAssistantTabs(tabs, activeId), [tabs, activeId]);

  /** Close the tabs of conversations that are gone, leaving a new one if none is left. */
  const removeSessions = useCallback((ids: ReadonlySet<string>) => {
    setClosed((c) => c.filter((t) => !t.sessionID || !ids.has(t.sessionID)));
    setState((prev) => {
      const next = prev.tabs.filter((t) => !t.sessionID || !ids.has(t.sessionID));
      if (next.length === prev.tabs.length) return prev;
      if (next.length === 0) {
        const tab = newAssistantTab();
        return { tabs: [tab], activeId: tab.id };
      }
      if (next.some((t) => t.id === prev.activeId)) return { ...prev, tabs: next };
      const index = prev.tabs.findIndex((t) => t.id === prev.activeId);
      return { tabs: next, activeId: next[Math.min(Math.max(0, index - 1), next.length - 1)].id };
    });
  }, []);

  // Conversations deleted elsewhere (a Terminal, another computer) lose their tabs.
  const sessionIDs = useMemo(() => tabs.flatMap((t) => (t.sessionID ? [t.sessionID] : [])), [tabs]);
  const sessions = useSessionsByID(sessionIDs);
  const gone = sessionIDs.filter((_, i) => sessions[i]?.gone).join(' ');
  const [pruned, setPruned] = useState('');
  if (gone && gone !== pruned) {
    setPruned(gone);
    removeSessions(new Set(gone.split(' ')));
  }

  const { data: running = [] } = useActiveSessions();
  const pending = usePendingRequests();
  const waiting = new Set([...pending.permissions.map((p) => p.sessionID), ...pending.forms.map((f) => f.sessionID)]);
  // Stable while nothing shown changes, so the title bar isn't republished on every render.
  const infoKey = JSON.stringify(
    tabs.map((tab): TabInfo => {
      if (!tab.sessionID) return { id: tab.id, title: 'New conversation', state: 'new' };
      const session = sessions[sessionIDs.indexOf(tab.sessionID)]?.session;
      return {
        id: tab.id,
        title: session ? sessionTitle(session) : 'Loading…',
        state: waiting.has(tab.sessionID) ? 'waiting' : running.includes(tab.sessionID) ? 'running' : 'idle',
      };
    }),
  );
  const stripTabs = useMemo((): TabInfo[] => JSON.parse(infoKey), [infoKey]);
  useWindowTitle(activeTab.sessionID ? (stripTabs.find((t) => t.id === activeTab.id)?.title ?? null) : null);

  const select = (id: string) => setState((prev) => ({ ...prev, activeId: id }));

  const openTab = () => {
    const tab = newAssistantTab();
    setState((prev) => ({ tabs: [...prev.tabs, tab], activeId: tab.id }));
  };

  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    forgetTabDraft(tab);
    if (tab.sessionID) {
      scrollPositions.delete(tab.sessionID);
      setClosed((c) => [...c, tab].slice(-CLOSED_TABS_LIMIT));
    }
    // Closing the last tab closes the window, which opens fresh next time.
    if (tabs.length === 1) {
      saveAssistantTabs([], '');
      closeWindow(windowId);
      return;
    }
    setState((prev) => {
      const index = prev.tabs.findIndex((t) => t.id === id);
      const next = prev.tabs.filter((t) => t.id !== id);
      if (index === -1 || next.length === 0) return prev;
      return { tabs: next, activeId: prev.activeId === id ? next[Math.max(0, index - 1)].id : prev.activeId };
    });
  };

  const reopen = () => {
    const sessionID = closed.at(-1)?.sessionID;
    if (!sessionID) return;
    setClosed((c) => c.slice(0, -1));
    setState((prev) => showSession(prev, sessionID));
  };

  const cycle = (delta: number) => {
    const index = tabs.findIndex((t) => t.id === activeId);
    select(tabs[(index + delta + tabs.length) % tabs.length].id);
  };

  const choose = (sessionID: string) => {
    setState((prev) => showSession(prev, sessionID));
    setListOpen(false);
  };

  /** Open a conversation in a tab of its own, behind the selected one. */
  const openInNewTab = (sessionID: string) =>
    setState((prev) => {
      if (prev.tabs.some((t) => t.sessionID === sessionID)) return prev;
      const index = prev.tabs.findIndex((t) => t.id === prev.activeId);
      const tab = newAssistantTab(sessionID);
      return { ...prev, tabs: [...prev.tabs.slice(0, index + 1), tab, ...prev.tabs.slice(index + 1)] };
    });

  const startNew = (directory?: string) => {
    setState((prev) => placeTab(prev, newAssistantTab(null, directory ?? null)));
    setListOpen(false);
  };

  const updateTab = (id: string, change: Partial<AssistantTab>) =>
    setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === id ? { ...t, ...change } : t)) }));

  const started = (tab: AssistantTab, sessionID: string) => {
    forgetTabDraft(tab);
    updateTab(tab.id, { sessionID });
  };

  // Rename from a tab's menu puts focus in the title field; the closing menu mustn't take it back.
  const renamingFromMenu = useRef(false);
  const renameTab = (id: string) => {
    const sessionID = tabs.find((t) => t.id === id)?.sessionID;
    if (!sessionID) return;
    renamingFromMenu.current = true;
    select(id);
    setRenaming(sessionID);
  };

  // The strip lives in the title bar and outlives renders; it calls the latest of these.
  const move = (id: string, to: number) => setState((prev) => ({ ...prev, tabs: moveItem(prev.tabs, id, to) }));
  const actions = useRef({ select, closeTab, openTab, reopen, renameTab, move });
  useLayoutEffect(() => {
    actions.current = { select, closeTab, openTab, reopen, renameTab, move };
  });

  const canReopen = closed.length > 0;
  useEffect(() => {
    if (!ready) return;
    setTitlebar(
      <TabStrip
        tabs={stripTabs.map((t) => ({ id: t.id, title: t.title, icon: <TabIcon state={t.state} /> }))}
        activeId={activeId}
        label="Assistant tabs"
        newTabLabel="New conversation"
        newTabMenuLabel="New conversation"
        onActivate={(id) => actions.current.select(id)}
        onClose={(id) => actions.current.closeTab(id)}
        onNew={() => actions.current.openTab()}
        onMove={(id, to) => actions.current.move(id, to)}
        onReopen={canReopen ? () => actions.current.reopen() : undefined}
        tabMenuItems={(id) =>
          stripTabs.find((t) => t.id === id)?.state !== 'new' && (
            <ContextMenuItem onSelect={() => actions.current.renameTab(id)}>Rename</ContextMenuItem>
          )
        }
        onTabMenuCloseAutoFocus={(e) => {
          if (renamingFromMenu.current) e.preventDefault();
          renamingFromMenu.current = false;
        }}
      />,
    );
    return () => setTitlebar(null);
  }, [ready, stripTabs, activeId, canReopen, setTitlebar]);

  if (!ready) {
    return (
      <div className="grid h-full place-items-center bg-background text-foreground">
        <AssistantUnavailable />
      </div>
    );
  }

  // Tab shortcuts work everywhere in the window, the composer included.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 't') {
      if (e.shiftKey) reopen();
      else openTab();
    } else if (key === 'w' && !e.shiftKey) closeTab(activeTab.id);
    else if (key === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if ((key === 'PageUp' || key === 'PageDown') && !e.shiftKey) cycle(key === 'PageUp' ? -1 : 1);
    else if (/^[1-9]$/.test(key) && !e.shiftKey) select(tabs[key === '9' ? tabs.length - 1 : Math.min(Number(key), tabs.length) - 1].id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = listWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setListWidth(clampListWidth(startWidth + ev.clientX - startX));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  return (
    <div
      className="@container/assistant relative flex h-full w-full bg-background text-foreground"
      onKeyDownCapture={onKeyDown}
    >
      <SessionList
        selected={activeTab.sessionID}
        onSelect={choose}
        onOpenInNewTab={openInNewTab}
        onNew={startNew}
        onDeleted={(id) => removeSessions(new Set([id]))}
        style={{ width: listWidth }}
        className={cn(
          listOpen ? 'flex' : 'hidden',
          'absolute inset-y-0 left-0 z-20 max-w-[85%] shadow-xl @2xl/assistant:static @2xl/assistant:flex @2xl/assistant:max-w-none @2xl/assistant:shadow-none',
        )}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the conversation list"
        aria-valuenow={listWidth}
        aria-valuemin={MIN_LIST_WIDTH}
        aria-valuemax={MAX_LIST_WIDTH}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setListWidth(DEFAULT_LIST_WIDTH)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') setListWidth((w) => clampListWidth(w - 16));
          else if (e.key === 'ArrowRight') setListWidth((w) => clampListWidth(w + 16));
          else return;
          e.preventDefault();
        }}
        className="z-10 -ml-1 hidden w-1 shrink-0 cursor-col-resize touch-none hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none @2xl/assistant:block"
      />
      {listOpen && (
        <button
          type="button"
          aria-label="Close the conversation list"
          className="absolute inset-0 z-10 bg-background/40 @2xl/assistant:hidden"
          onClick={() => setListOpen(false)}
        />
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        {activeTab.sessionID ? (
          <Conversation
            key={activeTab.sessionID}
            sessionID={activeTab.sessionID}
            editingTitle={renaming === activeTab.sessionID}
            onEditingTitleChange={(editing) => setRenaming(editing ? activeTab.sessionID : null)}
            onShowList={() => setListOpen(true)}
            onDeleted={() => activeTab.sessionID && removeSessions(new Set([activeTab.sessionID]))}
            onNew={startNew}
          />
        ) : (
          <NewConversation
            key={activeTab.id}
            directory={activeTab.directory}
            onDirectoryChange={(directory) => updateTab(activeTab.id, { directory })}
            draftKey={newConversationDraftKey(activeTab.id)}
            onStarted={(sessionID) => started(activeTab, sessionID)}
            onShowList={() => setListOpen(true)}
          />
        )}
      </main>
    </div>
  );
}

/** A tab's icon: whether its conversation is working, or waiting on the user. */
function TabIcon({ state }: { state: TabInfo['state'] }) {
  switch (state) {
    case 'waiting':
      return (
        <span className="grid size-3.5 place-items-center" aria-label="Waiting for you">
          <span className="size-2 rounded-full bg-primary" />
        </span>
      );
    case 'running':
      return <Loader2 className="size-3.5 animate-spin" aria-label="Working" />;
    case 'new':
      return <SquarePen className="size-3.5" aria-hidden />;
    default:
      return <MessageSquare className="size-3.5" aria-hidden />;
  }
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

function Conversation({
  sessionID,
  editingTitle,
  onEditingTitleChange: setEditingTitle,
  onShowList,
  onDeleted,
  onNew,
}: {
  sessionID: string;
  /** The title is being edited (Rename, or /rename). */
  editingTitle: boolean;
  onEditingTitleChange: (editing: boolean) => void;
  onShowList: () => void;
  onDeleted: () => void;
  onNew: (directory?: string) => void;
}) {
  const { data: session } = useAssistantSession(sessionID);
  const { data: transcript, isLoading } = useSessionMessages(sessionID);
  const { data: permissions = [] } = useSessionPermissions(sessionID);
  const { data: forms = [] } = useSessionForms(sessionID);
  const composerRef = useQuestionHandoff(forms.length > 0);
  const { data: queued } = useSessionInbox(sessionID);
  const { data: active = [] } = useActiveSessions();
  const { models, setModel } = usePreferredModel();
  const { data: recentData } = useRecentModelKeys();
  const home = useHomeDirectory();
  const send = useSendPrompt(sessionID);
  const interrupt = useInterruptSession();
  const background = useBackgroundSession();
  const cancelQueued = useCancelQueued();
  const switchModel = useSwitchModel();
  const switchAgent = useSwitchAgent();
  const compact = useCompactSession();
  const rename = useRenameSession();
  const { toast } = useToast();
  const running = active.includes(sessionID);
  const messages = transcript?.messages;
  const commands = useSlashCommands(session?.location.directory, CONVERSATION_COMMANDS);
  const directory = session?.location.directory;
  const fileLinkBase = useMemo(() => ({ directory, home }), [directory, home]);
  useMarkViewedSession(sessionID);

  // Follow the conversation down as it grows, unless the user scrolled up.
  // Coming back to its tab finds it where it was left.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [left] = useState(() => scrollPositions.get(sessionID));
  const stick = useRef(left?.stuck ?? true);
  const restoreTop = useRef(left && !left.stuck ? left.top : null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (restoreTop.current !== null && messages) {
      el.scrollTop = restoreTop.current;
      restoreTop.current = null;
    }
  }, [messages, queued, permissions.length, forms.length, running]);

  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: cleanAssistantError(error), variant: 'destructive' });

  // The one being switched to, so a quick second Shift+Tab goes on from there.
  const agent = (switchAgent.isPending ? switchAgent.variables?.agent : session?.agent) ?? 'build';
  const changeAgent = (agent: string) => switchAgent.mutate({ sessionID, agent }, { onError: fail('Couldn’t switch') });
  const cycleAgent = useCycleAgent(agent, changeAgent);

  const toBackground = () => background.mutate(sessionID, { onError: fail('Couldn’t move it to the background') });

  const runCommand = (name: string, args: string, files: PromptAttachment[]) => {
    stick.current = true;
    switch (name) {
      case 'compact':
        return compact.mutateAsync(sessionID, { onError: fail('Couldn’t compact the conversation') });
      case 'new':
        return onNew(session?.location.directory);
      case 'rename':
        if (!args) return setEditingTitle(true);
        return rename.mutateAsync({ sessionID, title: args }, { onError: fail('Couldn’t rename') });
      case 'stop':
        return interrupt.mutateAsync(sessionID, { onError: fail('Couldn’t stop') });
      default:
        return send.mutateAsync({ command: name, text: args, files }, { onError: fail(`Couldn’t run /${name}`) });
    }
  };

  return (
    // Focusable so Ctrl+B still reaches it after a click in the transcript.
    <div
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        if (event.key.toLowerCase() !== 'b' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
        if (!running) return;
        event.preventDefault();
        toBackground();
      }}
    >
      <ConversationHeader
        session={session}
        home={home}
        running={running}
        editing={editingTitle}
        onEditingChange={setEditingTitle}
        onShowList={onShowList}
        onDeleted={onDeleted}
      />
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          scrollPositions.set(sessionID, { top: el.scrollTop, stuck: stick.current });
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-3xl px-4 py-6 @2xl/assistant:px-6">
          {isLoading && !messages ? (
            <TranscriptSkeleton />
          ) : (
            <>
              {transcript?.more && (
                <p className="mb-6 text-center text-xs text-muted-foreground">Earlier messages aren’t shown.</p>
              )}
              <FileLinkBaseContext value={fileLinkBase}>
                <Transcript
                  messages={messages ?? []}
                  queued={queued}
                  running={running}
                  home={home}
                  onCancelQueued={(message) =>
                    cancelQueued.mutate({ sessionID, id: message.id }, { onError: fail('Couldn’t cancel') })
                  }
                />
              </FileLinkBaseContext>
            </>
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-4 @2xl/assistant:px-6">
        {permissions.map((request) => (
          <PermissionCard key={request.id} request={request} />
        ))}
        {forms.map((form) => (
          <FormCard key={form.id} form={form} />
        ))}
        <div ref={composerRef} hidden={forms.length > 0}>
          <Composer
            autoFocus
            draftKey={sessionID}
            running={running}
            busy={send.isPending || compact.isPending}
            placeholder={running ? 'Add something while it works…' : 'Reply, or type / for commands…'}
            onSubmit={(text, files) => {
              stick.current = true;
              return send.mutateAsync({ text, files }, { onError: fail('Couldn’t send') });
            }}
            commands={commands}
            onCommand={runCommand}
            onStop={() => interrupt.mutate(sessionID, { onError: fail('Couldn’t stop') })}
            toolbar={
              <>
                <ModelPicker
                  models={models}
                  value={session?.model}
                  recent={recentData}
                  onChange={(model) => {
                    setModel(model);
                    switchModel.mutate({ sessionID, model }, { onError: fail('Couldn’t switch models') });
                  }}
                />
                <AgentPicker value={agent} onChange={changeAgent} />
              </>
            }
            onCycleAgent={cycleAgent}
          />
        </div>
      </div>
    </div>
  );
}

function ConversationHeader({
  session,
  home,
  running,
  editing,
  onEditingChange: setEditing,
  onShowList,
  onDeleted,
}: {
  session: SessionInfo | undefined;
  home?: string;
  running: boolean;
  /** The title is being edited (Rename, or /rename). */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onShowList: () => void;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Rename puts focus in the title field; the closing menu mustn't take it back.
  const renaming = useRef(false);
  const rename = () => {
    renaming.current = true;
    setEditing(true);
  };
  const keepFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };
  const cost = session ? formatCost(session.cost) : '';

  return (
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <ListToggle onClick={onShowList} />
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!session || editing}>
          <div className="min-w-0 flex-1">
            {editing && session ? (
              <ConversationTitleInput session={session} onDone={() => setEditing(false)} />
            ) : session ? (
              <h2 className="truncate text-sm font-semibold">{sessionTitle(session)}</h2>
            ) : (
              <Skeleton className="h-4 w-48" />
            )}
            {session && (
              <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <Folder className="size-3 shrink-0" aria-hidden />
                <span className="truncate" title={session.location.directory}>
                  {tildify(session.location.directory, home)}
                </span>
                {cost && <span aria-label="Cost so far">· {cost}</span>}
                {running && (
                  <span className="flex items-center gap-1 text-primary">
                    · <Loader2 className="size-3 animate-spin" aria-hidden /> Working
                  </span>
                )}
              </p>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={keepFocus}>
          <ContextMenuItem onSelect={rename}>
            <Pencil aria-hidden /> Rename
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
            <Trash2 aria-hidden /> Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {session && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="Conversation options">
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onCloseAutoFocus={keepFocus}>
            <DropdownMenuItem onSelect={rename}>
              <Pencil aria-hidden /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              <Trash2 aria-hidden /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DeleteConversationDialog session={session} open={confirming} onOpenChange={setConfirming} onDeleted={onDeleted} />
    </header>
  );
}

function ListToggle({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 @2xl/assistant:hidden"
      aria-label="Show conversations"
      onClick={onClick}
    >
      <PanelLeft className="size-4" aria-hidden />
    </Button>
  );
}

function TranscriptSkeleton() {
  return (
    <div className="space-y-8" aria-label="Loading the conversation">
      <div className="flex justify-end">
        <Skeleton className="h-11 w-2/3 rounded-3xl" />
      </div>
      <div className="space-y-3">
        <Skeleton className="mb-5 h-4 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

function NewConversation({
  directory,
  onDirectoryChange: setDirectory,
  draftKey,
  onStarted,
  onShowList,
}: {
  /** The folder it works in; null for the default one. */
  directory: string | null;
  onDirectoryChange: (directory: string) => void;
  draftKey: string;
  onStarted: (id: string) => void;
  onShowList: () => void;
}) {
  const defaultDirectory = useAssistantDirectory();
  const home = useHomeDirectory();
  const [agent, setAgent] = useState('build');
  const cycleAgent = useCycleAgent(agent, setAgent);
  const { model, setModel, models } = usePreferredModel();
  const { data: recent } = useRecentModelKeys();
  const start = useStartConversation();
  const { pickFile } = useFilePicker();
  const { toast } = useToast();
  const folder = directory ?? defaultDirectory;
  const commands = useSlashCommands(folder, NO_COMMANDS);

  const begin = (text: string, files: PromptAttachment[] = [], command?: string) =>
    start.mutateAsync(
      { text, files, model, agent, directory: folder, command },
      {
        onSuccess: (session) => onStarted(session.id),
        onError: (error) =>
          toast({ title: 'Couldn’t start the conversation', description: cleanAssistantError(error), variant: 'destructive' }),
      },
    );

  const chooseFolder = async () => {
    const picked = await pickFile({ title: 'Work in a folder', confirmLabel: 'Choose', directory: true, initialPath: folder }).catch(
      () => null,
    );
    if (picked) setDirectory(picked);
  };

  return (
    <>
      <header className="flex items-center px-3 py-2 @2xl/assistant:hidden">
        <ListToggle onClick={onShowList} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 @2xl/assistant:px-6">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="relative">
              <div aria-hidden className="absolute inset-2 rounded-full bg-primary/25 blur-2xl motion-safe:animate-pulse" />
              <img src="/icons/apps/assistant.png" alt="" className="relative size-24 object-contain drop-shadow-sm" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight @xl/assistant:text-4xl">What can I help with?</h1>
            <p className="max-w-md text-muted-foreground">
              The assistant can read and change files, run commands and look things up on this computer. It asks before
              anything its rules say to check with you.
            </p>
          </div>
          <Composer
            autoFocus
            draftKey={draftKey}
            busy={start.isPending}
            placeholder="Ask the assistant to do something…"
            onSubmit={(text, files) => begin(text, files)}
            commands={commands}
            onCommand={(name, args, files) => begin(args, files, name)}
            toolbar={
              <>
                <ModelPicker models={models} value={model} recent={recent} onChange={setModel} />
                <AgentPicker value={agent} onChange={setAgent} />
              </>
            }
            onCycleAgent={cycleAgent}
          />
          <div className="flex flex-wrap items-center justify-center gap-2">
            <FolderPicker value={folder} home={home} onChange={setDirectory} onOther={() => void chooseFolder()} />
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                variant="ghost"
                size="sm"
                disabled={start.isPending}
                className="h-8 rounded-full bg-muted/60 text-muted-foreground hover:text-foreground"
                onClick={() => void begin(suggestion).catch(() => {})}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

/** Switches to the agent after `value`, for Shift+Tab; undefined with fewer than two. */
function useCycleAgent(value: string, onChange: (agent: string) => void): (() => void) | undefined {
  const { data: agents = [] } = useAssistantAgents();
  if (agents.length < 2) return undefined;
  return () => onChange(agents[(agents.findIndex((a) => a.id === value) + 1) % agents.length].id);
}

/** Build (does the work) or Plan (only reads and plans), and any others configured. */
function AgentPicker({ value, onChange }: { value: string; onChange: (agent: string) => void }) {
  const { data: agents = [] } = useAssistantAgents();
  const color = useAgentColor();
  const current = agents.find((a) => a.id === value);
  if (agents.length < 2) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-2 text-xs font-medium text-muted-foreground transition-colors duration-300 hover:text-foreground"
          style={{ color: color(value) }}
          aria-label={`Agent: ${current?.name ?? value}`}
          title="Agent (Shift+Tab to switch)"
        >
          {current?.name ?? value}
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {agents.map((agent) => (
            <DropdownMenuRadioItem key={agent.id} value={agent.id} className="items-start">
              <span>
                <span className="block font-medium" style={{ color: color(agent.id) }}>
                  {agent.name}
                </span>
                {agent.description && (
                  <span className="line-clamp-2 block text-xs text-muted-foreground">{agent.description}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How many recent folders the folder picker offers. */
const RECENT_FOLDER_LIMIT = 8;

/**
 * The folders recent conversations worked in, most recent first. A
 * worktree counts as its main checkout, since worktrees come and go.
 */
function useRecentFolders(): string[] {
  const { data: sessions } = useAssistantSessions();
  const listed = useMemo(
    () => (sessions ?? []).filter((s) => !s.time.archived).sort((a, b) => b.time.updated - a.time.updated),
    [sessions],
  );
  const directories = useMemo(() => [...new Set(listed.map((s) => s.location.directory))], [listed]);
  const mains = useMainCheckouts(directories);
  return useMemo(
    () => [...new Set(directories.map((d) => mains.get(d) ?? d))].slice(0, RECENT_FOLDER_LIMIT),
    [directories, mains],
  );
}

/** The folder a new conversation works in: a recent one, or another from the file picker. */
function FolderPicker({
  value,
  home,
  onChange,
  onOther,
}: {
  value: string | undefined;
  home: string | undefined;
  onChange: (directory: string) => void;
  onOther: () => void;
}) {
  const recent = useRecentFolders();
  const folders = value && !recent.includes(value) ? [value, ...recent] : recent;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 rounded-full" aria-label="Work in a folder">
          <Folder className="size-3.5" aria-hidden />
          <span className="max-w-60 truncate">{value ? tildify(value, home) : 'Home'}</span>
          <ChevronDown className="size-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {folders.length > 0 && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Recent folders</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={value ?? ''} onValueChange={onChange}>
              {folders.map((folder) => (
                <DropdownMenuRadioItem key={folder} value={folder} title={folder}>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{directoryName(folder, home)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{tildify(folder, home)}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={onOther}>
          <FolderOpen aria-hidden /> Other folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The recently used models' keys, for the picker's first group. */
function useRecentModelKeys(): { data: string[] } {
  const { model } = usePreferredModel();
  const { data: sessions } = useAssistantSessions();
  return useMemo(() => {
    const keys = [
      ...(model ? [modelKey(model)] : []),
      ...(sessions ?? []).flatMap((s) => (s.model ? [modelKey(s.model)] : [])),
    ];
    return { data: [...new Set(keys)] };
  }, [model, sessions]);
}
