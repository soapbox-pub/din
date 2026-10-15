/**
 * The shell's end of Din's embedded display.
 *
 * Native Linux apps run on a private X server that Din composites
 * (electron/native-display.mts + native-display-worker.mts). This module is
 * the renderer half: it holds the MessagePort to the compositor process,
 * keeps one <canvas> per X window and paints damaged regions into it as they
 * arrive, and turns DOM input into X input.
 *
 * Canvases live here, outside React, so pixels have somewhere to land before
 * a window mounts, and so a window keeps its last frame across re-renders,
 * minimize and the genie. React components (NativeWindowView, NativeDisplay
 * Host) only adopt a canvas into the DOM and listen for lifecycle events.
 *
 * Coordinates: the X screen is the shell's viewport, in CSS pixels. A popup
 * at root (x, y) is drawn at viewport (x, y); a toplevel's root position is
 * its canvas's viewport position, reported with `setGeometry`.
 */

/** One X window as the shell knows it. */
export interface NativeSurface {
  /** X window id. */
  id: number;
  /** Override-redirect (menu, tooltip, dropdown) rather than a toplevel. */
  popup: boolean;
  title: string;
  /** EWMH window type suffix: NORMAL, DIALOG, MENU, TOOLTIP, ... */
  kind: string;
  /** Root position and size. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Owner pid and WM_CLASS, for matching the window to an installed app. */
  pid: number | null;
  wmClass: string[];
  transientFor: number | null;
  /**
   * The app draws its own title bar (or none: a Windows program's
   * popup-style window, a splash screen, a desktop widget), so Din's is
   * left off, and the window positions itself.
   */
  csd: boolean;
  canvas: HTMLCanvasElement;
}

/** A window edge or corner, as Din's resize handles name them. */
export type NativeResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Lifecycle events for the React side. */
export type NativeDisplayEvent =
  | { type: 'open'; surface: NativeSurface }
  | { type: 'popup'; surface: NativeSurface }
  | { type: 'close'; surface: NativeSurface }
  | { type: 'title'; surface: NativeSurface }
  | { type: 'configure'; surface: NativeSurface }
  | { type: 'activate'; surface: NativeSurface }
  /** The app started or stopped drawing its own title bar. */
  | { type: 'decoration'; surface: NativeSurface }
  /**
   * The app's own title bar or edges, under a held button, ask Din to move
   * or resize the window (an interactive gesture, like Din's own chrome).
   */
  | { type: 'move'; surface: NativeSurface }
  | { type: 'resize'; surface: NativeSurface; edge: NativeResizeEdge }
  /** The app's own maximize/minimize buttons. */
  | { type: 'maximize'; surface: NativeSurface; maximized: boolean }
  | { type: 'minimize'; surface: NativeSurface }
  /** Asked to close twice, and still open: offer to force quit. */
  | { type: 'close-ignored'; surface: NativeSurface }
  /** The app locked the pointer (mouse-look) or let it go. */
  | { type: 'pointer-lock'; surface: NativeSurface; locked: boolean };

interface WindowInfo {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  wmClass: string[];
  pid: number | null;
  kind: string;
  transientFor: number | null;
  /** Absent from servers that predate it. */
  csd?: boolean;
}

interface FrameUpdate {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer>;
}

/** Messages from the compositor. */
type WorkerMessage =
  | ({ type: 'open' | 'popup' } & WindowInfo)
  | { type: 'close'; id: number }
  | { type: 'title'; id: number; title: string }
  | { type: 'configure'; id: number; x: number; y: number; width: number; height: number }
  | { type: 'activate'; id: number }
  | { type: 'decoration'; id: number; csd: boolean }
  | { type: 'move'; id: number }
  | { type: 'resize'; id: number; edge: string }
  | { type: 'maximize'; id: number; maximized: boolean }
  | { type: 'minimize'; id: number }
  | { type: 'pointer-lock'; id: number; locked: boolean }
  /** `source` names the server (X or Wayland) that wants the ack. */
  | { type: 'frames'; source?: string; updates: FrameUpdate[] }
  | { type: 'cursor'; width: number; height: number; xhot: number; yhot: number; data: Uint8Array<ArrayBuffer> }
  /** A named cursor (Wayland cursor-shape: CSS cursor names). */
  | { type: 'cursor'; name: string }
  | { type: 'clipboard'; text: string }
  /** Where the Wayland compositor streams its pixels (see connectFrameStream). */
  | { type: 'frame-stream'; url: string };

