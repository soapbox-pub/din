/**
 * The engine underneath every guest (an app, a web page, an extension popup,
 * DevTools): today Electron's <webview>. This file and GuestSurface.tsx are
 * the only places that know it; everything else talks about guests, by
 * element or by id. docs/guest-surfaces.md.
 */
import { isWebviewAvailable } from '@/lib/isElectron';

/** Tells main whether a guest is showing (it can't see the desktop's windows). */
export interface GuestVisibilityBridge {
  set(webContentsId: number, hidden: boolean): void;
}

export interface GuestFileDropBridge {
  send(webContentsId: number, type: 'over' | 'drop' | 'cancel', x: number, y: number, paths: string[]): void;
}

/** Hears from main when a guest's page first draws something (the engine's element never says). */
export interface GuestPaintBridge {
  onFirstPaint(callback: (webContentsId: number) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    guestVisibility?: GuestVisibilityBridge;
    /** Present only inside the Electron shell. */
    guestPaint?: GuestPaintBridge;
    /** Present only inside the Electron shell. */
    guestFileDrop?: GuestFileDropBridge;
  }
}

/** A guest's host element in the desktop's document. Opaque outside src/platform. */
export type GuestElement = HTMLElement & { readonly __guest: true };

/** What the engine's element can do, as far as Din uses it. */
interface WebviewElement extends HTMLElement {
  reload(): void;
  reloadIgnoringCache(): void;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  setZoomFactor(factor: number): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getWebContentsId(): number;
  executeJavaScript(code: string): Promise<unknown>;
}

const TAG = 'webview';

/** Whether this host can embed guests at all (Electron); otherwise only iframes. */
export function guestsAvailable(): boolean {
  return isWebviewAvailable();
}

export interface CreateGuestOptions {
  src: string;
  /** The engine's session partition, e.g. `persist:webbrowser`. */
  partition: string;
  /** Extra `webpreferences` the main process reads at attach (and strips). */
  webpreferences?: string;
  /** Let the page open windows (which main routes into tabs). */
  allowPopups?: boolean;
  className?: string;
}

/**
 * A configured guest element, not yet in the document. Every attribute is
 * set before insertion, because the engine reads some (`allowpopups`) only
 * at attach and ignores later changes.
 */
export function createGuest(options: CreateGuestOptions): GuestElement {
  const el = document.createElement(TAG);
  el.setAttribute('partition', options.partition);
  if (options.webpreferences) el.setAttribute('webpreferences', options.webpreferences);
  if (options.allowPopups) el.setAttribute('allowpopups', 'true');
  el.setAttribute('src', options.src);
  if (options.className) el.className = options.className;
  el.style.display = 'flex';
  // Focus moving straight from one guest to another moves the document's
  // focus but not the keyboard's: the page it went to never hears of it, and
  // even clicks into it can't take focus from then on (verified on Electron
  // 43). Leaving the other guest first, by way of the shell, does it right.
  const focus = el.focus.bind(el);
  el.focus = (focusOptions?: FocusOptions) => {
    const active = document.activeElement;
    if (active !== el && isGuestElement(active)) active.blur();
    focus(focusOptions);
  };
  return el as GuestElement;
}

function engine(el: GuestElement): WebviewElement {
  return el as unknown as WebviewElement;
}

/** The guest's id (its WebContents id), or null before it attaches. */
export function guestId(el: GuestElement): number | null {
  try {
    return engine(el).getWebContentsId();
  } catch {
    return null;
  }
}

/** Whether an element is a guest's host element. */
export function isGuestElement(el: Element | null | undefined): el is GuestElement {
  return !!el && el.tagName === TAG.toUpperCase();
}

/** Every guest in the desktop's document. */
export function guestElements(): GuestElement[] {
  return [...document.querySelectorAll<HTMLElement>(TAG)] as GuestElement[];
}

/** The host element of the guest with this id, or null. */
export function findGuest(id: number): GuestElement | null {
  return guestElements().find((el) => guestId(el) === id) ?? null;
}

/** The Din window holding the guest with this id, by window id. */
export function guestWindowId(id: number): string | null {
  return findGuest(id)?.closest('[data-window-id]')?.getAttribute('data-window-id') ?? null;
}

/**
 * The frame the engine renders a guest into, inside its host element. A
 * fullscreen page is this frame, which PageFullscreenHost moves and clips.
 */
export function guestFrame(el: GuestElement): HTMLElement | null {
  return el.shadowRoot?.querySelector('iframe') ?? null;
}

/** The guest's navigation and page controls. All tolerate a guest that isn't attached yet. */
export const guest = {
  reload: (el: GuestElement) => engine(el).reload(),
  reloadIgnoringCache: (el: GuestElement) => engine(el).reloadIgnoringCache(),
  loadURL: (el: GuestElement, url: string) => engine(el).loadURL(url),
  goBack: (el: GuestElement) => engine(el).goBack(),
  goForward: (el: GuestElement) => engine(el).goForward(),
  canGoBack: (el: GuestElement) => engine(el).canGoBack(),
  canGoForward: (el: GuestElement) => engine(el).canGoForward(),
  getURL: (el: GuestElement) => engine(el).getURL(),
  setZoom(el: GuestElement, factor: number): boolean {
    try {
      engine(el).setZoomFactor(factor);
      return true;
    } catch {
      return false;
    }
  },
  /** Run script in the page. Only for Din's own probes of web pages (icons, selection, size). */
  executeJavaScript: (el: GuestElement, code: string) => engine(el).executeJavaScript(code),
};

const firstPaintListeners = new Map<number, Set<() => void>>();
let firstPaintUnsubscribe: (() => void) | null = null;

/**
 * Call `listener` each time the guest with this id draws a new document's
 * first frame with content in it. One bridge subscription serves them all.
 * Returns an unsubscribe function; a no-op outside Electron.
 */
export function onGuestFirstPaint(id: number, listener: () => void): () => void {
  const bridge = window.dinos?.guestPaint;
  if (!bridge) return () => {};
  firstPaintUnsubscribe ??= bridge.onFirstPaint((painted) => {
    for (const fn of firstPaintListeners.get(painted) ?? []) fn();
  });
  let set = firstPaintListeners.get(id);
  if (!set) firstPaintListeners.set(id, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) firstPaintListeners.delete(id);
    if (firstPaintListeners.size === 0) {
      firstPaintUnsubscribe?.();
      firstPaintUnsubscribe = null;
    }
  };
}

/** The engine's events on the host element, by Din's names for them. */
export const GUEST_EVENTS = {
  attach: 'did-attach',
  domReady: 'dom-ready',
  loadStart: 'did-start-loading',
  loadStop: 'did-stop-loading',
  loadFail: 'did-fail-load',
  title: 'page-title-updated',
  favicon: 'page-favicon-updated',
  themeColor: 'did-change-theme-color',
  navigate: 'did-navigate',
  navigateInPage: 'did-navigate-in-page',
  gone: 'render-process-gone',
} as const;
