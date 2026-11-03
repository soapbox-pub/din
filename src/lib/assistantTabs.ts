import { z } from 'zod';
import type { PromptAttachment } from '@/lib/assistant';

/**
 * The Assistant's tabs, kept across closing its window and across restarts,
 * the way the browser keeps its own (see browserSession). The Assistant has
 * one window, so there is one list.
 */

/** One tab: a conversation, or a new one not yet started (`sessionID` null). */
export interface AssistantTab {
  id: string;
  sessionID: string | null;
  /** Where a new conversation will work; null for the default folder. */
  directory: string | null;
}

export interface SavedAssistantTabs {
  tabs: AssistantTab[];
  /** Index of the selected tab. */
  active: number;
}

const savedSchema: z.ZodType<SavedAssistantTabs> = z.object({
  tabs: z.array(z.object({ id: z.string(), sessionID: z.string().nullable(), directory: z.string().nullable() })),
  active: z.number().int(),
});

const TABS_KEY = 'din.assistant.tabs';

export function newAssistantTab(sessionID: string | null = null, directory: string | null = null): AssistantTab {
  return { id: crypto.randomUUID(), sessionID, directory };
}

export function loadAssistantTabs(): SavedAssistantTabs | null {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const parsed = savedSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.tabs.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveAssistantTabs(tabs: AssistantTab[], activeId: string): void {
  try {
    if (tabs.length === 0) {
      localStorage.removeItem(TABS_KEY);
      return;
    }
    const saved: SavedAssistantTabs = { tabs, active: Math.max(0, tabs.findIndex((t) => t.id === activeId)) };
    localStorage.setItem(TABS_KEY, JSON.stringify(saved));
  } catch (error) {
    console.warn(`Failed to save ${TABS_KEY} to localStorage:`, error);
  }
}

/** Where the composer keeps unsent text under `key`. */
export function draftStorageKey(key: string): string {
  return `din.assistant.draft.${key}`;
}

/** Put text (and files) in the composer under `key`, for when it next shows. */
export function saveDraft(key: string, text: string, files: PromptAttachment[] = []): void {
  try {
    if (text) localStorage.setItem(draftStorageKey(key), text);
  } catch {
    // Full or unavailable: the composer starts empty.
  }
  if (files.length > 0) saveDraftFiles(key, files);
}

/*
 * The files attached to an unsent message. Pasted pictures are data: URLs
 * too big for localStorage, so they go in IndexedDB; localStorage keeps only
 * a mark that there are some, for isBlankTab to see at once.
 */

const FILES_DB = 'din-assistant-drafts';
const FILES_STORE = 'files';

function draftFilesMarkKey(key: string): string {
  return `din.assistant.draft-files.${key}`;
}

let openingFiles: Promise<IDBDatabase> | null = null;

function filesDatabase(): Promise<IDBDatabase> {
  openingFiles ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(FILES_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FILES_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB wouldn’t open'));
  });
  openingFiles.catch(() => (openingFiles = null));
  return openingFiles;
}

function runFiles<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return filesDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(FILES_STORE, mode).objectStore(FILES_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
      }),
  );
}

const draftFilesSchema = z.array(z.object({ uri: z.string(), name: z.string().optional() }));

/** The files kept under `key`; none when there are none or they can't be read. */
export async function loadDraftFiles(key: string): Promise<PromptAttachment[]> {
  try {
    if (!localStorage.getItem(draftFilesMarkKey(key))) return [];
  } catch {
    return [];
  }
  const stored = await runFiles<unknown>('readonly', (store) => store.get(key)).catch(() => undefined);
  const parsed = draftFilesSchema.safeParse(stored);
  return parsed.success ? parsed.data : [];
}

/** Keep `files` under `key`, or forget them when there are none. */
export function saveDraftFiles(key: string, files: PromptAttachment[]): void {
  try {
    if (files.length > 0) localStorage.setItem(draftFilesMarkKey(key), '1');
    else localStorage.removeItem(draftFilesMarkKey(key));
  } catch {
    // Unavailable: they're still kept, just not seen by isBlankTab.
  }
  const value = files.map(({ uri, name }) => ({ uri, name }));
  const write = files.length > 0
    ? runFiles('readwrite', (store) => store.put(value, key))
    : runFiles('readwrite', (store) => store.delete(key));
  void write.catch(() => {});
}

function hasDraftFiles(key: string): boolean {
  return !!localStorage.getItem(draftFilesMarkKey(key));
}

/** Where a question's unsent answers are kept, by the question's id. */
export function formDraftStorageKey(formID: string): string {
  return `din.assistant.form.${formID}`;
}

/** The composer's key for a tab's new conversation; conversations use their session's id. */
export function newConversationDraftKey(tabId: string): string {
  return `new:${tabId}`;
}

/** A new-conversation tab with nothing typed in it, fine to reuse. */
export function isBlankTab(tab: AssistantTab): boolean {
  if (tab.sessionID !== null) return false;
  try {
    const key = newConversationDraftKey(tab.id);
    return !localStorage.getItem(draftStorageKey(key)) && !hasDraftFiles(key);
  } catch {
    return true;
  }
}

/** Forget a closed new-conversation tab's unsent text and files. */
export function forgetTabDraft(tab: AssistantTab): void {
  if (tab.sessionID !== null) return;
  const key = newConversationDraftKey(tab.id);
  try {
    localStorage.removeItem(draftStorageKey(key));
  } catch {
    // Nothing to forget.
  }
  saveDraftFiles(key, []);
}
