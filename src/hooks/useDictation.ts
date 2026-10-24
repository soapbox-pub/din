import { useCallback, useSyncExternalStore } from 'react';
import { getDictationState, subscribeDictation, type DictationState } from '@/lib/dictation';

/** The dictation session's state (see src/lib/dictation.ts). */
export function useDictation(): DictationState {
  return useSyncExternalStore(subscribeDictation, getDictationState);
}

/** Whether a session is listening for (or typing into) the element in `ref`. */
export function useIsDictatingInto(ref: React.RefObject<Element | null>): boolean {
  const snapshot = useCallback(() => {
    const { status, owner } = getDictationState();
    return status !== 'idle' && status !== 'error' && owner !== null && owner === ref.current;
  }, [ref]);
  return useSyncExternalStore(subscribeDictation, snapshot);
}
