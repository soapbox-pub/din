import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactElement, type Ref } from 'react';
import { ArrowDown, Check, ChevronDown, ChevronsUpDown, Folder, FolderOpen, Loader2, PanelLeft, PanelRightOpen, Plus, Redo2, Settings, SquarePen, SquareTerminal, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenuItem } from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { attachmentOf, saveHandedFile, splitAttachedPaths } from '@/shared/assistant/attachedFiles';
import { useGivenSecretNames, useSecretRequests } from '@/shared/assistant/secretRequests';
import { SecretRequestCard } from '@/shared/assistant/Secrets';
import { AssistantUnavailable } from '@/shared/assistant/AssistantUnavailable';
import { BackgroundTasks } from '@/shared/assistant/BackgroundTasks';
import { CallBar } from '@/shared/assistant/Call';
import { carryCall, useCall } from '@/shared/assistant/useCall';
import { speakNextReply, useReplyVoice } from '@/shared/assistant/replyVoice';
import { ConversationTitleInput, DeleteConversationDialog } from '@/shared/assistant/ConversationActions';
import { Composer, type ComposerHandle, type SlashCommand } from '@/shared/assistant/Composer';
import { ModelPicker, ThinkingPicker } from '@/shared/assistant/ModelPicker';
import { PROVIDER_WINDOW_APP_ID, providerWindowParams } from '@/shared/assistant/providerWindow';
import { FileLinkBaseContext } from '@/shared/assistant/fileLinks';
import { FindBar, type FindBarHandle } from '@/shared/assistant/FindBar';
import { ForkDialog, type UserMessage } from '@/shared/assistant/ForkDialog';
import { LoadMore } from '@/shared/assistant/LoadMore';
import { FormCard, PasswordCard, PermissionCard } from '@/shared/assistant/RequestCards';
import { SessionList } from '@/shared/assistant/SessionList';
import { Transcript } from '@/shared/assistant/Transcript';
import { WorkIndicator } from '@/shared/assistant/WorkIndicator';
import { useQuestionHandoff } from '@/shared/assistant/useQuestionHandoff';
import { ProjectIcon } from '@/shared/assistant/ProjectIcon';
import { AppAssistantHost } from '@/shared/assistant/appHost';
import { useAssistantHost } from '@/shared/assistant/host';
import { TabStrip } from '@/shared/TabStrip';
import { dinWindowMove } from '@/shared/dinWindowMove';
import { useDin, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { useOnLaunch, wasReopened, windowLaunch, type Launch } from '@/shared/launch';
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
  useAssistantStatus,
  useAssistantWork,
  useBackgroundSession,
  useKillShell,
  tasksOf,
  workKind,
  commandsUnder,
  type BackgroundTask,
  useDirectoryIcons,
  useCancelQueued,
  useCompactSession,
  useForkSession,
  useHomeDirectory,
  useInterruptSession,
  useMainCheckouts,
  followDinSession,
  useMarkSeenSession,
  useMarkViewedSession,
  usePendingRequests,
  usePreferredModel,
  useProjectFolders,
  useProjectIcons,
  useRedoMessages,
  useRenameSession,
  useSendPrompt,
  useSessionFolders,
  useSessionForms,
  useSessionPasswords,
  useSessionInbox,
  useSessionMessages,
  useSessionPermissions,
  useSessionsByID,
  useStartConversation,
  useSwitchAgent,
  useSwitchModel,
  useUndoMessage,
  useUnreadSessions,
} from '@/hooks/useAssistant';
import {
  backgroundOnly,
  cleanAssistantError,
  contextUsage,
  directoryName,
  formatContextUsage,
  formatCost,
  modelKey,
  modelRef,
  supportedVariant,
  DEFAULT_VARIANT,
  sessionTitle,
  tildify,
  type FileDiff,
  type PromptAttachment,
  type SessionInfo,
} from '@/lib/assistant';
import {
  forgetTabDraft,
  isBlankTab,
  isUntouchedTab,
  loadAssistantTabs,
  newAssistantTab,
  newProjectTab,
  newConversationDraftKey,
  saveAssistantTabs,
  saveDraft,
  type AssistantTab,
} from '@/lib/assistantTabs';
import { cn } from '@/lib/utils';
import { ContentPane, ToolButton } from '@/shared/appChrome';
import { SIDEBAR_WIDTH, flushPane, focusRing } from '@/shared/appChromeStyles';
import { ATTACHED_DIR, intentOf, type LaunchIntent } from './intents';
import { GitBranchChip } from './GitPanel';
import { ProjectHeading, ProjectOverview, ProjectTiles } from './ProjectPage';
import { SidePanel, type SideTab } from './SidePanel';
import { TERMINAL_ATTRIBUTE, TerminalPanel } from './TerminalPanel';
import { PreviewOpenContext, useSessionPreviews, type Preview } from '@/shared/assistant/previews';
import { prefersReducedMotion } from '@/shared/reducedMotion';
import { bundledIconProps } from '@/shared/iconSizes';

/** The commands Din runs itself in a conversation, beside the server's. */
const CONVERSATION_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up the model’s context', instant: true },
  { name: 'connect', description: 'Add an AI provider: Claude, OpenRouter and more', instant: true },
  { name: 'fork', description: 'Continue in a new conversation, from here or an earlier message', instant: true },
  { name: 'new', description: 'Start a new conversation in this folder', instant: true },
  { name: 'rename', args: '[title]', description: 'Rename this conversation' },
  { name: 'stop', description: 'Stop the agent', instant: true },
  { name: 'undo', description: 'Take back your last message, what the agent did and the files it changed', instant: true },
];

/** And once something is undone, a way to bring it back. */
const UNDONE_COMMANDS: SlashCommand[] = [
  ...CONVERSATION_COMMANDS.slice(0, 4),
  { name: 'redo', description: 'Bring back what /undo took away, files too', instant: true },
  ...CONVERSATION_COMMANDS.slice(4),
];

/**
 * A user message's files that can be attached again (pasted ones aren't
 * kept), those sent as their paths at the end of its text among them.
 */
function reattachable(message: UserMessage): PromptAttachment[] {
  return [
    ...(message.files ?? []).flatMap((file) => (file.source?.type === 'uri' ? [{ uri: file.source.uri, name: file.name }] : [])),
    ...splitAttachedPaths(message.text).paths.map(attachmentOf),
  ];
}

/** A new conversation has the server's and /connect: there is nothing yet to compact or rename. */
const NEW_COMMANDS: SlashCommand[] = CONVERSATION_COMMANDS.filter((c) => c.name === 'connect');

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
const DEFAULT_LIST_WIDTH = SIDEBAR_WIDTH;
const MIN_LIST_WIDTH = 192;
const MAX_LIST_WIDTH = 560;

const clampListWidth = (width: number) => Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, width));

function loadListWidth(): number {
  const width = Number(localStorage.getItem(LIST_WIDTH_KEY));
  // 256 was the default, saved whether or not it was ever dragged.
  return width && width !== 256 ? clampListWidth(width) : DEFAULT_LIST_WIDTH;
}

const GIT_OPEN_KEY = 'din.assistant.git';
const GIT_WIDTH_KEY = 'din.assistant.git-width';
const MIN_GIT_WIDTH = 224;

const clampGitWidth = (width: number) => Math.min(MAX_LIST_WIDTH, Math.max(MIN_GIT_WIDTH, width));

function loadGitWidth(): number {
  const width = Number(localStorage.getItem(GIT_WIDTH_KEY));
  return width ? clampGitWidth(width) : SIDEBAR_WIDTH;
}

const PREVIEW_WIDTH_KEY = 'din.assistant.preview-width';
const DEFAULT_PREVIEW_WIDTH = 560;
const MIN_PREVIEW_WIDTH = 320;
const MAX_PREVIEW_WIDTH = 1600;

const clampPreviewWidth = (width: number) => Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, width));

function loadPreviewWidth(): number {
  const width = Number(localStorage.getItem(PREVIEW_WIDTH_KEY));
  return width ? clampPreviewWidth(width) : DEFAULT_PREVIEW_WIDTH;
}

/** The window's width (px) from which the Git panel sits beside the conversation: `@5xl/assistant`. */
const GIT_BESIDE_WIDTH = 1024;

/** A ref for an element, and whether it's at least `min` px wide (the window's width until it's measured). */
function useWideEnough(min: number): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(() => window.innerWidth >= min);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWide(el.offsetWidth >= min);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, min]);
  return [setEl, wide];
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
  /** `background`: all that's left running is commands, not an agent. `project`: a project's page. */
  state: 'new' | 'project' | 'idle' | 'running' | 'background' | 'waiting';
  /** How many commands it has running, for the background state's label. */
  commands?: number;
  /** The folder its conversation works in, for the project's favicon. */
  directory?: string;
  /** Its conversation has unread notifications. */
  unread?: boolean;
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

