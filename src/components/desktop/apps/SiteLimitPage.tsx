import { useEffect, useState } from 'react';
import { Ban, Hourglass, Timer } from 'lucide-react';
import { useSiteLimitBlock } from '@/hooks/useSiteLimits';
import { formatMinutes, formatSpent, getSiteLimitsBridge, type SiteLimitBlock } from '@/lib/siteLimits';
import { Button } from '@/components/ui/button';
import { Host, Interstitial } from '@/components/desktop/apps/BrowserInterstitial';

/** "1st", "2nd", "3rd", "11th", "22nd". */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Seconds left on a page's countdown, ticking down to 0. */
function useCountdown(block: SiteLimitBlock | null): number {
  const end = block ? block.since + block.wait * 1000 : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [end]);
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/**
 * What stands in for a site the user limited (electron/site-limits.mts), over
 * a browser tab or an installed app's window that tried to go there. Closing
 * is the easy way out; going in waits out a countdown that grows with each
 * try that day, then is only for a few minutes. A blocked site has no way in.
 * Renders nothing while the guest isn't stopped.
 */
export function SiteLimitPage({
  wcId,
  closeLabel,
  onClose,
}: {
  /** The guest it covers, or null before it attaches. */
  wcId: number | null;
  /** "Close tab", "Close window". */
  closeLabel: string;
  onClose: () => void;
}) {
  const block = useSiteLimitBlock(wcId);
  const left = useCountdown(block);
  const [error, setError] = useState(false);

  if (!block) return null;
  const bridge = getSiteLimitsBridge();
  const ready = left === 0;

  const allow = (minutes: number) => {
    setError(false);
    bridge?.allow(block.wcId, minutes).catch(() => setError(true));
  };

  const tries =
    block.attempts > 1 ? (
      <p>
        This is your {ordinal(block.attempts)} try today
        {block.seconds >= 60 ? <>, and you've spent {formatSpent(block.seconds)} there.</> : '.'}
      </p>
    ) : null;

  const content =
    block.mode === 'pause'
      ? {
          icon: <Hourglass className="size-8" strokeWidth={1.5} />,
          title: 'Take a breath',
          body: (
            <>
              <p>
                You asked Din to pause before opening <Host>{block.site}</Host>. Is it what you want to
                be doing right now?
              </p>
              {tries}
            </>
          ),
        }
      : block.mode === 'daily'
        ? {
            icon: <Timer className="size-8" strokeWidth={1.5} />,
            title: 'Your time is up for today',
            body: (
              <>
                <p>
                  You gave <Host>{block.site}</Host> {formatMinutes(block.minutes)} a day, and you've had
                  them. It opens again tomorrow.
                </p>
                {tries}
              </>
            ),
          }
        : {
            icon: <Ban className="size-8" strokeWidth={1.5} />,
            title: `${block.site} is blocked`,
            body: (
              <>
                <p>You blocked this site to keep your time for other things.</p>
                <p className="text-base">You can change that in the Web Browser's settings.</p>
              </>
            ),
          };

  const progress = block.wait > 0 ? 1 - left / block.wait : 1;

  return (
    <Interstitial
      icon={content.icon}
      title={content.title}
      details={[['Address', block.url]]}
      actions={
        <>
          <Button size="lg" onClick={onClose} autoFocus>
            {closeLabel}
          </Button>
          {block.canStay && (
            <Button size="lg" variant="ghost" onClick={() => void bridge?.dismiss(block.wcId).catch(() => {})}>
              Go back
            </Button>
          )}
          {ready &&
            block.passes.map((minutes) => (
              <Button key={minutes} size="lg" variant="outline" onClick={() => allow(minutes)}>
                {block.mode === 'daily' ? `${minutes} more minutes` : `Open for ${minutes} minutes`}
              </Button>
            ))}
        </>
      }
    >
      {content.body}
      {block.passes.length > 0 && (
        <div className="space-y-2 pt-2">
          <div
            aria-hidden
            className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
          >
            <div
              className="h-full rounded-full bg-pigment motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-linear"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="text-base" aria-live="polite">
            {ready ? (
              'You can go in now, for a little while.'
            ) : (
              <>
                <span className="sr-only">Wait a moment before you can go in.</span>
                <span aria-hidden className="tabular-nums">
                  You can go in in {left} {left === 1 ? 'second' : 'seconds'}.
                </span>
              </>
            )}
          </p>
          {error && <p className="text-base text-destructive">That didn't work. Try again.</p>}
        </div>
      )}
    </Interstitial>
  );
}
