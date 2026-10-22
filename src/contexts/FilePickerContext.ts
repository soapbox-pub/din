import { createContext, useContext } from 'react';
import type { FileFilter } from '@/lib/fileFilters';

/** Options controlling a single file-picker request. */
export interface FilePickerOptions {
  /** Dialog title, e.g. "Choose a cursor theme". */
  title?: string;
  /** Label for the confirm button, e.g. "Open". */
  confirmLabel?: string;
  /**
   * Case-insensitive filename extensions (with or without leading dot) that
   * may be selected, e.g. `['.CurXPTheme']`. Other files are shown greyed out
   * and cannot be chosen. Omit to allow any file. Shorthand for one filter.
   */
  extensions?: string[];
  /** Absolute directory to open in initially. Defaults to the home directory. */
  initialPath?: string;
  /** `save` asks for a name to save a new file under. Defaults to `open`. */
  mode?: 'open' | 'save';
  /** Let several files be chosen at once (open mode). */
  multiple?: boolean;
  /** Choose folders rather than files. */
  directory?: boolean;
  /** File types the user can switch between; the first applies unless `currentFilter` says otherwise. */
  filters?: FileFilter[];
  /** Index into `filters` of the one applied first. */
  currentFilter?: number;
  /** Save mode: the name suggested. */
  currentName?: string;
  /** Aborting closes the picker as if cancelled (the asker gave up). */
  signal?: AbortSignal;
}

/** What the user chose. */
export interface FilePickerResult {
  /** Absolute paths: one, unless `multiple` was set. */
  paths: string[];
  /** Index into `filters` of the filter in use, or null. */
  filter: number | null;
}

/** The file-picker service exposed to any component inside the Desktop. */
export interface FilePickerContextValue {
  /**
   * Open an in-Din file picker window and resolve with the absolute path of
   * the selected file, or `null` if the user cancelled. Only one picker can be
   * open at a time; a second call while one is open rejects the earlier one.
   */
  pickFile(options?: FilePickerOptions): Promise<string | null>;
  /** Like `pickFile`, for every kind of request: several files, folders, saving. */
  pickFiles(options?: FilePickerOptions): Promise<FilePickerResult | null>;
}

export const FilePickerContext = createContext<FilePickerContextValue | undefined>(
  undefined,
);

/** Access the in-Din file picker. Must be used within the Desktop. */
export function useFilePicker(): FilePickerContextValue {
  const ctx = useContext(FilePickerContext);
  if (!ctx) {
    throw new Error('useFilePicker must be used within a Desktop');
  }
  return ctx;
}