interface NativeDisplayBridge {
  connect(): void;
  /** Draw a GPU-rendered window into this canvas (electron/native-gpu.mts). */
  attachCanvas(id: number, canvas: HTMLCanvasElement): void;
  detachCanvas(id: number): void;
  /** Called once per GPU present batch, after drawing. */
  onPresented(callback: () => void): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    nativeDisplay?: NativeDisplayBridge;
  }
}

/**
 * What a Din window adds around its content: the 1px border on each side,
 * and the 36px title bar (src/components/desktop/Window.tsx) - nothing, if
 * the app draws its own. A native window of W x H content needs a Din
 * window this much larger.
 */
export function windowChrome(surface: { csd: boolean }): { width: number; height: number } {
  return surface.csd ? { width: 0, height: 0 } : { width: 2, height: 38 };
}

const RESIZE_EDGES = new Set<string>(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/** CSS custom property carrying the app's current cursor. */
export const NATIVE_CURSOR_VAR = '--din-native-cursor';

const surfaces = new Map<number, NativeSurface>();
const listeners = new Set<(event: NativeDisplayEvent) => void>();
let port: MessagePort | null = null;
let started = false;

/** Whether the embedded display can exist here at all. */
export function nativeDisplaySupported(): boolean {
  return typeof window !== 'undefined' && window.nativeDisplay !== undefined;
}

/**
 * Connect to the compositor (idempotent). The port arrives asynchronously
 * via window.postMessage from the preload.
 */
export function startNativeDisplay(): void {
  if (started || !nativeDisplaySupported()) return;
  started = true;
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data !== 'din:native-display-port' ||
      !event.ports[0]
    ) {
      return;
    }
    port?.close();
    port = event.ports[0];
    port.onmessage = (e: MessageEvent<WorkerMessage>) => onMessage(e.data);
  });
  // GPU frames are drawn by the preload; acking them is what paces the apps.
  window.nativeDisplay?.onPresented(() => ackOnNextFrame('wayland'));
  window.nativeDisplay?.connect();
}

