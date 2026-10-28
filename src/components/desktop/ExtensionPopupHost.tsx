import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  getCrxBridge,
  type CrxActionPopupCommand,
  type CrxPopupAnchorRect,
} from '@/lib/crx';
import { useAppContext } from '@/hooks/useAppContext';
import { useMonitors } from '@/contexts/MonitorsContext';
import { contains } from '@/lib/monitors';
import { ScreenLayer } from './MonitorsProvider';

/**
 * Hosts Chrome-extension action popups (e.g. Bitwarden's unlock bubble)
 * inside the Din window, like Chrome's in-window bubble.
 *
 * electron-chrome-extensions opens chrome.action popups as separate native
 * frameless windows - fine on a windowing desktop, but Din is a
 * single-window kiosk where a popup toplevel detaches from the shell window
 * (under a kiosk compositor it can't even be positioned). Instead, the main
 * process routes popup requests here (window.dinos.crx; see the activateClick
 * override in electron/main.mts) and the popup page is hosted in an overlay
 * <webview> anchored to the toolbar action that opened it. The anchor rect
 * arrives in shell-viewport CSS pixels (the action element's
 * getBoundingClientRect), which is exactly this overlay's coordinate space
 * (a ScreenLayer, spanning every monitor).
 *
 * The guest shares the browser session (persist:webbrowser), so the
 * extension API preload and storage work in the popup page just as they do
 * in the library's native popup. Dismissed by an outside click, Escape, a
 * tab opening from the popup, or the action being clicked again (the main
 * process's toggle).
 *
 * Renders nothing outside the Electron shell or when no popup is open.
 */

/** Popup sizing bounds (mirror Chrome / electron-chrome-extensions). */
const MIN_WIDTH = 25;
const MIN_HEIGHT = 25;
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;
/** Chrome's bubble offset below the action button. */
const POSITION_PADDING = 5;
/** Margin the bubble always keeps to the viewport edges. */
const VIEWPORT_MARGIN = 8;
/** Provisional size until the guest's preferred size is measured. */
const DEFAULT_WIDTH = 380;
const DEFAULT_HEIGHT = 600;

interface PopupState {
  url: string;
  anchorRect: CrxPopupAnchorRect;
}

export function ExtensionPopupHost() {
  const crx = getCrxBridge();
  const { monitors, primary } = useMonitors();
  const [popup, setPopup] = useState<PopupState | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  const close = useCallback(() => {
    setPopup(null);
    crx?.actionPopupClosed();
  }, [crx]);

  // Open/close commands from the main process.
  useEffect(() => {
    if (!crx) return;
    return crx.onActionPopup((command: CrxActionPopupCommand) => {
      if (command.type === 'open') {
        setSize(null); // measure each popup fresh
        setPopup({ url: command.url, anchorRect: command.anchorRect });
      } else {
        setPopup(null);
      }
    });
  }, [crx]);

  // A popup that opens a tab (chrome.tabs.create, a target=_blank link)
  // dismisses itself, like Chrome's bubble.
  useEffect(() => {
    if (!crx || !popup) return;
    return crx.onTabCommand((command) => {
      if (command.type === 'create' || command.type === 'open') setPopup(null);
    });
  }, [crx, popup]);

  // Escape dismisses.
  useEffect(() => {
    if (!popup) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [popup, close]);

  if (!crx || !popup) return null;

  const width = size?.width ?? DEFAULT_WIDTH;
  const height = size?.height ?? DEFAULT_HEIGHT;

  // Anchor the bubble under the action button, its right edge aligned with
  // the button's (Chrome's default), clamped into the button's monitor.
  const { anchorRect } = popup;
  const screen =
    monitors.find((m) => contains(m, anchorRect.x + anchorRect.width / 2, anchorRect.y + anchorRect.height / 2)) ??
    primary;
  const maxX = screen.x + screen.width - width - VIEWPORT_MARGIN;
  const maxY = screen.y + screen.height - height - VIEWPORT_MARGIN;
  const x = Math.max(
    screen.x + VIEWPORT_MARGIN,
    Math.min(anchorRect.x + anchorRect.width - width, maxX),
  );
  const y = Math.max(
    screen.y + VIEWPORT_MARGIN,
    Math.min(anchorRect.y + anchorRect.height + POSITION_PADDING, maxY),
  );

  return (
    // The transparent backdrop swallows the dismissing click (Chrome-style:
    // a click outside closes the bubble without activating what was hit).
    <ScreenLayer className="z-[10000]" onPointerDown={close}>
      <div
        role="dialog"
        aria-label="Extension popup"
        className="absolute overflow-hidden rounded-xl border border-border/60 bg-white shadow-2xl"
        style={{ left: x, top: y, width, height }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <PopupWebview key={popup.url} src={popup.url} onMeasure={setSize} />
      </div>
    </ScreenLayer>
  );
}

/**
 * The popup page's rendering surface: an imperatively-created <webview> in
 * the browser session (partition must be set before attach, see BrowserView)
 * with popups enabled, so links inside the popup route through the main
 * process's window-open handler into browser tabs. Measures the page's
 * preferred size after load and reports it up (clamped to popup bounds).
 */
function PopupWebview({
  src,
  onMeasure,
}: {
  src: string;
  onMeasure: (size: { width: number; height: number }) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<ElectronWebviewElement | null>(null);
  const onMeasureRef = useRef(onMeasure);
  useEffect(() => {
    onMeasureRef.current = onMeasure;
  }, [onMeasure]);

  // The shell's interface zoom, applied to the guest so its content scales
  // (and its hit-testing stays aligned) like every other surface.
  const { config } = useAppContext();
  const zoomFactor = config.zoomLevel / 100;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || webviewRef.current) return;
    const el = document.createElement('webview') as unknown as ElectronWebviewElement;
    el.setAttribute('partition', 'persist:webbrowser');
    el.setAttribute('allowpopups', 'true');
    el.setAttribute('src', src);
    el.className = 'h-full w-full bg-white';
    el.style.display = 'flex';
    webviewRef.current = el;
    container.appendChild(el);

    const measure = () => {
      el.executeJavaScript(
        '(() => { const b = document.body; if (!b) return null; const r = b.getBoundingClientRect(); return { width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()',
      )
        .then((rect) => {
          if (!rect || typeof rect !== 'object') return;
          const { width, height } = rect as { width: number; height: number };
          if (width <= 0 || height <= 0) return;
          onMeasureRef.current({
            width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)),
            height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)),
          });
        })
        .catch(() => {});
    };
    const applyZoom = () => {
      try {
        el.setZoomFactor(zoomFactor);
      } catch {
        // Guest not attached yet; dom-ready retries.
      }
    };
    const onDomReady = () => {
      applyZoom();
      measure();
      // Some popups settle into their final size asynchronously; re-measure.
      setTimeout(measure, 300);
    };
    el.addEventListener('dom-ready', onDomReady);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.remove();
      webviewRef.current = null;
    };
    // The src is fixed for the element's lifetime (keyed on it by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomFactor]);

  return <div ref={containerRef} className="h-full w-full" />;
}

/** Minimal typing for the Electron <webview> element methods we use. */
interface ElectronWebviewElement extends HTMLElement {
  setZoomFactor(factor: number): void;
  executeJavaScript(code: string): Promise<unknown>;
}
