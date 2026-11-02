import type { MessageFilter } from '@/lib/mail';
import type { Selection } from './api';
import type { ComposeSeed } from './format';

/**
 * What a Mail window keeps with `din.app.saveState`, for Din to reopen it
 * as it was: a viewer's mailbox, filter, search, open message and place in
 * the list, or a message being written.
 */
export type SavedWindow =
  | { kind: 'viewer'; selection: Selection; filter: MessageFilter; search: string; message: string | null; scroll: number }
  | { kind: 'compose'; seed: ComposeSeed; dirty: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isSelection(v: unknown): v is Selection {
  if (!isObject(v)) return false;
  if (v.kind === 'all') return typeof v.special === 'string';
  return v.kind === 'mailbox' && typeof v.accountId === 'string' && typeof v.path === 'string';
}

export function savedViewer(state: unknown): Extract<SavedWindow, { kind: 'viewer' }> | null {
  if (!isObject(state) || state.kind !== 'viewer' || !isSelection(state.selection)) return null;
  return {
    kind: 'viewer',
    selection: state.selection,
    filter: state.filter === 'unread' || state.filter === 'flagged' ? state.filter : null,
    search: typeof state.search === 'string' ? state.search : '',
    message: typeof state.message === 'string' ? state.message : null,
    scroll: typeof state.scroll === 'number' && state.scroll > 0 ? state.scroll : 0,
  };
}

export function savedCompose(state: unknown): Extract<SavedWindow, { kind: 'compose' }> | null {
  if (!isObject(state) || state.kind !== 'compose' || !isObject(state.seed)) return null;
  const s = state.seed as Partial<ComposeSeed>;
  if (!Array.isArray(s.to) || !Array.isArray(s.cc) || !Array.isArray(s.bcc) || typeof s.subject !== 'string' || typeof s.html !== 'string') return null;
  return { kind: 'compose', seed: s as ComposeSeed, dirty: state.dirty === true };
}
