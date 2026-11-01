/**
 * window.din itself (docs/din/README.md): what Din puts in every page it
 * hosts as an app, before the page's own scripts run, the way a browser
 * provides `navigator`. In Electron the app preload runs it in the page's
 * world (electron/din-app-preload.cjs, bundled in by
 * scripts/build-din-runtime.mjs); framed outside Electron, src/sdk/frame.ts
 * does. Every call goes to the desktop over the window's port, except
 * din.system, whose bridges talk to main over ports of their own.
 *
 * The object is there at once; what the desktop tells it (the launch, the
 * window's state, the theme, the account, the permissions) arrives with its
 * hello, and `din.ready` resolves once it has. Calls made before then wait
 * their turn.
 *
 * It must stay self-contained (no imports with side effects outside this
 * file's graph): it's bundled into one function the preload serializes.
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
import type { MailBridge } from '@/lib/mail';
import type { VolumesBridge } from '@/lib/volumes';
import type { PasswordsBridge } from '@/lib/passwords';
import type { VmsBridge } from '@/lib/vms';
import type { AccountSnapshot, FromDesktop, HandleData, Hello, Method, NotificationData, Push, Requests } from '@/sdk/protocol';
import { acceleratorMatches } from '@/sdk/accelerators';
import { caretSpot, typesText } from '@/shared/caret';

/** How the runtime reaches the desktop: the preload's ports, or a port posted into a frame. */
export interface Transport {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  system?: {
    ready(permission: string): Promise<void>;
    call(permission: string, channel: string, args: unknown[]): Promise<unknown>;
    send(permission: string, channel: string, args: unknown[]): void;
    on(permission: string, channel: string, listener: (...args: unknown[]) => void): () => void;
  };
  /**
   * The page is framed in a plain browser, which keeps a press's pointer in
   * the frame: the desktop is told of presses, and of the pointer during a
   * move or resize.
   */
  framed?: boolean;
}

/** The MIME type a Din drag carries its token under (DRAG_MIME in src/sdk/index.ts). */
const DRAG_MIME = 'application/x-din-drag';

class DinPermissionError extends Error {
  readonly permission: string;
  constructor(permission: string, message = `This app doesn't have the ${permission} permission`) {
    super(message);
    this.name = 'DinPermissionError';
    this.permission = permission;
  }
}

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

/** What the page's Notification and badge need from the desktop. */
interface NotificationHost {
  permission: () => NotificationPermission;
  ready: Promise<void>;
  show: (id: number, title: string, options: NotificationData) => void;
  close: (id: number) => void;
  setBadge: (badge: number | 'flag' | null) => Promise<void>;
  onEvent: (cb: (id: number, event: 'click' | 'close', action: string | null) => void) => Unsubscribe;
}

type Handler = ((this: Notification, event: Event) => unknown) | null;

/**
 * The web Notification API and navigator.setAppBadge(), backed by Din's
 * notification center and the app's Dock tile. Beyond the standard,
 * `actions` work on `new Notification()` too, not only in service workers:
 * a button's click event carries its `action`.
 */
