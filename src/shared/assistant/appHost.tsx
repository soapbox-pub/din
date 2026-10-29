import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import type { Din, DinFileHandle } from '@/sdk';
import { useDin } from '@/sdk/react';
import { useAssistantEventSync } from '@/hooks/useAssistant';
import { AssistantHostContext, type AssistantHost } from '@/shared/assistant/host';

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

async function startIn(din: Din, path: string | undefined): Promise<DinFileHandle | undefined> {
  return path ? din.files.fromPath(path).catch(() => undefined) : undefined;
}

/**
 * Dictation into the composer's field, through din.dictation (it types
 * into what's focused). Lit while what's dictated goes into this window's
 * composer, from its mic or Din's dictation key alike.
 */
function useAppDictation(din: Din, ref: RefObject<HTMLTextAreaElement | null>) {
  const [status, setStatus] = useState(din.dictation.status);
  useEffect(() => din.dictation.onStatus(setStatus), [din]);
  // Whether the composer has focus: dictation types into the focused field.
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
    return () => {
      el.removeEventListener('focus', on);
      el.removeEventListener('blur', off);
    };
  }, [ref]);
  const active = din.dictation.here && focused && (status === 'listening' || status === 'transcribing');
  return {
    available: din.dictation.available,
    active,
    toggle: () => {
      if (active) {
        void din.dictation.finish();
        return;
      }
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      din.dictation.start().catch(() => {});
    },
  };
}

/**
 * The assistant's UI in an app: window.din for what the desktop does, and
 * the app's own copy of the queries kept current from the server's events.
 * Needs the `assistant` permission, and `fs` for the folder picker,
 * attachments and file links.
 */
export function AppAssistantHost({ children }: { children: ReactNode }) {
  const din = useDin();
  useAssistantEventSync();
  // Din's settings for the assistant, which the desktop keeps.
  const [settings, setSettings] = useState(din.assistant.settings);
  useEffect(() => din.assistant.onSettingsChange(setSettings), [din]);

  const host = useMemo(
    (): AssistantHost => ({
      directory: settings.directory,
      colorfulReplies: settings.colorfulReplies,
      setEnabled: (enabled) => din.assistant.setSettings({ enabled }),
      openApp: (appId, params) => void din.app.open(appId, params),
      openUrl: (url) => void din.app.openUrl(url),
      openPath: (path, kind) =>
        void din.files.fromPath(path).then((handle) =>
          kind === 'directory' ? din.app.open('file-browser', {}, [handle]) : din.app.openFiles([handle]),
        ),
      showInFolder: (path) =>
        void din.files
          .fromPath(parentOf(path))
          .then((folder) => din.app.open('file-browser', { select: path.slice(path.lastIndexOf('/') + 1) }, [folder])),
      pickFiles: async ({ title }) => {
        const picked = await din.files.open({ title, multiple: true, writable: false });
        return picked.map((handle) => handle.path);
      },
      pickFolder: async ({ title, initialPath }) => {
        const [picked] = await din.files.open({ title, directory: true, writable: false, startIn: await startIn(din, initialPath) });
        return picked?.path ?? null;
      },
      notify: ({ title, description }) => void din.notifications.show(title, { body: description, transient: true }),
      useDictation: (ref) => useAppDictation(din, ref),
    }),
    [din, settings.directory, settings.colorfulReplies],
  );

  return <AssistantHostContext value={host}>{children}</AssistantHostContext>;
}
