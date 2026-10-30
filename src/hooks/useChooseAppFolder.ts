import { useCallback, useState } from 'react';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useToast } from '@/hooks/useToast';
import { getAppsBridge } from '@/lib/dinApps';
import { folderError, type OpenedFolder } from '@/lib/fileApps';

/** Choose a folder and open it as an app; resolves with it, or null if the user cancelled or it can't be one (a toast says why). */
export function useChooseAppFolder(): { choose: () => Promise<OpenedFolder | null>; busy: boolean } {
  const { pickFiles } = useFilePicker();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const choose = useCallback(async () => {
    const bridge = getAppsBridge();
    if (!bridge) return null;
    const picked = await pickFiles({ title: 'Choose an App Folder', confirmLabel: 'Choose', directory: true });
    const path = picked?.paths[0];
    if (!path) return null;
    setBusy(true);
    try {
      return await bridge.folder(path);
    } catch (error) {
      toast({ title: 'That folder isn’t an app', description: folderError(error), variant: 'destructive' });
      return null;
    } finally {
      setBusy(false);
    }
  }, [pickFiles, toast]);
  return { choose, busy };
}
