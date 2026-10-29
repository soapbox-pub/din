/**
 * The app side of window.din (docs/din/README.md): `connect()` waits for the
 * desktop's hello and returns the Din object, which it also sets as
 * window.din. Every call goes to the desktop over the app's port, except
 * din.system, whose bridges talk to main over ports of their own.
 */
import type {
  Din,
  DinAccount,
  DinApp,
  DinAssistant,
  AssistantSettings,
  DinClipboard,
  DinDesktop,
  DinDictation,
  DinDrag,
  DinMedia,
  DictationStatus,
  MediaAction,
  DinFileHandle,
  DinFiles,
  DinMenus,
  DinNotifications,
  DinPermissions,
  DinPrint,
  DinSystem,
  DinTheme,
  DinWindow,
  DragInfo,
  DropResult,
  FrameStyle,
  LaunchContext,
  MenuItem,
  Nip07,
  NostrEventTemplate,
  Permission,
  SignedNostrEvent,
  ThemeSnapshot,
  Unsubscribe,
  WindowState,
} from '@/sdk/din';
import type { FsBridge } from '@/lib/fs';
import type { AssistantBridge } from '@/lib/assistant';
import type { InddBridge } from '@/lib/indd';
import type { VolumesBridge } from '@/lib/volumes';
import type { AccountSnapshot, FromDesktop, HandleData, Hello, Method, Push, Requests } from '@/sdk/protocol';
import { acceleratorMatches } from '@/sdk/accelerators';

export type * from '@/sdk/din';

/** Thrown (as a rejection) when the app calls something its manifest didn't ask for. */
export class DinPermissionError extends Error {
  readonly permission: string;
  constructor(permission: string, message = `This app doesn't have the ${permission} permission`) {
    super(message);
    this.name = 'DinPermissionError';
    this.permission = permission;
  }
}

/**
 * File types as the desktop's `FileFilter` lists name them (`{ name,
 * patterns: ['*.png'] }`), for apps that already have such lists.
 */
export function typesFromFilters(filters: readonly { name: string; patterns: readonly string[] }[]): { description: string; extensions: string[] }[] {
  return filters.map((f) => ({
    description: f.name,
    extensions: f.patterns.filter((p) => p.startsWith('*.')).map((p) => p.slice(1)),
  }));
}

/** The MIME type a Din drag carries its token under. */
export const DRAG_MIME = 'application/x-din-drag';

// ---------------------------------------------------------------------------
// Transport: the preload's in Electron, or a port the desktop posts into an
// iframe elsewhere (npm run dev:browser).
// ---------------------------------------------------------------------------

interface Transport {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  system?: {
    ready(permission: string): Promise<void>;
    call(permission: string, channel: string, args: unknown[]): Promise<unknown>;
    send(permission: string, channel: string, args: unknown[]): void;
    on(permission: string, channel: string, listener: (...args: unknown[]) => void): () => void;
  };
}

declare global {
  interface Window {
    /** The app preload's ports (electron/din-app-preload.cjs). */
    __dinTransport?: Transport;
  }
}

