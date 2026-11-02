import { useEffect, useRef } from 'react';
import { BatteryLow, BatteryWarning } from 'lucide-react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useBatteryStatus } from '@/hooks/usePower';
import { closeNotificationByKey, notify } from '@/lib/notificationCenter';

/** A device's battery is low at this, and nearly empty at this, in percent. */
const LOW = 10;
const EMPTY = 2;
/** It's warned about again once it's been charged past this. */
const RECHARGED = 15;

/**
 * Warns when a mouse's or keyboard's battery runs low, as a Mac does: once
 * when it's down to 10%, and again, staying up, when it's nearly empty.
 * Renders nothing.
 */
export function DeviceBatteryHost() {
  const status = useBatteryStatus();
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);
  /** The lowest level each device was warned at, by its kernel name. */
  const warned = useRef(new Map<string, number>());

  const devices = status.data?.devices;
  useEffect(() => {
    for (const device of devices ?? []) {
      const key = `device-battery:${device.name}`;
      const charging = device.status === 'charging' || device.status === 'full';
      if (device.percent === null) continue;
      if (charging || device.percent > RECHARGED) {
        if (warned.current.delete(device.name)) closeNotificationByKey(key);
        continue;
      }
      const level = device.percent <= EMPTY ? EMPTY : device.percent <= LOW ? LOW : null;
      const before = warned.current.get(device.name);
      if (level === null || (before !== undefined && before <= level)) continue;
      warned.current.set(device.name, level);
      const empty = level === EMPTY;
      notify({
        source: { name: 'Battery', icon: empty ? BatteryWarning : BatteryLow },
        title: empty ? `${device.label} is almost out of battery` : `${device.label}’s battery is low`,
        body: `${device.percent}% left. Charge it soon${empty ? ', or it will turn off' : ''}.`,
        urgency: empty ? 'critical' : 'normal',
        replaceKey: key,
        onActivate: () => openRef.current('settings', { section: 'power' }),
      });
    }
  }, [devices]);

  return null;
}
