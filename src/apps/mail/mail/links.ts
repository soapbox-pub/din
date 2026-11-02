import { useCallback } from 'react';
import { isMailtoUrl } from '@/lib/mailto';

/** Where a link in a message goes: Mail itself for mailto:, the browser for the web. */
export function useOpenLink(onMailto: (url: string) => void) {
  return useCallback(
    (href: string) => {
      if (isMailtoUrl(href)) onMailto(href);
      else if (/^https?:/i.test(href)) window.open(href);
    },
    [onMailto],
  );
}
