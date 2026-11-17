import { useEffect } from 'react';
import { useInstallerStatus } from '@/hooks/useInstaller';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/** Set once Customize has opened by itself on this computer, so it only ever does once. */
const OPENED_KEY = 'customize:auto-opened';

/**
 * Opens Customize the first time the desktop comes up on this computer, so
 * someone new to Din starts by making it theirs. Not on a live USB boot,
 * which opens the Installer instead (InstallerAutoOpen), and keeps nothing.
 */
export function CustomizeAutoOpen() {
  const installer = useInstallerStatus();
  const { open } = useWindowActions();
  // Unknown until the installer answers, where there's one to ask.
  const known = !installer.isLoading;
  const live = installer.data?.available === true && installer.data.live;

  useEffect(() => {
    if (!known || live || localStorage.getItem(OPENED_KEY)) return;
    localStorage.setItem(OPENED_KEY, '1');
    open('customize');
  }, [known, live, open]);

  return null;
}