function frameTransport(): Promise<Transport> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || (e.data as { type?: string } | null)?.type !== 'din:port') return;
      const port = e.ports[0];
      if (!port) return;
      window.removeEventListener('message', onMessage);
      const listeners = new Set<(message: unknown) => void>();
      const inbox: unknown[] = [];
      port.onmessage = (m) => {
        if (listeners.size === 0) inbox.push(m.data);
        for (const l of listeners) l(m.data);
      };
      resolve({
        post: (message) => port.postMessage(message),
        onMessage: (listener) => {
          listeners.add(listener);
          for (const m of inbox.splice(0)) listener(m);
          return () => listeners.delete(listener);
        },
      });
    };
    window.addEventListener('message', onMessage);
    // Tell the desktop we're listening; it answers with the port.
    window.parent.postMessage({ type: 'din:hello' }, '*');
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class Emitter<T> {
  private listeners = new Set<(value: T) => void>();
  on(cb: (value: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
}

function rename(error: { name: string; message: string }): Error {
  const e = error.name === 'DinPermissionError' ? new DinPermissionError('', error.message) : new Error(error.message);
  e.name = error.name;
  return e;
}

/** Apply the desktop's theme to this document. */
function applyTheme(theme: ThemeSnapshot, loadedFaces: Set<string>): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme.scheme);
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
  for (const face of theme.fontFaces) {
    const key = `${face.family}\u0000${face.url}`;
    if (loadedFaces.has(key) || !/^https:\/\//.test(face.url)) continue;
    loadedFaces.add(key);
    const font = new FontFace(face.family, `url("${face.url}")`);
    document.fonts.add(font);
    void font.load().catch(() => {});
  }
  if (theme.tokens['font-sans']) root.style.fontFamily = theme.tokens['font-sans'];
}

/** Bridges' invoke and send channels and their events, mirroring electron/preload.cjs. */
const FS_METHODS = [
  'homedir', 'stat', 'readdir', 'readFile', 'writeFile', 'mkdir', 'rename', 'copyFile', 'rm', 'copyInto', 'moveInto',
  'move', 'trash', 'restore', 'purge', 'trashDir', 'details', 'du', 'chmod', 'extract', 'cancelExtract', 'compress',
  'listArchive', 'recent', 'listFiles', 'search', 'watch', 'unwatch',
] as const;

function fsBridge(t: NonNullable<Transport['system']>): FsBridge {
  const bridge: Record<string, unknown> = {};
  for (const m of FS_METHODS) bridge[m] = (...args: unknown[]) => t.call('fs', `fs:${m}`, args);
  bridge.onChange = (cb: (path: string) => void) => t.on('fs', 'fs:changed', (p) => cb(p as string));
  return bridge as unknown as FsBridge;
}

function assistantBridge(t: NonNullable<Transport['system']>): AssistantBridge {
  const bridge: Record<string, unknown> = {};
  for (const m of ['status', 'setEnabled', 'install', 'restart', 'recentModels', 'request']) {
    bridge[m] = (...args: unknown[]) => t.call('assistant', `assistant:${m}`, args);
  }
  bridge.onStatus = (cb: (status: unknown) => void) => t.on('assistant', 'assistant:status', (s) => cb(s));
  bridge.onEvent = (cb: (event: unknown) => void) => t.on('assistant', 'assistant:event', (e) => cb(e));
  return bridge as unknown as AssistantBridge;
}

function ptyBridge(t: NonNullable<Transport['system']>): NonNullable<DinSystem['pty']> {
  return {
    spawn: (...args: unknown[]) => t.call('pty', 'pty:spawn', args),
    write: (...args: unknown[]) => t.send('pty', 'pty:write', args),
    resize: (...args: unknown[]) => t.send('pty', 'pty:resize', args),
    kill: (...args: unknown[]) => t.send('pty', 'pty:kill', args),
    onData: (cb: (id: number, data: Uint8Array) => void) => t.on('pty', 'pty:data', (id, data) => cb(id as number, data as Uint8Array)),
    onExit: (cb: (id: number, code: number) => void) => t.on('pty', 'pty:exit', (id, code) => cb(id as number, code as number)),
    onCommandStart: (cb: (id: number, command: string) => void) =>
      t.on('pty', 'pty:commandStart', (id, command) => cb(id as number, command as string)),
    onCommandDone: (cb: (id: number, done: { command: string; seconds: number }) => void) =>
      t.on('pty', 'pty:commandDone', (id, done) => cb(id as number, done as { command: string; seconds: number })),
    release: (id: number) => t.call('pty', 'pty:release', [id]),
    adopt: (token: string) => t.call('pty', 'pty:adopt', [token]),
  } as unknown as NonNullable<DinSystem['pty']>;
}

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

let connecting: Promise<Din> | null = null;

/**
 * Connect to the desktop. Resolves once it has said hello, with the theme
 * applied, granted bridges ready and window.din set. Safe to call twice.
 */
export function connect(): Promise<Din> {
  connecting ??= start();
  return connecting;
}

async function start(): Promise<Din> {
  const transport = window.__dinTransport ?? (await frameTransport());
  // Bridge calls answer `{ result }` or `{ error }` (errors cross the
  // preload's contextBridge as data, keeping their names).
  const raw = transport.system;
  const bridges: Transport['system'] = raw && {
    ready: (permission) => raw.ready(permission),
    send: (permission, channel, args) => raw.send(permission, channel, args),
    on: (permission, channel, listener) => raw.on(permission, channel, listener),
    call: async (permission, channel, args) => {
      const reply = (await raw.call(permission, channel, args)) as { result?: unknown; error?: { name: string; message: string } };
      if (reply.error) throw rename(reply.error);
      return reply.result;
    },
  };

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const pushes = new Emitter<Push>();
  let hello: Hello | null = null;
  let resolveHello!: (h: Hello) => void;
  const helloArrived = new Promise<Hello>((r) => (resolveHello = r));

  transport.onMessage((raw) => {
    const message = raw as FromDesktop;
    if (message.type === 'hello') {
      hello = message;
      resolveHello(message);
    } else if (message.type === 'reply') {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(rename(message.error));
      else call.resolve(message.result);
    } else {
      pushes.emit(message);
    }
  });

  function request<M extends Method>(method: M, ...[params]: Requests[M][0] extends void ? [] : [Requests[M][0]]): Promise<Requests[M][1]> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      transport.post({ type: 'request', id, method, params });
    });
  }
  /** Fire and forget, in order: setters. Errors are logged, not thrown. */
  function tell<M extends Method>(method: M, ...args: Requests[M][0] extends void ? [] : [Requests[M][0]]): void {
    (request as (m: M, ...a: unknown[]) => Promise<unknown>)(method, ...args).catch((e: unknown) => console.warn(`din: ${method}:`, e));
  }

  const h = await helloArrived;

  // Settings this app kept on the desktop's origin, before anything reads storage.
  if (h.storage) {
    for (const [key, value] of Object.entries(h.storage)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
    tell('storage.migrated');
  }
  if (h.recentFiles) {
    for (const [key, value] of Object.entries(h.recentFiles)) {
      const parse = (text: string | null): { key?: unknown }[] => {
        try {
          const list: unknown = JSON.parse(text ?? '[]');
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      };
      const mine = parse(localStorage.getItem(key));
      const known = new Set(mine.map((e) => e?.key));
      localStorage.setItem(key, JSON.stringify([...mine, ...parse(value).filter((e) => !known.has(e?.key))]));
    }
    tell('storage.migrated');
  }

  const permissions = new Set<Permission>(h.permissions);
  const need = (permission: Permission) => {
    if (!permissions.has(permission)) throw new DinPermissionError(permission);
  };
  /** The whole filesystem, or the folders a scoped grant reaches (main checks which). */
  const needFs = () => {
    if (!permissions.has('fs') && !h.scopedFs) throw new DinPermissionError('fs');
  };

  // ---- file handles ----
  const fileListeners = new Map<string, Emitter<'modified' | 'removed'>>();
  pushes.on((p) => {
    if (p.type === 'fileChange') fileListeners.get(p.handle)?.emit(p.change);
  });
  const handleIds = new WeakMap<DinFileHandle, string>();
  const idOf = (file: DinFileHandle): string => {
    const id = handleIds.get(file);
    if (!id) throw new TypeError('Not a Din file handle');
    return id;
  };
  function wrap(data: HandleData): DinFileHandle {
    const handle: DinFileHandle = {
      kind: data.kind,
      name: data.name,
      key: data.key,
      path: data.path,
      writable: data.writable,
      async getFile() {
        const f = await request('files.read', { handle: data.id });
        return new File([f.bytes], f.name, { type: f.type, lastModified: f.lastModified });
      },
      async write(content) {
        let payload: ArrayBuffer | string;
        if (typeof content === 'string') payload = content;
        else if (content instanceof Blob) payload = await content.arrayBuffer();
        else if (content instanceof ArrayBuffer) payload = content;
        else payload = new Uint8Array(content.buffer, content.byteOffset, content.byteLength).slice().buffer;
        await request('files.write', { handle: data.id, data: payload });
      },
      onChange(cb) {
        let emitter = fileListeners.get(data.id);
        if (!emitter) {
          fileListeners.set(data.id, (emitter = new Emitter()));
          tell('files.watch', { handle: data.id });
        }
        const off = emitter.on(cb);
        return () => {
          off();
        };
      },
      persist: () => request('files.persist', { handle: data.id }),
      parent: async () => {
        const p = await request('files.parent', { handle: data.id });
        return p ? wrap(p) : null;
      },
      url: () => request('files.url', { handle: data.id }),
    };
    if (data.kind === 'directory') {
      handle.entries = async () => (await request('files.entries', { handle: data.id })).map(wrap);
    }
    handleIds.set(handle, data.id);
    return handle;
  }
  const launchOf = (l: Hello['launch']): LaunchContext => ({ ...l, files: l.files.map(wrap) });

  // ---- app ----
  const launches = new Emitter<LaunchContext>();
  const windowMessages = new Emitter<{ from: string; data: unknown }>();
  pushes.on((p) => {
    if (p.type === 'windowMessage') windowMessages.emit({ from: p.from, data: p.data });
  });
  let launch = launchOf(h.launch);
  pushes.on((p) => {
    if (p.type === 'launch') {
      launch = launchOf(p.launch);
      launches.emit(launch);
    }
  });
  let readied = false;
  const app: DinApp = {
    id: h.appId,
    get launch() {
      return launch;
    },
    onLaunch: (cb) => launches.on(cb),
    ready() {
      if (readied) return;
      readied = true;
      tell('app.ready');
    },
    open: (appId, params, files) => request('app.open', { appId, params, handles: files?.map(idOf) }),
    openFiles: (files) => request('app.openFiles', { handles: files.map(idOf) }),
    openUrl: (url) => request('app.openUrl', { url }),
    canOpen: (appId) => request('app.canOpen', { appId }),
    windows: () => request('app.windows'),
    postToWindow: (windowId, data) => tell('app.postToWindow', { windowId, data }),
    onWindowMessage: (cb) => windowMessages.on(({ from, data }) => cb(from, data)),
    session: {
      get: (key) => request('app.sessionGet', { key }),
      set: (key, value) => tell('app.sessionSet', { key, value }),
    },
  };
  if (document.readyState === 'complete') queueMicrotask(() => app.ready());
  else window.addEventListener('load', () => app.ready(), { once: true });

  // ---- window ----
  let state: WindowState = h.state;
  let frameStyle: FrameStyle = h.frameStyle;
  const states = new Emitter<WindowState>();
  const styles = new Emitter<FrameStyle>();
  let closeHandler: (() => boolean) | null = null;
  const tabHovers = new Emitter<{ x: number; y: number } | null>();
  pushes.on((p) => {
    if (p.type === 'tabHover') tabHovers.emit(p.at);
  });
  pushes.on((p) => {
    if (p.type === 'state') {
      state = p.state;
      states.emit(state);
    } else if (p.type === 'frameStyle') {
      frameStyle = p.style;
      styles.emit(frameStyle);
    } else if (p.type === 'closeRequest') {
      let keep = false;
      try {
        keep = closeHandler ? closeHandler() === true : false;
      } catch (e) {
        console.error('din: onCloseRequest threw:', e);
      }
      tell('window.closeAnswer', { request: p.request, keep });
    }
  });
  const point = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
  const win: DinWindow = {
    get state() {
      return state;
    },
    onChange: (cb) => states.on(cb),
    setTitle: (title) => tell('window.setTitle', { title }),
    setIcon: (url) => tell('window.setIcon', { url }),
    setAccent: (color) => tell('window.setAccent', { color }),
    get frameStyle() {
      return frameStyle;
    },
    onFrameStyleChange: (cb) => styles.on(cb),
    setChrome: (chrome) => tell('window.setChrome', chrome),
    setShape: (shape) => tell('window.setShape', { shape }),
    beginMove: (e) => tell('window.beginMove', { at: point(e) }),
    beginResize: (edge, e) => tell('window.beginResize', { edge, at: point(e) }),
    setBounds: (bounds) => tell('window.setBounds', bounds),
    minimize: () => tell('window.minimize'),
    maximize: () => tell('window.maximize'),
    restore: () => tell('window.restore'),
    toggleMaximize: () => tell('window.toggleMaximize'),
    focus: () => tell('window.focus'),
    close: () => tell('window.close'),
    requestClose: () => tell('window.requestClose'),
    showWindowMenu: (at) => tell('window.menu', { at }),
    tabDragMove: (at, label) => request('window.tabDragMove', { at, label }),
    tabDragEnd: (at) => request('window.tabDragEnd', { at }),
    onTabHover: (cb) => tabHovers.on(cb),
    onCloseRequest(handler) {
      const had = closeHandler !== null;
      closeHandler = handler;
      if (had !== (handler !== null)) tell('window.setCloseGuard', { on: handler !== null });
    },
  };

  // ---- menus ----
  const menuActions = new Emitter<string>();
  pushes.on((p) => {
    if (p.type === 'menuAction') menuActions.emit(p.id);
  });
  // Accelerators work wherever focus is in the window: keys reach this
  // document, not the desktop's, so they're matched here.
  type Bound = { id: string; accelerator: string; notInFields: boolean };
  let accelerators: Bound[] = [];
  const collect = (items: MenuItem[], out: Bound[]) => {
    for (const item of items) {
      if (item.type === 'separator' || item.type === 'label') continue;
      if (item.type === 'submenu') collect(item.items, out);
      else if (item.accelerator && item.enabled !== false) {
        out.push({ id: item.id, accelerator: item.accelerator, notInFields: item.notInFields === true });
      }
    }
  };
  const inField = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'range', 'color'].includes(target.type)));
  window.addEventListener('keydown', (e) => {
    const field = inField(e.target);
    const hit = accelerators.find((a) => !(field && a.notInFields) && acceleratorMatches(a.accelerator, e));
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    menuActions.emit(hit.id);
  }, true);
  const menus: DinMenus = {
    setMenuBar(list) {
      const found: Bound[] = [];
      for (const menu of list ?? []) collect(menu.items, found);
      accelerators = found;
      tell('menus.setMenuBar', { menus: list });
    },
    popup: (items, at) => request('menus.popup', { items, at }),
    onAction: (cb) => menuActions.on(cb),
  };

  // ---- files ----
  const files: DinFiles = {
    open: async (options = {}) => {
      const { startIn, ...rest } = options;
      const startInHandle = startIn && typeof startIn === 'object' ? idOf(startIn) : undefined;
      const result = await request('files.open', { ...rest, startIn: typeof startIn === 'string' ? startIn : undefined, startInHandle });
      return result.map(wrap);
    },
    save: async (options = {}) => {
      const { startIn, ...rest } = options;
      const startInHandle = startIn && typeof startIn === 'object' ? idOf(startIn) : undefined;
      const result = await request('files.save', { ...rest, startIn: typeof startIn === 'string' ? startIn : undefined, startInHandle });
      return result ? wrap(result) : null;
    },
    restore: async (token) => {
      const result = await request('files.restore', { token });
      return result ? wrap(result) : null;
    },
    fromPath: async (path) => {
      needFs();
      return wrap(await request('files.fromPath', { path }));
    },
    release: (token) => tell('files.release', { token }),
    pathUrl: (path) => {
      needFs();
      if (!h.fsUrlBase) throw new Error('File URLs are only available inside Din');
      return `${h.fsUrlBase}${path.split('/').map(encodeURIComponent).join('/')}`;
    },
  };

  // ---- drag and drop ----
  let currentDrag: DragInfo | null = h.drag;
  const drags = new Emitter<DragInfo | null>();
  const dragEnds = new Emitter<{ token: string; dropped: boolean; operation: 'copy' | 'move' | 'link' | null }>();
  const detached = new Emitter<{ tabType: string; state: unknown; at: { x: number; y: number } }>();
  pushes.on((p) => {
    if (p.type === 'drag') {
      currentDrag = p.drag;
      drags.emit(currentDrag);
      reportDragOver(currentDrag !== null);
    } else if (p.type === 'dragEnd') {
      dragEnds.emit({ token: p.token, dropped: p.dropped, operation: p.operation });
    } else if (p.type === 'tabDetached') {
      detached.emit({ tabType: p.tabType, state: p.state, at: p.at });
    }
  });
  // While a Din drag is on, say where it is over this window, at most once a
  // frame, for the desktop's drag overlay.
  let overFrame = 0;
  let overAt: { x: number; y: number } | null = null;
  const onDragOver = (e: DragEvent) => {
    overAt = point(e);
    if (overFrame) return;
    overFrame = requestAnimationFrame(() => {
      overFrame = 0;
      if (overAt) tell('drag.over', { at: overAt });
    });
  };
  function reportDragOver(on: boolean) {
    window.removeEventListener('dragover', onDragOver, true);
    if (on) window.addEventListener('dragover', onDragOver, true);
  }
  reportDragOver(h.drag !== null);

  /** Put a new drag's token on the event, register it, and report the drag's end. */
  function beginDrag(e: DragEvent, register: (token: string) => Promise<void>, text: string) {
    // The DataTransfer must be filled now, during dragstart, so the token is
    // minted here; it's random, so no other app can guess it.
    const token = crypto.randomUUID();
    const registered = register(token).catch((error: unknown) => console.warn('din: drag:', error));
    e.dataTransfer?.setData(DRAG_MIME, token);
    if (text) e.dataTransfer?.setData('text/plain', text);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
    // A drag image from a guest doesn't reach the screen, so the desktop
    // draws the drag's label where the pointer is (reported below); the
    // engine's own image is made empty so the two can't double up.
    const blank = document.createElement('div');
    blank.style.cssText = 'position:fixed;top:-10px;left:-10px;width:1px;height:1px;opacity:0';
    document.body.appendChild(blank);
    e.dataTransfer?.setDragImage(blank, 0, 0);
    requestAnimationFrame(() => blank.remove());
    e.target?.addEventListener(
      'dragend',
      (end) => {
        const ev = end as DragEvent;
        const finish = { token, dropEffect: ev.dataTransfer?.dropEffect ?? 'none', at: point(ev) };
        void registered.then(() => tell('drag.finish', finish));
      },
      { once: true },
    );
  }
  const drag: DinDrag = {
    startFiles(e, list, label) {
      const handles = list.map(idOf);
      beginDrag(e, (token) => request('drag.startFiles', { token, handles, label }), list.map((f) => f.name).join('\n'));
    },
    startPaths(e, paths, label) {
      needFs();
      beginDrag(e, (token) => request('drag.startPaths', { token, paths, label }), paths.join('\n'));
    },
    startTab(e, tabType, tabState, label) {
      beginDrag(e, (token) => request('drag.startTab', { token, tabType, state: tabState, label }), label);
    },
    get current() {
      return currentDrag;
    },
    onChange: (cb) => drags.on(cb),
    async accept(e, operation = 'copy') {
      const token = e.dataTransfer?.getData(DRAG_MIME);
      if (!token) return null;
      const result = await request('drag.accept', { token, operation });
      if (!result) return null;
      if (result.kind === 'files') return { kind: 'files', files: result.files.map(wrap), operation: result.operation } satisfies DropResult;
      return result;
    },
    onEnd: (cb) => dragEnds.on(cb),
    onTabDetached: (cb) => detached.on(cb),
  };

  // ---- clipboard ----
  const clipboardChanges = new Emitter<{ count: number; cut: boolean } | null>();
  pushes.on((p) => {
    if (p.type === 'clipboardFiles') clipboardChanges.emit(p.has);
  });
  const clipboard: DinClipboard = {
    readFiles: async () => {
      const r = await request('clipboard.readFiles');
      return r ? { files: r.files.map(wrap), cut: r.cut } : null;
    },
    writeFiles: (list, cut) => tell('clipboard.writeFiles', { handles: list.map(idOf), cut }),
    onFilesChange: (cb) => clipboardChanges.on(cb),
  };

  // ---- theme ----
  const loadedFaces = new Set<string>();
  let themeSnapshot = h.theme;
  applyTheme(themeSnapshot, loadedFaces);
  const themes = new Emitter<ThemeSnapshot>();
  pushes.on((p) => {
    if (p.type !== 'theme') return;
    themeSnapshot = p.theme;
    applyTheme(themeSnapshot, loadedFaces);
    themes.emit(themeSnapshot);
  });
  const theme: DinTheme = {
    get current() {
      return themeSnapshot;
    },
    onChange: (cb) => themes.on(cb),
  };

  // ---- account ----
  let accountSnapshot: AccountSnapshot = h.account;
  const accounts = new Emitter<void>();
  pushes.on((p) => {
    if (p.type !== 'account') return;
    accountSnapshot = p.account;
    accounts.emit();
  });
  const nostr: Nip07 | null = permissions.has('nostr')
    ? {
        getPublicKey: () => request('nostr.getPublicKey'),
        signEvent: async (event: NostrEventTemplate) => (await request('nostr.signEvent', { event })) as SignedNostrEvent,
        nip04: {
          encrypt: (pubkey, text) => request('nostr.encrypt', { version: 'nip04', pubkey, text }),
          decrypt: (pubkey, text) => request('nostr.decrypt', { version: 'nip04', pubkey, text }),
        },
        nip44: {
          encrypt: (pubkey, text) => request('nostr.encrypt', { version: 'nip44', pubkey, text }),
          decrypt: (pubkey, text) => request('nostr.decrypt', { version: 'nip44', pubkey, text }),
        },
      }
    : null;
  if (nostr && !('nostr' in window)) Object.defineProperty(window, 'nostr', { value: nostr, configurable: false });
  const account: DinAccount = {
    get pubkey() {
      return accountSnapshot.pubkey;
    },
    get relays() {
      return accountSnapshot.relays;
    },
    get blossom() {
      return accountSnapshot.blossom;
    },
    onChange: (cb) => accounts.on(cb),
    nostr,
  };

  // ---- notifications, printing, permissions ----
  const notificationActions = new Emitter<{ tag: string | null; action: string }>();
  pushes.on((p) => {
    if (p.type === 'notificationAction') notificationActions.emit({ tag: p.tag, action: p.action });
  });
  const notifications: DinNotifications = {
    show: (title, options = {}) => request('notifications.show', { title, options }),
    onAction: (cb) => notificationActions.on(cb),
    setBadge: (count) => tell('notifications.setBadge', { count }),
  };
  const print: DinPrint = {
    available: h.printAvailable,
    html: async (title, html) => {
      need('printing');
      await request('print.html', { title, html });
    },
    file: async (file) => {
      need('printing');
      await request('print.file', { handle: idOf(file) });
    },
  };
  const permissionsApi: DinPermissions = { has: (p) => permissions.has(p) };

  // ---- media session, wallpaper, dictation ----
  const mediaActions = new Emitter<MediaAction>();
  pushes.on((p) => {
    if (p.type === 'mediaAction') mediaActions.emit(p.action);
  });
  const media: DinMedia = {
    setSession(session) {
      need('media-session');
      tell('media.setSession', { session });
    },
    onAction: (cb) => mediaActions.on(cb),
  };
  const desktop: DinDesktop = {
    setWallpaper: async (file) => {
      need('wallpaper');
      await request('desktop.setWallpaper', { handle: idOf(file) });
    },
  };
  let dictationStatus = h.dictation.status;
  let dictationHere = h.dictation.here;
  const dictationChanges = new Emitter<DictationStatus>();
  pushes.on((p) => {
    if (p.type !== 'dictation') return;
    dictationStatus = p.status;
    dictationHere = p.here;
    dictationChanges.emit(p.status);
  });
  const dictation: DinDictation = {
    available: h.dictation.available,
    get status() {
      return dictationStatus;
    },
    get here() {
      return dictationHere;
    },
    onStatus: (cb) => dictationChanges.on(cb),
    start: (options) => request('dictation.start', { held: options?.held === true }),
    finish: () => request('dictation.finish'),
    cancel: () => tell('dictation.cancel'),
  };

  // ---- the assistant's settings ----
  const noAssistant: AssistantSettings = { enabled: false, directory: '', colorfulReplies: true, model: null };
  let assistantSettings = h.assistant ?? noAssistant;
  const assistantChanges = new Emitter<AssistantSettings>();
  pushes.on((p) => {
    if (p.type !== 'assistantSettings') return;
    assistantSettings = p.settings;
    assistantChanges.emit(p.settings);
  });
  const assistant: DinAssistant = {
    get settings() {
      return assistantSettings;
    },
    onSettingsChange: (cb) => assistantChanges.on(cb),
    setSettings: (patch) => {
      need('assistant');
      tell('assistant.setSettings', patch);
    },
    follow: (sessionID) => {
      if (permissions.has('assistant')) tell('assistant.follow', { sessionID });
    },
    setViewing: (sessionID) => {
      if (permissions.has('assistant')) tell('assistant.viewing', { sessionID });
    },
  };

  // ---- system bridges, over their own ports to main ----
  const system: DinSystem = {};
  const sys = bridges;
  if (sys) {
    if (permissions.has('fs') || h.scopedFs) {
      await sys.ready('fs');
      system.fs = fsBridge(sys);
    }
    if (permissions.has('pty')) {
      await sys.ready('pty');
      system.pty = ptyBridge(sys);
    }
    if (permissions.has('assistant')) {
      await sys.ready('assistant');
      system.assistant = assistantBridge(sys);
    }
    if (permissions.has('volumes')) {
      await sys.ready('volumes');
      const v: Record<string, unknown> = {};
      for (const m of ['state', 'mount', 'eject']) v[m] = (...args: unknown[]) => sys.call('volumes', `volumes:${m}`, args);
      v.onChanged = (cb: (state: unknown) => void) => sys.on('volumes', 'volumes:changed', (s) => cb(s));
      v.onEvent = (cb: (event: unknown) => void) => sys.on('volumes', 'volumes:event', (e) => cb(e));
      system.volumes = v as unknown as VolumesBridge;
    }
    if (permissions.has('indd')) {
      await sys.ready('indd');
      system.indd = { convert: (...args: unknown[]) => sys.call('indd', 'indd:convert', args) } as unknown as InddBridge;
    }
  }

  void hello;
  const din: Din = {
    version: 1,
    app,
    window: win,
    menus,
    files,
    drag,
    clipboard,
    theme,
    account,
    notifications,
    print,
    media,
    desktop,
    dictation,
    assistant,
    permissions: permissionsApi,
    system,
  };
  Object.defineProperty(window, 'din', { value: din, configurable: false, writable: false });
  return din;
}
