import { useEffect } from 'react';
import { useFilePicker } from '@/contexts/FilePickerContext';
import {
  getFilePickerHostBridge,
  type FilePickerBridgeRequest,
} from '@/lib/filePickerBridge';

/**
 * Desktop-lifetime fulfiller for file-chooser requests relayed from browser
 * tabs and installed web-app guests (see electron/main.mts's
 * attachFileChooserInterception). When a native `<input type=file>` is clicked
 * inside a guest, the chooser is intercepted over CDP and proxied here; this
 * host opens the in-Din {@link FilePickerDialog} via `useFilePicker` and
 * answers with the chosen absolute path, which the main process hands back to
 * the page with `DOM.setFileInputFiles`.
 *
 * Renders nothing; does nothing outside the Electron shell (the bridge is
 * absent in a plain browser, where there are no `<webview>` guests).
 */
export function FilePickerBridgeHost() {
  const { pickFile } = useFilePicker();

  useEffect(() => {
    const bridge = getFilePickerHostBridge();
    if (!bridge) return;

    return bridge.onRequest(async (request: FilePickerBridgeRequest) => {
      try {
        const path = await pickFile({
          title: request.origin ? `Upload a file to ${request.origin}` : 'Upload a file',
          confirmLabel: 'Upload',
        });
        bridge.respond({ requestId: request.requestId, path });
      } catch {
        bridge.respond({ requestId: request.requestId, path: null });
      }
    });
  }, [pickFile]);

  return null;
}
