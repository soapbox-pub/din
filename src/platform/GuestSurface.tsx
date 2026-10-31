import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, Ref, RefObject } from 'react';
import { activeFileDrag, fileDragActive, subscribeFileDrag } from '@/components/desktop/apps/files/dnd';
import { useAppContext } from '@/hooks/useAppContext';
import { useWindowVisible } from '@/contexts/WindowVisibleContext';
import { createGuest, guest, GUEST_EVENTS, guestId, isGuestFullscreen, type GuestElement } from '@/platform/guest';

/** Imperative controls of a guest surface. */
export interface GuestSurfaceHandle {
  /** The host element, once mounted (for platform helpers like `guestFrame`). */
  element(): GuestElement | null;
  /** The guest's id, once attached. */
  id(): number | null;
  reload(): void;
  reloadIgnoringCache(): void;
  loadURL(url: string): void;
  goBack(): void;
  goForward(): void;
  focus(): void;
  /** Put the page in full screen, or take it out. */
  toggleFullscreen(): void;
  /** Run script in the page: Din's own probes of web pages only, never of apps. */
  executeJavaScript(code: string): Promise<unknown>;
  /** Style the current document: Din's own styles only (the blank page's backdrop). */
  insertCSS(css: string): Promise<void>;
}

/** A network-level load failure of the main frame. */
export interface GuestLoadError {
  /** The URL as the engine reported it. */
  url: string;
  errorCode: number;
  errorDescription: string;
}

export interface GuestSurfaceProps {
  ref?: Ref<GuestSurfaceHandle>;
  /** The first URL; later navigations go through `loadURL`, keeping the guest's history. */
  src: string;
  /** The session partition, fixed for the surface's lifetime. */
  partition: string;
  /** Extra attach-time preferences main reads (the installed-app mark). Fixed. */
  webpreferences?: string;
  /** Let the page open windows (main routes them). Fixed. */
  allowPopups?: boolean;
  /** Classes for the guest element. Fixed. */
  guestClassName?: string;
  className?: string;
  style?: CSSProperties;
  /** The page's own zoom on top of the interface zoom. */
  pageZoom?: number;
  /** The caller is hiding the surface (a background tab); the page is told it's hidden. */
  hidden?: boolean;
  /**
   * Take files dragged from Files over the page and drop them into it as
   * real files (they'd otherwise arrive as paths the page can't open).
   */
  acceptFileDrops?: boolean;
  onAttach?: (id: number) => void;
  onDomReady?: () => void;
  onLoadStart?: () => void;
  onLoadEnd?: () => void;
  onLoadError?: (error: GuestLoadError) => void;
  onTitle?: (title: string) => void;
  onFavicons?: (favicons: string[]) => void;
  onThemeColor?: (color: string | null) => void;
  /** A committed main-frame navigation: the URL, the raw current URL, and history. */
  onNavigate?: (url: string, currentUrl: string, canGoBack: boolean, canGoForward: boolean) => void;
  /** The guest's renderer went away (crashed, killed, out of memory). */
  onGone?: () => void;
}

/**
 * The one component that embeds a guest: a built-in app, an nsite, a web
 * page, an extension popup, DevTools. It owns the engine element and keeps
 * it in step with the desktop: zoom, visibility, and (opt-in) file drops.
 */
