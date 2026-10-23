import { useEffect, useRef } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { notify } from '@/lib/notificationCenter';
import { getVolumesBridge } from '@/lib/volumes';

const SOURCE = { appId: 'file-browser', name: 'Files' };

/**
 * Tells the user about removable disks: one plugged in is ready (click to
 * open it in Files), one ejected is safe to unplug, one pulled out while
 * mounted should have been ejected first, and one that can't be read.
 */
export function VolumesHost() {
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    const volumes = getVolumesBridge();
    if (!volumes) return;
    return volumes.onEvent((event) => {
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
  }, []);

  return null;
}
