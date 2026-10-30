import { useCallback } from 'react';
import { useDin } from '@/sdk/react';
import { isMailtoUrl } from '@/lib/mailto';

/** Where a link in a message goes: Mail itself for mailto:, the browser for the web. */
export function useOpenLink(onMailto: (url: string) => void) {
  const din = useDin();
  return useCallback(
    (href: string) => {
      if (isMailtoUrl(href)) onMailto(href);
      else if (/^https?:/i.test(href)) void din.app.openUrl(href);
    },
    [din, onMailto],
  );
}
