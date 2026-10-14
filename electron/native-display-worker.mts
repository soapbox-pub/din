// The embedded display's window manager and compositor, run as an Electron
// utility process (see native-display.mts, which owns the X server).
//
// Native Linux apps are X11 clients of a private, headless X server (Xvfb)
// that only Din can see. This process connects to it and is, at once:
//
//   - its window manager: it holds SubstructureRedirect on the root, so every
//     toplevel's map and configure request comes here, and it decides where
//     windows live (wherever their Din window is on screen);
//   - its compositor: every toplevel is redirected offscreen (Composite), and
//     DAMAGE reports which rectangles changed, which are read back with
//     GetImage and streamed to the shell renderer as RGBA;
//   - its input device: pointer and keyboard events from the renderer are
//     injected with XTEST, so apps can't tell them from real hardware;
//   - a clipboard bridge (text) and a cursor mirror (XFIXES).
//
// The shell renders each toplevel into a <canvas> inside an ordinary Din
// window, so native apps get Din's chrome, Dock tiles, Alt+Tab, genie and
// wobbly windows for free. Popups (menus, tooltips, dropdowns - override-
// redirect windows, which no window manager manages) are drawn in an overlay
// at their root position.
//
// Coordinates: the X screen is the shell's viewport. A toplevel's X position
// is its canvas's position in the shell window (CSS px), kept in sync by the
// renderer, so a popup an app opens at root (x, y) belongs at viewport
// (x, y), and a pointer event at canvas offset (dx, dy) goes to root
// (left + dx, top + dy).
//
// Messages: window lifecycle goes to the main process (parentPort), which
// matches windows to installed apps; pixels and input travel on a
// MessagePort straight between this process and the shell renderer.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { X11Client, type WindowId } from './x11.mts';
import {
  changeProperty,
  compositeRedirectSubwindows,
  configureWindow,
  convertSelection,
  createHiddenWindow,
  damageCreate,
  damageDestroy,
  deleteProperty,
  FAKE_BUTTON_PRESS,
  FAKE_BUTTON_RELEASE,
  FAKE_KEY_PRESS,
  FAKE_KEY_RELEASE,
  FAKE_MOTION,
  fakeInput,
  getGeometry,
  getImage,
  killClient,
  mapWindow,
  queryVersion,
  queryXTestVersion,
  sendEvent,
  setInputFocus,
  setSelectionOwner,
  STACK_ABOVE,
  xfixesGetCursorImage,
  xfixesSelectCursorInput,
  xfixesSelectSelectionInput,
  type Extension,
} from './x11-requests.mts';

/** Core event codes. */
const EV_DESTROY_NOTIFY = 17;
const EV_UNMAP_NOTIFY = 18;
const EV_MAP_NOTIFY = 19;
const EV_MAP_REQUEST = 20;
const EV_CONFIGURE_NOTIFY = 22;
const EV_CONFIGURE_REQUEST = 23;
const EV_PROPERTY_NOTIFY = 28;
const EV_SELECTION_REQUEST = 30;
const EV_SELECTION_NOTIFY = 31;
const EV_CLIENT_MESSAGE = 33;

/** Event masks. */
const STRUCTURE_NOTIFY = 1 << 17;
const SUBSTRUCTURE_NOTIFY = 1 << 19;
const SUBSTRUCTURE_REDIRECT = 1 << 20;
const PROPERTY_CHANGE = 1 << 22;

/** Composite NameWindowPixmap / core FreePixmap. */
const COMPOSITE_NAME_WINDOW_PIXMAP = 6;
const OP_FREE_PIXMAP = 54;

/**
 * Frames in flight to the renderer before capture pauses. Damage keeps
 * accumulating meanwhile, so a slow renderer gets fewer, larger updates
 * instead of an ever-growing queue.
 */
const MAX_IN_FLIGHT = 2;
/** Coalescing window for damage, roughly one display frame. */
const FLUSH_MS = 8;
/**
 * Above this many damaged rectangles a window is fetched as one bounding
 * box: one big GetImage beats dozens of tiny round trips.
 */
const MAX_RECTS = 8;
/** Clipboard text larger than this isn't bridged (no INCR transfers). */
const MAX_CLIPBOARD_BYTES = 256 * 1024;

/** A rectangle in window coordinates. */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One window this process composites. */
interface Surface {
  id: WindowId;
  /** Toplevels get a Din window; override-redirect popups an overlay. */
  popup: boolean;
  /** Root position and size, as the server last confirmed it. */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  damage: number;
  /** The window's offscreen pixmap (re-named after every resize). */
  pixmap: number;
  /** Damaged rectangles not yet sent. */
  dirty: Rect[];
  /** Whether the renderer has been told this window exists. */
  announced: boolean;
  /** WM_PROTOCOLS: WM_DELETE_WINDOW / WM_TAKE_FOCUS support. */
  deleteWindow: boolean;
  takeFocus: boolean;
}