/**
 * Shows the project in `directory`: its page's tab, or a new one, in place
 * of the selected tab when nothing's been typed there; with `behind`, in a
 * tab beside the selected one, which stays selected.
 */
function showProject(state: TabsState, directory: string, behind = false): TabsState {
  const open = state.tabs.find((t) => t.project && t.directory === directory);
  if (open) return behind ? state : { ...state, activeId: open.id };
  const tab = newProjectTab(directory);
  const index = state.tabs.findIndex((t) => t.id === state.activeId);
  if (behind) return { ...state, tabs: [...state.tabs.slice(0, index + 1), tab, ...state.tabs.slice(index + 1)] };
  if (index !== -1 && isUntouchedTab(state.tabs[index])) {
    return { tabs: state.tabs.map((t, i) => (i === index ? { ...tab, terminal: state.tabs[index].terminal } : t)), activeId: tab.id };
  }
  return placeTab(state, tab);
}

/**
 * The tabs the window opens with: the ones it had, and what it was opened
 * for (`keep`: only a conversation's, never a new one, unless it has none).
 */
function initialTabs(sessionID: string | null, directory: string | null, keep = false): TabsState {
  const saved = loadAssistantTabs();
  const state = saved
    ? { tabs: saved.tabs, activeId: (saved.tabs[saved.active] ?? saved.tabs[0]).id }
    : { tabs: [], activeId: '' };
  if (sessionID) return showSession(state, sessionID);
  if ((directory && !keep) || state.tabs.length === 0) return placeTab(state, newAssistantTab(null, directory));
  return state;
}

/** The terminal shown or hidden in the conversation's tab, or the selected one's. */
function withTerminal(state: TabsState, sessionID: string | null, terminal: boolean): TabsState {
  const id = (sessionID && state.tabs.find((t) => t.sessionID === sessionID)?.id) || state.activeId;
  return { ...state, activeId: id, tabs: state.tabs.map((t) => (t.id === id ? { ...t, terminal } : t)) };
}

/**
 * Assistant - conversations with OpenCode, the coding agent, through its
 * background server (see src/lib/assistant.ts), reached over
 * `din.system.assistant`.
 *
 * Conversations are OpenCode's sessions, so the list includes the ones
 * started from a Terminal too, and they keep working with the window
 * closed: the menu bar's robot shows what's running, and Din notifies when
 * the agent needs an answer (the desktop's AssistantHost). While the window
 * is open it says itself when a conversation finishes out of sight
 * (useTurnNotifications). The agent asks before what its rules say to ask
 * about; the request shows above the composer.
 *
 * The conversation list runs to the top of the window, GNOME-style, and the
 * app draws the title bar on either side of it (a `custom` frame).
 * Conversations open in tabs, in the title bar over them, kept across closing
 * the window and restarts (lib/assistantTabs). Only the selected tab is
 * mounted: each conversation polls the server while it is. Launched with
 * `sessionID` (and a fresh `nonce`) in its params, it selects that
 * conversation's tab (and with `focusPassword` equal to the nonce, puts the
 * cursor in its sudo password request); with `directory` instead (Files'
 * "Open in Assistant"),
 * it opens a new conversation in that folder. One window: launching it again
 * comes through `launchQueue` (`useOnLaunch`).
 */
export function Assistant() {
  return (
    <AppAssistantHost>
      <AssistantWindow />
    </AppAssistantHost>
  );
}

/** What a launch asks for: a conversation, or a new one (in a folder). */
function launchRequest({ params }: Pick<Launch, 'params'>): {
  sessionID: string | null;
  directory: string | null;
  focusPassword: boolean;
  /** Its message was spoken (Super+A held, the menu bar's mic): its reply is to be read aloud. */
  speakReply: boolean;
  /** Show or hide the conversation's terminal (din assistant terminal), not opening a tab for it. */
  terminal: 'show' | 'hide' | null;
  /** Show a project's page, the folder it's in (din assistant project). */
  project: string | null;
} {
  return {
    sessionID: typeof params.sessionID === 'string' ? params.sessionID : null,
    directory: typeof params.directory === 'string' ? params.directory : null,
    // Params are merged into the last launch's, so only this launch's nonce counts.
    focusPassword: params.focusPassword !== undefined && params.focusPassword === params.nonce,
    speakReply: params.speakReply !== undefined && params.speakReply === params.nonce,
    terminal:
      params.terminalAt !== undefined && params.terminalAt === params.nonce && (params.terminal === 'show' || params.terminal === 'hide')
        ? params.terminal
        : null,
    project:
      typeof params.project === 'string' && params.project && params.projectAt !== undefined && params.projectAt === params.nonce
        ? params.project
        : null,
  };
}

/** A password request to put the cursor in once it's shown. */
interface PasswordFocus {
  sessionID: string;
  key: number;
}

