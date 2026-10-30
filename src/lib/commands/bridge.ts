import type { Answer } from './index';

/** What the desktop's preload exposes for `din` commands (electron/preload.cjs). */
export interface CommandBridge {
  /** CommandRequest in electron/din-launch.mts, unchecked. */
  onRun(callback: (request: unknown) => void): () => void;
  taken(id: string): Promise<void>;
  answer(id: string, answer: Answer): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    commands?: CommandBridge;
  }
}

export function getCommandBridge(): CommandBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.commands;
}

export type CommandRequest =
  | { id: string; argv: string[]; cwd: string }
  | { id: string; path: string[]; input: Record<string, unknown>; cwd: string };

/** A request from main, checked. */
export function parseCommandRequest(raw: unknown): CommandRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;
  const cwd = typeof r.cwd === 'string' ? r.cwd : '';
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (strings(r.argv)) return { id: r.id, argv: r.argv, cwd };
  if (strings(r.path) && typeof r.input === 'object' && r.input !== null && !Array.isArray(r.input)) {
    return { id: r.id, path: r.path, input: r.input as Record<string, unknown>, cwd };
  }
  return null;
}
