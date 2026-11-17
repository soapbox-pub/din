import { useSyncExternalStore } from 'react';
import { getSpeechState, subscribeSpeech, type SpeechState } from '@/lib/speech';

/** Din's voice: whether it's installed, its voices, and what's being said (src/lib/speech.ts). */
export function useSpeech(): SpeechState {
  return useSyncExternalStore(subscribeSpeech, getSpeechState);
}
