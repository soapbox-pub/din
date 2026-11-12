import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { useSiteLimitSettings } from '@/hooks/useSiteLimits';
import { limitOfHost } from '@/lib/siteLimits';
import { StatusPill } from '@/shared/appChrome';

function hostOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) ? hostname : null;
  } catch {
    return null;
  }
}

/** "4:05", "12:00". */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The time left on a limited site's pass (electron/site-limits.mts), beside
 * the address bar while the page is on it, so the minutes the user chose to
 * spend there are always in view. Nothing otherwise.
 */
export function SiteLimitTimer({ url }: { url: string }) {
  const settings = useSiteLimitSettings();
  const host = hostOf(url);
  const limit = settings && host ? limitOfHost(settings.limits, host) : null;
  const until = limit ? settings?.passes[limit.site] : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);

  if (!limit || !until) return null;
  const left = Math.ceil((until - now) / 1000);
  if (left <= 0) return null;

  const minutes = Math.ceil(left / 60);
  const label = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left on ${limit.site}`;
  return (
    <StatusPill role="timer" aria-label={label} title={label} className="h-7 gap-1.5 px-3 text-xs tabular-nums">
      <Hourglass className="size-3.5" strokeWidth={1.75} aria-hidden />
      {clock(left)}
    </StatusPill>
  );
}