function installNotifications(host: NotificationHost): void {
  const live = new Map<number, AppNotification>();
  let nextId = 1;
  host.onEvent((id, event, action) => {
    const n = live.get(id);
    if (!n) return;
    if (event === 'close') live.delete(id);
    n.fire(event, action);
  });

  class AppNotification extends EventTarget {
    static get permission(): NotificationPermission {
      return host.permission();
    }
    static async requestPermission(callback?: NotificationPermissionCallback): Promise<NotificationPermission> {
      await host.ready;
      const permission = host.permission();
      callback?.(permission);
      return permission;
    }
    static get maxActions(): number {
      return 3;
    }

    readonly title: string;
    readonly body: string;
    readonly icon: string;
    readonly tag: string;
    readonly data: unknown;
    readonly silent: boolean | null;
    readonly requireInteraction: boolean;
    readonly dir: NotificationDirection;
    readonly lang: string;
    readonly badge: string;
    onclick: Handler = null;
    onclose: Handler = null;
    onerror: Handler = null;
    onshow: Handler = null;
    private readonly id = nextId++;

    constructor(title: string, options: NotificationOptions & { actions?: { action: string; title: string }[] } = {}) {
      super();
      this.title = String(title);
      this.body = options.body ?? '';
      this.icon = options.icon ?? '';
      this.tag = options.tag ?? '';
      this.data = options.data ?? null;
      this.silent = options.silent ?? null;
      this.requireInteraction = options.requireInteraction ?? false;
      this.dir = options.dir ?? 'auto';
      this.lang = options.lang ?? '';
      this.badge = options.badge ?? '';
      void host.ready.then(() => {
        if (host.permission() !== 'granted') return this.fire('error', null);
        live.set(this.id, this);
        host.show(this.id, this.title, {
          body: this.body,
          icon: this.icon,
          tag: this.tag,
          requireInteraction: this.requireInteraction,
          actions: (options.actions ?? []).slice(0, 3).map((a) => ({ id: String(a.action), label: String(a.title) })),
        });
        this.fire('show', null);
      });
    }

    close(): void {
      if (live.has(this.id)) host.close(this.id);
    }

    /** @internal */
    fire(type: 'click' | 'close' | 'error' | 'show', action: string | null): void {
      const event = new Event(type, { cancelable: type === 'click' });
      if (type === 'click' && action) Object.defineProperty(event, 'action', { value: action });
      this.dispatchEvent(event);
      const handler = { click: this.onclick, close: this.onclose, error: this.onerror, show: this.onshow }[type];
      handler?.call(this as unknown as Notification, event);
    }
  }

  Object.defineProperty(window, 'Notification', { value: AppNotification, writable: true, configurable: true });
  Object.defineProperty(navigator, 'setAppBadge', {
    value: (contents?: number) =>
      host.setBadge(contents === undefined ? 'flag' : Math.max(0, Math.floor(Number(contents))) || null),
    configurable: true,
  });
  Object.defineProperty(navigator, 'clearAppBadge', { value: () => host.setBadge(null), configurable: true });
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
  'listArchive', 'recent', 'find', 'listFiles', 'search', 'watch', 'unwatch',
] as const;

function fsBridge(t: NonNullable<Transport['system']>): FsBridge {
  const bridge: Record<string, unknown> = {};
  for (const m of FS_METHODS) bridge[m] = (...args: unknown[]) => t.call('fs', `fs:${m}`, args);
  bridge.onChange = (cb: (path: string) => void) => t.on('fs', 'fs:changed', (p) => cb(p as string));
  return bridge as unknown as FsBridge;
}