export function GuestSurface({
  ref,
  src,
  partition,
  webpreferences,
  allowPopups = false,
  guestClassName = 'h-full w-full',
  className,
  style,
  pageZoom = 1,
  hidden = false,
  acceptFileDrops = false,
  onAttach,
  onDomReady,
  onLoadStart,
  onLoadEnd,
  onLoadError,
  onTitle,
  onFavicons,
  onThemeColor,
  onNavigate,
  onGone,
}: GuestSurfaceProps) {
  const windowVisible = useWindowVisible();
  const pageHidden = hidden || !windowVisible;
  const { config } = useAppContext();
  const zoomFactor = (config.zoomLevel / 100) * pageZoom;
  const containerRef = useRef<HTMLDivElement>(null);
  const elRef = useRef<GuestElement | null>(null);
  const initial = useRef({ src, partition, webpreferences, allowPopups, guestClassName });

  // Built off-DOM and appended fully configured: see createGuest.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || elRef.current) return;
    const el = createGuest({
      src: initial.current.src,
      partition: initial.current.partition,
      webpreferences: initial.current.webpreferences,
      allowPopups: initial.current.allowPopups,
      className: initial.current.guestClassName,
    });
    elRef.current = el;
    container.appendChild(el);
    return () => {
      el.remove();
      elRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    element: () => elRef.current,
    id: () => (elRef.current ? guestId(elRef.current) : null),
    reload: () => elRef.current && guest.reload(elRef.current),
    reloadIgnoringCache: () => elRef.current && guest.reloadIgnoringCache(elRef.current),
    loadURL: (url) => {
      // Aborted and failed loads reject; the load-error event reports them.
      if (elRef.current) guest.loadURL(elRef.current, url).catch(() => {});
    },
    goBack: () => elRef.current && guest.goBack(elRef.current),
    goForward: () => elRef.current && guest.goForward(elRef.current),
    focus: () => elRef.current?.focus(),
    toggleFullscreen: () => {
      if (elRef.current) void guest.toggleFullscreen(elRef.current);
    },
    executeJavaScript: (code) =>
      elRef.current ? guest.executeJavaScript(elRef.current, code) : Promise.reject(new Error('No guest')),
    insertCSS: async (css) => {
      if (elRef.current) await guest.insertCSS(elRef.current, css);
    },
  }), []);

  useGuestEvent(elRef, GUEST_EVENTS.loadStart, onLoadStart && (() => onLoadStart()));
  useGuestEvent(elRef, GUEST_EVENTS.loadStop, onLoadEnd && (() => onLoadEnd()));
  useGuestEvent(elRef, GUEST_EVENTS.domReady, onDomReady && (() => onDomReady()));
  // Subframe failures and aborts (-3: navigated again, became a download)
  // aren't page-level errors.
  useGuestEvent(elRef, GUEST_EVENTS.loadFail, onLoadError && ((e) => {
    const { errorCode, errorDescription, validatedURL, isMainFrame } = e as Event & {
      errorCode?: number;
      errorDescription?: string;
      validatedURL?: string;
      isMainFrame?: boolean;
    };
    if (isMainFrame === false || errorCode === -3) return;
    onLoadError({
      url: typeof validatedURL === 'string' ? validatedURL : '',
      errorCode: typeof errorCode === 'number' ? errorCode : 0,
      errorDescription: typeof errorDescription === 'string' ? errorDescription : '',
    });
  }));
  useGuestEvent(elRef, GUEST_EVENTS.title, onTitle && ((e) => {
    const { title } = e as Event & { title?: string };
    if (typeof title === 'string') onTitle(title);
  }));
  useGuestEvent(elRef, GUEST_EVENTS.favicon, onFavicons && ((e) => {
    const { favicons } = e as Event & { favicons?: string[] };
    if (Array.isArray(favicons)) onFavicons(favicons);
  }));
  useGuestEvent(elRef, GUEST_EVENTS.themeColor, onThemeColor && ((e) => {
    const { themeColor } = e as Event & { themeColor?: string | null };
    onThemeColor(typeof themeColor === 'string' ? themeColor : null);
  }));
  const reportNavigation = (el: GuestElement, url: unknown) => {
    if (typeof url !== 'string' || !onNavigate) return;
    onNavigate(url, guest.getURL(el), guest.canGoBack(el), guest.canGoForward(el));
  };
  useGuestEvent(elRef, GUEST_EVENTS.navigate, onNavigate && ((e, el) => reportNavigation(el, (e as Event & { url?: string }).url)));
  useGuestEvent(elRef, GUEST_EVENTS.navigateInPage, onNavigate && ((e, el) => {
    const { url, isMainFrame } = e as Event & { url?: string; isMainFrame?: boolean };
    if (isMainFrame) reportNavigation(el, url);
  }));
  useGuestEvent(elRef, GUEST_EVENTS.gone, onGone && (() => onGone()));

  // The id once the guest attaches (dom-ready covers a missed did-attach).
  useEffect(() => {
    const el = elRef.current;
    if (!el || !onAttach) return;
    const attached = () => {
      const id = guestId(el);
      if (id !== null) onAttach(id);
    };
    el.addEventListener(GUEST_EVENTS.attach, attached);
    el.addEventListener(GUEST_EVENTS.domReady, attached);
    return () => {
      el.removeEventListener(GUEST_EVENTS.attach, attached);
      el.removeEventListener(GUEST_EVENTS.domReady, attached);
    };
  }, [onAttach]);

  // The engine doesn't pass the shell frame's zoom on to guests, and a
  // mismatch also offsets the guest's hit-testing; it resets on navigation,
  // so it's reapplied on every dom-ready.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const apply = () => {
      guest.setZoom(el, zoomFactor);
    };
    apply();
    el.addEventListener(GUEST_EVENTS.domReady, apply);
    return () => el.removeEventListener(GUEST_EVENTS.domReady, apply);
  }, [zoomFactor]);

  // A guest is handed its window's visibility by the engine, so a background
  // tab or a minimized window's page would think it's showing (see
  // guestVisibility in electron/main.mts). Restated once it attaches.
  useEffect(() => {
    const el = elRef.current;
    const bridge = window.dinos?.guestVisibility;
    if (!el || !bridge) return;
    const report = () => {
      const id = guestId(el);
      if (id !== null) bridge.set(id, pageHidden);
    };
    report();
    el.addEventListener(GUEST_EVENTS.attach, report);
    el.addEventListener(GUEST_EVENTS.domReady, report);
    return () => {
      el.removeEventListener(GUEST_EVENTS.attach, report);
      el.removeEventListener(GUEST_EVENTS.domReady, report);
    };
  }, [pageHidden]);

  // A fullscreen page that stops showing (its tab went to the background, its
  // window was minimized or hidden) would stay fullscreen out of sight, and
  // Blink would keep the rest of the desktop inert, ignoring every click and
  // key. It leaves fullscreen.
  useEffect(() => {
    const el = elRef.current;
    if (!pageHidden || !el || !isGuestFullscreen(el)) return;
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    guest.executeJavaScript(el, 'document.fullscreenElement && document.exitFullscreen().catch(() => {})').catch(() => {});
  }, [pageHidden]);

  // Files dragged from Files: the drag goes to the page as paths it can't
  // open, so the desktop covers the page and has main drop the files
  // themselves into it (see guestFileDrop in electron/main.mts).
  const fileDrag = useSyncExternalStore(subscribeFileDrag, fileDragActive);
  const fileDropBridge = acceptFileDrops ? window.dinos?.guestFileDrop : undefined;
  const sendFileDrag = (type: 'over' | 'drop' | 'cancel', event: React.DragEvent<HTMLElement>) => {
    const el = elRef.current;
    const id = el ? guestId(el) : null;
    if (id === null || !fileDropBridge) return;
    // The page's CSS pixels: the shell's, through any transform on the
    // window, then the page's own zoom on top of the interface zoom.
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = rect.width > 0 ? event.currentTarget.clientWidth / rect.width : 1;
    const scaleY = rect.height > 0 ? event.currentTarget.clientHeight / rect.height : 1;
    const x = ((event.clientX - rect.left) * scaleX) / pageZoom;
    const y = ((event.clientY - rect.top) * scaleY) / pageZoom;
    fileDropBridge.send(id, type, x, y, activeFileDrag(event)?.paths ?? []);
  };
  // A drag that ended without leaving the page still lets go of it.
  useEffect(() => {
    const el = elRef.current;
    const id = el ? guestId(el) : null;
    if (fileDrag || id === null || !fileDropBridge) return;
    fileDropBridge.send(id, 'cancel', 0, 0, []);
  }, [fileDrag, fileDropBridge]);

  return (
    <div className={className ?? 'relative h-full w-full'} style={{ display: 'flex', ...style }}>
      <div ref={containerRef} className="h-full w-full" style={{ display: 'flex' }} />
      {fileDrag && fileDropBridge && (
        <div
          className="absolute inset-0 z-10"
          onDragOver={(event) => {
            if (!activeFileDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            sendFileDrag('over', event);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) sendFileDrag('cancel', event);
          }}
          onDrop={(event) => {
            if (!activeFileDrag(event)) return;
            event.preventDefault();
            sendFileDrag('drop', event);
          }}
        />
      )}
    </div>
  );
}

/**
 * Listen to a guest event while mounted, calling the latest listener. A
 * falsy listener listens to nothing.
 */
function useGuestEvent(
  elRef: RefObject<GuestElement | null>,
  name: string,
  listener: ((e: Event, el: GuestElement) => void) | undefined | null | false,
) {
  const latest = useRef(listener);
  useLayoutEffect(() => {
    latest.current = listener;
  });
  const listening = !!listener;
  useEffect(() => {
    const el = elRef.current;
    if (!el || !listening) return;
    const fn = (e: Event) => {
      if (latest.current) latest.current(e, el);
    };
    el.addEventListener(name, fn);
    return () => el.removeEventListener(name, fn);
  }, [elRef, name, listening]);
}
