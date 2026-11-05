import { useEffect, useRef } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { appForFile } from '@/lib/fileTypes';
import { getNativeAppsBridge, type NativeOpenPath } from '@/lib/nativeApps';

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Opens the links native apps open (xdg-open, the desktop portal) the way
 * the desktop's own links open: in an installed web app or the Web Browser.
 * Folders they open, and files they ask to show ("Show in Folder"), open in
 * Files; a file they open goes to the app for its kind, never run as a
 * program, as a sandboxed app could otherwise run one outside its sandbox.
 */
export function NativeLinksHost() {
  const openUrl = useOpenUrl();
  const { open } = useWindowActions();
  const live = useRef({ openUrl, open });
  useEffect(() => {
    live.current = { openUrl, open };
  });

  useEffect(() => {
    const native = getNativeAppsBridge();
    if (!native) return;
    const offUrl = native.onOpenUrl((url) => live.current.openUrl(url));
    const offPath = native.onOpenPath(({ path, kind, select }: NativeOpenPath) => {
      if (select) live.current.open('file-browser', { path: parentPath(path), select: basename(path) });
      else if (kind === 'directory') live.current.open('file-browser', { path });
      else live.current.open(appForFile(basename(path)), { path });
    });
    return () => {
      offUrl();
      offPath();
    };
  }, []);

  return null;
}
