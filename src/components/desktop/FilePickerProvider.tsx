import { ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import {
  FilePickerContext,
  type FilePickerContextValue,
  type FilePickerOptions,
  type FilePickerResult,
} from '@/contexts/FilePickerContext';
import { FilePickerDialog } from './FilePickerDialog';

interface PendingRequest {
  id: number;
  options: FilePickerOptions;
  resolve: (result: FilePickerResult | null) => void;
  /** What had focus before, to give it back (a native app's window, say). */
  focused: Element | null;
}

let lastRequestId = 0;

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
  const pendingRef = useRef<PendingRequest | null>(null);

  const settle = useCallback((request: PendingRequest, result: FilePickerResult | null, refocus = true) => {
    if (pendingRef.current !== request) return;
    pendingRef.current = null;
    setPending(null);
    request.resolve(result);
    const { focused } = request;
    if (refocus && focused instanceof HTMLElement && focused.isConnected) {
      requestAnimationFrame(() => focused.focus({ preventScroll: true }));
    }
  }, []);

  const pickFiles = useCallback<FilePickerContextValue['pickFiles']>(
    (options = {}) => {
      return new Promise<FilePickerResult | null>((resolve) => {
        if (options.signal?.aborted) return resolve(null);
        // If a picker is somehow already open, cancel it first.
        const current = pendingRef.current;
        if (current) settle(current, null, false);
        const request: PendingRequest = {
          id: ++lastRequestId,
          options,
          resolve,
          focused: current?.focused ?? document.activeElement,
        };
        options.signal?.addEventListener('abort', () => settle(request, null), { once: true });
        pendingRef.current = request;
        setPending(request);
      });
    },
    [settle],
  );

  const pickFile = useCallback<FilePickerContextValue['pickFile']>(
    async (options = {}) => (await pickFiles({ ...options, multiple: false }))?.paths[0] ?? null,
    [pickFiles],
  );

  const value = useMemo<FilePickerContextValue>(() => ({ pickFile, pickFiles }), [pickFile, pickFiles]);

  return (
    <FilePickerContext.Provider value={value}>
      {children}
      {pending && (
        <FilePickerDialog
          key={pending.id}
          options={pending.options}
          onConfirm={(result) => settle(pending, result)}
          onCancel={() => settle(pending, null)}
        />
      )}
    </FilePickerContext.Provider>
  );
}
