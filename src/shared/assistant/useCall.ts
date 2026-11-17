import { useCallback, useEffect, useRef, useState } from 'react';
import { useAssistantHost, type Listening } from '@/shared/assistant/host';

/**
 * Calling the assistant: talk, and what's said goes to it as a message each
 * time the user pauses; its replies are read aloud (replyVoice.ts, which
 * reads every reply during a call). Listening is Din's dictation, without
 * end, in the window the call is in. While the assistant speaks, what the
 * microphone hears is its own voice and isn't sent; Interrupt stops it.
 * Mute turns the microphone off without hanging up. CallBar (Call.tsx)
 * shows it in the composer's place.
 */

/** What was said goes once the user has been quiet this long after it. */
const SEND_AFTER_MS = 1500;
/** Words heard this soon after the voice stops are the end of its own. */
const ECHO_MS = 1200;

export type CallPhase =
  /** Listening, the assistant idle: the user's turn. */
  | 'listening'
  /** Listening while the assistant works on what was said. */
  | 'thinking'
  /** The assistant reading its reply aloud. */
  | 'speaking'
  | 'muted'
  /** Listening stopped by itself (another dictation took the microphone, or it failed): Resume starts it again. */
  | 'paused';

export interface Call {
  active: boolean;
  phase: CallPhase;
  /** What's been heard and not sent yet. */
  heard: string;
  /** Why listening stopped, while paused. */
  problem: string | null;
  startedAt: number;
  start(): void;
  end(): void;
  toggleMute(): void;
  /** Start listening again after it stopped by itself. */
  resume(): void;
  /** Stop the reply being read, and listen. */
  interrupt(): void;
}

/** A call carried from the new-conversation screen into the conversation its first words started. */
let carried: { sessionID: string; startedAt: number } | null = null;

/** Carry the call on into this conversation, once it shows. */
export function carryCall(sessionID: string, startedAt: number): void {
  carried = { sessionID, startedAt };
}

function takeCarried(sessionID: string | undefined): number | null {
  if (!sessionID || carried?.sessionID !== sessionID) return null;
  const { startedAt } = carried;
  carried = null;
  return startedAt;
}

/**
 * The call in a conversation (or on the new-conversation screen, without
 * `sessionID`): `send` sends what was said as a message, `running` whether
 * the assistant is working. Null where there's no dictation; without Din's
 * voice, starting one points to where to install it.
 */
export function useCall({
  sessionID,
  running,
  send,
}: {
  sessionID?: string;
  running: boolean;
  send: (text: string) => Promise<unknown>;
}): Call | null {
  const host = useAssistantHost();
  const voice = host.useVoice();
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [heard, setHeard] = useState('');
  const [startedAt, setStartedAt] = useState(0);

  const listening = useRef<Listening | null>(null);
  const said = useRef('');
  const interim = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speaking = voice.speaking !== null;
  const speakingNow = useRef(false);
  const spokeUntil = useRef(0);
  const latest = useRef({ send, voice });
  useEffect(() => {
    latest.current = { send, voice };
  });

  const show = () => setHeard([said.current, interim.current].filter(Boolean).join(' '));
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const drop = () => {
    clearTimer();
    said.current = '';
    interim.current = '';
    setHeard('');
  };
  const flush = () => {
    timer.current = null;
    // Still talking: wait for the end of it.
    if (interim.current) return;
    const text = said.current.trim();
    said.current = '';
    show();
    if (text) void latest.current.send(text).catch(() => {});
  };
  const schedule = () => {
    clearTimer();
    if (said.current) timer.current = setTimeout(flush, SEND_AFTER_MS);
  };
  const ownVoice = () => speakingNow.current || Date.now() - spokeUntil.current < ECHO_MS;

  const stopListening = () => {
    const l = listening.current;
    listening.current = null;
    l?.stop();
  };

  const startListening = useCallback(() => {
    if (!host.listen || listening.current) return;
    setPaused(false);
    setProblem(null);
    const l = host.listen({
      onFinal: (text) => {
        if (ownVoice()) return;
        said.current = said.current ? `${said.current} ${text}` : text;
        interim.current = '';
        show();
        schedule();
      },
      onInterim: (text) => {
        if (ownVoice()) return;
        interim.current = text;
        show();
        if (text) clearTimer();
        else schedule();
      },
      onEnd: (error) => {
        if (listening.current !== l) return;
        listening.current = null;
        // Something else took the microphone, or it gave out: the user picks it up again.
        setPaused(true);
        setProblem(error?.message || (error ? 'Listening stopped' : 'Listening stopped. Resume to talk again.'));
      },
    });
    listening.current = l;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- its helpers read refs
  }, [host.listen]);

  // A call carried on from the new-conversation screen goes on here.
  useEffect(() => {
    const since = takeCarried(sessionID);
    if (since === null || !host.listen) return;
    /* eslint-disable react-hooks/set-state-in-effect -- picking up a call the screen before started */
    setActive(true);
    setStartedAt(since);
    startListening();
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as it shows
  }, []);

  // The voice's own words aren't the user's.
  useEffect(() => {
    speakingNow.current = speaking;
    if (speaking) {
      // What was half heard when it began is dropped (the bar shows it speaking meanwhile).
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      said.current = '';
      interim.current = '';
    } else {
      spokeUntil.current = Date.now();
    }
  }, [speaking]);

  // Hanging up when the conversation goes.
  useEffect(
    () => () => {
      clearTimer();
      stopListening();
    },
    [],
  );

  if (!host.listen) return null;

  const end = () => {
    drop();
    stopListening();
    latest.current.voice.stop();
    setActive(false);
    setMuted(false);
    setPaused(false);
    setProblem(null);
  };

  const phase: CallPhase = paused ? 'paused' : muted ? 'muted' : speaking ? 'speaking' : running ? 'thinking' : 'listening';

  return {
    active,
    phase,
    heard,
    problem,
    startedAt,
    start: () => {
      if (active) return;
      // Replies are read aloud, which needs Din's voice: where to get it.
      if (!voice.available) {
        host.notify({ title: 'Calls need Speech', description: 'Install Speech in Settings → Optional Features, then call again.' });
        host.openApp('settings', { section: 'features' });
        return;
      }
      setActive(true);
      setMuted(false);
      setStartedAt(Date.now());
      drop();
      startListening();
    },
    end,
    toggleMute: () => {
      if (muted) {
        setMuted(false);
        startListening();
      } else {
        setMuted(true);
        drop();
        stopListening();
      }
    },
    resume: () => {
      setMuted(false);
      startListening();
    },
    interrupt: () => {
      latest.current.voice.stop();
      spokeUntil.current = 0;
    },
  };
}

