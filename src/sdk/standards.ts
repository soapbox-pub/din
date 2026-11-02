/**
 * Web standards an app can use instead of `window.din`, wired to the
 * desktop by the runtime (src/sdk/runtime.ts), so a page written for the web
 * works in a Din window as it would in a browser:
 *
 * - The Media Session API (`navigator.mediaSession`) is what Din's media
 *   controls and the media keys show and drive, as `din.media` is.
 * - `document.title`, `<link rel="icon">` and `<meta name="theme-color">`
 *   are the window's title, icon and accent, as `din.window.setTitle`,
 *   `setIcon` and `setAccent` are.
 *
 * Part of the runtime's bundle, so nothing here may have side effects on
 * import.
 */
import type { MediaAction, MediaSession as DinMediaSession, Unsubscribe } from '@/sdk/din';

/** Pictures larger than this aren't passed on: the desktop gets them as data: URLs. */
const MAX_PICTURE_BYTES = 512 * 1024;

/**
 * A picture the desktop can show: data: and https URLs as they are, others
 * (the app's own din:// files, blob: URLs) read here into a data: URL.
 */
function pictureCache(onLoaded: () => void): (src: string | null | undefined) => string | null {
  const loaded = new Map<string, string | null>();
  return (src) => {
    if (!src) return null;
    let url: URL;
    try {
      url = new URL(src, location.href);
    } catch {
      return null;
    }
    if (url.protocol === 'data:' || url.protocol === 'https:') return url.href;
    if (loaded.has(url.href)) return loaded.get(url.href) ?? null;
    loaded.set(url.href, null);
    void fetch(url.href)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (blob) =>
          new Promise<string | null>((resolve) => {
            if (!blob || blob.size > MAX_PICTURE_BYTES || !blob.type.startsWith('image/')) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          }),
      )
      .catch(() => null)
      .then((data) => {
        loaded.set(url.href, data);
        if (data) onLoaded();
      });
    return null;
  };
}

/** Run `fn` once, soon, however many times this is called before then. */
function coalesce(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fn();
    });
  };
}

export interface MediaSessionHost {
  /** What's playing now, or null; called only when it changes. */
  report(session: DinMediaSession | null): void;
  /** Din's media controls and the media keys. */
  onAction(cb: (action: MediaAction) => void): Unsubscribe;
}

/**
 * Pass what the page tells `navigator.mediaSession` on to the desktop, and
 * the desktop's actions to the page's action handlers. Without a handler,
 * play and pause act on the page's `<audio>` and `<video>`, as a browser's
 * media controls do.
 */
export function bridgeMediaSession(host: MediaSessionHost): { /** Report again, whatever was last. */ refresh(): void } {
  const none = { refresh: () => {} };
  if (typeof MediaSession === 'undefined' || !navigator.mediaSession) return none;
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  let last = '';

  const elements = () => [...document.querySelectorAll<HTMLMediaElement>('audio, video')].filter((el) => el.currentSrc && !el.ended);

  const summarize = (): DinMediaSession | null => {
    const session = navigator.mediaSession;
    const metadata = session.metadata;
    if (!metadata && handlers.size === 0) return null;
    const media = elements();
    const playing = session.playbackState === 'none' ? media.some((el) => !el.paused) : session.playbackState === 'playing';
    const artwork = metadata?.artwork.length ? metadata.artwork[metadata.artwork.length - 1].src : null;
    return {
      title: metadata?.title || document.title,
      subtitle: metadata?.artist || metadata?.album || '',
      artwork: picture(artwork),
      playing,
      canPlay: handlers.has('play') || media.length > 0,
      canPrevious: handlers.has('previoustrack'),
      canNext: handlers.has('nexttrack'),
    };
  };

  const report = coalesce(() => {
    const session = summarize();
    const json = JSON.stringify(session);
    if (json === last) return;
    last = json;
    host.report(session);
  });
  const picture = pictureCache(report);

  const proto = MediaSession.prototype;
  const setActionHandler = proto.setActionHandler;
  Object.defineProperty(proto, 'setActionHandler', {
    configurable: true,
    writable: true,
    value: function (this: MediaSession, action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      setActionHandler.call(this, action, handler);
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
      report();
    },
  });
  for (const name of ['metadata', 'playbackState'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const set = descriptor?.set;
    if (!descriptor || !set) continue;
    Object.defineProperty(proto, name, {
      ...descriptor,
      set(this: MediaSession, value: unknown) {
        set.call(this, value);
        report();
      },
    });
  }
  // Changes made to the metadata object itself (metadata.title = …).
  if (typeof MediaMetadata !== 'undefined') {
    for (const name of ['title', 'artist', 'album', 'artwork'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(MediaMetadata.prototype, name);
      const set = descriptor?.set;
      if (!descriptor || !set) continue;
      Object.defineProperty(MediaMetadata.prototype, name, {
        ...descriptor,
        set(this: MediaMetadata, value: unknown) {
          set.call(this, value);
          if (navigator.mediaSession.metadata === this) report();
        },
      });
    }
  }
  for (const type of ['play', 'pause', 'ended', 'emptied']) window.addEventListener(type, report, true);

  host.onAction((action) => {
    const handler = handlers.get(action);
    if (handler) {
      try {
        handler({ action });
      } catch (e) {
        console.error('din: media session handler threw:', e);
      }
      return;
    }
    const media = elements();
    if (action === 'pause') for (const el of media) el.pause();
    else if (action === 'play') void media.reverse().find((el) => el.paused)?.play().catch(() => {});
  });

  return {
    refresh: () => {
      last = '';
      report();
    },
  };
}

export interface DocumentHeadHost {
  title(title: string | null): void;
  icon(url: string | null): void;
  accent(color: string | null): void;
}

/**
 * The window's title, icon and accent from the page's `<title>`, icon link
 * and theme-color, as a browser's tab follows them. What the page's HTML
 * starts with is the app's own (its name, its icon, its manifest's color),
 * so only changes from that are passed on, and going back to it gives the
 * window the app's again.
 */
export function watchDocumentHead(host: DocumentHeadHost): void {
  const read = () => {
    const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i][href]');
    const themeColor = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color" i][content]')].find(
      (m) => !m.media || matchMedia(m.media).matches,
    );
    return {
      title: document.title.trim(),
      icon: icons.length ? icons[icons.length - 1].href : '',
      accent: themeColor?.content.trim() ?? '',
    };
  };

  let baseline: ReturnType<typeof read> | null = null;
  const sent: { title: string | null; icon: string | null; accent: string | null } = { title: null, icon: null, accent: null };

  const update = coalesce(() => {
    if (!baseline) return;
    const now = read();
    const title = now.title && now.title !== baseline.title ? now.title : null;
    const icon = now.icon && now.icon !== baseline.icon ? picture(now.icon) : null;
    const accent = now.accent && now.accent !== baseline.accent ? now.accent : null;
    if (title !== sent.title) host.title((sent.title = title));
    if (icon !== sent.icon) host.icon((sent.icon = icon));
    if (accent !== sent.accent) host.accent((sent.accent = accent));
  });
  const picture = pictureCache(update);

  const start = () => {
    baseline = read();
    new MutationObserver(update).observe(document.head ?? document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'rel', 'name', 'content', 'media'],
    });
  };
  // The parser's work is done before the page's deferred and module scripts run.
  if (document.readyState !== 'loading') start();
  else document.addEventListener('readystatechange', start, { once: true });
}
