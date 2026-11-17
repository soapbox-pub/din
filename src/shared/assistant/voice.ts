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
  /**
   * Read Markdown being written, a piece at a time, under `key`: without a
   * `reading`, it stops whatever this window was saying and starts a new
   * reading, whose number it returns; with one, the piece waits its turn
   * behind the rest of that reading. Null once that reading was stopped
   * (stop(), or something else read), so the writer stops too.
   */
  append(markdown: string, key: string, reading?: number): number | null;
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
  /** The current reading, so a stopped one's late endings change nothing. */
  let reading = 0;
  /** Its pieces not yet said. */
  let pending = 0;
  let snapshot: Voice;

  const publish = () => {
    snapshot = { available: engine.available(), speaking, started, speak, append, stop };
    for (const listener of listeners) listener();
  };

  /** Say a piece as part of reading `mine`; `done` once it's over. */
  const say = (text: string, mine: number, done?: () => void) => {
    pending++;
    engine.speak(text, {
      onStart: () => {
        if (reading !== mine || started) return;
        started = true;
        publish();
      },
      onEnd: () => {
        if (reading === mine && --pending === 0) {
          speaking = null;
          started = false;
          publish();
        }
        done?.();
      },
    });
  };

  /** A new reading under `key`, stopping this window's last. */
  const begin = (key: string): number => {
    const mine = ++reading;
    if (speaking !== null) engine.cancel();
    pending = 0;
    speaking = key;
    started = false;
    return mine;
  };

  function speak(markdown: string, key: string, done?: () => void): void {
    const text = speakableText(markdown);
    if (!text || !engine.available()) {
      reading++;
      if (speaking !== null) engine.cancel();
      speaking = null;
      started = false;
      publish();
      done?.();
      return;
    }
    const mine = begin(key);
    publish();
    say(text, mine, done);
  }

  function append(markdown: string, key: string, ongoing?: number): number | null {
    if (ongoing !== undefined && ongoing !== reading) return null;
    if (!engine.available()) return null;
    const mine = ongoing ?? begin(key);
    const text = speakableText(markdown);
    if (text) {
      if (speaking !== key) {
        // Between pieces it had gone quiet: the same reading, speaking again.
        speaking = key;
        started = false;
      }
      say(text, mine);
    }
    publish();
    return mine;
  }

  function stop(): void {
    reading++;
    pending = 0;
    if (speaking === null) return;
    speaking = null;
    started = false;
    engine.cancel();
    publish();
  }

  snapshot = { available: engine.available(), speaking, started, speak, append, stop };
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
  /** This window's utterances not yet over. */
  const current = new Set<SpeechSynthesisUtterance>();
  return {
    available: () => (synthesis?.getVoices().length ?? 0) > 0,
    subscribe: (cb) => {
      synthesis?.addEventListener('voiceschanged', cb);
      return () => synthesis?.removeEventListener('voiceschanged', cb);
    },
    speak: (text, { onStart, onEnd }) => {
      if (!synthesis) return onEnd();
      const utterance = new SpeechSynthesisUtterance(text);
      current.add(utterance);
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        current.delete(utterance);
        onEnd();
      };
      utterance.onstart = onStart;
      utterance.onend = end;
      utterance.onerror = end;
      synthesis.speak(utterance);
    },
    cancel: () => {
      if (current.size === 0) return;
      current.clear();
      synthesis?.cancel();
    },
  };
}
