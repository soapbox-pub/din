import { useMemo, type ReactNode, type RefObject } from 'react';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useSetAssistantEnabled } from '@/hooks/useAssistant';
import { useIsDictatingInto } from '@/hooks/useDictation';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { elementTarget, finishDictation, hasDictationBridge, startDictation } from '@/lib/dictation';
import { appForFile } from '@/lib/fileTypes';
import { getFileClipboard } from '@/lib/fileClipboard';
import { parentPath } from '@/lib/fs';
import { AssistantHostContext, type AssistantHost } from '@/shared/assistant/host';

function useDesktopDictation(ref: RefObject<HTMLTextAreaElement | null>) {
  const active = useIsDictatingInto(ref);
  return {
    available: hasDictationBridge(),
    active,
    toggle: () => {
      const textarea = ref.current;
      if (!textarea) return;
      if (active) {
        void finishDictation();
        return;
      }
      textarea.focus();
      void startDictation(elementTarget(textarea));
    },
  };
}

/** The assistant's UI on the desktop (the menu bar's panel, Super+A, Settings): its own services. */
export function DesktopAssistantHost({ children }: { children: ReactNode }) {
  const { config } = useAppContext();
  const setEnabled = useSetAssistantEnabled();
  const { open } = useWindowActions();
  const { pickFile, pickFiles } = useFilePicker();
  const openUrl = useOpenUrl();
  const { toast } = useToast();

  const host = useMemo(
    (): AssistantHost => ({
      directory: config.assistantDirectory,
      colorfulReplies: config.assistantColorfulReplies,
      setEnabled,
      openApp: (appId, params) => open(appId, params),
      openUrl,
      openPath: (path, kind) => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        open(kind === 'directory' ? 'file-browser' : appForFile(name), { path });
      },
      showInFolder: (path) => open('file-browser', { path: parentPath(path), select: path.slice(path.lastIndexOf('/') + 1) }),
      pickFiles: async (options) => (await pickFiles({ ...options, multiple: true }).catch(() => null))?.paths ?? [],
      pickFolder: (options) => pickFile({ ...options, directory: true }).catch(() => null),
      // Din's file clipboard is the desktop's own; a drop of files from Files
      // carries their file: URLs, which the composer reads itself.
      transferredPaths: (_data, kind) => {
        const paths = kind === 'paste' ? getFileClipboard()?.paths : undefined;
        return paths?.length ? Promise.resolve(paths) : null;
      },
      notify: ({ title, description, destructive }) =>
        toast({ title, description, variant: destructive ? 'destructive' : undefined }),
      useDictation: useDesktopDictation,
    }),
    [config.assistantDirectory, config.assistantColorfulReplies, setEnabled, open, pickFile, pickFiles, openUrl, toast],
  );

  return <AssistantHostContext value={host}>{children}</AssistantHostContext>;
}