function assistantBridge(t: NonNullable<Transport['system']>, sudo: boolean): AssistantBridge {
  const bridge: Record<string, unknown> = {};
  for (const m of ['status', 'setEnabled', 'install', 'restart', 'recentModels', 'request']) {
    bridge[m] = (...args: unknown[]) => t.call('assistant', `assistant:${m}`, args);
  }
  // sudo's requests are answered only with assistant-sudo; without it there
  // are none to show.
  for (const m of ['answerPassword', 'approve']) {
    bridge[m] = sudo
      ? (...args: unknown[]) => t.call('assistant-sudo', `assistant:${m}`, args)
      : () => Promise.reject(new DinPermissionError('assistant-sudo'));
  }
  bridge.passwords = sudo ? () => t.call('assistant-sudo', 'assistant:passwords', []) : () => Promise.resolve([]);
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

// What the getters say until the hello: nothing known, nothing granted.
const NO_RECT = { x: 0, y: 0, width: 0, height: 0 };
const NO_STATE: WindowState = {
  id: '', focused: false, visible: true, minimized: false, maximized: false, snapped: null, fullscreen: false,
  bounds: NO_RECT, workArea: NO_RECT,
};
const NO_ACCOUNT: AccountSnapshot = { pubkey: null, relays: [], blossom: [] };
const NO_ASSISTANT: AssistantSettings = { enabled: false, directory: '', colorfulReplies: true, model: null };

/** Define window.din, talking to the desktop over this transport. Once per document. */
export function installDin(transport: Transport): void {
  if ('din' in window) return;

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
  let h: Hello | null = null;
  let resolveHello!: (h: Hello) => void;
  const helloArrived = new Promise<Hello>((r) => (resolveHello = r));

  transport.onMessage((raw) => {
    const message = raw as FromDesktop;
    if (message.type === 'hello') {
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

  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));

  const permissions = new Set<Permission>();
  const need = (permission: Permission) => {
    if (!permissions.has(permission)) throw new DinPermissionError(permission);
  };
  /** The whole filesystem, or the folders a scoped grant reaches (main checks which). */
  const needFs = () => {
    if (!permissions.has('fs') && !h?.scopedFs) throw new DinPermissionError('fs');
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
  let launch: LaunchContext = { reason: 'new', params: {}, files: [], shortcut: null };
  pushes.on((p) => {
    if (p.type === 'launch') {
      launch = launchOf(p.launch);
      launches.emit(launch);
    }
  });
  let readied = false;
  const app: DinApp = {
    get id() {
      return h?.appId ?? location.hostname;
    },
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

  // ---- window ----
  let state: WindowState = NO_STATE;
  let frameStyle: FrameStyle = { accent: null, dark: false };
  const states = new Emitter<WindowState>();
  const styles = new Emitter<FrameStyle>();
  let closeHandler: (() => boolean) | null = null;
  const tabHovers = new Emitter<{ x: number; y: number } | null>();
  pushes.on((p) => {
    if (p.type === 'tabHover') tabHovers.emit(p.at);
  });
  // Framed, a press here never reaches the desktop, which sees only focus
  // leaving it for the first frame: the window is told to come forward.
  if (transport.framed) {
    window.addEventListener(
      'pointerdown',
      () => {
        if (!state.focused) tell('window.focus');
      },
      true,
    );
  }
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
  /**
   * A move or resize begun from `down`, until `begun` resolves at its end.
   * Framed, the pointer stays here, so it's passed on: as a distance in
   * screen pixels, which holds while the frame moves along under it.
   */
  const gesture = (down: PointerEvent, begun: Promise<void>): Promise<void> => {
    if (!transport.framed) return begun;
    const send = (e: PointerEvent, done: boolean) =>
      tell('window.gesturePointer', { delta: { x: e.screenX - down.screenX, y: e.screenY - down.screenY }, done });
    const move = (e: PointerEvent) => send(e, e.buttons === 0);
    const up = (e: PointerEvent) => send(e, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return begun.finally(() => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    });
  };
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
    beginMove: (e) => gesture(e, request('window.beginMove', { at: point(e) })),
    beginResize: (edge, e) => gesture(e, request('window.beginResize', { edge, at: point(e) })),
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
      await ready;
      needFs();
      return wrap(await request('files.fromPath', { path }));
    },
    release: (token) => tell('files.release', { token }),
    requestAccess: async (paths, reason) => (await request('files.requestAccess', { paths, reason })).map(wrap),
    pathUrl: (path) => {
      needFs();
      if (!h?.fsUrlBase) throw new Error('File URLs are only available inside Din');
      return `${h.fsUrlBase}${path.split('/').map(encodeURIComponent).join('/')}`;
    },
  };

  // ---- drag and drop ----
  let currentDrag: DragInfo | null = null;
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
  let themeSnapshot: ThemeSnapshot = {
    scheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    tokens: {},
    fontFaces: [],
    zoom: 1,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    icons: {},
  };
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
  let accountSnapshot: AccountSnapshot = NO_ACCOUNT;
  const accounts = new Emitter<void>();
  pushes.on((p) => {
    if (p.type !== 'account') return;
    accountSnapshot = p.account;
    accounts.emit();
  });
  const nostr: Nip07 = {
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
  };
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
    get nostr() {
      return permissions.has('nostr') ? nostr : null;
    },
  };

  // ---- notifications (the web's own API), toasts, printing, permissions ----
  installNotifications({
    permission: () => (h ? (permissions.has('notifications') ? 'granted' : 'denied') : 'default'),
    ready,
    show: (id, title, options) => tell('notifications.show', { id, title, options }),
    close: (id) => tell('notifications.close', { id }),
    setBadge: async (badge) => {
      await ready;
      if (!permissions.has('notifications')) throw new DOMException('The app may not badge its icon', 'NotAllowedError');
      tell('notifications.setBadge', { badge });
    },
    onEvent: (cb) => pushes.on((p) => {
      if (p.type === 'notification') cb(p.id, p.event, p.action);
    }),
  });
  const toast: Din['toast'] = (title, options = {}) => tell('toast', { title: String(title), body: options.body });
  const print: DinPrint = {
    get available() {
      return h?.printAvailable ?? false;
    },
    html: async (title, html) => {
      await ready;
      need('printing');
      await request('print.html', { title, html });
    },
    file: async (file) => {
      await ready;
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
      await ready;
      need('wallpaper');
      await request('desktop.setWallpaper', { handle: idOf(file) });
    },
    setCursor: async (file) => {
      await ready;
      need('cursor');
      await request('desktop.setCursor', { handle: idOf(file) });
    },
  };
  let dictationStatus: DictationStatus = 'idle';
  let dictationHere = false;
  const dictationChanges = new Emitter<DictationStatus>();
  pushes.on((p) => {
    if (p.type !== 'dictation') return;
    dictationStatus = p.status;
    dictationHere = p.here;
    dictationChanges.emit(p.status);
  });
  const dictation: DinDictation = {
    get available() {
      return h?.dictation.available ?? false;
    },
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
  let assistantSettings = NO_ASSISTANT;
  const assistantChanges = new Emitter<AssistantSettings>();
  pushes.on((p) => {
    if (p.type !== 'assistantSettings') return;
    assistantSettings = p.settings;
    assistantChanges.emit(p.settings);
  });
  let assistantUnread: readonly string[] = [];
  const assistantUnreadChanges = new Emitter<readonly string[]>();
  pushes.on((p) => {
    if (p.type !== 'assistantUnread') return;
    assistantUnread = p.sessionIDs;
    assistantUnreadChanges.emit(p.sessionIDs);
  });
  const assistant: DinAssistant = {
    get settings() {
      return assistantSettings;
    },
    onSettingsChange: (cb) => assistantChanges.on(cb),
    get unread() {
      return assistantUnread;
    },
    onUnreadChange: (cb) => assistantUnreadChanges.on(cb),
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

  // Filled in once the desktop has granted them.
  const system: DinSystem = {};

  const din: Din = {
    version: 1,
    ready,
    app,
    window: win,
    menus,
    files,
    drag,
    clipboard,
    theme,
    account,
    toast,
    print,
    media,
    desktop,
    dictation,
    assistant,
    permissions: permissionsApi,
    system,
  };
  Object.defineProperty(window, 'din', { value: din, configurable: false, writable: false, enumerable: true });

  // ---- power mode: where the caret is as keys are typed, while it's on ----
  let powerMode = false;
  pushes.on((p) => {
    if (p.type === 'powerMode') powerMode = p.on;
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (!powerMode || !typesText(e)) return;
      // After the key has gone in, so the caret has moved.
      requestAnimationFrame(() => {
        const spot = caretSpot(document);
        if (spot) tell('window.typed', spot);
      });
    },
    true,
  );

  // ---- the hello: what the desktop says this window is and may do ----
  void helloArrived.then(async (hello) => {
    h = hello;

    // Settings this app kept on the desktop's origin, before anything reads storage.
    if (hello.storage) {
      for (const [key, value] of Object.entries(hello.storage)) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
      tell('storage.migrated');
    }
    if (hello.recentFiles) {
      for (const [key, value] of Object.entries(hello.recentFiles)) {
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

    for (const p of hello.permissions) permissions.add(p);
    launch = launchOf(hello.launch);
    state = hello.state;
    frameStyle = hello.frameStyle;
    themeSnapshot = hello.theme;
    applyTheme(themeSnapshot, loadedFaces);
    accountSnapshot = hello.account;
    currentDrag = hello.drag;
    reportDragOver(hello.drag !== null);
    dictationStatus = hello.dictation.status;
    dictationHere = hello.dictation.here;
    assistantSettings = hello.assistant ?? NO_ASSISTANT;
    assistantUnread = hello.assistantUnread;
    powerMode = hello.powerMode;
    if (permissions.has('nostr') && !('nostr' in window)) {
      Object.defineProperty(window, 'nostr', { value: nostr, configurable: false });
    }

    // System bridges, over their own ports to main.
    const sys = bridges;
    if (sys) {
      if (permissions.has('fs') || hello.scopedFs) {
        await sys.ready('fs');
        system.fs = fsBridge(sys);
      }
      if (permissions.has('pty')) {
        await sys.ready('pty');
        system.pty = ptyBridge(sys);
      }
      if (permissions.has('assistant')) {
        await sys.ready('assistant');
        const sudo = permissions.has('assistant-sudo');
        if (sudo) await sys.ready('assistant-sudo');
        system.assistant = assistantBridge(sys, sudo);
      }
      if (permissions.has('volumes')) {
        await sys.ready('volumes');
        const v: Record<string, unknown> = {};
        for (const m of ['state', 'mount', 'unlock', 'eject']) v[m] = (...args: unknown[]) => sys.call('volumes', `volumes:${m}`, args);
        v.onChanged = (cb: (state: unknown) => void) => sys.on('volumes', 'volumes:changed', (s) => cb(s));
        v.onEvent = (cb: (event: unknown) => void) => sys.on('volumes', 'volumes:event', (e) => cb(e));
        system.volumes = v as unknown as VolumesBridge;
      }
      if (permissions.has('indd')) {
        await sys.ready('indd');
        system.indd = { convert: (...args: unknown[]) => sys.call('indd', 'indd:convert', args) } as unknown as InddBridge;
      }
      if (permissions.has('mail')) {
        await sys.ready('mail');
        const m: Record<string, unknown> = {};
        for (const c of ['accounts', 'discover', 'addAccount', 'updateAccount', 'removeAccount', 'mailboxes', 'messages', 'message', 'attachment', 'setFlags', 'move', 'remove', 'send', 'saveDraft']) {
          m[c] = (...args: unknown[]) => sys.call('mail', `mail:${c}`, args);
        }
        m.onChanged = (cb: (change: unknown) => void) => sys.on('mail', 'mail:changed', (c) => cb(c));
        system.mail = m as unknown as MailBridge;
      }
      if (permissions.has('passwords')) {
        await sys.ready('passwords');
        const p: Record<string, unknown> = {};
        for (const m of [
          'state', 'create', 'unlock', 'lock', 'setAutoUnlock', 'forgetNever', 'changePassword', 'list', 'get', 'save',
          'setFavorite', 'move', 'trash', 'restore', 'deleteForever', 'emptyTrash', 'createGroup', 'renameGroup',
          'deleteGroup', 'generate', 'copy',
        ]) {
          p[m] = (...args: unknown[]) => sys.call('passwords', `passwords:${m}`, args);
        }
        p.onChanged = (cb: (state: unknown) => void) => sys.on('passwords', 'passwords:changed', (s) => cb(s));
        system.passwords = p as unknown as PasswordsBridge;
      }
      if (permissions.has('vms')) {
        await sys.ready('vms');
        const v: Record<string, unknown> = {};
        for (const m of [
          'status', 'list', 'create', 'install', 'retryInstall', 'cancelInstall', 'update', 'remove', 'start', 'shutdown', 'forceStop', 'pause', 'resume', 'reset',
          'setCdrom', 'resizeDisk', 'snapshots', 'takeSnapshot', 'restoreSnapshot', 'deleteSnapshot', 'openDisplay',
        ]) {
          v[m] = (...args: unknown[]) => sys.call('vms', `vms:${m}`, args);
        }
        v.displayWrite = (...args: unknown[]) => sys.send('vms', 'vms:displayWrite', args);
        v.closeDisplay = (...args: unknown[]) => sys.send('vms', 'vms:closeDisplay', args);
        v.onDisplayData = (cb: (conn: number, data: Uint8Array) => void) =>
          sys.on('vms', 'vms:display', (conn, data) => cb(conn as number, data as Uint8Array));
        v.onDisplayClosed = (cb: (conn: number) => void) => sys.on('vms', 'vms:displayClosed', (conn) => cb(conn as number));
        v.onChanged = (cb: (vms: unknown) => void) => sys.on('vms', 'vms:changed', (list) => cb(list));
        system.vms = v as unknown as VmsBridge;
      }
    }

    // The splash goes on load, or now if that's been: whichever is later.
    if (document.readyState === 'complete') queueMicrotask(() => app.ready());
    else window.addEventListener('load', () => app.ready(), { once: true });
    resolveReady();
  });
}
