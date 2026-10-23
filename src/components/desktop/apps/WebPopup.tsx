import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, Lock, VenetianMask } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import {
  BrowserView,
  WEBBROWSER_PARTITION,
  WEBBROWSER_PRIVATE_PARTITION,
  type BrowserViewHandle,
  type LoadErrorInfo,
} from '@/components/desktop/apps/BrowserView';
import { LoadErrorPage } from '@/components/desktop/apps/WebBrowser';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { consumeTabCommands, publishTabCommand } from '@/lib/browserTabBus';
import { isAllowedTabUrl } from '@/lib/crx';
import { getShellShortcuts } from '@/lib/shellShortcuts';

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * A pop-up window a page opened with window.open and a size - a sign-in
 * window, a share dialog - shown the way Chrome shows one: a small window
 * with the page's address, read-only, over a single page. No tabs, no
 * navigation controls.
 *
 * Opened by BrowserExtensionHost with launch params `url`, `openerWcId` (the
 * page that opened it) and `private`. The page is linked to its opener by the
 * main process (electron/popups.mts) - window.opener, postMessage and the
 * opener watching it close all work - and lives in the opener's browser
 * session: private if it came from a private window, the browser's otherwise.
 *
 * Its page's guest consumes the tab commands bound to it: the opener focusing
 * or closing it, and links it opens in new tabs, which go on to its opener's
 * browser window.
 */
export function WebPopup({ windowId, params }: AppComponentProps) {
  const { close: closeWindow, focus: focusWindow } = useWindowActions();
  const initialUrl = typeof params?.url === 'string' && isAllowedTabUrl(params.url) ? params.url : null;
  const openerWcId = typeof params?.openerWcId === 'number' ? params.openerWcId : undefined;
  const isPrivate = params?.private === true;

  const viewRef = useRef<BrowserViewHandle>(null);
  const [url, setUrl] = useState(initialUrl ?? '');
  const [title, setTitle] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<LoadErrorInfo | null>(null);
  const [wcId, setWcId] = useState<number | null>(null);
  const wcIdRef = useRef<number | null>(null);

  useWindowTitle(title || hostnameOf(url) || 'Pop-up');

  const close = useCallback(() => closeWindow(windowId), [closeWindow, windowId]);

  useEffect(() => {
    return consumeTabCommands(
      (command) => {
        switch (command.type) {
          case 'select':
            focusWindow(windowId);
            break;
          case 'close':
            close();
            break;
          case 'open':
            // A link the pop-up opens in a new tab goes where its opener's
            // would: its browser window, and so its session.
            publishTabCommand({ ...command, openerWcId });
            break;
        }
      },
      (id) => id === wcIdRef.current,
      true,
    );
  }, [focusWindow, windowId, close, openerWcId]);

  // Browser keys pressed in the page (focus is in the guest, so the main
  // process forwards them): the ones that make sense with no tabs.
  useEffect(() => {
    const bridge = getShellShortcuts();
    if (!bridge || wcId === null) return;
    return bridge.onShortcut((shortcut) => {
      if (!('wcId' in shortcut) || shortcut.wcId !== wcId) return;
      if (shortcut.action === 'close-tab' || shortcut.action === 'close-window') close();
      else if (shortcut.action === 'reload') {
        if (shortcut.force) viewRef.current?.reloadIgnoringCache();
        else viewRef.current?.reload();
      }
    });
  }, [wcId, close]);

  const onWebContentsId = useCallback((id: number) => {
    wcIdRef.current = id;
    setWcId(id);
  }, []);
  const onNavigate = useCallback((next: string) => {
    setUrl(next);
    setLoadError(null);
  }, []);
  const onTitleChange = useCallback((next: string) => setTitle(next), []);
  const onLoadError = useCallback((info: LoadErrorInfo) => setLoadError(info), []);

  if (!initialUrl) {
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6 text-center">
        <p className="max-w-xs text-sm text-muted-foreground">This pop-up has no page to show.</p>
      </div>
    );
  }

  const secure = url.startsWith('https:') || url.startsWith('nsite:');
  const SiteIcon = secure ? Lock : Globe;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <SiteIcon
          className="size-3.5 shrink-0"
          aria-label={secure ? 'Secure connection' : 'Not secure'}
        />
        <span className="min-w-0 flex-1 select-text truncate" title={url}>
          {url}
        </span>
        {isPrivate && (
          <span
            className="flex shrink-0 items-center gap-1 font-medium text-foreground/80"
            title="Private window - history and cookies are discarded when it closes"
          >
            <VenetianMask className="size-3.5" aria-hidden />
            Private
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <BrowserView
          ref={viewRef}
          src={initialUrl}
          partition={isPrivate ? WEBBROWSER_PRIVATE_PARTITION : WEBBROWSER_PARTITION}
          onNavigate={onNavigate}
          onTitleChange={onTitleChange}
          onLoadError={onLoadError}
          onWebContentsId={onWebContentsId}
        />
        {loadError && (
          <LoadErrorPage
            info={loadError}
            onRetry={() => {
              setLoadError(null);
              viewRef.current?.loadURL(loadError.url || url);
            }}
          />
        )}
      </div>
    </div>
  );
}