/** Interned atoms. */
interface Atoms {
  wmProtocols: number;
  wmDeleteWindow: number;
  wmTakeFocus: number;
  wmState: number;
  wmName: number;
  wmClass: number;
  wmTransientFor: number;
  wmNormalHints: number;
  netWmName: number;
  netWmPid: number;
  netWmWindowType: number;
  netActiveWindow: number;
  netSupported: number;
  netSupportingWmCheck: number;
  netWmState: number;
  netWmStateFocused: number;
  netFrameExtents: number;
  utf8String: number;
  string: number;
  text: number;
  targets: number;
  clipboard: number;
  primary: number;
  dinSelection: number;
  atom: number;
  window: number;
  cardinal: number;
  windowTypeNames: Map<number, string>;
}

let x: X11Client;
let atoms: Atoms;
let composite: Extension;
let damageExt: Extension;
let xtest: Extension;
let xfixes: Extension;
/** Unmapped helper window: WM check window, selection owner, focus sink. */
let wmWindow: WindowId;
/** Mapped InputOnly window the pointer parks on when it leaves the canvases. */
let parkWindow: WindowId;

const surfaces = new Map<WindowId, Surface>();
/** Pixels to the renderer, input from it. Replaced on every shell reload. */
let port: Electron.MessagePortMain | null = null;
let inFlight = 0;
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;
/** Whether the X connection is up and this process is the window manager. */
let ready = false;
/** A renderer port that arrived before the X connection was up. */
let pendingPort: Electron.MessagePortMain | null = null;

/** Post to the main process. */
function toMain(message: unknown): void {
  process.parentPort.postMessage(message);
}