/** Subscribe to window lifecycle events. Returns an unsubscribe fn. */
export function subscribeNativeDisplay(listener: (event: NativeDisplayEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNativeSurface(id: number): NativeSurface | undefined {
  return surfaces.get(id);
}

/** Every live popup, for the overlay layer's first render. */
export function nativePopups(): NativeSurface[] {
  return [...surfaces.values()].filter((s) => s.popup);
}

function emit(event: NativeDisplayEvent): void {
  for (const listener of listeners) listener(event);
}

function send(message: unknown): void {
  port?.postMessage(message);
}

/**
 * Ack a batch once it's actually on screen: at the shell's next animation
 * frame. Acks are what release apps' frame callbacks (their vsync), so acking
 * as soon as a batch was drawn let an app like Firefox render far faster than
 * any display refreshes; tied to rAF, apps run at the real refresh rate.
 */
function ackOnNextFrame(source: string | undefined): void {
  requestAnimationFrame(() => send({ type: 'ack', source }));
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  canvas.style.display = 'block';
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  canvas.style.cursor = `var(${NATIVE_CURSOR_VAR}, default)`;
  return canvas;
}

/** Resize a canvas, keeping its pixels until the next full frame lands. */
function resizeCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
  width = Math.max(1, width);
  height = Math.max(1, height);
  if (canvas.width === width && canvas.height === height) return;
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  copy.getContext('2d')?.drawImage(canvas, 0, 0);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.getContext('2d')?.drawImage(copy, 0, 0);
}

function onMessage(message: WorkerMessage): void {
  switch (message.type) {
    case 'frames': {
      for (const update of message.updates) {
        drawUpdate(
          update.id,
          update.x,
          update.y,
          update.width,
          update.height,
          new Uint8ClampedArray(update.data.buffer, update.data.byteOffset, update.data.byteLength),
        );
      }
      ackOnNextFrame(message.source);
      return;
    }
    case 'frame-stream':
      return connectFrameStream(message.url);
    case 'open':
    case 'popup': {
      const existing = surfaces.get(message.id);
      const surface: NativeSurface = {
        id: message.id,
        popup: message.type === 'popup',
        title: message.title,
        kind: message.kind,
        x: message.x,
        y: message.y,
        width: message.width,
        height: message.height,
        pid: message.pid,
        wmClass: message.wmClass,
        transientFor: message.transientFor,
        csd: message.csd === true,
        canvas: existing?.canvas ?? createCanvas(message.width, message.height),
      };
      resizeCanvas(surface.canvas, surface.width, surface.height);
      surfaces.set(surface.id, surface);
      for (const early of earlyUpdates.get(surface.id) ?? []) {
        drawUpdate(surface.id, early.x, early.y, early.width, early.height, early.pixels);
      }
      earlyUpdates.delete(surface.id);
      window.nativeDisplay?.attachCanvas(surface.id, surface.canvas);
      // A re-announce (after a shell reload) of a window that already has a
      // Din window must not open a second one.
      if (!existing) emit({ type: message.type, surface });
      return;
    }
    case 'close': {
      const surface = surfaces.get(message.id);
      if (!surface) return;
      surfaces.delete(message.id);
      closeRequests.delete(message.id);
      window.nativeDisplay?.detachCanvas(message.id);
      emit({ type: 'close', surface });
      return;
    }
    case 'title': {
      const surface = surfaces.get(message.id);
      if (!surface) return;
      surface.title = message.title;
      emit({ type: 'title', surface });
      return;
    }
    case 'configure': {
      const surface = surfaces.get(message.id);
      if (!surface) return;
      surface.x = message.x;
      surface.y = message.y;
      surface.width = message.width;
      surface.height = message.height;
      resizeCanvas(surface.canvas, message.width, message.height);
      emit({ type: 'configure', surface });
      return;
    }
    case 'activate': {
      const surface = surfaces.get(message.id);
      if (surface) emit({ type: 'activate', surface });
      return;
    }
    case 'decoration': {
      const surface = surfaces.get(message.id);
      const csd = message.csd === true;
      if (!surface || surface.popup || surface.csd === csd) return;
      surface.csd = csd;
      emit({ type: 'decoration', surface });
      return;
    }
    case 'move':
    case 'minimize': {
      const surface = surfaces.get(message.id);
      if (surface && !surface.popup) emit({ type: message.type, surface });
      return;
    }
    case 'resize': {
      const surface = surfaces.get(message.id);
      if (!surface || surface.popup || !RESIZE_EDGES.has(message.edge)) return;
      emit({ type: 'resize', surface, edge: message.edge as NativeResizeEdge });
      return;
    }
    case 'maximize': {
      const surface = surfaces.get(message.id);
      if (surface && !surface.popup) emit({ type: 'maximize', surface, maximized: message.maximized === true });
      return;
    }
    case 'pointer-lock': {
      const surface = surfaces.get(message.id);
      if (surface) emit({ type: 'pointer-lock', surface, locked: message.locked === true });
      return;
    }
    case 'cursor':
      return setCursor(message);
    case 'clipboard':
      lastClipboard = message.text;
      void navigator.clipboard?.writeText(message.text).catch(() => {});
      return;
  }
}

/**
 * Patches for windows not announced yet. Wayland pixels and announcements
 * travel on different channels (see connectFrameStream), so a window's first
 * frame can beat its 'open'.
 */
const earlyUpdates = new Map<
  number,
  { x: number; y: number; width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> }[]
>();
/** Cap on windows with early patches held (a stuck id mustn't leak). */
const MAX_EARLY_WINDOWS = 16;

function drawUpdate(
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  pixels: Uint8ClampedArray<ArrayBuffer>,
): void {
  const surface = surfaces.get(id);
  if (!surface) {
    const held = earlyUpdates.get(id);
    if (held) held.push({ x, y, width, height, pixels });
    else if (earlyUpdates.size < MAX_EARLY_WINDOWS) earlyUpdates.set(id, [{ x, y, width, height, pixels }]);
    return;
  }
  surface.canvas.getContext('2d')?.putImageData(new ImageData(pixels, width, height), x, y);
}

let frameStream: WebSocket | null = null;

/**
 * Receive Wayland pixels straight from the compositor (native/din-compositor
 * /src/frames.rs) instead of through the display worker: Node and the
 * MessagePort in between cost two full copies of every frame, and capped a
 * full-window repaint at ~130 MB/s; a WebSocket delivers each batch as one
 * ArrayBuffer. The URL is localhost-only and carries a per-session token.
 *
 * Each message is a batch: u32 count, then per patch u32 id, i32 x, i32 y,
 * u32 width, u32 height (little-endian) and the RGBA bytes. Batches are
 * acked on the control channel, which is what paces the apps.
 */
function connectFrameStream(url: string): void {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+$/.test(url)) return;
  frameStream?.close();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    const buffer = event.data;
    const view = new DataView(buffer);
    const count = view.getUint32(0, true);
    let offset = 4;
    for (let i = 0; i < count && offset + 20 <= buffer.byteLength; i += 1) {
      const id = view.getUint32(offset, true);
      const x = view.getInt32(offset + 4, true);
      const y = view.getInt32(offset + 8, true);
      const width = view.getUint32(offset + 12, true);
      const height = view.getUint32(offset + 16, true);
      const length = width * height * 4;
      offset += 20;
      if (offset + length > buffer.byteLength) break;
      drawUpdate(id, x, y, width, height, new Uint8ClampedArray(buffer, offset, length));
      offset += length;
    }
    ackOnNextFrame('wayland');
  };
  frameStream = ws;
}