function AssistantWindow() {
  const din = useDin();
  const host = useAssistantHost();
  const ready = useAssistantReady();
  const { data: status } = useAssistantStatus();
  const [{ tabs, activeId }, setState] = useState(() => {
    const { sessionID, directory, terminal, project } = launchRequest(windowLaunch());
    if (terminal) return withTerminal(initialTabs(sessionID, null, true), sessionID, terminal === 'show');
    if (project) return showProject(initialTabs(null, null, true), project);
    // An intent opens its own conversation, once it's started (below).
    return initialTabs(sessionID, intentOf(windowLaunch(), din.app.opener, wasReopened()) ? null : directory);
  });
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const [passwordFocus, setPasswordFocus] = useState<PasswordFocus | null>(() => {
    const { sessionID, focusPassword } = launchRequest(windowLaunch());
    return sessionID && focusPassword ? { sessionID, key: 1 } : null;
  });
  const [closed, setClosed] = useState<AssistantTab[]>([]);
  // The conversation whose title is being edited (Rename, or /rename).
  const [renaming, setRenaming] = useState<string | null>(null);
  // The conversation a tab's Delete is asking about.
  const [deleting, setDeleting] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  // Add provider (/connect, the menu), in the desktop's provider window.
  const addProvider = () => host.openApp(PROVIDER_WINDOW_APP_ID, providerWindowParams());
  const searchRef = useRef<HTMLInputElement>(null);
  const conversationRef = useRef<ConversationHandle>(null);
  const [listWidth, setListWidth] = useState(loadListWidth);
  // Only a width dragged to is kept, so the default can change.
  useEffect(() => (listWidth === DEFAULT_LIST_WIDTH ? localStorage.removeItem(LIST_WIDTH_KEY) : localStorage.setItem(LIST_WIDTH_KEY, String(listWidth))), [listWidth]);
  // The Git panel at the right, open or not across restarts, and its width.
  // It sits beside the conversation only in a window wide enough for both;
  // narrower, it hides by itself, and opening it slides it over the
  // conversation until it's closed, leaving the setting as it was.
  const [gitOpen, setGitOpen] = useState(() => localStorage.getItem(GIT_OPEN_KEY) === '1');
  useEffect(() => (gitOpen ? localStorage.setItem(GIT_OPEN_KEY, '1') : localStorage.removeItem(GIT_OPEN_KEY)), [gitOpen]);
  const [rootRef, wide] = useWideEnough(GIT_BESIDE_WIDTH);
  const [gitOver, setGitOver] = useState(false);
  if (wide && gitOver) setGitOver(false);
  const gitShown = wide ? gitOpen : gitOver;
  const setGitShown = wide ? setGitOpen : setGitOver;
  // The pane holds Git and the pages the agent previewed, a tab each; its
  // width is Git's narrow one or a page's wider one, by the tab shown.
  const [sideTab, setSideTab] = useState<SideTab>('git');
  const [gitWidth, setGitWidth] = useState(loadGitWidth);
  useEffect(() => (gitWidth === SIDEBAR_WIDTH ? localStorage.removeItem(GIT_WIDTH_KEY) : localStorage.setItem(GIT_WIDTH_KEY, String(gitWidth))), [gitWidth]);
  const [previewWidth, setPreviewWidth] = useState(loadPreviewWidth);
  useEffect(
    () => (previewWidth === DEFAULT_PREVIEW_WIDTH ? localStorage.removeItem(PREVIEW_WIDTH_KEY) : localStorage.setItem(PREVIEW_WIDTH_KEY, String(previewWidth))),
    [previewWidth],
  );
  // Each preview's reloads, by URI, so its frame starts again.
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const reloadPreview = (uri: string) => setReloads((prev) => ({ ...prev, [uri]: (prev[uri] ?? 0) + 1 }));
  const defaultDirectory = useAssistantDirectory();
  const home = useHomeDirectory();

  // Single instance: a relaunch (a notification, the menu bar) brings new
  // params. One with no session asks for a new one. Launch params are merged
  // into the window's old ones, so launchers name both `sessionID` and
  // `directory`, clearing whichever they don't use, and a fresh `nonce`.
  // Another app asking for something (Studio's "Make with Assistant"): a
  // conversation in its folder, started at once if the app is one the intent
  // trusts, else with the request waiting in the composer.
  const { mutateAsync: startConversation } = useStartConversation();
  const { model } = usePreferredModel();
  const runIntent = useCallback(
    (intent: LaunchIntent) => {
      if (intent.kind === 'attach') {
        // A new conversation in the usual folder, the file waiting in its composer.
        saveHandedFile(ATTACHED_DIR, intent.folder, intent.name, intent.content).then(
          (path) => {
            const tab = newAssistantTab(null, null);
            saveDraft(newConversationDraftKey(tab.id), '', [attachmentOf(path)]);
            setState((prev) => placeTab(prev, tab));
          },
          (error: unknown) =>
            host.notify({ title: 'Couldn’t attach that', description: error instanceof Error ? error.message : String(error), destructive: true }),
        );
        return;
      }
      if (!intent.context) {
        const tab = newAssistantTab(null, intent.directory);
        saveDraft(newConversationDraftKey(tab.id), intent.prompt);
        setState((prev) => placeTab(prev, tab));
        return;
      }
      startConversation({ text: intent.prompt, model, agent: 'build', directory: intent.directory, context: intent.context })
        .then(
          (session) => setState((prev) => showSession(prev, session.id)),
          (error: unknown) =>
            host.notify({ title: 'Couldn’t start the conversation', description: cleanAssistantError(error), destructive: true }),
        );
    },
    [host, model, startConversation],
  );
  const ranIntent = useRef<unknown>(null);
  // A spoken message's reply is read aloud, once it comes.
  useEffect(() => {
    const launch = windowLaunch();
    const { sessionID, speakReply } = launchRequest(launch);
    if (sessionID && speakReply) speakNextReply(sessionID, Number(launch.params.nonce) || Date.now());
  }, []);
  useEffect(() => {
    const launch = windowLaunch();
    const intent = intentOf(launch, din.app.opener, wasReopened());
    if (!intent || ranIntent.current === launch.params.nonce) return;
    ranIntent.current = launch.params.nonce;
    runIntent(intent);
  }, [din, runIntent]);

  useOnLaunch((launch) => {
    const intent = intentOf(launch, din.app.opener);
    if (intent) {
      if (ranIntent.current === launch.params.nonce) return;
      ranIntent.current = launch.params.nonce;
      runIntent(intent);
      return;
    }
    const { sessionID, directory, focusPassword, speakReply, terminal, project } = launchRequest(launch);
    if (terminal) {
      setState((prev) => withTerminal(sessionID ? showSession(prev, sessionID) : prev, sessionID, terminal === 'show'));
      return;
    }
    if (project) {
      setState((prev) => showProject(prev, project));
      return;
    }
    if (sessionID && speakReply) speakNextReply(sessionID, Number(launch.params.nonce) || Date.now());
    setPasswordFocus((prev) => (sessionID && focusPassword ? { sessionID, key: (prev?.key ?? 0) + 1 } : null));
    setState((prev) => (sessionID ? showSession(prev, sessionID) : placeTab(prev, newAssistantTab(null, directory))));
  });

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

  // Din follows what's open in tabs: the desktop says when one finishes out of sight.
  useEffect(() => {
    for (const sessionID of sessionIDs) followDinSession(sessionID);
  }, [sessionIDs]);

  // Busy while it works, or a command or subagent it started still runs.
  const work = useAssistantWork(sessions.flatMap((s) => (s.session ? [s.session.location.directory] : [])));
  const pending = usePendingRequests();
  const unread = useUnreadSessions();
  const waiting = new Set(
    [...pending.permissions, ...pending.forms, ...pending.passwords].map((request) => request.sessionID),
  );
  // Stable while nothing shown changes, so the title bar isn't republished on every render.
  const infoKey = JSON.stringify(
    tabs.map((tab): TabInfo => {
      if (!tab.sessionID) {
        return tab.project && tab.directory
          ? { id: tab.id, title: directoryName(tab.directory, home), state: 'project', directory: tab.directory }
          : { id: tab.id, title: 'New conversation', state: 'new' };
      }
      const session = sessions[sessionIDs.indexOf(tab.sessionID)]?.session;
      const kind = workKind(work, tab.sessionID);
      return {
        id: tab.id,
        title: session ? sessionTitle(session) : 'Loading…',
        state: waiting.has(tab.sessionID) ? 'waiting' : kind === 'agent' ? 'running' : kind ? 'background' : 'idle',
        commands: kind === 'commands' ? commandsUnder(work, tab.sessionID).length : undefined,
        directory: session?.location.directory,
        unread: unread.has(tab.sessionID) || undefined,
      };
    }),
  );
  const stripTabs = useMemo((): TabInfo[] => JSON.parse(infoKey), [infoKey]);
  const icons = useDirectoryIcons([...new Set(stripTabs.flatMap((t) => (t.directory ? [t.directory] : [])))]);
  // Din's title bar while there's only a message to show; the app's own, with its tabs, once it's up.
  const ownHeader = ready || !status;
  useEffect(() => din.window.setChrome({ frame: ownHeader ? 'custom' : 'standard' }), [din, ownHeader]);
  useWindowTitle(activeTab.sessionID || activeTab.project ? (stripTabs.find((t) => t.id === activeTab.id)?.title ?? null) : null);

  // The folder the selected tab's conversation works in, whose repository the Git panel shows.
  const activeDirectory = activeTab.sessionID
    ? sessions[sessionIDs.indexOf(activeTab.sessionID)]?.session?.location.directory
    : (activeTab.directory ?? defaultDirectory);

  // The pages the selected conversation's agent previewed. One it shows now
  // opens the pane on its tab (sliding it over a narrow window's
  // conversation), or reloads the tab it has.
  const { data: activeTranscript } = useSessionMessages(activeTab.sessionID ?? null);
  const { previews, close: closePreview, reopen: reopenPreview } = useSessionPreviews(activeTab.sessionID ?? null, activeTranscript?.messages, (preview: Preview) => {
    setSideTab(preview.uri);
    reloadPreview(preview.uri);
    setGitShown(true);
  });
  /** A preview's card in the transcript: its tab, brought back if it was closed. */
  const showPreview = (uri: string) => {
    reopenPreview(uri);
    setSideTab(uri);
    setGitShown(true);
  };
  const shownTab: SideTab = sideTab !== 'git' && previews.some((p) => p.uri === sideTab) ? sideTab : 'git';
  const gitTabShown = gitShown && shownTab === 'git';
  // Ctrl+Shift+G, the branch under the composer and the menu: Git, in the pane.
  const toggleGit = () => {
    if (gitTabShown) setGitShown(false);
    else {
      setSideTab('git');
      setGitShown(true);
    }
  };

  const select = (id: string) => setState((prev) => ({ ...prev, activeId: id }));

  // Each tab's terminal, at the bottom of the content pane: shown while its
  // tab is selected and its `terminal` is on, its shell started when it first
  // shows and running, hidden or not, until it ends or its tab closes.
  const paneRef = useRef<HTMLElement>(null);
  const shownTerminal = activeTab.terminal ? activeTab.id : null;
  const [terminalsRunning, setTerminalsRunning] = useState<ReadonlySet<string>>(new Set());
  const tabDirectory = (tab: AssistantTab) =>
    tab.sessionID ? sessions[sessionIDs.indexOf(tab.sessionID)]?.session?.location.directory : (tab.directory ?? defaultDirectory);
  // Where it starts must be known first, or it would start in the home folder.
  if (shownTerminal && !terminalsRunning.has(shownTerminal) && tabDirectory(activeTab)) {
    setTerminalsRunning(new Set([...terminalsRunning, shownTerminal]));
  }
  const terminals = tabs.flatMap((tab) => (terminalsRunning.has(tab.id) ? [{ id: tab.id, directory: tabDirectory(tab) }] : []));
  /** The keyboard back to the composer, when it was in a terminal that's going away. */
  const leaveTerminal = () => {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !focused.closest(`[${TERMINAL_ATTRIBUTE}]`)) return;
    requestAnimationFrame(() => paneRef.current?.querySelector<HTMLTextAreaElement>('textarea:not(.xterm-helper-textarea)')?.focus());
  };
  // Ctrl+`, Ctrl+Shift+I and the folder under the composer.
  const toggleTerminal = () => {
    if (activeTab.terminal) leaveTerminal();
    setState((prev) => withTerminal(prev, null, !activeTab.terminal));
  };
  // Its shell ended, or Close Terminal.
  const closeTerminal = (id: string) => {
    if (id === shownTerminal) leaveTerminal();
    setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === id ? { ...t, terminal: false } : t)) }));
    setTerminalsRunning((running) => new Set([...running].filter((r) => r !== id)));
  };
  // A long command finished out of sight, and its notification was clicked.
  const revealTerminal = (id: string) => {
    setState((prev) => ({ activeId: id, tabs: prev.tabs.map((t) => (t.id === id ? { ...t, terminal: true } : t)) }));
    window.focus();
  };

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
      window.close();
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

  /** A project's page: a tile on a new tab, its heading in the list. */
  const openProject = (directory: string, behind = false) => {
    setState((prev) => showProject(prev, directory, behind));
    if (!behind) setListOpen(false);
  };

  const updateTab = (id: string, change: Partial<AssistantTab>) =>
    setState((prev) => ({ ...prev, tabs: prev.tabs.map((t) => (t.id === id ? { ...t, ...change } : t)) }));

  const started = (tab: AssistantTab, sessionID: string) => {
    forgetTabDraft(tab);
    updateTab(tab.id, { sessionID, project: undefined });
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
  // Renamed in its tab, while the conversation is open in one.
  const renamingTab = renaming ? tabs.find((t) => t.sessionID === renaming) : undefined;
  const renamingSession = renaming ? sessions[sessionIDs.indexOf(renaming)]?.session : undefined;

  const fork = useForkSession();
  /**
   * Fork a conversation into a tab beside its own: all of it, or what came
   * before `message`, which waits in the new one's composer (as in OpenCode).
   */
  const forkSession = (sessionID: string, message?: UserMessage) =>
    fork.mutate(
      { sessionID, before: message?.id },
      {
        onSuccess: (session) => {
          if (message) saveDraft(session.id, splitAttachedPaths(message.text).text, reattachable(message));
          setState((prev) => placeTab(prev, newAssistantTab(session.id)));
          setListOpen(false);
        },
        onError: (error) =>
          host.notify({ title: 'Couldn’t fork the conversation', description: cleanAssistantError(error), destructive: true }),
      },
    );

  const move = (id: string, to: number) => setState((prev) => ({ ...prev, tabs: moveItem(prev.tabs, id, to) }));

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
    // In a terminal, the shell has Ctrl+T, W, F, K and the digits (Ctrl+W
    // deletes a word, Ctrl+K the rest of the line, Ctrl+F moves on).
    const inTerminal = e.target instanceof Element && e.target.closest(`[${TERMINAL_ATTRIBUTE}]`) !== null;
    if ((key === '`' || e.code === 'Backquote') && !e.shiftKey) toggleTerminal();
    else if (key === 'i' && e.shiftKey) toggleTerminal();
    else if (inTerminal && !e.shiftKey && (/^[1-9]$/.test(key) || ['t', 'w', 'f', 'k'].includes(key))) return;
    else if (key === 't') {
      if (e.shiftKey) reopen();
      else openTab();
    } else if (key === 'w' && !e.shiftKey) closeTab(activeTab.id);
    else if (key === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if ((key === 'PageUp' || key === 'PageDown') && !e.shiftKey) cycle(key === 'PageUp' ? -1 : 1);
    else if (key === 'g' && e.shiftKey) toggleGit();
    else if (key === 'f' && !e.shiftKey && conversationRef.current) conversationRef.current.find();
    else if ((key === 'f' || key === 'k') && !e.shiftKey) {
      // Search the list, sliding it out first in a narrow window. Ctrl+F
      // does too in a new conversation, which has nothing to find in.
      setListOpen(true);
      requestAnimationFrame(() => searchRef.current?.select());
    } else if (/^[1-9]$/.test(key) && !e.shiftKey) select(tabs[key === '9' ? tabs.length - 1 : Math.min(Number(key), tabs.length) - 1].id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  // The side pane's width: Git's, or a page's.
  const previewShown = shownTab !== 'git';
  const sideWidth = previewShown ? previewWidth : gitWidth;
  const setSideWidth = (width: number) => (previewShown ? setPreviewWidth(clampPreviewWidth(width)) : setGitWidth(clampGitWidth(width)));
  const sideMin = previewShown ? MIN_PREVIEW_WIDTH : MIN_GIT_WIDTH;
  const sideMax = previewShown ? MAX_PREVIEW_WIDTH : MAX_LIST_WIDTH;

  /** Drag a sidebar's edge: the list's (`1`, growing rightward) or the side pane's (`-1`). */
  const startResize = (e: React.PointerEvent<HTMLDivElement>, side: 1 | -1 = 1) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = side === 1 ? listWidth : sideWidth;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      side === 1
        ? setListWidth(clampListWidth(startWidth + ev.clientX - startX))
        : setSideWidth(startWidth - (ev.clientX - startX));
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
      ref={rootRef}
      className="@container/assistant relative flex h-full w-full text-foreground"
      onKeyDownCapture={onKeyDown}
    >
      <SessionList
        selected={activeTab.sessionID}
        onSelect={choose}
        onOpenInNewTab={openInNewTab}
        onNew={startNew}
        onOpenProject={openProject}
        selectedProject={activeTab.project ? activeTab.directory : null}
        onFork={forkSession}
        onDeleted={(id) => removeSessions(new Set([id]))}
        unread={unread}
        menu={<AssistantMenu onAddProvider={addProvider} />}
        searchRef={searchRef}
        style={{ width: listWidth }}
        className={cn(
          listOpen ? 'flex' : 'hidden',
          'absolute inset-y-0 left-0 z-20 max-w-[85%] bg-background shadow-xl @2xl/assistant:static @2xl/assistant:bg-transparent @2xl/assistant:flex @2xl/assistant:max-w-none @2xl/assistant:shadow-none',
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
        className="z-30 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none @2xl/assistant:block"
      />
      {listOpen && (
        <button
          type="button"
          aria-label="Close the conversation list"
          className="absolute inset-0 z-10 bg-background/40 @2xl/assistant:hidden"
          onClick={() => setListOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The title bar over the conversation; the list has its own part of it. */}
        <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pl-2 pr-3">
          <ListToggle onClick={() => setListOpen(true)} />
          <TabStrip
            tabs={stripTabs.map((t) => ({
              id: t.id,
              title: t.title,
              icon: <TabIcon state={t.state} commands={t.commands} favicon={t.directory && icons.get(t.directory)} unread={t.unread} />,
            }))}
            activeId={activeId}
            label="Assistant tabs"
            newTabLabel="New conversation"
            newTabMenuLabel="New conversation"
            onActivate={select}
            onClose={closeTab}
            onNew={openTab}
            onMove={move}
            onReopen={closed.length > 0 ? reopen : undefined}
            moveWindow={tabs.length === 1 ? dinWindowMove(din) : undefined}
            tabMenuItems={(id) => {
              const sessionID = tabs.find((t) => t.id === id)?.sessionID;
              return (
                sessionID && (
                  <>
                    <ContextMenuItem onSelect={() => renameTab(id)}>Rename</ContextMenuItem>
                    <ContextMenuItem onSelect={() => forkSession(sessionID)}>Fork</ContextMenuItem>
                    <ContextMenuItem variant="destructive" onSelect={() => setDeleting(sessionID)}>
                      Delete
                    </ContextMenuItem>
                  </>
                )
              );
            }}
            onTabMenuCloseAutoFocus={(e) => {
              if (renamingFromMenu.current) e.preventDefault();
              renamingFromMenu.current = false;
            }}
            editing={
              renamingTab && renamingSession
                ? {
                    id: renamingTab.id,
                    editor: (
                      <ConversationTitleInput
                        session={renamingSession}
                        onDone={() => setRenaming(null)}
                        className="h-5 rounded-sm px-1 text-xs md:text-xs"
                      />
                    ),
                  }
                : null
            }
          />
          {/* In a window wide enough for it, the side pane can always be shown from here, as it was left. */}
          {wide && !gitShown && (
            <ToolButton label={previews.length > 0 ? 'Show Git and previews' : 'Show Git (Ctrl+Shift+G)'} onClick={() => setGitOpen(true)}>
              <PanelRightOpen className="size-4.5" strokeWidth={1.75} aria-hidden />
            </ToolButton>
          )}
          {/* With the side pane open, the window's controls are at its top instead. */}
          {!gitShown && <WindowControls />}
        </WindowDragRegion>
        <ContentPane
          ref={paneRef}
          inset={false}
          className={cn(
            '@2xl/assistant:mr-2 @2xl/assistant:mb-2 @2xl/assistant:rounded-2xl @2xl/assistant:border-t-0 @2xl/assistant:clay',
            // Beside the Git panel, it meets the panel, not the screen, at its right.
            gitShown
              ? '@5xl/assistant:mr-0 @max-5xl/assistant:[[data-screen-right]_&]:mr-0 @max-5xl/assistant:[[data-screen-right]_&]:rounded-tr-none @max-5xl/assistant:[[data-screen-right]_&]:rounded-br-none [[data-screen-bottom]_&]:mb-0 [[data-screen-bottom]_&]:rounded-bl-none [[data-screen-bottom]_&]:rounded-br-none'
              : flushPane,
          )}
        >
          <PreviewOpenContext value={showPreview}>
          {activeTab.sessionID ? (
            <Conversation
              key={activeTab.sessionID}
              ref={conversationRef}
              sessionID={activeTab.sessionID}
              passwordFocus={passwordFocus?.sessionID === activeTab.sessionID ? passwordFocus.key : undefined}
              onPasswordFocused={() => setPasswordFocus(null)}
              onRename={() => setRenaming(activeTab.sessionID)}
              onNew={startNew}
              onOpenSession={choose}
              onFork={(message) => activeTab.sessionID && forkSession(activeTab.sessionID, message)}
              onAddProvider={addProvider}
              gitOpen={gitTabShown}
              onToggleGit={toggleGit}
              terminalOpen={activeTab.terminal ?? false}
              onToggleTerminal={toggleTerminal}
            />
          ) : (
            <NewConversation
              key={activeTab.id}
              directory={activeTab.directory}
              project={activeTab.project ?? false}
              onDirectoryChange={(directory) => updateTab(activeTab.id, { directory, project: undefined })}
              onOpenProject={openProject}
              onOpenSession={choose}
              draftKey={newConversationDraftKey(activeTab.id)}
              onStarted={(sessionID) => started(activeTab, sessionID)}
              onAddProvider={addProvider}
              terminalOpen={activeTab.terminal ?? false}
              onToggleTerminal={toggleTerminal}
            />
          )}
          </PreviewOpenContext>
          <TerminalPanel terminals={terminals} shownId={shownTerminal} onClose={closeTerminal} onReveal={revealTerminal} container={paneRef} />
        </ContentPane>
      </div>
      {gitShown && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side pane"
            aria-valuenow={sideWidth}
            aria-valuemin={sideMin}
            aria-valuemax={sideMax}
            tabIndex={0}
            title="Drag to resize, double-click to reset"
            onPointerDown={(e) => startResize(e, -1)}
            onDoubleClick={() => setSideWidth(previewShown ? DEFAULT_PREVIEW_WIDTH : SIDEBAR_WIDTH)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft') setSideWidth(sideWidth + 16);
              else if (e.key === 'ArrowRight') setSideWidth(sideWidth - 16);
              else return;
              e.preventDefault();
            }}
            className="z-30 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none hover:bg-ring/40 focus-visible:bg-ring/60 focus-visible:outline-none @5xl/assistant:block"
          />
          {/* Narrower, it slides over the conversation, as the list does. */}
          <button
            type="button"
            aria-label="Hide the side pane"
            className="absolute inset-0 z-10 bg-background/40 @5xl/assistant:hidden"
            onClick={() => setGitShown(false)}
          />
          <SidePanel
            directory={activeDirectory}
            previews={previews}
            tab={shownTab}
            onTab={setSideTab}
            onClosePreview={closePreview}
            reloads={reloads}
            onReload={reloadPreview}
            onHide={() => setGitShown(false)}
            style={{ width: sideWidth }}
            className={cn(
              'absolute inset-y-0 right-0 z-20 bg-background shadow-xl @5xl/assistant:static @5xl/assistant:bg-transparent @5xl/assistant:shadow-none',
              // A page may be wide, but the conversation keeps room beside it.
              previewShown ? 'max-w-[92%] @5xl/assistant:max-w-[70%]' : 'max-w-[85%] @5xl/assistant:max-w-none',
            )}
          />
        </>
      )}
      <DeleteConversationDialog
        session={deleting ? sessions[sessionIDs.indexOf(deleting)]?.session : undefined}
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        onDeleted={() => deleting && removeSessions(new Set([deleting]))}
      />
    </div>
  );
}

/** The app’s menu, in the list’s title bar: Add Provider, and Settings → Assistant (providers among it) for the rest. */
function AssistantMenu({ onAddProvider }: { onAddProvider: () => void }) {
  const { openApp } = useAssistantHost();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolButton label="Assistant settings" title="Settings">
          <Settings className="size-4.5" strokeWidth={1.75} aria-hidden />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onAddProvider}>
          <Plus aria-hidden /> Add Provider…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openApp('settings', { section: 'assistant' })}>
          <Settings aria-hidden /> Assistant Settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A tab's icon: whether its conversation is working, running only commands
 * in the background, or waiting on the user, else a dot while it has unread
 * notifications, else its project's favicon, if it has one.
 */
function TabIcon({
  state,
  commands,
  favicon,
  unread,
}: {
  state: TabInfo['state'];
  commands?: number;
  favicon?: string;
  unread?: boolean;
}) {
  if (state === 'waiting' || (state === 'idle' && unread)) {
    return (
      <span className="grid size-3.5 place-items-center" aria-label={state === 'waiting' ? 'Waiting for you' : 'Unread notification'}>
        <span className="size-2 rounded-full bg-primary" />
      </span>
    );
  }
  switch (state) {
    case 'running':
      return <WorkIndicator kind="agent" />;
    case 'background':
      return <WorkIndicator kind="commands" commands={commands} />;
    case 'new':
      return <SquarePen className="size-3.5" aria-hidden />;
    case 'project':
      return <ProjectIcon src={favicon} fallback={<Folder className="size-3.5" aria-hidden />} />;
    default:
      return <ProjectIcon src={favicon} />;
  }
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

interface ConversationHandle {
  /** Open the find bar, or focus it if it's open. */
  find(): void;
}

function Conversation({
  ref,
  sessionID,
  passwordFocus,
  onPasswordFocused,
  onRename,
  onNew,
  onOpenSession,
  onFork,
  onAddProvider,
  gitOpen,
  onToggleGit,
  terminalOpen,
  onToggleTerminal,
}: {
  ref?: Ref<ConversationHandle>;
  sessionID: string;
  /** Put the cursor in its password request, when it has one (a notification asked to). */
  passwordFocus?: number;
  onPasswordFocused: () => void;
  /** Edit its title in its tab (/rename on its own). */
  onRename: () => void;
  onNew: (directory?: string) => void;
  /** Show another conversation (a subagent's) in its tab. */
  onOpenSession: (sessionID: string) => void;
  /** Fork it, whole or from before `message`. */
  onFork: (message?: UserMessage) => void;
  /** /connect: add an AI provider. */
  onAddProvider: () => void;
  /** The Git panel, which the branch under the composer shows. */
  gitOpen: boolean;
  onToggleGit: () => void;
  /** The terminal under it, which the folder under the composer shows. */
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
  const { data: session } = useAssistantSession(sessionID);
  const { data: transcript, isLoading, loadEarlier, loadingEarlier, earlierFailed } = useSessionMessages(sessionID);
  const { data: permissions = [] } = useSessionPermissions(sessionID);
  const { data: forms = [] } = useSessionForms(sessionID);
  const passwords = useSessionPasswords(sessionID);
  const composerRef = useQuestionHandoff(forms.length > 0);
  const { data: queued } = useSessionInbox(sessionID);
  const { data: active = [] } = useActiveSessions();
  const { models, setModel } = usePreferredModel();
  const sessionModel = session?.model && models.find((m) => modelKey(m) === modelKey(session.model!));
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
  const undo = useUndoMessage();
  const redo = useRedoMessages();
  const { notify } = useAssistantHost();
  const [forking, setForking] = useState(false);
  const [finding, setFinding] = useState(false);
  const findBarRef = useRef<FindBarHandle>(null);
  const composer = useRef<ComposerHandle>(null);
  const running = active.includes(sessionID);
  // What /undo took away stays on the server until Redo or the next message; it isn't shown.
  const revert = session?.revert;
  const { messages, undone } = useMemo(() => {
    const all = transcript?.messages;
    const at = revert && all ? all.findIndex((m) => m.id === revert.messageID) : -1;
    if (!all || at === -1) return { messages: all, undone: 0 };
    return { messages: all.slice(0, at), undone: all.slice(at).filter((m) => m.type === 'user').length };
  }, [transcript?.messages, revert]);
  const secretRequests = useSecretRequests(sessionID, messages);
  // Undone messages' secrets too: the conversation still has them.
  const givenSecrets = useGivenSecretNames(transcript?.messages);
  const commands = useSlashCommands(session?.location.directory, revert ? UNDONE_COMMANDS : CONVERSATION_COMMANDS);
  const directory = session?.location.directory;
  const fileLinkBase = useMemo(() => ({ directory, home }), [directory, home]);
  useMarkViewedSession(sessionID);

  // What it started that still runs: the calls that started it keep
  // spinning, and what it isn't waiting on shows above the composer.
  const work = useAssistantWork(directory ? [directory] : []);
  const tasks = tasksOf(work, sessionID);
  const taskIDs = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const inBackground = useSettled(
    useMemo(() => backgroundOnly(tasks, messages), [tasks, messages]),
    BACKGROUND_SETTLE_MS,
  );
  const killShell = useKillShell();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  /** Stop a task, and with a subagent, whatever it left running too. */
  const stopTask = (task: BackgroundTask) => {
    const all: BackgroundTask[] = [];
    const collect = (t: BackgroundTask) => {
      all.push(t);
      if (t.kind === 'subagent') tasksOf(work, t.id).forEach(collect);
    };
    collect(task);
    setStopping((prev) => new Set([...prev, task.id]));
    void Promise.all(
      all.map((t) =>
        t.kind === 'shell'
          ? killShell.mutateAsync({ directory: t.directory, shellID: t.id })
          : interrupt.mutateAsync(t.id),
      ),
    )
      .catch(fail(task.kind === 'shell' ? 'Couldn’t stop the command' : 'Couldn’t stop the subagent'))
      .finally(() =>
        setStopping((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        }),
      );
  };

  // Follow the conversation down as it grows, unless the user scrolled up.
  // Coming back to its tab finds it where it was left.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [left] = useState(() => scrollPositions.get(sessionID));
  const stick = useRef(left?.stuck ?? true);
  const [stuck, setStuck] = useState(left?.stuck ?? true);
  const restoreTop = useRef(left && !left.stuck ? left.top : null);
  // Set during a smooth jump to the bottom, so the scrolls on the way don't
  // bring the button back.
  const jumping = useRef(false);
  const markSeen = useMarkSeenSession(sessionID, scrollRef);
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setStuck(true);
    jumping.current = true;
    const smooth = !prefersReducedMotion();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    el.focus({ preventScroll: true });
  };
  // Earlier messages go in above what's on screen, which stays put, unless
  // Home asked for the very top. `prepending` is kept current (scrolling and
  // messages coming in below move it) until they arrive.
  const firstID = messages?.[0]?.id;
  const prepending = useRef<{ first: string | undefined; top: number; height: number } | null>(null);
  const toTop = useRef(false);
  const showEarlier = useCallback(
    (all = false) => {
      const el = scrollRef.current;
      if (el) prepending.current = { first: firstID, top: el.scrollTop, height: el.scrollHeight };
      void loadEarlier(all).catch((error: unknown) =>
        notify({ title: 'Couldn’t load earlier messages', description: cleanAssistantError(error), destructive: true }),
      );
    },
    [firstID, loadEarlier, notify],
  );
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const before = prepending.current;
    if (!el || !before) return;
    if (firstID !== before.first && !stick.current) {
      el.scrollTop = toTop.current ? 0 : before.top + (el.scrollHeight - before.height);
    }
    // Loading all of them brings several pages.
    prepending.current = { first: firstID, top: el.scrollTop, height: el.scrollHeight };
  }, [firstID, messages, queued, permissions.length, forms.length, passwords.length, secretRequests.length, running]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (restoreTop.current !== null && messages) {
      el.scrollTop = restoreTop.current;
      restoreTop.current = null;
    }
  }, [messages, queued, permissions.length, forms.length, passwords.length, secretRequests.length, running]);

  useImperativeHandle(ref, () => ({
    find: () => {
      setFinding(true);
      findBarRef.current?.focus();
      // Find looks through the whole conversation.
      if (transcript?.more) showEarlier(true);
    },
  }));

  const closeFind = () => {
    setFinding(false);
    scrollRef.current?.focus({ preventScroll: true });
  };

  const fail = (title: string) => (error: unknown) =>
    notify({ title, description: cleanAssistantError(error), destructive: true });

  // Talking with it: a call, and its replies read aloud.
  const call = useCall({
    sessionID,
    running,
    send: (text) => {
      stick.current = true;
      return send.mutateAsync({ text, files: [] }, { onError: fail('Couldn’t send what you said') });
    },
  });
  const onCall = call?.active ?? false;
  useReplyVoice({ sessionID, messages, call: onCall });

  // The one being switched to, so a quick second Shift+Tab goes on from there.
  const agent = (switchAgent.isPending ? switchAgent.variables?.agent : session?.agent) ?? 'build';
  const changeAgent = (agent: string) => switchAgent.mutate({ sessionID, agent }, { onError: fail('Couldn’t switch') });
  const cycleAgent = useCycleAgent(agent, changeAgent);

  const toBackground = () => background.mutate(sessionID, { onError: fail('Couldn’t move it to the background') });

  // As in OpenCode's TUI: a message still waiting is just taken back; otherwise
  // the conversation goes back to before the last one, and it's back in the
  // composer to edit and send again.
  const undoLast = async () => {
    const waiting = queued?.at(-1);
    if (waiting) {
      await cancelQueued.mutateAsync({ sessionID, id: waiting.id }, { onError: fail('Couldn’t undo') });
      composer.current?.fill(waiting.payload.text);
      return;
    }
    const last = messages?.findLast((m): m is UserMessage => m.type === 'user' && !!m.text.trim());
    if (!last) return notify({ title: 'Nothing to undo' });
    await undo.mutateAsync({ sessionID, messageID: last.id, running }, { onError: fail('Couldn’t undo') });
    composer.current?.fill(last.text, reattachable(last));
  };

  const redoAll = () => redo.mutateAsync(sessionID, { onError: fail('Couldn’t redo') });

  const runCommand = (name: string, args: string, files: PromptAttachment[]) => {
    stick.current = true;
    switch (name) {
      case 'compact':
        return compact.mutateAsync(sessionID, { onError: fail('Couldn’t compact the conversation') });
      case 'new':
        return onNew(session?.location.directory);
      case 'connect':
        return onAddProvider();
      case 'fork':
        return setForking(true);
      case 'rename':
        if (!args) return onRename();
        return rename.mutateAsync({ sessionID, title: args }, { onError: fail('Couldn’t rename') });
      case 'stop':
        return interrupt.mutateAsync(sessionID, { onError: fail('Couldn’t stop') });
      case 'undo':
        return undoLast();
      case 'redo':
        return redoAll();
      default:
        return send.mutateAsync({ command: name, text: args, files }, { onError: fail(`Couldn’t run /${name}`) });
    }
  };

  return (
    // Focusable so Ctrl+B still reaches it after a click in the transcript.
    <div
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
      // Seeing how it ended, with the window already on this tab.
      onPointerMove={markSeen}
      onWheel={markSeen}
      onKeyDown={(event) => {
        if (event.key.toLowerCase() !== 'b' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
        if (!running) return;
        event.preventDefault();
        toBackground();
      }}
    >
      <ForkDialog messages={messages ?? []} open={forking} onOpenChange={setForking} onFork={onFork} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Focusable so arrow keys, Page Up/Down, Home and End scroll it after a click. */}
        <div
          ref={scrollRef}
          tabIndex={-1}
          onKeyDown={(e) => {
            markSeen();
            // Home goes to the start of the conversation, not of what's loaded.
            if (e.key !== 'Home' || e.altKey || e.metaKey || e.shiftKey || !transcript?.more) return;
            toTop.current = true;
            showEarlier(true);
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (prepending.current) prepending.current = { ...prepending.current, top: el.scrollTop, height: el.scrollHeight };
            if (el.scrollTop > 0) toTop.current = false;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
            if (jumping.current && !bottom) return;
            jumping.current = false;
            stick.current = bottom;
            setStuck(bottom);
            scrollPositions.set(sessionID, { top: el.scrollTop, stuck: bottom });
          }}
          onScrollEnd={(e) => {
            if (!jumping.current) return;
            // Cut short, by a wheel or a key.
            jumping.current = false;
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
            setStuck(stick.current);
          }}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
        >
          <div className="mx-auto w-full max-w-3xl px-4 py-6 @2xl/assistant:px-6">
            {isLoading && !messages ? (
              <TranscriptSkeleton />
            ) : (
              <>
                {transcript?.more && (
                  <LoadMore
                    scrollRef={scrollRef}
                    edge="top"
                    loaded={messages?.length ?? 0}
                    loading={loadingEarlier}
                    failed={earlierFailed}
                    onLoad={showEarlier}
                    label="Show earlier messages"
                    loadingLabel="Loading earlier messages…"
                    className="mb-6"
                  />
                )}
                <FileLinkBaseContext value={fileLinkBase}>
                  <Transcript
                    messages={messages ?? []}
                    queued={queued}
                    running={running}
                    tasks={taskIDs}
                    home={home}
                    onCancelQueued={(message) =>
                      cancelQueued.mutate({ sessionID, id: message.id }, { onError: fail('Couldn’t cancel') })
                    }
                    onSendNow={
                      running && inBackground.length < tasks.length && !background.isPending ? toBackground : undefined
                    }
                    onFork={onFork}
                    workElsewhere={running && inBackground.length > 0}
                  />
                  {revert && undone > 0 && (
                    <UndoneNotice count={undone} files={revert.files ?? []} busy={redo.isPending} onRedo={redoAll} />
                  )}
                </FileLinkBaseContext>
              </>
            )}
          </div>
        </div>
        {finding && <FindBar ref={findBarRef} scrollRef={scrollRef} onClose={closeFind} />}
        {!stuck && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Jump to the bottom"
            title="Jump to the bottom"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 size-9 -translate-x-1/2 rounded-full bg-background shadow-md motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-90"
          >
            <ArrowDown />
          </Button>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-2 @2xl/assistant:px-6">
        <BackgroundTasks
          tasks={inBackground}
          working={running ? (messages ?? []) : undefined}
          stopping={stopping} onOpen={onOpenSession} onStop={stopTask} />
        {permissions.map((request) => (
          <PermissionCard key={request.id} request={request} />
        ))}
        {forms.map((form) => (
          <FormCard key={form.id} form={form} />
        ))}
        {passwords.map((request, i) => (
          <PasswordCard
            key={request.requestId}
            request={request}
            focusKey={i === 0 ? passwordFocus : undefined}
            onFocused={onPasswordFocused}
          />
        ))}
        {secretRequests.map((request) => (
          <SecretRequestCard key={request.callID} request={request} />
        ))}
        {onCall && forms.length === 0 && <CallBar call={call!} />}
        <div ref={composerRef} hidden={forms.length > 0 || onCall}>
          <Composer
            ref={composer}
            autoFocus
            draftKey={sessionID}
            secrets
            givenSecrets={givenSecrets}
            onCall={call?.start}
            running={running}
            busy={send.isPending || compact.isPending || undo.isPending || redo.isPending}
            placeholder={running ? 'Add something while it works…' : 'Reply, or type / for commands…'}
            onSubmit={(text, files, { spoken }) => {
              stick.current = true;
              if (spoken) speakNextReply(sessionID);
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
                    // The thinking level carries over, where the new model has it.
                    const ref = modelRef(model, supportedVariant(model, session?.model?.variant) ?? DEFAULT_VARIANT);
                    setModel(ref);
                    switchModel.mutate({ sessionID, model: ref }, { onError: fail('Couldn’t switch models') });
                  }}
                />
                <AgentPicker value={agent} onChange={changeAgent} />
                <ThinkingPicker
                  model={sessionModel}
                  value={session?.model?.variant}
                  onChange={(variant) => {
                    if (!session?.model) return;
                    const ref = modelRef(session.model, variant ?? DEFAULT_VARIANT);
                    setModel(ref);
                    switchModel.mutate({ sessionID, model: ref }, { onError: fail('Couldn’t change how hard it thinks') });
                  }}
                />
              </>
            }
            onCycleAgent={cycleAgent}
          />
        </div>
        {session && (
          <StatusLine
            session={session}
            home={home}
            context={messages ? contextUsage(messages, models) : null}
            gitOpen={gitOpen}
            onToggleGit={onToggleGit}
            terminalOpen={terminalOpen}
            onToggleTerminal={onToggleTerminal}
          />
        )}
      </div>
    </div>
  );
}

