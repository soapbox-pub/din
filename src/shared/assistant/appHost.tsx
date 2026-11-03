import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Din } from '@/sdk';
import { pickFiles, pickFolder } from '@/shared/fileHandles';
import { useDin } from '@/sdk/react';
import { toast } from '@/shared/toast';
import { useAssistantEventSync } from '@/hooks/useAssistant';
import { AssistantHostContext, type AssistantHost } from '@/shared/assistant/host';
import { appLink } from '@/shared/launch';

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

async function startIn(din: Din, path: string | undefined): Promise<FileSystemHandle | undefined> {
  return path ? din.files.fromPath(path).catch(() => undefined) : undefined;
}

/** A space before the text unless it starts a line or follows one. */
function spaced(before: string, text: string): string {
  return before && !/\s$/.test(before) && !/^[.,!?;:]/.test(text) ? ` ${text}` : text;
}

/**
 * Dictation into the composer's field: the web's SpeechRecognition (Din's
 * dictation, in the window the user is in), what's said typed at the
 * cursor as if from the keyboard. Lit while its own session listens.
 */
function useAppDictation(ref: RefObject<HTMLTextAreaElement | null>) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    void globalThis.SpeechRecognition?.available({ langs: [], processLocally: true })
      .then((answer) => live && setAvailable(answer === 'available'))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const recognition = useRef<SpeechRecognition | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => recognition.current?.abort(), []);
  return {
    available,
    active,
    toggle: () => {
      if (recognition.current) {
        recognition.current.stop();
        return;
      }
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      const r = new SpeechRecognition();
      r.onresult = (e) => {
        const text = e.results[0]?.[0]?.transcript ?? '';
        const field = ref.current;
        if (!text || !field?.isConnected) return;
        field.focus();
        document.execCommand('insertText', false, spaced(field.value.slice(0, field.selectionStart ?? field.value.length), text));
      };
      r.onend = () => {
        if (recognition.current === r) recognition.current = null;
        setActive(false);
      };
      recognition.current = r;
      setActive(true);
      r.start();
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
      openApp: (appId, params) => void window.open(appLink(appId, params)),
      openUrl: (url) => window.open(url),
      openPath: (path, kind) =>
        void din.files.fromPath(path).then((handle) =>
          kind === 'directory' ? din.app.launch(appLink('file-browser'), [handle]) : din.app.openFiles([handle]),
        ),
      showInFolder: (path) =>
        void din.files
          .fromPath(parentOf(path))
          .then((folder) => din.app.launch(appLink('file-browser', { select: path.slice(path.lastIndexOf('/') + 1) }), [folder])),
      pickFiles: async ({ title }) => {
        const picked = await pickFiles({ title, multiple: true, mode: 'read' });
        return picked.map((handle) => din.files.path(handle));
      },
      pickFolder: async ({ title, initialPath }) => {
        const picked = await pickFolder({ title, startIn: await startIn(din, initialPath) });
        return picked ? din.files.path(picked) : null;
      },
      notify: ({ title, description, destructive }) => toast(title, { body: description, destructive }),
      useDictation: (ref) => useAppDictation(ref),
    }),
    [din, settings.directory, settings.colorfulReplies],
  );

  return <AssistantHostContext value={host}>{children}</AssistantHostContext>;
}
