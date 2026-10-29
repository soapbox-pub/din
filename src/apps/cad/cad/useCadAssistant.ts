import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useActiveSessions, usePreferredModel, useSendPrompt, useStartConversation } from '@/hooks/useAssistant';
import type { PromptAttachment } from '@/lib/assistant';
import { getFsBridge } from '@/lib/fs';
import type { Drawing, Entity } from './model';
import { instructions, readAgentDrawing, writeAgentDrawing, type Snapshot } from './assistant';

const MAX_BYTES = 256 * 1024 * 1024;

/** Undo runs for the agent's turns: negative, so they never meet a command's. */
let turns = 0;

const fileUri = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

export interface CadAssistantHost {
  /** The drawing's file name. */
  name: string;
  drawing: () => Drawing | null;
  /** view.md: what the user sees and has selected. */
  view: () => string;
  /** view.png. */
  capture: () => Promise<Uint8Array | null>;
  /** Put the agent's version on screen; one `run` is one undo step. */
  apply: (d: Drawing, run: number) => void;
}

export type CadAssistant = ReturnType<typeof useCadAssistant>;

/**
 * The assistant working on the open drawing. Its conversation runs in a
 * folder of its own under ~/.cache/din/cad-assistant, where the drawing is
 * written as drawing.json before each message (see ./assistant.ts); CAD
 * watches the folder and puts what the agent saves on screen as it goes,
 * all of one turn as one undo step. `docKey` changes when another drawing
 * opens in the window, which starts over.
 */
export function useCadAssistant(host: CadAssistantHost, docKey: number) {
  const fs = getFsBridge();
  const hostRef = useRef(host);
  useLayoutEffect(() => {
    hostRef.current = host;
  });

  const [sessionID, setSessionID] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const snapshot = useRef<Snapshot | null>(null);
  const added = useRef<Entity[]>([]);
  const lastText = useRef<string | null>(null);
  const turn = useRef(0);
  const problems = useRef<string[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const { data: active = [] } = useActiveSessions();
  const running = sessionID !== null && active.includes(sessionID);
  const { model } = usePreferredModel();
  const start = useStartConversation();
  const send = useSendPrompt(sessionID);

  const reset = useCallback(() => {
    setSessionID(null);
    setDir(null);
    setProblem(null);
    snapshot.current = null;
    added.current = [];
    lastText.current = null;
  }, []);
  useEffect(() => reset, [docKey, reset]);

  /** Read drawing.json and apply what changed. `final`: the turn is over, so say what couldn't be read. */
  const pull = useCallback(
    (final: boolean) => {
      chain.current = chain.current.then(async () => {
        const snap = snapshot.current;
        const d = hostRef.current.drawing();
        if (!fs || !dir || !snap || !d) return;
        let text: string;
        try {
          const r = await fs.readFile(`${dir}/drawing.json`, MAX_BYTES);
          text = new TextDecoder().decode(r.data);
        } catch {
          return;
        }
        if (text !== lastText.current) {
          try {
            const m = readAgentDrawing(text, snap, hostRef.current.drawing() ?? d, added.current);
            lastText.current = text;
            added.current = m.added;
            problems.current = m.problems;
            if (m.drawing !== hostRef.current.drawing()) hostRef.current.apply(m.drawing, turn.current);
          } catch (err) {
            // Most likely half written; the next save or the end of the turn reads it again.
            problems.current = [`drawing.json couldn’t be read: ${err instanceof Error ? err.message : String(err)}`];
          }
        }
        if (final) {
          const list = problems.current;
          setProblem(list.length ? `${list.slice(0, 3).join('. ')}${list.length > 3 ? ` (and ${list.length - 3} more)` : ''}.` : null);
        }
      });
      return chain.current;
    },
    [fs, dir],
  );

  useEffect(() => {
    if (!fs || !dir) return;
    let id: number | null = null;
    let gone = false;
    void fs.watch(dir).then((w) => {
      if (gone && w !== null) void fs.unwatch(w);
      else id = w;
    });
    const off = fs.onChange((p) => {
      if (p === dir) void pull(false);
    });
    return () => {
      gone = true;
      off();
      if (id !== null) void fs.unwatch(id);
    };
  }, [fs, dir, pull]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void pull(true);
    wasRunning.current = running;
  }, [running, pull]);

  const submit = useCallback(
    async (text: string, extra: PromptAttachment[]) => {
      const h = hostRef.current;
      const d = h.drawing();
      if (!fs || !d) throw new Error('No drawing is open');
      let folder = dir;
      if (!folder) {
        const home = await fs.homedir();
        folder = `${home}/.cache/din/cad-assistant/${Date.now().toString(36)}-${h.name.replace(/[^\w.-]+/g, '_')}`;
        await fs.mkdir(folder);
        setDir(folder);
      }
      const files: PromptAttachment[] = [];
      if (!running) {
        // Whatever the agent saved last goes in before the drawing is written out again.
        await pull(true);
        const out = writeAgentDrawing(hostRef.current.drawing() ?? d);
        lastText.current = out.text;
        snapshot.current = out.snapshot;
        added.current = [];
        problems.current = [];
        setProblem(null);
        turn.current = -++turns;
        await fs.writeFile(`${folder}/drawing.json`, out.text);
        await fs.writeFile(`${folder}/view.md`, h.view());
        const png = await h.capture().catch(() => null);
        if (png) await fs.writeFile(`${folder}/view.png`, png);
        files.push({ uri: fileUri(`${folder}/view.md`), name: 'view.md' });
      }
      if (!sessionID) {
        await fs.writeFile(`${folder}/INSTRUCTIONS.md`, instructions(h.name, d));
        const session = await start.mutateAsync({
          text,
          files: [{ uri: fileUri(`${folder}/INSTRUCTIONS.md`), name: 'INSTRUCTIONS.md' }, ...files, ...extra],
          model,
          directory: folder,
        });
        setSessionID(session.id);
      } else {
        await send.mutateAsync({ text, files: [...files, ...extra] });
      }
    },
    [fs, dir, running, sessionID, pull, start, send, model],
  );

  return { sessionID, running, problem, submit, reset, sending: start.isPending || send.isPending };
}
