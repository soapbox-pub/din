import { useEffect, useState } from 'react';
import { onAnnounce, type Politeness } from '@/lib/announce';

/** How long announcements settle before one is read, so a held volume key says only where it stopped. */
const SETTLE_MS = 150;

/**
 * The desktop's live regions, which announce() speaks through. They're
 * always in the page, empty until there's something to say, as screen
 * readers only read changes to a region they already know.
 */
export function Announcer() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');

  useEffect(() => {
    const timers: Partial<Record<Politeness, number>> = {};
    const stop = onAnnounce((message, politeness) => {
      const set = politeness === 'assertive' ? setAssertive : setPolite;
      window.clearTimeout(timers[politeness]);
      // Emptied first, so the same words twice running are read twice.
      set('');
      timers[politeness] = window.setTimeout(() => set(message), SETTLE_MS);
    });
    return () => {
      stop();
      window.clearTimeout(timers.polite);
      window.clearTimeout(timers.assertive);
    };
  }, []);

  return (
    <div className="sr-only">
      <div role="status" aria-live="polite" aria-atomic="true">{polite}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true">{assertive}</div>
    </div>
  );
}
