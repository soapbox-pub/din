import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { isWebviewAvailable } from '@/lib/isElectron';

/** Imperative controls a BrowserView surface exposes to its parent. */
export interface BrowserViewHandle {
  reload: () => void;
}

export interface BrowserViewProps {
  /** The https URL to display. */
  src: string;
  /** Called when the surface starts loading a page. */
  onLoadStart?: () => void;
  /** Called when the surface finishes loading (success or failure). */
  onLoadEnd?: () => void;
  /**
   * Called when the loaded page reports its title.
   * Only available on the Electron <webview> surface.
   */
  onTitleChange?: (title: string) => void;
  /**
   * Called when the loaded page reports its favicon URLs.
   * Only available on the Electron <webview> surface.
   */
  onFaviconChange?: (favicons: string[]) => void;
}

/**
 * A web-content rendering surface.
 *
 * Abstracts over two implementations chosen at runtime:
 *   - Electron <webview>: a real embedder that loads arbitrary sites,
 *     bypassing the X-Frame-Options / frame-ancestors restrictions that block
 *     iframes. Used when running inside the Electron shell.
 *   - <iframe>: the web fallback (e.g. `make dev-browser`). Subject to remote
 *     sites' framing policies, so many sites will refuse to load.
 *
 * Both only ever receive https URLs (sanitized upstream).
 */
export const BrowserView = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function BrowserView(props, ref) {
    return isWebviewAvailable() ? (
      <WebviewSurface ref={ref} {...props} />
    ) : (
      <IframeSurface ref={ref} {...props} />
    );
  },
);

const IframeSurface = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function IframeSurface({ src, onLoadStart, onLoadEnd }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useImperativeHandle(ref, () => ({
      reload: () => {
        if (iframeRef.current) iframeRef.current.src = src;
      },
    }), [src]);

    // An <iframe> has no reliable "load started" event, so signal start when
    // the requested src changes and end on its `load` event.
    useEffect(() => {
      onLoadStart?.();
    }, [src, onLoadStart]);

    return (
      <iframe
        ref={iframeRef}
        src={src}
        title="Web content"
        className="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={onLoadEnd}
      />
    );
  },
);

const WebviewSurface = forwardRef<BrowserViewHandle, BrowserViewProps>(
  function WebviewSurface(
    { src, onLoadStart, onLoadEnd, onTitleChange, onFaviconChange },
    ref,
  ) {
    const webviewRef = useRef<ElectronWebviewElement>(null);

    useImperativeHandle(ref, () => ({
      reload: () => webviewRef.current?.reload(),
    }), []);

    // Keep the displayed page in sync with the requested src. Assigning via
    // the element's loadURL avoids a full element remount on every navigation.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      if (el.getAttribute('src') !== src) {
        el.setAttribute('src', src);
      }
    }, [src]);

    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const start = () => onLoadStart?.();
      const stop = () => onLoadEnd?.();
      el.addEventListener('did-start-loading', start);
      el.addEventListener('did-stop-loading', stop);
      return () => {
        el.removeEventListener('did-start-loading', start);
        el.removeEventListener('did-stop-loading', stop);
      };
    }, [onLoadStart, onLoadEnd]);

    // Page metadata (title / favicon), reported only by the Electron webview.
    useEffect(() => {
      const el = webviewRef.current;
      if (!el) return;
      const title = (e: Event) => {
        const { title } = e as Event & { title?: string };
        if (typeof title === 'string') onTitleChange?.(title);
      };
      const favicon = (e: Event) => {
        const { favicons } = e as Event & { favicons?: string[] };
        if (Array.isArray(favicons)) onFaviconChange?.(favicons);
      };
      el.addEventListener('page-title-updated', title);
      el.addEventListener('page-favicon-updated', favicon);
      return () => {
        el.removeEventListener('page-title-updated', title);
        el.removeEventListener('page-favicon-updated', favicon);
      };
    }, [onTitleChange, onFaviconChange]);

    return (
      <webview
        ref={webviewRef}
        src={src}
        // A partition isolates cookies/storage from the shell's own origin.
        partition="persist:webbrowser"
        className="h-full w-full bg-white"
        style={{ display: 'flex' }}
      />
    );
  },
);

/** Minimal typing for the Electron <webview> element methods we use. */
interface ElectronWebviewElement extends HTMLElement {
  reload(): void;
  loadURL(url: string): Promise<void>;
}
