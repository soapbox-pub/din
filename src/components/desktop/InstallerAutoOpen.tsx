import { useEffect } from 'react';
import { useIsLiveBoot } from '@/hooks/useInstaller';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/** Set once the Installer has been opened this boot, so a re-login doesn't reopen it. */
const OPENED_KEY = 'installer:auto-opened';

/** On a live USB boot, opens the Installer when the desktop first comes up. */
export function InstallerAutoOpen() {
  const live = useIsLiveBoot();
  const { open } = useWindowActions();

  useEffect(() => {
    if (!live || sessionStorage.getItem(OPENED_KEY)) return;
    sessionStorage.setItem(OPENED_KEY, '1');
    open('installer');
  }, [live, open]);

  return null;
}
