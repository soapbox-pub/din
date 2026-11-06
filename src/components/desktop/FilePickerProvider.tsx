import { ReactNode, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  FilePickerContext,
  type FilePickerContextValue,
  type FilePickerResult,
} from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { focusedWindow, windowRect } from '@/hooks/useWindows';
import { windowTile } from '@/lib/apps';
import { addPickerRequest, FILE_PICKER_APP_ID, settlePickerRequest } from '@/lib/filePickerWindows';

let lastRequestId = 0;

/**
 * Provides the in-Din {@link useFilePicker} service. Each request opens a
 * file picker window of its own (FILE_PICKER_APP_ID), one the user can move
 * aside, minimize or maximize like any other, under the Dock tile of the app
 * that asked; `pickFiles()` resolves with what was chosen, or `null` when
 * the window is cancelled or closed.
 *
 * This deliberately does NOT go through the host OS file dialog — the whole
 * point of the desktop shell is that file selection happens inside Din, using
 * the same `window.dinos.fs` bridge the Files app uses.
 */
export function FilePickerProvider({ children }: { children: ReactNode }) {
  const actions = useWindowActions();
  const { getApp } = useInstalledApps();
  const areas = useWorkAreas();
  const live = useRef({ actions, getApp, areas });
  useEffect(() => {
    live.current = { actions, getApp, areas };
  });

  const pickFiles = useCallback<FilePickerContextValue['pickFiles']>(
    (options = {}) =>
      new Promise<FilePickerResult | null>((resolve) => {
        if (options.signal?.aborted) return resolve(null);
        const { actions, getApp, areas } = live.current;
        const windows = actions.getSession().windows.filter((w) => !w.closing);
        // The asker's window: the one it names, else the focused one (a
        // page's upload button or a native app's Open was just clicked in it).
        const parent =
          (options.owner
            ? windows
                .filter((w) => w.appId === options.owner && !w.minimized)
                .reduce<(typeof windows)[number] | null>((top, w) => (!top || w.z > top.z ? w : top), null)
            : null) ?? focusedWindow(windows);
        const owner = options.owner
          ? (getApp(options.owner)?.dockAs ?? options.owner)
          : parent
            ? windowTile(parent, getApp)
            : null;

        const request = String(++lastRequestId);
        addPickerRequest(request, {
          options,
          settle: (result) => {
            resolve(result);
            // Back to the window that asked.
            if (parent && windowId) actions.focus(parent.id);
          },
        });
        const windowId = actions.open(FILE_PICKER_APP_ID, { request, ...(owner ? { dockAs: owner } : {}) });
        if (!windowId) return settlePickerRequest(request, null);

        // Over the window that asked, as a sheet would be, kept on its screen.
        if (parent && !parent.minimized) {
          const at = windowRect(parent, areas);
          const size = getApp(FILE_PICKER_APP_ID)?.defaultSize ?? { width: 960, height: 600 };
          const area =
            areas.find((a) => at.x + at.width / 2 >= a.x && at.x + at.width / 2 < a.x + a.width) ?? areas[0];
          let x = Math.round(at.x + (at.width - size.width) / 2);
          let y = Math.round(at.y + Math.min(48, Math.max(0, (at.height - size.height) / 2)));
          if (area) {
            x = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - size.width));
            y = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - size.height));
          }
          actions.move(windowId, x, y);
        }

        options.signal?.addEventListener(
          'abort',
          () => {
            settlePickerRequest(request, null);
            live.current.actions.close(windowId);
          },
          { once: true },
        );
      }),
    [],
  );

  const pickFile = useCallback<FilePickerContextValue['pickFile']>(
    async (options = {}) => (await pickFiles({ ...options, multiple: false }))?.paths[0] ?? null,
    [pickFiles],
  );

  const value = useMemo<FilePickerContextValue>(() => ({ pickFile, pickFiles }), [pickFile, pickFiles]);

  return <FilePickerContext.Provider value={value}>{children}</FilePickerContext.Provider>;
}
