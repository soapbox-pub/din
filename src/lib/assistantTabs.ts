import { z } from 'zod';

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

/** The composer's key for a tab's new conversation; conversations use their session's id. */
export function newConversationDraftKey(tabId: string): string {
  return `new:${tabId}`;
}

/** A new-conversation tab with nothing typed in it, fine to reuse. */
export function isBlankTab(tab: AssistantTab): boolean {
  if (tab.sessionID !== null) return false;
  try {
    return !localStorage.getItem(draftStorageKey(newConversationDraftKey(tab.id)));
  } catch {
    return true;
  }
}

/** Forget a closed new-conversation tab's unsent text. */
export function forgetTabDraft(tab: AssistantTab): void {
  if (tab.sessionID !== null) return;
  try {
    localStorage.removeItem(draftStorageKey(newConversationDraftKey(tab.id)));
  } catch {
    // Nothing to forget.
  }
}
