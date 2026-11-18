import { useEffect, useRef } from 'react';
import { BatteryLow, BatteryWarning } from 'lucide-react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useBatteryStatus } from '@/hooks/usePower';
import { formatTimeRemaining, summarizePower } from '@/lib/power';
import { closeNotificationByKey, notify } from '@/lib/notificationCenter';

/**
 * The computer's battery is low at this, very low at this, and about to run
 * out at this, in percent. UPower (os/configuration.nix) calls 10% critical
 * and puts the computer to sleep, or turns it off, at 4%.
 */
const LOW = 20;
const CRITICAL = 10;
const EMPTY = 5;
/** It's warned about again once it's been charged past this. */
const RECHARGED = 25;

const KEY = 'system-battery';

/**
 * Warns when the computer's own battery runs low, as a Mac does: once at 20%,
 * and at 10% and 5% with a warning that stays up until it's plugged in, so a
 * laptop never just goes dark. Plugging in takes the warning down. Renders
 * nothing.
 */
export function BatteryWarningHost() {
  const status = useBatteryStatus();
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  /** The lowest level warned at since it was last charged. */
  const warned = useRef<number | null>(null);

  const data = status.data;
  useEffect(() => {
    if (!data?.available) return;
    const summary = summarizePower(data);
    if (!summary || summary.percent === null) return;
    const { percent } = summary;
    const onPower =
      data.acConnected || summary.charging || summary.status === 'full' || summary.status === 'not-charging';
    if (onPower || percent > RECHARGED) {
      if (warned.current !== null) {
        warned.current = null;
        closeNotificationByKey(KEY);
      }
      return;
    }
    const level = percent <= EMPTY ? EMPTY : percent <= CRITICAL ? CRITICAL : percent <= LOW ? LOW : null;
    if (level === null || (warned.current !== null && warned.current <= level)) return;
    warned.current = level;

    const left =
      summary.secondsRemaining !== null && summary.secondsRemaining > 0
        ? `${percent}% left, about ${formatTimeRemaining(summary.secondsRemaining).toLowerCase()}.`
        : `${percent}% left.`;
    const urgent = level <= CRITICAL;
    notify({
      source: { name: 'Battery', icon: urgent ? BatteryWarning : BatteryLow },
      title:
        level === EMPTY
          ? 'Your battery is almost empty'
          : level === CRITICAL
            ? 'Your battery is very low'
            : 'Your battery is low',
      body: urgent
        ? `${left} Plug in now, or your computer will turn off soon. Save your work.`
        : `${left} Plug in soon.`,
      urgency: urgent ? 'critical' : 'normal',
      replaceKey: KEY,
      onActivate: () => openRef.current('settings', { section: 'power' }),
    });
  }, [data]);

  return null;
}
