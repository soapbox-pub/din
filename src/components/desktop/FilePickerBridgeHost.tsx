import { useEffect } from 'react';
import { useFilePicker, type FilePickerOptions } from '@/contexts/FilePickerContext';
import {
  getFilePickerHostBridge,
  type FilePickerBridgeRequest,
} from '@/lib/filePickerBridge';

/**
 * Desktop-lifetime fulfiller for file-chooser requests relayed from browser
 * tabs and installed web-app guests (see electron/main.mts's
 * attachFileChooserInterception), and from native apps' Open and Save
 * dialogs (the desktop portal, electron/file-chooser.mts). When a native
 * `<input type=file>` is clicked inside a guest, the chooser is intercepted
 * over CDP and proxied here; this host opens the in-Din
 * {@link FilePickerDialog} via `useFilePicker` and answers with the chosen
 * absolute paths, which the main process hands back to the page with
 * `DOM.setFileInputFiles` (or to the app, through the portal).
 *
 * Renders nothing; does nothing outside the Electron shell (the bridge is
 * absent in a plain browser, where there are no `<webview>` guests).
 */
export function FilePickerBridgeHost() {
  const { pickFiles } = useFilePicker();

  useEffect(() => {
    const bridge = getFilePickerHostBridge();
    if (!bridge) return;
    /** Open requests, so an app giving up can close its picker. */
    const open = new Map<number, AbortController>();

    const offCancel = bridge.onCancel((requestId) => open.get(requestId)?.abort());
    const offRequest = bridge.onRequest(async (request: FilePickerBridgeRequest) => {
      const controller = new AbortController();
      open.set(request.requestId, controller);
      try {
        const result = await pickFiles({ ...pickerOptions(request), signal: controller.signal });
        bridge.respond({
          requestId: request.requestId,
          path: result?.paths[0] ?? null,
          paths: result?.paths ?? null,
          filter: result?.filter ?? null,
        });
      } catch {
        bridge.respond({ requestId: request.requestId, path: null, paths: null, filter: null });
      } finally {
        open.delete(request.requestId);
      }
    });
    return () => {
      offRequest();
      offCancel();
    };
  }, [pickFiles]);

  return null;
}

function pickerOptions({ origin, multiple, options }: FilePickerBridgeRequest): FilePickerOptions {
  if (!options) {
    return {
      title: origin ? `Upload ${multiple ? 'files' : 'a file'} to ${origin}` : `Upload ${multiple ? 'files' : 'a file'}`,
      confirmLabel: 'Upload',
      multiple,
    };
  }
  return {
    title: options.title || undefined,
    confirmLabel: options.confirmLabel ?? undefined,
    mode: options.mode,
    multiple: options.multiple,
    directory: options.directory,
    filters: options.filters,
    currentFilter: options.currentFilter ?? undefined,
    currentName: options.currentName ?? undefined,
    initialPath: options.initialPath ?? undefined,
  };
}
