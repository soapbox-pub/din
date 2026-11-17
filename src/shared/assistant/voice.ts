import { useSyncExternalStore } from 'react';
import { speakableText } from '@/shared/speakable';

/**
 * The assistant reading aloud, in Din's voice: Read Aloud on a reply, the
 * replies it speaks by itself (replyVoice.ts) and a call's (Call.tsx). One
 * thing at a time per window: speaking something stops what this window was
 * saying. Each host gives it an engine, the app's speechSynthesis or the
 * desktop's own speaker, which both end at the same voice (src/lib/speech.ts).
 */

/** What a host speaks with. */
export interface VoiceEngine {
  /** A voice is installed. */
  available(): boolean;
  /** Calls back when `available` may have changed. */
  subscribe(cb: () => void): () => void;
  /** Say plain text; `onEnd` once it's said or stopped short. */
  speak(text: string, handlers: { onStart: () => void; onEnd: () => void }): void;
  /** Stop what this window is saying. */
  cancel(): void;
}

export interface Voice {
  available: boolean;
  /** The key of what's being said (or about to be), or null. */
  speaking: string | null;
  /** Whether the words have started coming (not still being made ready). */
  started: boolean;
  /** Read Markdown aloud under `key`, stopping whatever this window was saying; `done` once it's over either way. */
  speak(markdown: string, key: string, done?: () => void): void;
  stop(): void;
}

export interface VoiceStore {
  getSnapshot(): Voice;
  subscribe(cb: () => void): () => void;
}

export function createVoice(engine: VoiceEngine): VoiceStore {
  const listeners = new Set<() => void>();
  let speaking: string | null = null;
  let started = false;
  /** Which speak() is current, so a stopped one's late ending changes nothing. */
  let turn = 0;
  let snapshot: Voice;

  const publish = () => {
    snapshot = { available: engine.available(), speaking, started, speak, stop };
    for (const listener of listeners) listener();
  };

  function speak(markdown: string, key: string, done?: () => void): void {
    const text = speakableText(markdown);
    const mine = ++turn;
    if (speaking !== null) engine.cancel();
    if (!text || !engine.available()) {
      speaking = null;
      started = false;
      publish();
      done?.();
      return;
    }
    speaking = key;
    started = false;
    publish();
    engine.speak(text, {
      onStart: () => {
        if (turn !== mine) return;
        started = true;
        publish();
      },
      onEnd: () => {
        if (turn === mine) {
          speaking = null;
          started = false;
          publish();
        }
        done?.();
      },
    });
  }

  function stop(): void {
    turn++;
    if (speaking === null) return;
    speaking = null;
    started = false;
    engine.cancel();
    publish();
  }

  snapshot = { available: engine.available(), speaking, started, speak, stop };
  engine.subscribe(() => {
    if (engine.available() !== snapshot.available) publish();
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

export function useVoiceStore(store: VoiceStore): Voice {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** An engine over the web's speechSynthesis, which in a Din app is Din's voice. */
export function speechSynthesisEngine(): VoiceEngine {
  const synthesis = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  let current: SpeechSynthesisUtterance | null = null;
  return {
    available: () => (synthesis?.getVoices().length ?? 0) > 0,
    subscribe: (cb) => {
      synthesis?.addEventListener('voiceschanged', cb);
      return () => synthesis?.removeEventListener('voiceschanged', cb);
    },
    speak: (text, { onStart, onEnd }) => {
      if (!synthesis) return onEnd();
      const utterance = new SpeechSynthesisUtterance(text);
      current = utterance;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        if (current === utterance) current = null;
        onEnd();
      };
      utterance.onstart = onStart;
      utterance.onend = end;
      utterance.onerror = end;
      synthesis.speak(utterance);
    },
    cancel: () => {
      if (current) synthesis?.cancel();
    },
  };
}