/** Below the transcript after /undo: what was taken back, and Redo. */
function UndoneNotice({
  count,
  files,
  busy,
  onRedo,
}: {
  count: number;
  files: FileDiff[];
  busy: boolean;
  onRedo: () => unknown;
}) {
  return (
    <div className="mt-6 bg-foreground/[0.04] rounded-xl px-4 py-3 text-sm">
      <div className="flex items-center gap-3">
        <Undo2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="min-w-0 flex-1">
          {count === 1 ? 'Undid a message' : `Undid ${count} messages`}
          {files.length > 0 && ` and the changes to ${files.length === 1 ? 'a file' : `${files.length} files`}`}.{' '}
          <span className="text-muted-foreground">Sending a message makes it final.</span>
        </p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void onRedo()} className="shrink-0">
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Redo2 aria-hidden />}
          Redo
        </Button>
      </div>
      {files.length > 0 && (
        <ul className="mt-2 space-y-0.5 pl-7 font-mono text-xs text-muted-foreground">
          {files.map((file) => (
            <li key={file.file} className="flex gap-2">
              <span className="min-w-0 truncate" title={file.file}>
                {file.file}
              </span>
              {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
              {file.deletions > 0 && <span className="text-destructive">−{file.deletions}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Under the composer, quietly: where the conversation works, which shows
 * its terminal; its branch, which shows Git; and what it has cost and how
 * full the model's context is.
 */
function StatusLine({
  session,
  home,
  context,
  gitOpen,
  onToggleGit,
  terminalOpen,
  onToggleTerminal,
}: {
  session: SessionInfo;
  home?: string;
  context: number | null;
  gitOpen: boolean;
  onToggleGit: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
  const cost = formatCost(session.cost);
  const usage = context !== null ? formatContextUsage(context) : null;
  const directory = session.location.directory;
  return (
    <div className="flex h-4 items-center gap-3 px-1 text-xs text-muted-foreground">
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          onClick={onToggleTerminal}
          aria-pressed={terminalOpen}
          title={`${terminalOpen ? 'Hide' : 'Show'} the terminal in ${directory} (Ctrl+\` or Ctrl+Shift+I)`}
          className={cn(
            'inline-flex h-4 min-w-0 shrink items-center gap-1 rounded-full px-1 hover:text-foreground',
            focusRing,
            terminalOpen && 'text-foreground',
          )}
        >
          <SquareTerminal className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{tildify(directory, home)}</span>
        </button>
        <GitBranchChip directory={directory} open={gitOpen} onToggle={onToggleGit} />
      </span>
      {(cost || usage) && (
        <span
          className={cn('shrink-0 tabular-nums', context !== null && context >= 0.8 && 'text-warning')}
          title={[cost && `${cost} so far`, usage && `${usage} of the model’s context window`].filter(Boolean).join(' · ')}
          aria-label={[cost && `${cost} so far`, usage && `${usage} of the model’s context window`].filter(Boolean).join(', ')}
        >
          {[cost, usage].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  );
}

function ListToggle({ onClick }: { onClick: () => void }) {
  return (
    <ToolButton label="Show conversations" className="@2xl/assistant:hidden" onClick={onClick}>
      <PanelLeft className="size-4.5" strokeWidth={1.75} aria-hidden />
    </ToolButton>
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

/**
 * A new conversation's tab: which project it's for, chosen in the composer
 * or from the tiles of the projects worked in lately, which open a
 * project's page; or that page itself (`project`), with the project's
 * conversations and statistics under the composer. Both end with the
 * Terminal, a shell in the folder at the bottom of the tab.
 */
function NewConversation({
  directory,
  project,
  onDirectoryChange: setDirectory,
  onOpenProject,
  onOpenSession,
  draftKey,
  onStarted,
  onAddProvider,
  terminalOpen,
  onToggleTerminal,
}: {
  /** The folder it works in; null for the default one. */
  directory: string | null;
  /** It's the page of the project in `directory`. */
  project: boolean;
  onDirectoryChange: (directory: string) => void;
  /** Show a project's page, here or (`behind`) in a tab of its own. */
  onOpenProject: (directory: string, behind?: boolean) => void;
  onOpenSession: (sessionID: string) => void;
  draftKey: string;
  onStarted: (id: string) => void;
  /** /connect: add an AI provider. */
  onAddProvider: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}) {
  const defaultDirectory = useAssistantDirectory();
  const home = useHomeDirectory();
  const [agent, setAgent] = useState('build');
  const cycleAgent = useCycleAgent(agent, setAgent);
  const { model, variant, setModel, setVariant, models } = usePreferredModel();
  const { data: recent } = useRecentModelKeys();
  const start = useStartConversation();
  const { notify, pickFolder } = useAssistantHost();
  const folder = directory ?? defaultDirectory;
  const commands = useSlashCommands(folder, NEW_COMMANDS);
  const recentFolders = useRecentFolders();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const callRef = useRef<ReturnType<typeof useCall>>(null);
  const begin = (text: string, files: PromptAttachment[] = [], command?: string, spoken = false) => {
    const sent = Date.now();
    return start.mutateAsync(
      { text, files, model, agent, directory: folder, command },
      {
        onSuccess: (session) => {
          if (spoken) speakNextReply(session.id, sent);
          // A call goes on in the conversation its first words started.
          const call = callRef.current;
          if (call?.active) carryCall(session.id, call.startedAt);
          onStarted(session.id);
        },
        onError: (error) =>
          notify({ title: 'Couldn’t start the conversation', description: cleanAssistantError(error), destructive: true }),
      },
    );
  };
  // Words said while the first ones start the conversation wait for it: they'd start another.
  const call = useCall({
    running: start.isPending,
    send: (text) => (start.isPending ? Promise.reject(new Error('Starting')) : begin(text, [], undefined, true)),
  });
  useEffect(() => {
    callRef.current = call;
  });

  /** The folder chosen, and the cursor back in the message. */
  const choose = (picked: string) => {
    setDirectory(picked);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const chooseFolder = async () => {
    const picked = await pickFolder({ title: 'Work in a folder', confirmLabel: 'Choose', initialPath: folder }).catch(() => null);
    if (picked) choose(picked);
  };
  const name = folder ? directoryName(folder, home) : 'this project';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 @2xl/assistant:px-6">
        <div className={cn('flex flex-col gap-6', project ? 'pt-12 pb-8' : 'flex-1 justify-center py-10')}>
          {project && folder ? (
            <ProjectHeading directory={folder} home={home} />
          ) : (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="relative">
                <div aria-hidden className="absolute inset-2 rounded-full bg-primary/25 blur-2xl motion-safe:animate-pulse" />
                <img {...bundledIconProps('/icons/apps/assistant.png')} alt="" className="relative size-24 object-contain drop-shadow-sm" />
              </div>
              <h1 className="font-[family-name:var(--font-title)] text-4xl font-semibold tracking-tight">Which project?</h1>
            </div>
          )}
          {call?.active && <CallBar call={call} />}
          <Composer
            autoFocus
            draftKey={draftKey}
            secrets
            textareaRef={textareaRef}
            className={call?.active ? 'hidden' : undefined}
            onCall={call?.start}
            busy={start.isPending}
            placeholder={project ? `Ask something about ${name}…` : 'Ask the assistant to do something…'}
            onSubmit={(text, files, { spoken }) => begin(text, files, undefined, spoken)}
            commands={commands}
            onCommand={(command, args, files) => (command === 'connect' ? onAddProvider() : begin(args, files, command))}
            header={
              !project && (
                <div className="border-b border-foreground/[0.06] pb-1">
                  <FolderPicker value={folder} home={home} onChange={choose} onOther={() => void chooseFolder()}>
                    <ProjectField folder={folder} home={home} />
                  </FolderPicker>
                </div>
              )
            }
            toolbar={
              <>
                <ModelPicker models={models} value={model} recent={recent} onChange={setModel} />
                <AgentPicker value={agent} onChange={setAgent} />
                <ThinkingPicker model={model} value={variant} onChange={setVariant} />
              </>
            }
            onCycleAgent={cycleAgent}
          />
          {!project && (
            <ProjectTiles
              folders={recentFolders}
              home={home}
              onOpen={onOpenProject}
              onNew={choose}
            />
          )}
        </div>
        {project && folder && <ProjectOverview directory={folder} home={home} onOpenSession={onOpenSession} />}
        {/* Clear of the screen's bottom edge, where the pointer would bring up the Dock. */}
        <div className="flex shrink-0 justify-center pt-8 pb-12">
          <button
            type="button"
            onClick={onToggleTerminal}
            aria-pressed={terminalOpen}
            title={`${terminalOpen ? 'Hide' : 'Show'} the terminal${folder ? ` in ${tildify(folder, home)}` : ''} (Ctrl+\`)`}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
              focusRing,
              terminalOpen && 'text-foreground',
            )}
          >
            <SquareTerminal className="size-4.5" strokeWidth={1.75} aria-hidden />
            Terminal
          </button>
        </div>
      </div>
    </div>
  );
}

/** The composer's top on a new tab: the project it's for, which picks another. */
function ProjectField({ folder, home, ...props }: ComponentProps<'button'> & { folder: string | undefined; home: string | undefined }) {
  const icon = useProjectIcons(folder ? [folder] : []).get(folder ?? '');
  const name = folder ? directoryName(folder, home) : 'Home';
  return (
    <button
      type="button"
      {...props}
      aria-label={`Project: ${name}. Choose another`}
      className={cn(
        'group flex h-12 w-full min-w-0 items-center gap-3 rounded-xl px-2 text-left hover:bg-foreground/5 aria-expanded:bg-foreground/5',
        focusRing,
      )}
    >
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-background clay">
        <ProjectIcon src={icon} className="size-5" fallback={<Folder className="size-4.5 text-ink-accent" strokeWidth={1.75} />} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold leading-tight">{name}</span>
        {folder && <span className="truncate text-xs text-muted-foreground">{tildify(folder, home)}</span>}
      </span>
      <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
    </button>
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

/**
 * How long a task must stay out of the transcript's running calls before it
 * shows as in the background. The list of running commands and the messages
 * update apart, so a command the agent waits on can look like neither for a
 * moment as it starts and ends.
 */
const BACKGROUND_SETTLE_MS = 1000;

/** Of `tasks`, the ones that have been in them for `ms`. */
function useSettled<T extends { id: string }>(tasks: T[], ms: number): T[] {
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  const ids = tasks.map((task) => task.id).join('\n');
  useEffect(() => {
    if (!ids) return;
    const timer = setTimeout(() => setSettled(new Set(ids.split('\n'))), ms);
    return () => clearTimeout(timer);
  }, [ids, ms]);
  return useMemo(() => tasks.filter((task) => settled.has(task.id)), [tasks, settled]);
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

/**
 * Every folder a conversation has worked in that's still there, loaded once
 * `enabled`, most recent first; a worktree counts as its main checkout.
 */
function useAllFolders(enabled: boolean): { folders: string[]; loading: boolean } {
  const { data, isPending } = useSessionFolders(enabled);
  const directories = useMemo(() => data ?? [], [data]);
  const mains = useMainCheckouts(directories);
  const folders = useMemo(() => [...new Set(directories.map((d) => mains.get(d) ?? d))], [directories, mains]);
  return { folders, loading: enabled && isPending };
}

/**
 * The folder a new conversation works in: a recent one, any folder a
 * conversation has worked in or any project in ~/Projects found by
 * searching, or another from the file picker.
 */
function FolderPicker({
  value,
  home,
  onChange,
  onOther,
  children,
}: {
  value: string | undefined;
  home: string | undefined;
  onChange: (directory: string) => void;
  onOther: () => void;
  /** What opens it. */
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searching = search.trim().length > 0;
  const recent = useRecentFolders();
  // Loaded as it opens, so the search has them by the time anything's typed.
  const all = useAllFolders(open);
  const { data: projectFolders } = useProjectFolders(open);
  const folders = useMemo(() => {
    const listed = value && !recent.includes(value) ? [value, ...recent] : recent;
    return searching ? [...new Set([...listed, ...all.folders])] : listed;
  }, [value, recent, searching, all.folders]);
  // The projects in ~/Projects no conversation has worked in, found by searching too.
  const projects = useMemo(() => {
    if (!searching || !projectFolders) return [];
    const listed = new Set(folders);
    return projectFolders.filter((folder) => !listed.has(folder));
  }, [searching, projectFolders, folders]);

  const pick = (folder: string) => {
    setOpen(false);
    setSearch('');
    onChange(folder);
  };

  const item = (folder: string) => (
    <CommandItem
      key={folder}
      value={folder}
      keywords={[directoryName(folder, home)]}
      onSelect={() => pick(folder)}
      title={folder}
      className="cursor-pointer gap-2"
    >
      <Check className={cn('size-4 shrink-0', folder === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate font-medium">{directoryName(folder, home)}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{tildify(folder, home)}</span>
      </span>
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <Command>
          <CommandInput placeholder="Search projects and folders…" value={search} onValueChange={setSearch} className="h-9" />
          <CommandList className="max-h-80">
            <CommandEmpty className="py-4 text-center text-sm text-muted-foreground">
              {all.loading ? 'Looking through your conversations…' : 'No project or conversation’s folder is like that.'}
            </CommandEmpty>
            {folders.length > 0 && (
              <CommandGroup heading={searching ? 'Folders conversations worked in' : 'Recent folders'}>
                {folders.map(item)}
              </CommandGroup>
            )}
            {projects.length > 0 && <CommandGroup heading="Projects">{projects.map(item)}</CommandGroup>}
            {searching && all.loading && folders.length > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden /> Looking through your conversations…
              </div>
            )}
            <CommandSeparator alwaysRender />
            <CommandGroup forceMount>
              <CommandItem
                value="__other_folder__"
                forceMount
                onSelect={() => {
                  setOpen(false);
                  setSearch('');
                  onOther();
                }}
                className="cursor-pointer gap-2"
              >
                <FolderOpen className="size-4" aria-hidden /> Other folder…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
