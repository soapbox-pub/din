import { useEffect, useRef, useState } from 'react';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { notify } from '@/lib/notificationCenter';
import { getPrintingBridge, onShowPrintDialog, type PrintDocument } from '@/lib/printing';
import { PrintDialog } from './PrintDialog';

const SOURCE = { appId: 'settings', name: 'Printing' };

/**
 * Desktop-lifetime host for printing: the print dialog, for pages that ask
 * (window.print(), Ctrl+P, the browser's menu) and files from Files and
 * Preview, one at a time; and a word when a printer stops with a job
 * waiting (out of paper, offline), and when that job prints after all.
 *
 * Renders nothing outside the Electron shell.
 */
export function PrintHost() {
  const [queue, setQueue] = useState<PrintDocument[]>([]);
  const { open } = useWindowActions();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    const bridge = getPrintingBridge();
    if (!bridge) return;
    // Dialogs from before a reload are gone.
    void bridge.reset();
    const add = (document: PrintDocument) => setQueue((q) => [...q, document]);
    const offOpen = bridge.onOpen(add);
    const offShow = onShowPrintDialog(add);
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

  const current = queue[0];
  if (!current) return null;
  return (
    <PrintDialog
      key={current.id}
      document={current}
      onClose={() => setQueue((q) => q.filter((d) => d.id !== current.id))}
    />
  );
}
