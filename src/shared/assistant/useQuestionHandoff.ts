import { useLayoutEffect, useRef } from 'react';

/**
 * While the agent waits on a question, its conversation hides the composer:
 * the answer goes in the form, not in a message (as in OpenCode's own UI).
 * Put the returned ref on the composer's wrapper, a sibling of the
 * `FormCard`s. Focus that was in the composer moves to the form, and back
 * once it's answered.
 */
export function useQuestionHandoff(asking: boolean) {
  const composerRef = useRef<HTMLDivElement>(null);
  const handedOff = useRef(false);

  // Before paint, while focus is still in the composer the commit just hid.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    if (asking) {
      if (!composer.contains(document.activeElement)) return;
      composer.parentElement?.querySelector<HTMLElement>('[data-form-step]')?.focus();
      handedOff.current = true;
    } else if (handedOff.current) {
      handedOff.current = false;
      if (!document.activeElement || document.activeElement === document.body) composer.querySelector('textarea')?.focus();
    }
  }, [asking]);

  return composerRef;
}
