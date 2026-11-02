import { useEffect, useLayoutEffect, useRef } from 'react';
import { Share2 } from 'lucide-react';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { appForFile } from '@/lib/fileTypes';
import { parentPath } from '@/lib/fs';
import { closeNotificationByKey, notify, updateNotificationByKey, type NotifyInput } from '@/lib/notificationCenter';
import { getQuickShareBridge, isOpenableLink, type QuickShareTransfer } from '@/lib/quickShare';

/**
 * What nearby devices share over Quick Share (electron/quickshare.mts), as
 * one notification per share. First it asks, with the code the sender's
 * screen shows too: anyone on the network could be sending, so nothing
 * arrives until the user accepts, and only the user can (not the din
 * command). Then progress with Cancel, then what arrived, with Open or Show
 * in Files, or Open for a link.
 */
export function QuickShareHost() {
  const { open } = useWindowManager();
  const openUrl = useOpenUrl();
  const live = useRef({ open, openUrl });
  useLayoutEffect(() => {
    live.current = { open, openUrl };
  });

  useEffect(() => {
    const quickShare = getQuickShareBridge();
    if (!quickShare) return;
    const source = { name: 'Quick Share', icon: Share2 };
    const key = (id: string) => `quick-share:${id}`;

    const what = (t: QuickShareTransfer): string => {
      if (t.offer.text) return t.offer.text.kind === 'url' ? 'a link' : 'some text';
      const files = t.offer.files;
      return files.length === 1 ? files[0].name : `${files.length} files`;
    };

    const progress = (t: QuickShareTransfer): Pick<NotifyInput, 'title' | 'body' | 'progress'> => ({
      title: `Receiving ${what(t)}`,
      body: `From ${t.device}`,
      progress: t.total ? t.transferred / t.total : null,
    });

    const ask = (t: QuickShareTransfer) => {
      const preview = t.offer.text?.title ? `: “${t.offer.text.title}”` : '';
      notify({
        source,
        title: `${t.device} wants to share ${what(t)}`,
        body: `Code ${t.pin}. Check it’s the code on ${t.device}${preview}`,
        replaceKey: key(t.id),
        actions: [
          { id: 'accept', label: 'Accept' },
          { id: 'decline', label: 'Decline' },
        ],
        timeout: 0,
        resident: true,
        onScreenOnly: true,
        onActivate: (action) => {
          if (action === 'accept' || action === 'decline') void quickShare.respond(t.id, action === 'accept').catch(() => {});
        },
        onClose: (reason) => {
          if (reason === 'dismissed') void quickShare.respond(t.id, false).catch(() => {});
        },
      });
    };

    const showProgress = (t: QuickShareTransfer) =>
      notify({
        source,
        ...progress(t),
        replaceKey: key(t.id),
        actions: [{ id: 'cancel', label: 'Cancel' }],
        timeout: 0,
        resident: true,
        onActivate: (action) => {
          if (action === 'cancel') void quickShare.cancel(t.id).catch(() => {});
        },
      });

    const showResult = (t: QuickShareTransfer) => {
      if (t.status === 'cancelled' || t.status === 'declined') return closeNotificationByKey(key(t.id));
      if (t.status === 'failed') {
        notify({ source, title: `Couldn’t receive ${what(t)} from ${t.device}`, body: t.error ?? 'It stopped sending.', replaceKey: key(t.id) });
        return;
      }
      if (t.url) {
        const url = t.url;
        const openable = isOpenableLink(url);
        notify({
          source,
          title: `Link from ${t.device}`,
          body: url,
          replaceKey: key(t.id),
          actions: openable ? [{ id: 'open', label: 'Open' }] : [],
          onActivate: () => {
            if (openable) live.current.openUrl(url);
          },
        });
        return;
      }
      const missed = t.failed.length
        ? `${t.failed.length === 1 ? `${t.failed[0]} didn’t arrive` : `${t.failed.length} didn’t arrive`}${t.error ? `: ${t.error}` : '.'}`
        : '';
      const single = t.files.length === 1 ? t.files[0] : null;
      const last = t.files[t.files.length - 1];
      const showFile = (file: { name: string; path: string }) => live.current.open(appForFile(file.name), { path: file.path });
      const showInFiles = (file: { name: string; path: string }) =>
        live.current.open('file-browser', { path: parentPath(file.path), select: file.name });
      notify({
        source,
        title: single ? `Received ${single.name}` : `Received ${t.files.length} files`,
        body: [`From ${t.device}, in Downloads.`, missed].filter(Boolean).join(' '),
        replaceKey: key(t.id),
        actions: single ? [{ id: 'open', label: 'Open' }, { id: 'show', label: 'Show in Files' }] : [{ id: 'show', label: 'Show in Files' }],
        onActivate: (action) => {
          if (single && action !== 'show') showFile(single);
          else showInFiles(last);
        },
      });
    };

    /** Shares whose progress is on screen. */
    const shown = new Set<string>();
    return quickShare.onTransfer((t) => {
      if (t.status === 'asking') return ask(t);
      if (t.status === 'receiving') {
        if (shown.has(t.id)) updateNotificationByKey(key(t.id), progress(t));
        else {
          shown.add(t.id);
          showProgress(t);
        }
        return;
      }
      shown.delete(t.id);
      showResult(t);
    });
  }, []);

  return null;
}
