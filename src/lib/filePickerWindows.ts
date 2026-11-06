import type { FilePickerOptions, FilePickerResult } from '@/contexts/FilePickerContext';

/**
 * The file picker's window (src/components/desktop/apps/FilePickerWindow.tsx):
 * hidden from the launcher, opened by FilePickerProvider with a `request`
 * launch param naming one of the requests below, and a `dockAs` one putting
 * it under the Dock tile of the app that asked.
 */
export const FILE_PICKER_APP_ID = 'file-picker';

/** A request waiting on its picker window. */
export interface PickerRequest {
  options: FilePickerOptions;
  /** Answers the asker; the first call wins, later ones do nothing. */
  settle: (result: FilePickerResult | null) => void;
}

/**
 * Requests by id. Kept here rather than in the window's launch params,
 * which are plain data (an asker's AbortSignal and promise aren't), and
 * never restored: a picker from before a reload has no one waiting on it.
 */
const requests = new Map<string, PickerRequest>();

export function addPickerRequest(id: string, request: PickerRequest): void {
  requests.set(id, request);
}

export function getPickerRequest(id: string): PickerRequest | undefined {
  return requests.get(id);
}

/** Answer a request and forget it. */
export function settlePickerRequest(id: string, result: FilePickerResult | null): void {
  const request = requests.get(id);
  if (!request) return;
  requests.delete(id);
  request.settle(result);
}
