import { useSyncExternalStore } from 'react';

const isDarkNow = () => document.documentElement.classList.contains('dark');

function subscribeDark(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Whether Din is showing its dark theme right now. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDark, isDarkNow);
}