/** Mirror the app's cursor onto every native canvas, via a CSS variable. */
function setCursor(cursor: Extract<WorkerMessage, { type: 'cursor' }>): void {
  if ('name' in cursor) {
    // Cursor-shape names are CSS cursor names; anything else is untrusted
    // text headed for a style property, so only plain names pass.
    const name = /^[a-z-]+$/.test(cursor.name) ? cursor.name : 'default';
    document.documentElement.style.setProperty(NATIVE_CURSOR_VAR, name);
    return;
  }
  if (cursor.width === 0 || cursor.height === 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = cursor.width;
  canvas.height = cursor.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pixels = new Uint8ClampedArray(
    cursor.data.buffer,
    cursor.data.byteOffset,
    cursor.data.byteLength,
  );
  ctx.putImageData(new ImageData(pixels, cursor.width, cursor.height), 0, 0);
  document.documentElement.style.setProperty(
    NATIVE_CURSOR_VAR,
    `url(${canvas.toDataURL()}) ${cursor.xhot} ${cursor.yhot}, default`,
  );
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/** Tell the compositor where a toplevel's canvas is and how big. */
export function setNativeGeometry(
  id: number,
  geometry: { x: number; y: number; width: number; height: number },
): void {
  const surface = surfaces.get(id);
  if (!surface) return;
  const x = Math.round(geometry.x);
  const y = Math.round(geometry.y);
  const width = Math.max(1, Math.round(geometry.width));
  const height = Math.max(1, Math.round(geometry.height));
  if (surface.x === x && surface.y === y && surface.width === width && surface.height === height) {
    return;
  }
  surface.x = x;
  surface.y = y;
  surface.width = width;
  surface.height = height;
  resizeCanvas(surface.canvas, width, height);
  send({ type: 'geometry', id, x, y, width, height });
}

/** The toplevel holding Din's keyboard focus (0: none). */
let focusedSurface = 0;

/**
 * Give or take a toplevel's keyboard focus. Taking it only applies if it
 * still holds it, so the order in which two windows' effects run can't
 * leave focus on the wrong one.
 */
export function setNativeFocus(id: number, focused: boolean): void {
  if (focused) {
    if (focusedSurface === id) return;
    focusedSurface = id;
    void syncClipboard();
    send({ type: 'focus', id });
  } else if (focusedSurface === id) {
    focusedSurface = 0;
    send({ type: 'focus', id: 0 });
  }
}

/** Tell the app whether Din has its window maximized (its own title bar shows it). */
export function setNativeMaximized(id: number, maximized: boolean): void {
  send({ type: 'state', id, maximized });
}

export function raiseNativeWindow(id: number): void {
  send({ type: 'raise', id });
}

/**
 * How long after asking a window to close another close click means "it
 * didn't listen" rather than "close it again".
 */
const CLOSE_PATIENCE_MS = 60_000;

/** X window id -> when the shell last asked it to close. */
const closeRequests = new Map<number, number>();

/**
 * Ask an app to close a window (it may prompt first, or refuse).
 *
 * Asking again while an earlier request is still unanswered reports the
 * window as `close-ignored`, so the shell can offer to force quit - some
 * programs (desktop toys, hung apps) never close on request.
 */
export function closeNativeWindow(id: number): void {
  const asked = closeRequests.get(id);
  const surface = surfaces.get(id);
  closeRequests.set(id, Date.now());
  send({ type: 'close', id });
  if (surface && asked !== undefined && Date.now() - asked < CLOSE_PATIENCE_MS) {
    emit({ type: 'close-ignored', surface });
  }
}

/** Whether an X window is still alive. */
export function isNativeWindowOpen(id: number): boolean {
  return surfaces.has(id);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Key events are queued behind clipboard reads, so a Ctrl+V reaches the app
 * only after the text it pastes does.
 */
let keyQueue: Promise<void> = Promise.resolve();

/** DOM mouse button -> X button. */
const BUTTONS = [1, 2, 3, 8, 9];

/**
 * The pointer moved to (x, y). `movement` is the DOM's own movementX/Y,
 * which apps that read relative motion get as is.
 */
export function sendNativeMotion(
  id: number,
  x: number,
  y: number,
  movement?: { dx: number; dy: number },
): void {
  send({ type: 'motion', id, x, y, ...movement });
}

/** Movement while the window holds a pointer lock: the pointer stays put. */
export function sendNativeRelative(id: number, dx: number, dy: number): void {
  if (dx !== 0 || dy !== 0) send({ type: 'relative', id, dx, dy });
}

/**
 * The window's pointer lock ended (Escape, or focus went elsewhere): the app
 * gets it back only on the user's next click in the window.
 */
export function sendNativePointerUnlock(id: number): void {
  send({ type: 'pointer-unlock', id });
}

export function sendNativeButton(
  id: number,
  x: number,
  y: number,
  domButton: number,
  down: boolean,
): void {
  const button = BUTTONS[domButton];
  if (button) send({ type: 'button', id, x, y, button, down });
}

/** Pixels of wheel travel per X scroll click. */
const WHEEL_STEP = 50;
let wheelX = 0;
let wheelY = 0;

/**
 * Wheel input as X scroll buttons (4/5 vertical, 6/7 horizontal). Touchpad
 * scrolling arrives as many small deltas, so travel accumulates until it
 * adds up to a click.
 */
export function sendNativeWheel(id: number, x: number, y: number, event: WheelEvent): void {
  const scale = event.deltaMode === 1 ? WHEEL_STEP / 3 : event.deltaMode === 2 ? WHEEL_STEP * 10 : 1;
  wheelX += event.deltaX * scale;
  wheelY += event.deltaY * scale;
  const click = (button: number) => {
    send({ type: 'button', id, x, y, button, down: true });
    send({ type: 'button', id, x, y, button, down: false });
  };
  while (wheelY >= WHEEL_STEP) {
    click(5);
    wheelY -= WHEEL_STEP;
  }
  while (wheelY <= -WHEEL_STEP) {
    click(4);
    wheelY += WHEEL_STEP;
  }
  while (wheelX >= WHEEL_STEP) {
    click(7);
    wheelX -= WHEEL_STEP;
  }
  while (wheelX <= -WHEEL_STEP) {
    click(6);
    wheelX += WHEEL_STEP;
  }
}

/** The pointer left every native surface. */
export function sendNativeLeave(): void {
  send({ type: 'leave' });
}

/** Whether a keydown is a paste shortcut, which needs the clipboard first. */
function isPaste(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (
    (event.ctrlKey && !event.altKey && key === 'v') ||
    (event.shiftKey && !event.ctrlKey && event.code === 'Insert')
  );
}

/**
 * Forward a key to the focused app. Returns false for keys with no X
 * equivalent, which the caller should leave alone.
 */
export function sendNativeKey(event: KeyboardEvent, down: boolean): boolean {
  const keycode = KEYCODES[event.code];
  if (!keycode) return false;
  if (down && isPaste(event)) keyQueue = keyQueue.then(syncClipboard);
  keyQueue = keyQueue.then(() => send({ type: 'key', keycode, down }));
  return true;
}

/** Text last exchanged with the X clipboard, in either direction. */
let lastClipboard: string | null = null;

/** Offer the shell's clipboard text to apps (on focus, and before a paste). */
async function syncClipboard(): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return;
  }
  if (!text || text === lastClipboard) return;
  lastClipboard = text;
  send({ type: 'clipboard', text });
}

/**
 * DOM KeyboardEvent.code -> X keycode on the embedded server (evdev scancode
 * + 8, the mapping every Xorg keymap since 2008 uses). Physical keys, not
 * characters: the server applies its own layout, so this never depends on
 * the shell's.
 */
const KEYCODES: Record<string, number> = Object.fromEntries(
  Object.entries({
    Escape: 1,
    Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
    Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
    Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
    KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
    KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
    BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
    KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
    KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
    Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
    KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
    Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55,
    AltLeft: 56, Space: 57, CapsLock: 58,
    F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
    NumLock: 69, ScrollLock: 70,
    Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
    Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
    Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
    IntlBackslash: 86, F11: 87, F12: 88,
    NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
    Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106,
    End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
    NumpadEqual: 117, Pause: 119,
    MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  }).map(([code, scancode]) => [code, scancode + 8]),
);
