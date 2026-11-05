import { useEffect, useRef } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { notify } from '@/lib/notificationCenter';
import { getPrintingBridge, onShowPrintDialog, PRINT_WINDOW_APP_ID, type PrintDocument } from '@/lib/printing';

const SOURCE = { appId: 'settings', name: 'Printing' };

/**
 * Desktop-lifetime host for printing: a print window for each page that
 * asks (window.print(), Ctrl+P, the browser's menu) and each file from Files
 * and Preview (src/components/desktop/apps/PrintWindow.tsx); and a word
 * when a printer stops with a job waiting (out of paper, offline), and when
 * that job prints after all.
 *
 * Renders nothing; does nothing outside the Electron shell.
 */
export function PrintHost() {
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    const bridge = getPrintingBridge();
    if (!bridge) return;
    // Print windows from before a reload are gone (they're never restored).
    void bridge.reset();
    const show = (document: PrintDocument) => openRef.current(PRINT_WINDOW_APP_ID, { document });
    const offOpen = bridge.onOpen(show);
    const offShow = onShowPrintDialog(show);
    const offEvent = bridge.onEvent((event) => {
      const replaceKey = `print:${event.printer}:${event.title}`;
      if (event.type === 'problem') {
        notify({
          source: SOURCE,
          title: `${event.printer}: ${event.problem}`,
          body: `“${event.title}” will print once it’s sorted out.`,
          replaceKey,
          onActivate: () => openRef.current('settings', { section: 'printers' }),
        });
      } else {
        notify({ source: SOURCE, title: `“${event.title}” printed`, body: event.printer, replaceKey });
      }
    });
    return () => {
      offOpen();
      offShow();
      offEvent();
    };
  }, []);

  return null;
}
