import { useEffect, useRef } from 'react';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { getNativeAppsBridge } from '@/lib/nativeApps';

/**
 * Opens the links native apps open (xdg-open, the desktop portal) the way
 * the desktop's own links open: in an installed web app or the Web Browser.
 */
export function NativeLinksHost() {
  const openUrl = useOpenUrl();
  const openUrlRef = useRef(openUrl);
  useEffect(() => {
    openUrlRef.current = openUrl;
  }, [openUrl]);

  useEffect(() => {
    return getNativeAppsBridge()?.onOpenUrl((url) => openUrlRef.current(url));
  }, []);

  return null;
}
