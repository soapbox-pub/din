import { useEffect, useRef, useState } from 'react';

/** What MediaRecorder is asked for, first it takes. */
const TYPES = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];

interface Session {
  recorder: MediaRecorder;
  stream: MediaStream;
  context: AudioContext;
  chunks: Blob[];
  /** Resolves with the recording once it's stopped, or null when discarded. */
  done: Promise<Blob | null>;
  discard: boolean;
  /** Plays again what `pauseMedia` paused. */
  releaseMedia: () => void;
}

/**
 * Recording the microphone, for the composer's Record Audio: whether it's
 * on, for how long, an analyser for a level meter, and starting, stopping
 * (resolving with the sound and its file extension) or discarding it. A
 * recording going when the composer goes is discarded. `pauseMedia` pauses
 * what's playing elsewhere while it records, until the function it returns.
 */
export function useAudioRecorder(pauseMedia?: () => () => void) {
  const session = useRef<Session | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'recording'>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const end = (s: Session) => {
    s.stream.getTracks().forEach((t) => t.stop());
    void s.context.close().catch(() => {});
    s.releaseMedia();
    if (session.current === s) {
      session.current = null;
      setAnalyser(null);
      setState('idle');
    }
  };

  useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.discard = true;
      if (s.recorder.state !== 'inactive') s.recorder.stop();
      end(s);
    },
    [],
  );

  const start = async () => {
    if (session.current || state !== 'idle') return;
    setState('starting');
    // Quiet before the microphone opens, so it doesn't hear the music.
    const releaseMedia = pauseMedia?.() ?? (() => {});
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      releaseMedia();
      setState('idle');
      throw error;
    }
    const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const context = new AudioContext();
    const node = context.createAnalyser();
    node.fftSize = 256;
    context.createMediaStreamSource(stream).connect(node);
    const chunks: Blob[] = [];
    let released = false;
    const s: Session = {
      recorder,
      stream,
      context,
      chunks,
      discard: false,
      done: Promise.resolve(null),
      releaseMedia: () => {
        if (released) return;
        released = true;
        releaseMedia();
      },
    };
    s.done = new Promise((resolve) => {
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      recorder.onstop = () => {
        end(s);
        resolve(s.discard || chunks.length === 0 ? null : new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      };
    });
    session.current = s;
    recorder.start(1000);
    setAnalyser(node);
    setStartedAt(Date.now());
    setState('recording');
  };

  /** Stop, and resolve with what was recorded and the extension to keep it under; null if nothing was. */
  const stop = async (): Promise<{ audio: Blob; extension: string } | null> => {
    const s = session.current;
    if (!s) return null;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    const audio = await s.done;
    return audio ? { audio, extension: audio.type.startsWith('audio/ogg') ? 'ogg' : 'webm' } : null;
  };

  const discard = () => {
    const s = session.current;
    if (!s) return;
    s.discard = true;
    if (s.recorder.state !== 'inactive') s.recorder.stop();
    else end(s);
  };

  return { state, recording: state === 'recording', startedAt, analyser, start, stop, discard };
}
