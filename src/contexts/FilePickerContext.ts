import { createContext, useContext } from 'react';

/** Options controlling a single file-picker request. */
export interface FilePickerOptions {
  /** Dialog title, e.g. "Choose a cursor theme". */
  title?: string;
  /** Label for the confirm button, e.g. "Open". */
  confirmLabel?: string;
  /**
   * Case-insensitive filename extensions (with or without leading dot) that
   * may be selected, e.g. `['.CurXPTheme']`. Other files are shown greyed out
   * and cannot be chosen. Omit to allow any file.
   */
  extensions?: string[];
  /** Absolute directory to open in initially. Defaults to the home directory. */
  initialPath?: string;
}

/** The file-picker service exposed to any component inside the Desktop. */
export interface FilePickerContextValue {
  /**
   * Open an in-Din file picker window and resolve with the absolute path of
   * the selected file, or `null` if the user cancelled. Only one picker can be
   * open at a time; a second call while one is open rejects the earlier one.
   */
  pickFile(options?: FilePickerOptions): Promise<string | null>;
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