/** Post to the shell renderer, if one is connected. */
function toShell(message: unknown): void {
  port?.postMessage(message);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function requireExtension(name: string): Promise<Extension> {
  const ext = await x.queryExtension(name);
  if (!ext) throw new Error(`X server lacks ${name}`);
  return ext;
}

async function internAtoms(): Promise<Atoms> {
  const names = [
    'WM_PROTOCOLS', 'WM_DELETE_WINDOW', 'WM_TAKE_FOCUS', 'WM_STATE', 'WM_NAME',
    'WM_CLASS', 'WM_TRANSIENT_FOR', 'WM_NORMAL_HINTS', '_NET_WM_NAME',
    '_NET_WM_PID', '_NET_WM_WINDOW_TYPE', '_NET_ACTIVE_WINDOW', '_NET_SUPPORTED',
    '_NET_SUPPORTING_WM_CHECK', '_NET_WM_STATE', '_NET_WM_STATE_FOCUSED',
    '_NET_FRAME_EXTENTS', 'UTF8_STRING', 'STRING', 'TEXT', 'TARGETS',
    'CLIPBOARD', 'PRIMARY', 'DIN_SELECTION', 'ATOM', 'WINDOW', 'CARDINAL',
  ];
  const values = await Promise.all(names.map((name) => x.atom(name)));
  const get = (name: string) => values[names.indexOf(name)];

  // Window types, by the suffix the renderer cares about ("MENU", "TOOLTIP").
  const types = [
    'NORMAL', 'DIALOG', 'UTILITY', 'SPLASH', 'MENU', 'DROPDOWN_MENU',
    'POPUP_MENU', 'TOOLTIP', 'NOTIFICATION', 'COMBO', 'DND',
  ];
  const typeAtoms = await Promise.all(types.map((t) => x.atom(`_NET_WM_WINDOW_TYPE_${t}`)));

  return {
    wmProtocols: get('WM_PROTOCOLS'),
    wmDeleteWindow: get('WM_DELETE_WINDOW'),
    wmTakeFocus: get('WM_TAKE_FOCUS'),
    wmState: get('WM_STATE'),
    wmName: get('WM_NAME'),
    wmClass: get('WM_CLASS'),
    wmTransientFor: get('WM_TRANSIENT_FOR'),
    wmNormalHints: get('WM_NORMAL_HINTS'),
    netWmName: get('_NET_WM_NAME'),
    netWmPid: get('_NET_WM_PID'),
    netWmWindowType: get('_NET_WM_WINDOW_TYPE'),
    netActiveWindow: get('_NET_ACTIVE_WINDOW'),
    netSupported: get('_NET_SUPPORTED'),
    netSupportingWmCheck: get('_NET_SUPPORTING_WM_CHECK'),
    netWmState: get('_NET_WM_STATE'),
    netWmStateFocused: get('_NET_WM_STATE_FOCUSED'),
    netFrameExtents: get('_NET_FRAME_EXTENTS'),
    utf8String: get('UTF8_STRING'),
    string: get('STRING'),
    text: get('TEXT'),
    targets: get('TARGETS'),
    clipboard: get('CLIPBOARD'),
    primary: get('PRIMARY'),
    dinSelection: get('DIN_SELECTION'),
    atom: get('ATOM'),
    window: get('WINDOW'),
    cardinal: get('CARDINAL'),
    windowTypeNames: new Map(typeAtoms.map((atom, i) => [atom, types[i]])),
  };
}

async function start(display: string, xauthority: string): Promise<void> {
  const client = await X11Client.connect({ display, xauthority });
  if (!client) throw new Error(`Cannot connect to ${display}`);
  x = client;
  x.onClose = () => process.exit(0);
  x.onEvent = (code, packet) => {
    try {
      onEvent(code, packet);
    } catch (error) {
      console.error('native-display: event handler failed', error);
    }
  };
  // Races with dying windows (BadWindow, BadMatch, BadDrawable) are routine
  // for a window manager; nothing to do about them.
  x.onError = () => {};

  [composite, damageExt, xtest, xfixes] = await Promise.all([
    requireExtension('Composite'),
    requireExtension('DAMAGE'),
    requireExtension('XTEST'),
    requireExtension('XFIXES'),
  ]);
  await Promise.all([
    queryVersion(x, composite, 0, 4),
    queryVersion(x, damageExt, 1, 1),
    queryVersion(x, xfixes, 5, 0),
    queryXTestVersion(x, xtest),
  ]);
  atoms = await internAtoms();

  // Become the window manager. Only one client may hold SubstructureRedirect
  // on the root; on Din's own server nobody else asks.
  x.selectInput(x.root, SUBSTRUCTURE_REDIRECT | SUBSTRUCTURE_NOTIFY | PROPERTY_CHANGE);
  compositeRedirectSubwindows(x, composite, x.root);

  wmWindow = x.allocateId();
  createHiddenWindow(x, wmWindow);
  x.selectInput(wmWindow, PROPERTY_CHANGE);
  changeProperty(x, wmWindow, atoms.netSupportingWmCheck, atoms.window, 32, [wmWindow]);
  changeProperty(x, wmWindow, atoms.netWmName, atoms.utf8String, 8, Buffer.from('Din'));
  changeProperty(x, x.root, atoms.netSupportingWmCheck, atoms.window, 32, [wmWindow]);
  changeProperty(x, x.root, atoms.netSupported, atoms.atom, 32, [
    atoms.netActiveWindow, atoms.netSupportingWmCheck, atoms.netWmName,
    atoms.netWmState, atoms.netWmStateFocused, atoms.netFrameExtents,
  ]);

  parkWindow = x.allocateId();
  createParkWindow(parkWindow);

  xfixesSelectCursorInput(x, xfixes, x.root);
  xfixesSelectSelectionInput(x, xfixes, wmWindow, atoms.clipboard);

  ready = true;
  if (pendingPort) connectShell(pendingPort);
  pendingPort = null;
  toMain({ type: 'ready' });
}

/**
 * A 1x1 InputOnly window in the bottom-right corner of the screen, mapped and
 * raised on demand. The pointer is parked on it when it leaves every native
 * canvas, so apps see a proper leave (hover states clear, tooltips close)
 * instead of the pointer freezing over whatever it last touched.
 */
function createParkWindow(id: WindowId): void {
  const body = Buffer.alloc(32);
  body.writeUInt32LE(id, 0);
  body.writeUInt32LE(x.root, 4);
  body.writeInt16LE(x.screenWidth - 1, 8);
  body.writeInt16LE(x.screenHeight - 1, 10);
  body.writeUInt16LE(1, 12);
  body.writeUInt16LE(1, 14);
  body.writeUInt16LE(0, 16);
  body.writeUInt16LE(2, 18); // InputOnly
  body.writeUInt32LE(0, 20);
  body.writeUInt32LE(1 << 9, 24); // CWOverrideRedirect
  body.writeUInt32LE(1, 28);
  x.requestNoReply(1, 0, body); // CreateWindow, depth 0 for InputOnly
  mapWindow(x, id);
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

/** Metadata the renderer needs to give a toplevel a Din window. */
async function describe(id: WindowId) {
  const [netName, wmName, wmClass, pids, types, transient] = await Promise.all([
    x.getText(id, atoms.netWmName, atoms.utf8String),
    x.getText(id, atoms.wmName, atoms.utf8String),
    x.getText(id, atoms.wmClass, atoms.utf8String),
    x.getCardinals(id, atoms.netWmPid, 1),
    x.getCardinals(id, atoms.netWmWindowType, 8),
    x.getCardinals(id, atoms.wmTransientFor, 1),
  ]);
  const kind = types.map((t) => atoms.windowTypeNames.get(t)).find(Boolean) ?? 'NORMAL';
  return {
    title: (netName ?? wmName ?? '').replace(/\0.*$/s, ''),
    wmClass: (wmClass ?? '').split('\0').filter(Boolean),
    pid: pids[0] ?? null,
    kind,
    transientFor: transient[0] ?? null,
  };
}

/** Start compositing a window that just got mapped. */
async function track(id: WindowId, popup: boolean): Promise<void> {
  if (surfaces.has(id)) return;
  let geometry;
  try {
    geometry = await getGeometry(x, id);
  } catch {
    return; // died already
  }
  const surface: Surface = {
    id,
    popup,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    depth: geometry.depth,
    damage: x.allocateId(),
    pixmap: 0,
    dirty: [],
    announced: false,
    deleteWindow: false,
    takeFocus: false,
  };
  surfaces.set(id, surface);
  x.selectInput(id, PROPERTY_CHANGE | STRUCTURE_NOTIFY);
  damageCreate(x, damageExt, surface.damage, id);
  namePixmap(surface);
  if (!popup) {
    const protocols = await x.getCardinals(id, atoms.wmProtocols, 16).catch((): number[] => []);
    surface.deleteWindow = protocols.includes(atoms.wmDeleteWindow);
    surface.takeFocus = protocols.includes(atoms.wmTakeFocus);
  }
  await announce(surface);
}

/** Tell the renderer a surface exists (again, after a reconnect). */
async function announce(surface: Surface): Promise<void> {
  let info;
  try {
    info = await describe(surface.id);
  } catch {
    return;
  }
  if (!surfaces.has(surface.id)) return;
  surface.announced = true;
  toShell({
    type: surface.popup ? 'popup' : 'open',
    id: surface.id,
    x: surface.x,
    y: surface.y,
    width: surface.width,
    height: surface.height,
    ...info,
  });
  markAllDirty(surface);
}

/** Bind (or re-bind, after a resize) the window's offscreen pixmap. */
function namePixmap(surface: Surface): void {
  if (surface.pixmap) freePixmap(surface.pixmap);
  surface.pixmap = x.allocateId();
  const body = Buffer.alloc(8);
  body.writeUInt32LE(surface.id, 0);
  body.writeUInt32LE(surface.pixmap, 4);
  x.requestNoReply(composite.opcode, COMPOSITE_NAME_WINDOW_PIXMAP, body);
}

function freePixmap(pixmap: number): void {
  const body = Buffer.alloc(4);
  body.writeUInt32LE(pixmap, 0);
  x.requestNoReply(OP_FREE_PIXMAP, 0, body);
}

function untrack(id: WindowId): void {
  const surface = surfaces.get(id);
  if (!surface) return;
  surfaces.delete(id);
  damageDestroy(x, damageExt, surface.damage);
  if (surface.pixmap) freePixmap(surface.pixmap);
  if (focused === id) focused = 0;
  toShell({ type: 'close', id });
}

/** A client asked to be mapped: grant it, as ICCCM says a WM should. */
function onMapRequest(id: WindowId): void {
  changeProperty(x, id, atoms.wmState, atoms.wmState, 32, [1, 0]); // NormalState
  changeProperty(x, id, atoms.netFrameExtents, atoms.cardinal, 32, [0, 0, 0, 0]);
  mapWindow(x, id);
}

/**
 * A client asked to move/resize/restack. Sizes are granted (the renderer
 * then fits the Din window to the new size); positions are the window
 * manager's call, so a managed toplevel stays where its Din window is.
 */
function onConfigureRequest(packet: Buffer): void {
  const id = packet.readUInt32LE(8);
  const mask = packet.readUInt16LE(26);
  const managed = surfaces.get(id);
  const values: Parameters<typeof configureWindow>[2] = {};
  if (!managed && mask & 1) values.x = packet.readInt16LE(16);
  if (!managed && mask & 2) values.y = packet.readInt16LE(18);
  if (mask & 4) values.width = packet.readUInt16LE(20);
  if (mask & 8) values.height = packet.readUInt16LE(22);
  if (mask & 16) values.border = 0;
  configureWindow(x, id, values);
  if (!managed) return;
  if (values.width === undefined && values.height === undefined) {
    // Nothing really changed, but the client waits for a ConfigureNotify.
    sendSyntheticConfigure(managed);
  } else if (!managed.popup) {
    // The app resized itself: its Din window should follow.
    toShell({
      type: 'configure',
      id,
      x: managed.x,
      y: managed.y,
      width: values.width ?? managed.width,
      height: values.height ?? managed.height,
    });
  }
}

/** ICCCM 4.1.5: tell a client where it is after a WM-initiated move. */
function sendSyntheticConfigure(surface: Surface): void {
  const event = Buffer.alloc(32);
  event.writeUInt8(EV_CONFIGURE_NOTIFY, 0);
  event.writeUInt32LE(surface.id, 4);
  event.writeUInt32LE(surface.id, 8);
  event.writeUInt32LE(0, 12);
  event.writeInt16LE(surface.x, 16);
  event.writeInt16LE(surface.y, 18);
  event.writeUInt16LE(surface.width, 20);
  event.writeUInt16LE(surface.height, 22);
  sendEvent(x, surface.id, STRUCTURE_NOTIFY, event);
}

function onConfigureNotify(packet: Buffer): void {
  const surface = surfaces.get(packet.readUInt32LE(8));
  if (!surface) return;
  const nx = packet.readInt16LE(16);
  const ny = packet.readInt16LE(18);
  const width = packet.readUInt16LE(20);
  const height = packet.readUInt16LE(22);
  const resized = width !== surface.width || height !== surface.height;
  const moved = nx !== surface.x || ny !== surface.y;
  surface.x = nx;
  surface.y = ny;
  surface.width = width;
  surface.height = height;
  if (resized) {
    namePixmap(surface);
    markAllDirty(surface);
  }
  // Toplevels are sized by the renderer, which already knows; only popups
  // move on the app's own initiative. (App-initiated toplevel resizes are
  // reported from the ConfigureRequest instead, so a stale echo of the
  // renderer's own resize can never fight a live drag.)
  if (surface.popup && (resized || moved)) {
    toShell({ type: 'configure', id: surface.id, x: nx, y: ny, width, height });
  }
}

/** Title and type changes the renderer shows. */
async function onPropertyNotify(id: WindowId, atom: number): Promise<void> {
  const surface = surfaces.get(id);
  if (!surface || surface.popup) return;
  if (atom === atoms.netWmName || atom === atoms.wmName) {
    const info = await describe(id).catch(() => null);
    if (info) toShell({ type: 'title', id, title: info.title });
  } else if (atom === atoms.wmProtocols) {
    const protocols = await x.getCardinals(id, atoms.wmProtocols, 16).catch((): number[] => []);
    surface.deleteWindow = protocols.includes(atoms.wmDeleteWindow);
    surface.takeFocus = protocols.includes(atoms.wmTakeFocus);
  }
}

/** Messages clients send the window manager (EWMH). */
function onClientMessage(packet: Buffer): void {
  const id = packet.readUInt32LE(4);
  const type = packet.readUInt32LE(8);
  if (type === atoms.netActiveWindow && surfaces.has(id)) {
    // An app asking to be raised (a notification click, a second launch
    // of a single-instance app): let the shell decide, like any focus.
    toShell({ type: 'activate', id });
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function markAllDirty(surface: Surface): void {
  surface.dirty = [{ x: 0, y: 0, width: surface.width, height: surface.height }];
  scheduleFlush();
}

function onDamage(packet: Buffer): void {
  const surface = surfaces.get(packet.readUInt32LE(4));
  if (!surface) return;
  surface.dirty.push({
    x: packet.readInt16LE(16),
    y: packet.readInt16LE(18),
    width: packet.readUInt16LE(20),
    height: packet.readUInt16LE(22),
  });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer || flushing || inFlight >= MAX_IN_FLIGHT || !port) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_MS);
}

/** Clip a rect to the surface; null when nothing is left. */
function clip(rect: Rect, surface: Surface): Rect | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(surface.width, rect.x + rect.width);
  const y1 = Math.min(surface.height, rect.y + rect.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

function boundingBox(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Convert the server's BGRX/BGRA pixels to the RGBA ImageData wants. Depth
 * 24 windows have an undefined pad byte, so alpha is forced opaque; depth 32
 * (ARGB visual) windows keep theirs.
 */
function toRgba(data: Buffer, opaque: boolean): Uint8Array {
  // A large reply owns its buffer outright (x11.mts assembles it fresh), so
  // it's converted in place. A small one may be a view into a shared socket
  // chunk - posting that would clone the whole chunk - so it's copied out.
  const owned = data.byteOffset % 4 === 0 && data.byteLength * 2 >= data.buffer.byteLength;
  const out = owned ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  const pixels = new Uint32Array(out.buffer, out.byteOffset, out.length >> 2);
  const alpha = opaque ? 0xff000000 : 0;
  for (let i = 0; i < pixels.length; i += 1) {
    const p = pixels[i];
    pixels[i] =
      (alpha | (p & 0xff000000) | ((p & 0xff) << 16) | (p & 0xff00) | ((p >>> 16) & 0xff)) >>> 0;
  }
  return out;
}

interface FrameUpdate {
  id: WindowId;
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** Read back every damaged region and post them as one batch. */
async function flush(): Promise<void> {
  if (flushing || inFlight >= MAX_IN_FLIGHT || !port) return;
  flushing = true;
  const reads: Promise<FrameUpdate | null>[] = [];
  for (const surface of surfaces.values()) {
    if (!surface.announced || surface.dirty.length === 0) continue;
    const pending = surface.dirty
      .map((rect) => clip(rect, surface))
      .filter((rect): rect is Rect => rect !== null);
    surface.dirty = [];
    if (pending.length === 0) continue;
    // Many rects, or rects that mostly cover their bounding box (a video
    // frame damages the whole window every time), are read as one.
    const box = boundingBox(pending);
    const area = pending.reduce((sum, r) => sum + r.width * r.height, 0);
    const rects =
      pending.length > MAX_RECTS || area * 2 >= box.width * box.height ? [box] : pending;
    for (const rect of rects) {
      reads.push(
        getImage(x, surface.pixmap, rect.x, rect.y, rect.width, rect.height)
          .then((image) => ({
            id: surface.id,
            ...rect,
            data: toRgba(image.data, image.depth !== 32),
          }))
          // The window resized or died under the read; its next damage (or
          // its close) supersedes this one.
          .catch(() => null),
      );
    }
  }
  const updates = (await Promise.all(reads)).filter((u): u is FrameUpdate => u !== null);
  flushing = false;
  if (updates.length > 0 && port) {
    inFlight += 1;
    port.postMessage({ type: 'frames', updates });
  }
  if ([...surfaces.values()].some((s) => s.dirty.length > 0)) scheduleFlush();
}

// ---------------------------------------------------------------------------
// Input and focus
// ---------------------------------------------------------------------------

/** The focused toplevel (0 when Din's own UI has the keyboard). */
let focused: WindowId = 0;
/** Keycodes currently held down, so focus loss can release them. */
const heldKeys = new Set<number>();
const heldButtons = new Set<number>();

/** Root coordinates of a point given relative to a surface (0 = root). */
function toRoot(id: WindowId, rx: number, ry: number): [number, number] {
  const surface = surfaces.get(id);
  const ox = surface ? surface.x : 0;
  const oy = surface ? surface.y : 0;
  return [Math.round(ox + rx), Math.round(oy + ry)];
}

function motion(id: WindowId, rx: number, ry: number): void {
  const [rootX, rootY] = toRoot(id, rx, ry);
  fakeInput(x, xtest, FAKE_MOTION, 0, rootX, rootY);
}

/** Restack popups above everything; a raised toplevel must not cover a menu. */
function raisePopups(): void {
  for (const surface of surfaces.values()) {
    if (surface.popup) configureWindow(x, surface.id, { stackMode: STACK_ABOVE });
  }
}

function raise(id: WindowId): void {
  if (!surfaces.has(id)) return;
  configureWindow(x, id, { stackMode: STACK_ABOVE });
  raisePopups();
}

/** Move the pointer off every app window, onto the parking window. */
function park(): void {
  configureWindow(x, parkWindow, { stackMode: STACK_ABOVE });
  fakeInput(x, xtest, FAKE_MOTION, 0, x.screenWidth - 1, x.screenHeight - 1);
}

function sendProtocol(id: WindowId, protocol: number): void {
  const event = Buffer.alloc(32);
  event.writeUInt8(EV_CLIENT_MESSAGE, 0);
  event.writeUInt8(32, 1);
  event.writeUInt32LE(id, 4);
  event.writeUInt32LE(atoms.wmProtocols, 8);
  event.writeUInt32LE(protocol, 12);
  event.writeUInt32LE(x.lastTimestamp >>> 0, 16);
  sendEvent(x, id, 0, event);
}

function releaseAll(): void {
  for (const keycode of heldKeys) fakeInput(x, xtest, FAKE_KEY_RELEASE, keycode);
  heldKeys.clear();
  for (const button of heldButtons) fakeInput(x, xtest, FAKE_BUTTON_RELEASE, button);
  heldButtons.clear();
}

/** Give a toplevel the keyboard (0: hand it back to Din). */
function focus(id: WindowId): void {
  const next = surfaces.has(id) ? id : 0;
  if (next === focused) return;
  // Keys held while focus moves would otherwise stay down in the app.
  releaseAll();
  if (focused && surfaces.has(focused)) {
    changeProperty(x, focused, atoms.netWmState, atoms.atom, 32, []);
  }
  focused = next;
  changeProperty(x, x.root, atoms.netActiveWindow, atoms.window, 32, [next]);
  if (!next) {
    setInputFocus(x, x.root, 0);
    return;
  }
  const surface = surfaces.get(next)!;
  raise(next);
  changeProperty(x, next, atoms.netWmState, atoms.atom, 32, [atoms.netWmStateFocused]);
  setInputFocus(x, next, 0);
  if (surface.takeFocus) sendProtocol(next, atoms.wmTakeFocus);
}

function close(id: WindowId): void {
  const surface = surfaces.get(id);
  if (!surface) return;
  if (surface.deleteWindow) sendProtocol(id, atoms.wmDeleteWindow);
  else killClient(x, id);
}

/** Fit a toplevel to its Din window's canvas (root position and size). */
function setGeometry(id: WindowId, gx: number, gy: number, width: number, height: number): void {
  const surface = surfaces.get(id);
  if (!surface || surface.popup) return;
  const values: Parameters<typeof configureWindow>[2] = {};
  if (gx !== surface.x) values.x = gx;
  if (gy !== surface.y) values.y = gy;
  if (width !== surface.width) values.width = Math.max(1, width);
  if (height !== surface.height) values.height = Math.max(1, height);
  configureWindow(x, id, values);
  // Positions only matter for input routing; take them at once so pointer
  // events sent right behind this land in the right place.
  surface.x = gx;
  surface.y = gy;
}

// ---------------------------------------------------------------------------
// Clipboard (text) and cursor
// ---------------------------------------------------------------------------

/** Text Din put on the X clipboard, served to apps that paste. */
let clipboardText: string | null = null;

function onSelectionOwnerChange(packet: Buffer): void {
  const owner = packet.readUInt32LE(8);
  const selection = packet.readUInt32LE(12);
  if (selection !== atoms.clipboard || owner === 0 || owner === wmWindow) return;
  clipboardText = null;
  // An app copied: fetch the text, and the SelectionNotify below hands it on.
  convertSelection(
    x, wmWindow, atoms.clipboard, atoms.utf8String, atoms.dinSelection,
    packet.readUInt32LE(20),
  );
}

async function onSelectionNotify(packet: Buffer): Promise<void> {
  const property = packet.readUInt32LE(20);
  if (packet.readUInt32LE(8) !== wmWindow || property === 0) return;
  const value = await x
    .getProperty(wmWindow, property, MAX_CLIPBOARD_BYTES / 4)
    .catch(() => null);
  deleteProperty(x, wmWindow, property);
  if (!value || value.format !== 8 || value.value.length === 0) return;
  const text =
    value.type === atoms.string ? value.value.toString('latin1') : value.value.toString('utf8');
  toShell({ type: 'clipboard', text });
}

/** An app pasting while Din owns the clipboard. */
function onSelectionRequest(packet: Buffer): void {
  const time = packet.readUInt32LE(4);
  const requestor = packet.readUInt32LE(12);
  const selection = packet.readUInt32LE(16);
  const target = packet.readUInt32LE(20);
  let property = packet.readUInt32LE(24) || target;

  if (clipboardText === null) {
    property = 0;
  } else if (target === atoms.targets) {
    changeProperty(x, requestor, property, atoms.atom, 32, [
      atoms.targets, atoms.utf8String, atoms.string, atoms.text,
    ]);
  } else if (target === atoms.utf8String || target === atoms.text) {
    changeProperty(x, requestor, property, atoms.utf8String, 8, Buffer.from(clipboardText, 'utf8'));
  } else if (target === atoms.string) {
    changeProperty(x, requestor, property, atoms.string, 8, Buffer.from(clipboardText, 'latin1'));
  } else {
    property = 0;
  }

  const event = Buffer.alloc(32);
  event.writeUInt8(EV_SELECTION_NOTIFY, 0);
  event.writeUInt32LE(time, 4);
  event.writeUInt32LE(requestor, 8);
  event.writeUInt32LE(selection, 12);
  event.writeUInt32LE(target, 16);
  event.writeUInt32LE(property, 20);
  sendEvent(x, requestor, 0, event);
}

/** Din's clipboard changed (or is about to be pasted): offer it to apps. */
function setClipboard(text: string): void {
  if (text === clipboardText) return;
  clipboardText = text;
  setSelectionOwner(x, wmWindow, atoms.clipboard, 0);
}

let cursorSerial = -1;

async function onCursorChange(): Promise<void> {
  const image = await xfixesGetCursorImage(x, xfixes).catch(() => null);
  if (!image || image.serial === cursorSerial) return;
  cursorSerial = image.serial;
  // Premultiplied ARGB words (BGRA bytes) -> straight RGBA.
  const rgba = new Uint8Array(image.width * image.height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = image.pixels[i + 3];
    const scale = a === 0 ? 0 : 255 / a;
    rgba[i] = Math.min(255, Math.round(image.pixels[i + 2] * scale));
    rgba[i + 1] = Math.min(255, Math.round(image.pixels[i + 1] * scale));
    rgba[i + 2] = Math.min(255, Math.round(image.pixels[i] * scale));
    rgba[i + 3] = a;
  }
  toShell({
    type: 'cursor',
    width: image.width,
    height: image.height,
    xhot: image.xhot,
    yhot: image.yhot,
    data: rgba,
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function onEvent(code: number, packet: Buffer): void {
  if (code === damageExt.firstEvent) return onDamage(packet);
  if (code === xfixes.firstEvent) return onSelectionOwnerChange(packet);
  if (code === xfixes.firstEvent + 1) return void onCursorChange();

  // Structure events arrive twice (on the root and on the window itself);
  // the root's copy is the one that covers every window.
  const fromRoot = packet.readUInt32LE(4) === x.root;
  switch (code) {
    case EV_MAP_REQUEST:
      return onMapRequest(packet.readUInt32LE(8));
    case EV_CONFIGURE_REQUEST:
      return onConfigureRequest(packet);
    case EV_MAP_NOTIFY: {
      const id = packet.readUInt32LE(8);
      if (fromRoot && id !== parkWindow) void track(id, packet.readUInt8(12) !== 0);
      return;
    }
    case EV_UNMAP_NOTIFY: {
      if (!fromRoot) return;
      const id = packet.readUInt32LE(8);
      const surface = surfaces.get(id);
      if (surface && !surface.popup) changeProperty(x, id, atoms.wmState, atoms.wmState, 32, [0, 0]);
      untrack(id);
      return;
    }
    case EV_DESTROY_NOTIFY:
      if (fromRoot) untrack(packet.readUInt32LE(8));
      return;
    case EV_CONFIGURE_NOTIFY:
      if (fromRoot) onConfigureNotify(packet);
      return;
    case EV_PROPERTY_NOTIFY:
      return void onPropertyNotify(packet.readUInt32LE(4), packet.readUInt32LE(8));
    case EV_SELECTION_REQUEST:
      return onSelectionRequest(packet);
    case EV_SELECTION_NOTIFY:
      return void onSelectionNotify(packet);
    case EV_CLIENT_MESSAGE:
      return onClientMessage(packet);
  }
}

/** Messages from the shell renderer. */
type ShellMessage =
  | { type: 'ack' }
  | { type: 'geometry'; id: number; x: number; y: number; width: number; height: number }
  | { type: 'focus'; id: number }
  | { type: 'raise'; id: number }
  | { type: 'close'; id: number }
  | { type: 'motion'; id: number; x: number; y: number }
  | { type: 'button'; id: number; x: number; y: number; button: number; down: boolean }
  | { type: 'key'; keycode: number; down: boolean }
  | { type: 'leave' }
  | { type: 'clipboard'; text: string };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function onShellMessage(message: ShellMessage): void {
  switch (message.type) {
    case 'ack':
      inFlight = Math.max(0, inFlight - 1);
      return scheduleFlush();
    case 'geometry':
      return setGeometry(
        num(message.id), Math.round(num(message.x)), Math.round(num(message.y)),
        Math.round(num(message.width)), Math.round(num(message.height)),
      );
    case 'focus':
      return focus(num(message.id));
    case 'raise':
      return raise(num(message.id));
    case 'close':
      return close(num(message.id));
    case 'motion':
      return motion(num(message.id), num(message.x), num(message.y));
    case 'button': {
      const button = num(message.button);
      if (button < 1 || button > 9) return;
      motion(num(message.id), num(message.x), num(message.y));
      if (message.down) heldButtons.add(button);
      else heldButtons.delete(button);
      fakeInput(x, xtest, message.down ? FAKE_BUTTON_PRESS : FAKE_BUTTON_RELEASE, button);
      return;
    }
    case 'key': {
      const keycode = num(message.keycode);
      if (keycode < 8 || keycode > 255) return;
      if (message.down) heldKeys.add(keycode);
      else heldKeys.delete(keycode);
      fakeInput(x, xtest, message.down ? FAKE_KEY_PRESS : FAKE_KEY_RELEASE, keycode);
      return;
    }
    case 'leave':
      return park();
    case 'clipboard':
      if (typeof message.text === 'string' && message.text.length <= MAX_CLIPBOARD_BYTES) {
        setClipboard(message.text);
      }
      return;
  }
}

/** Swap in a new renderer port (first connect, or a reloaded shell). */
function connectShell(next: Electron.MessagePortMain): void {
  port?.close();
  port = next;
  inFlight = 0;
  port.on('message', (event) => {
    try {
      onShellMessage(event.data as ShellMessage);
    } catch (error) {
      console.error('native-display: shell message failed', error);
    }
  });
  port.start();
  // A fresh renderer knows nothing: re-announce every window.
  for (const surface of surfaces.values()) void announce(surface);
}

process.parentPort.on('message', (event) => {
  const data = event.data as { type: string; display?: string; xauthority?: string };
  if (data.type === 'start' && data.display && data.xauthority) {
    start(data.display, data.xauthority).catch((error: unknown) => {
      toMain({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    });
  } else if (data.type === 'port' && event.ports[0]) {
    if (ready) connectShell(event.ports[0]);
    else pendingPort = event.ports[0];
  }
});