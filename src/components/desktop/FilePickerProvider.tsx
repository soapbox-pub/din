import { ReactNode, useCallback, useMemo, useState } from 'react';
import {
  FilePickerContext,
  type FilePickerContextValue,
  type FilePickerOptions,
} from '@/contexts/FilePickerContext';
import { FilePickerDialog } from './FilePickerDialog';

interface PendingRequest {
  options: FilePickerOptions;
  resolve: (path: string | null) => void;
}

/**
 * Provides the in-Din {@link useFilePicker} service. A single modal
 * {@link FilePickerDialog} is rendered on demand; `pickFile()` returns a
 * promise that resolves with the chosen path (or `null` on cancel).
 *
 * This deliberately does NOT go through the host OS file dialog — the whole
 * point of the desktop shell is that file selection happens inside Din, using
 * the same `window.fs` bridge the Files app uses.
 */
export function FilePickerProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingRequest | null>(null);

  const pickFile = useCallback<FilePickerContextValue['pickFile']>((options = {}) => {
    return new Promise<string | null>((resolve) => {
      setPending((current) => {
        // If a picker is somehow already open, cancel it first.
        current?.resolve(null);
        return { options, resolve };
      });
    });
  }, []);

  const settle = useCallback((path: string | null) => {
    setPending((current) => {
      current?.resolve(path);
      return null;
    });
  }, []);

  const value = useMemo<FilePickerContextValue>(() => ({ pickFile }), [pickFile]);

  return (
    <FilePickerContext.Provider value={value}>
      {children}
      {pending && (
        <FilePickerDialog
          options={pending.options}
          onConfirm={(path) => settle(path)}
          onCancel={() => settle(null)}
        />
      )}
    </FilePickerContext.Provider>
  );
}
