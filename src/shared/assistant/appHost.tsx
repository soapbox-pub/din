import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Din } from '@/sdk';
import { pickFiles, pickFolder } from '@/shared/fileHandles';
import { useDin } from '@/sdk/react';
import { toast } from '@/shared/toast';
import { useAssistantEventSync } from '@/hooks/useAssistant';
import { AssistantHostContext, type AssistantHost, type ListenHandlers, type Listening } from '@/shared/assistant/host';
import { createVoice, speechSynthesisEngine, useVoiceStore, type VoiceStore } from '@/shared/assistant/voice';
import { appLink } from '@/shared/launch';
import { dictationTyper } from '@/shared/dictationField';

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

async function startIn(din: Din, path: string | undefined): Promise<FileSystemHandle | undefined> {
  return path ? din.files.fromPath(path).catch(() => undefined) : undefined;
}

/**
 * Dictation into the composer's field: the web's SpeechRecognition (Din's
 * dictation, in the window the user is in), what's said typed at the
 * cursor as if from the keyboard, the words shown as they're heard. Lit
 * while its own session listens.
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
      r.interimResults = true;
      const type = dictationTyper(textarea);
      /** Results typed for good. */
      let typed = 0;
      r.onresult = (e) => {
        // The final results not typed yet, then the words heard after them.
        let final = '';
        let interim = '';
        for (let i = typed; i < e.results.length; i++) {
          const result = e.results[i];
          const text = result?.[0]?.transcript.trim() ?? '';
          if (result?.isFinal && i === typed) {
            final = final && text ? `${final} ${text}` : final || text;
            typed++;
          } else if (text) {
            interim = interim ? `${interim} ${text}` : text;
          }
        }
        type(final, interim);
      };
      r.onend = () => {
        // Anything heard that never came final goes.
        type('', '');
        if (recognition.current === r) recognition.current = null;
        setActive(false);
      };
      recognition.current = r;
      setActive(true);
      r.start();
    },
  };
}

/** The window's voice: speechSynthesis, which in a Din app is Din's. */
let appVoice: VoiceStore | null = null;
function useAppVoice() {
  appVoice ??= createVoice(speechSynthesisEngine());
  return useVoiceStore(appVoice);
}

/**
 * A call's listening: the web's SpeechRecognition, continuous, with what's
 * heard so far as it goes. Each final result is a stretch of speech.
 */
function listen(handlers: ListenHandlers): Listening {
  const r = new SpeechRecognition();
  r.continuous = true;
  r.interimResults = true;
  let done = 0;
  let failed: { code: string; message: string } | null = null;
  let stopped = false;
  r.onresult = (e) => {
    let interim = '';
    for (let i = done; i < e.results.length; i++) {
      const result = e.results[i];
      const text = result?.[0]?.transcript.trim() ?? '';
      if (result?.isFinal && i === done) {
        done++;
        if (text) handlers.onFinal(text);
      } else if (text) {
        interim = interim ? `${interim} ${text}` : text;
      }
    }
    handlers.onInterim(interim);
  };
  r.onerror = (e) => {
    if (e.error !== 'aborted') failed = { code: e.error, message: e.message };
  };
  r.onend = () => {
    handlers.onInterim('');
    handlers.onEnd(stopped ? null : failed);
  };
  r.start();
  return {
    stop: () => {
      stopped = true;
      r.abort();
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
      speakReplies: settings.speakReplies,
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
      transferredPaths: (data) => {
        // Din's files come as items with a handle and no File (src/sdk/standards.ts).
        const items = [...data.items].filter((item) => item.kind === 'file' && item.getAsFile() === null);
        if (items.length === 0) return null;
        const handles = items.map((item) => item.getAsFileSystemHandle().catch(() => null));
        return Promise.all(handles).then((list) => list.flatMap((h) => (h ? [din.files.path(h)] : [])));
      },
      notify: ({ title, description, destructive }) => toast(title, { body: description, destructive }),
      useDictation: (ref) => useAppDictation(ref),
      pauseMedia: () => din.desktop.pauseMedia(),
      useVoice: useAppVoice,
      listen: typeof SpeechRecognition === 'function' ? listen : undefined,
    }),
    [din, settings.directory, settings.colorfulReplies, settings.speakReplies],
  );

  return <AssistantHostContext value={host}>{children}</AssistantHostContext>;
}
