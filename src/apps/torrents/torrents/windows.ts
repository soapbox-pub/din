import { useEffect } from 'react';
import { appLink } from '@/shared/launch';

/**
 * The windows Torrents opens beside its own, by their `window` launch
 * param: adding a torrent (`magnet`, or a .torrent file handed to it) and
 * the settings. They tell the main window what came of them over a
 * BroadcastChannel.
 */
export type TorrentsWindow = { window: 'add'; magnet?: string } | { window: 'settings' };

export const ADD_WINDOW_SIZE = { width: 560, height: 600 };
const SETTINGS_SIZE = { width: 560, height: 680 };

export function openTorrentsWindow(kind: TorrentsWindow): void {
  void window.open(appLink(null, { ...kind, floating: true, ...(kind.window === 'add' ? ADD_WINDOW_SIZE : SETTINGS_SIZE) }));
}

/** What a window tells the main one: a transfer it added, to show. */
export type TorrentsWindowMessage = { type: 'added'; id: number };

const CHANNEL = 'torrents';

export function announce(message: TorrentsWindowMessage): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(message);
  channel.close();
}

export function useTorrentsWindowMessages(onMessage: (message: TorrentsWindowMessage) => void): void {
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<TorrentsWindowMessage>) => onMessage(e.data);
    return () => channel.close();
  }, [onMessage]);
}
