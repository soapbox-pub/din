import { useEffect, useRef, useState } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { closeNotificationByKey, notify } from '@/lib/notificationCenter';
import { getVolumesBridge } from '@/lib/volumes';
import { UnlockVolumeDialog, type LockedVolume } from '@/shared/UnlockVolumeDialog';

const SOURCE = { appId: 'file-browser', name: 'Files' };

const lockedKey = (id: string) => `volume-locked:${id}`;

/**
 * Tells the user about removable disks: one plugged in is ready (click to
 * open it in Files), one encrypted is locked (click to unlock it, and it
 * goes once it's unlocked from anywhere), one ejected is safe to unplug, one
 * pulled out while mounted should have been ejected first, and one that
 * can't be read.
 */
export function VolumesHost() {
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  const [unlocking, setUnlocking] = useState<LockedVolume | null>(null);

  useEffect(() => {
    const volumes = getVolumesBridge();
    if (!volumes) return;
    /** Locked disks with a notification up. */
    const told = new Set<string>();
    const offChanged = volumes.onChanged((state) => {
      for (const id of told) {
        if (state.volumes.some((v) => v.id === id && v.locked)) continue;
        told.delete(id);
        closeNotificationByKey(lockedKey(id));
        setUnlocking((current) => (current?.id === id ? null : current));
      }
    });
    const offEvent = volumes.onEvent((event) => {
      const replaceKey = `volume:${event.name}`;
      switch (event.type) {
        case 'mounted':
          notify({
            source: SOURCE,
            title: `“${event.name}” is ready`,
            body: 'Click to open it in Files.',
            replaceKey,
            onActivate: () => openRef.current('file-browser', { path: event.mountPoint }),
          });
          return;
        case 'locked': {
          const volume = { id: event.id, name: event.name };
          told.add(event.id);
          notify({
            source: SOURCE,
            title: `“${event.name}” is encrypted`,
            body: 'Click to enter its passphrase and open it.',
            replaceKey: lockedKey(event.id),
            resident: true,
            onActivate: () => setUnlocking(volume),
            onClose: () => told.delete(event.id),
          });
          return;
        }
        case 'ejected':
          notify({
            source: SOURCE,
            title: `“${event.name}” can be removed`,
            body: 'It’s safe to unplug it now.',
            replaceKey,
          });
          return;
        case 'pulled':
          notify({
            source: SOURCE,
            title: 'Disk not ejected properly',
            body: `Eject “${event.name}” before unplugging it, or files on it may be lost.`,
            replaceKey,
          });
          return;
        case 'unreadable':
          notify({
            source: SOURCE,
            title: `Can’t open “${event.name}”`,
            body: event.error,
            replaceKey,
          });
      }
    });
    return () => {
      offChanged();
      offEvent();
    };
  }, []);

  return (
    <UnlockVolumeDialog
      volume={unlocking}
      onClose={() => setUnlocking(null)}
      onUnlocked={(mountPoint) => {
        setUnlocking(null);
        openRef.current('file-browser', { path: mountPoint });
      }}
    />
  );
}
