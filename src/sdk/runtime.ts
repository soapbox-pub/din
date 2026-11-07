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
 * window's state, the theme, the permissions) arrives with its
 * hello, and `din.ready` resolves once it has. Calls made before then wait
 * their turn.
 *
 * It must stay self-contained (no imports with side effects outside this
 * file's graph): it's bundled into one function the preload serializes.
 */
import type {
  Din,
  DinApp,
  DinAssistant,
  AssistantSettings,
  DinClipboard,
  DinDesktop,
  DinDrag,
  DinFiles,
  DinMenus,
  DinSystem,
  DinTheme,
  DinWindow,
  DragInfo,
  FrameStyle,
  MenuItem,
  Nip07,
  NostrEventTemplate,
  Permission,
  SignedNostrEvent,
  Rect,
  Snap,
  ThemeSnapshot,
  Unsubscribe,
} from '@/sdk/din';
import type { FsBridge } from '@/lib/fs';
import type { AssistantBridge } from '@/lib/assistant';
import type { InddBridge } from '@/lib/indd';
import type { MailBridge } from '@/lib/mail';
import type { VolumesBridge } from '@/lib/volumes';
import type { DriveSetupBridge } from '@/lib/drive';
import type { PasswordsBridge } from '@/lib/passwords';
import type { PhoneAppBridge } from '@/lib/phone';
import type { VmsBridge } from '@/lib/vms';
import type { GamesBridge } from '@/lib/games';
import type { CaptureBridge } from '@/lib/capture';
import type { FromDesktop, MediaAction, HandleData, Hello, Method, NotificationData, Push, Requests, ThemeData, WindowState, LaunchData } from '@/sdk/protocol';
import { acceleratorMatches } from '@/sdk/accelerators';
import { caretSpot, typesText } from '@/shared/caret';
import { seedHandles } from '@/shared/handleStore';
import { TITLE_BAR_CONTROLS } from '@/shared/titleBarControls';
import {
  bridgeMediaSession,
  grantOf,
  installFilePickers,
  installFileSystemObserver,
  installLaunchQueue,
  installClipboardFiles,
  installDraggedFiles,
  installDroppedFiles,
  installPermissionsQuery,
  installSpeechRecognition,
  installStoredHandles,
  installSavedState,
  installWindowState,
  toWebHandle,
  watchDocumentHead,
  type Grant,
} from '@/sdk/standards';

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

/**
 * Settings → Accessibility reach the app as the web's media features (set
 * on each app by electron/accessibility.mts); Din's stylesheet keys its
 * rules for them to root attributes, as the desktop's own root has them.
 */
function markAccessibility(): void {
  const root = document.documentElement;
  for (const [query, attribute] of [
    ['(prefers-reduced-motion: reduce)', 'data-reduce-motion'],
    ['(prefers-reduced-transparency: reduce)', 'data-reduce-transparency'],
    ['(prefers-contrast: more)', 'data-increase-contrast'],
  ]) {
    const media = matchMedia(query);
    const mark = () => root.toggleAttribute(attribute, media.matches);
    mark();
    media.addEventListener('change', mark);
  }
}

/** Apply the desktop's theme to this document. */
function applyTheme(theme: ThemeData, loadedFaces: Set<string>): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(theme.scheme);
  // On the body, not the root: a dark root makes Chromium paint the page's
  // canvas opaque dark, hiding the window's glass behind the app (app.css).
  root.style.setProperty('--din-color-scheme', theme.scheme);
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
  for (const m of ['status', 'setEnabled', 'install', 'restart', 'checkUpdate', 'upgrade', 'recentModels', 'request', 'claude', 'claudeInstall', 'claudeLogin', 'claudeCode', 'claudeCancel', 'git']) {
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
  const fileListeners = new Map<string, Set<(change: 'modified' | 'removed') => void>>();
  pushes.on((p) => {
    if (p.type === 'fileChange') for (const cb of [...(fileListeners.get(p.handle) ?? [])]) cb(p.change);
  });
  installFileSystemObserver((grant, cb) => {
    let stopped = false;
    let stop = () => {
      stopped = true;
    };
    void grant.id().then((id) => {
      if (stopped) return;
      let listeners = fileListeners.get(id);
      if (!listeners) {
        fileListeners.set(id, (listeners = new Set()));
        tell('files.watch', { handle: id });
      }
      const set = listeners;
      set.add(cb);
      stop = () => {
        set.delete(cb);
        if (set.size || fileListeners.get(id) !== set) return;
        fileListeners.delete(id);
        tell('files.unwatch', { handle: id });
      };
    }, () => {});
    return () => stop();
  });
  const grantFor = (file: FileSystemHandle): Grant => {
    const grant = grantOf(file);
    if (!grant) throw new TypeError('Not a file handle Din granted');
    return grant;
  };
  /** The desktop's id for a handle, getting a stored one's grant back first. */
  const idOf = (file: FileSystemHandle): Promise<string> => {
    try {
      return grantFor(file).id();
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const idsOf = (files: FileSystemHandle[] | undefined) => (files ? Promise.all(files.map(idOf)) : Promise.resolve(undefined));
  function grant(data: HandleData, token?: string): Grant {
    return {
      id: () => Promise.resolve(data.id),
      token,
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
      entries: async () => (data.kind === 'directory' ? (await request('files.entries', { handle: data.id })).map((d) => grant(d)) : []),
    };
  }
  // Handles kept in IndexedDB: as their grants' tokens, which the desktop keeps.
  const tokens = new Map<string, string>();
  installStoredHandles({
    store: (g) => {
      const known = g.token ?? tokens.get(g.key);
      if (known) return known;
      const token = crypto.randomUUID();
      tokens.set(g.key, token);
      void g.id().then((handle) => tell('files.persist', { handle, token }), () => {});
      return token;
    },
    restore: (stored) => {
      let live: Promise<Grant> | null = null;
      const real = () =>
        (live ??= request('files.restore', { token: stored.token }).then((data) => {
          if (!data) throw new DOMException(`${stored.name} can’t be found`, 'NotFoundError');
          return grant(data, stored.token);
        }));
      return {
        id: async () => (await real()).id(),
        token: stored.token,
        kind: stored.kind,
        name: stored.name,
        key: stored.key,
        path: stored.path,
        writable: stored.writable,
        getFile: async () => (await real()).getFile(),
        write: async (content) => (await real()).write(content),
        entries: async () => (await real()).entries(),
      };
    },
  });
  const wrap = (data: HandleData): FileSystemHandle => toWebHandle(grant(data)) as unknown as FileSystemHandle;
  const launchTo = installLaunchQueue();
  const restoreState = installSavedState((state) => tell('app.saveState', { state }));
  let opener: string | null = null;
  /** A launch: its opener and the state to restore first, for `launchQueue`'s consumer to read. */
  const launched = (l: LaunchData) => {
    opener = l.opener;
    // A reopened window's entry has state, null if it saved none: getState() tells it from a new one's undefined.
    if (l.state !== null || l.restored) restoreState(l.state);
    launchTo(l.url, l.files.map((d) => grant(d)));
  };

  // ---- app ----
  pushes.on((p) => {
    if (p.type === 'launch') launched(p.launch);
  });
  let readied = false;
  /** An app's URL, as a launch: a din:// app's, or this app's own (a new window of it); null for anything else. */
  const appTarget = (url: string | URL): { url: string; self: boolean } | null => {
    let u: URL;
    try {
      u = new URL(String(url), location.href);
    } catch {
      return null;
    }
    const self = u.protocol === location.protocol && u.host === location.host;
    return self || u.protocol === 'din:' || u.protocol === 'din+file:' ? { url: u.href, self } : null;
  };
  const app: DinApp = {
    get opener() {
      return opener;
    },
    ready() {
      if (readied) return;
      readied = true;
      tell('app.ready');
    },
    launch: async (url, files) => {
      const target = appTarget(url);
      if (!target) throw new TypeError(`Not an app's URL: ${String(url)}`);
      await request('app.open', { ...target, handles: await idsOf(files) });
    },
    openFiles: async (files, app) => request('app.openFiles', { handles: (await idsOf(files)) ?? [], ...(app ? { app } : {}) }),
    openWithApps: async (file) => {
      const [handle] = (await idsOf([file])) ?? [];
      return handle ? request('app.openWithApps', { handle }) : [];
    },
  };

  // ---- window ----
  let state: WindowState = NO_STATE;
  let frameStyle: FrameStyle = { accent: null, dark: false };
  let helloed = false;
  const states = new Emitter<void>();
  const snaps = new Emitter<Snap | null>();
  installWindowState({ state: () => (helloed ? state : null), onChange: (cb) => states.on(cb) });
  const styles = new Emitter<FrameStyle>();
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
      const snapped = state.snapped;
      state = p.state;
      // For CSS: the window fills its part of the screen, so what's inset in
      // it (appChrome's ContentPane) goes edge to edge, as on the desktop.
      // The edges that are the screen's, as screenEdges (src/lib/monitors.ts) has them.
      const whole = state.maximized || state.fullscreen;
      const root = document.documentElement;
      root.toggleAttribute('data-window-flush', whole || state.snapped !== null);
      root.toggleAttribute('data-screen-right', whole || state.snapped === 'right' || state.snapped === 'top-right' || state.snapped === 'bottom-right');
      root.toggleAttribute('data-screen-bottom', whole || state.snapped === 'left' || state.snapped === 'right' || state.snapped === 'bottom-left' || state.snapped === 'bottom-right');
      states.emit();
      if (state.snapped !== snapped) snaps.emit(state.snapped);
    } else if (p.type === 'frameStyle') {
      frameStyle = p.style;
      styles.emit(frameStyle);
    } else if (p.type === 'closeRequest') {
      // The web's beforeunload: cancelling it keeps the window open, and the app asks.
      const event = document.createEvent('BeforeUnloadEvent');
      event.initEvent('beforeunload', false, true);
      window.dispatchEvent(event);
      tell('window.closeAnswer', { request: p.request, keep: event.defaultPrevented || !!event.returnValue });
    }
  });
  const point = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
  /**
   * A move or resize begun from `down`, until `begun` resolves at its end.
   * Framed, the pointer stays here, so it's passed on: as a distance in
   * screen pixels, which holds while the frame moves along under it. So
   * does a finger or a pen anywhere: a touch goes to the page it began on
   * until it lifts, and never reaches the desktop's layer over the screen.
   */
  const gesture = (down: PointerEvent, begun: Promise<void>): Promise<void> => {
    if (!transport.framed && down.pointerType === 'mouse') return begun;
    const send = (e: PointerEvent, done: boolean) => {
      if (e.pointerId !== down.pointerId) return;
      tell('window.gesturePointer', { delta: { x: e.screenX - down.screenX, y: e.screenY - down.screenY }, done });
    };
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
    get id() {
      return state.id;
    },
    get snapped() {
      return state.snapped;
    },
    onSnappedChange: (cb) => snaps.on(cb),
    get frameStyle() {
      return frameStyle;
    },
    onFrameStyleChange: (cb) => styles.on(cb),
    setChrome: (chrome) => tell('window.setChrome', chrome),
    setShape: (shape) => tell('window.setShape', { shape }),
    beginMove: (e) => gesture(e, request('window.beginMove', { at: point(e) })),
    beginResize: (edge, e) => gesture(e, request('window.beginResize', { edge, at: point(e) })),
    requestClose: () => tell('window.requestClose'),
    tabDragMove: (at, label) => request('window.tabDragMove', { at, label }),
    tabDragEnd: (at) => request('window.tabDragEnd', { at }),
    onTabHover: (cb) => tabHovers.on(cb),
  };

  // CSS `app-region: drag`, from the Window Controls Overlay draft, is the
  // window's title bar: pressing it moves the window, double-clicking
  // maximizes it and right-clicking opens Din's window menu. Controls and
  // fields inside it, and anything `app-region: no-drag`, keep their own
  // clicks. Each runs after the page's own listeners, which can cancel it.
  const dragRegion = (target: EventTarget | null): boolean => {
    for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
      if (el.matches(TITLE_BAR_CONTROLS)) return false;
      const style = getComputedStyle(el);
      const region = style.getPropertyValue('app-region') || style.getPropertyValue('-webkit-app-region');
      if (region === 'drag') return true;
      if (region === 'no-drag') return false;
    }
    return false;
  };
  window.addEventListener('pointerdown', (e) => {
    if (e.defaultPrevented || e.button !== 0 || !e.isPrimary || !dragRegion(e.target)) return;
    e.preventDefault();
    // The move is handed to the desktop only once the pointer has moved a
    // little: the desktop then takes the whole gesture, and a click or
    // double-click would never come back here.
    const move = (m: PointerEvent) => {
      if (m.pointerId !== e.pointerId || Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 3) return;
      stop();
      void win.beginMove(e);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  window.addEventListener('dblclick', (e) => {
    if (e.defaultPrevented || e.button !== 0 || !dragRegion(e.target)) return;
    void request(state.maximized ? 'window.restore' : 'window.maximize');
  });
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || !dragRegion(e.target)) return;
    e.preventDefault();
    tell('window.menu', { at: point(e) });
  });

  watchDocumentHead({
    title: (title) => tell('window.setTitle', { title }),
    icon: (url) => tell('window.setIcon', { url }),
    accent: (color) => tell('window.setAccent', { color }),
  });
  const define = (name: string, value: unknown) => Object.defineProperty(window, name, { value, writable: true, configurable: true });
  // The Additional Windowing Controls draft's.
  for (const name of ['minimize', 'maximize', 'restore'] as const) define(name, () => request(`window.${name}`));
  // The web's own: in the desktop's CSS pixels, frame included (outerWidth
  // and outerHeight). A move and a resize in the same task go as one, so
  // neither undoes the other.
  let bounds: Partial<Rect> | null = null;
  const setBounds = (next: Partial<Rect>) => {
    if (!Object.values(next).every(Number.isFinite)) return;
    if (!bounds) {
      bounds = {};
      queueMicrotask(() => {
        const b = bounds!;
        bounds = null;
        tell('window.setBounds', b);
      });
    }
    Object.assign(bounds, next);
  };
  const now = () => ({ ...state.bounds, ...bounds });
  define('moveTo', (x: number, y: number) => setBounds({ x: Number(x), y: Number(y) }));
  define('moveBy', (dx: number, dy: number) => setBounds({ x: now().x + Number(dx), y: now().y + Number(dy) }));
  define('resizeTo', (width: number, height: number) => setBounds({ width: Number(width), height: Number(height) }));
  define('resizeBy', (dw: number, dh: number) => setBounds({ width: now().width + Number(dw), height: now().height + Number(dh) }));
  // The desktop asks before closing the window (a closeRequest, above) while
  // the page listens for beforeunload, as a browser asks before closing a tab.
  const unloadListeners = new Map<unknown, Set<boolean>>();
  const onbeforeunload = (() => {
    for (let o: object | null = window; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, 'onbeforeunload');
      if (d?.get && d.set) return { get: d.get, set: d.set };
    }
    return null;
  })();
  let guarded = false;
  const guard = () => {
    const on = unloadListeners.size > 0 || onbeforeunload?.get.call(window) != null;
    if (on !== guarded) tell('window.setCloseGuard', { on: (guarded = on) });
  };
  const capture = (options: unknown) => (typeof options === 'boolean' ? options : !!(options as { capture?: boolean } | undefined)?.capture);
  const addListener = window.addEventListener;
  const removeListener = window.removeEventListener;
  define('addEventListener', (type: string, listener: unknown, options?: unknown) => {
    (addListener as (...a: unknown[]) => void).call(window, type, listener, options);
    if (type !== 'beforeunload' || !listener) return;
    const set = unloadListeners.get(listener) ?? new Set();
    unloadListeners.set(listener, set.add(capture(options)));
    guard();
  });
  define('removeEventListener', (type: string, listener: unknown, options?: unknown) => {
    (removeListener as (...a: unknown[]) => void).call(window, type, listener, options);
    const set = type === 'beforeunload' ? unloadListeners.get(listener) : undefined;
    if (!set) return;
    set.delete(capture(options));
    if (!set.size) unloadListeners.delete(listener);
    guard();
  });
  if (onbeforeunload) {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true,
      enumerable: true,
      get: () => onbeforeunload.get.call(window),
      set: (handler: unknown) => {
        onbeforeunload.set.call(window, handler);
        guard();
      },
    });
  }
  // focus() brings the window forward; close() closes it at once, without
  // a beforeunload.
  define('focus', () => tell('window.focus'));
  define('close', () => tell('window.close'));
  // An app's URL (din://<id>/, its launch parameters in the query) launches
  // it, and the app's own a new window of it. Other links open as they do
  // anywhere on the desktop: into an installed app that owns the site,
  // mailto: in Mail, nostr: in its viewer, else the Web Browser. Like a
  // noopener open, it returns no window.
  define('open', (url?: string | URL, target?: string) => {
    if (url === undefined || String(url) === '') return null;
    const href = new URL(String(url), location.href).href;
    if (target === '_self' || target === '_parent' || target === '_top') {
      location.assign(href);
      return window;
    }
    const launch = appTarget(href);
    if (launch) tell('app.open', launch);
    else tell('app.openUrl', { url: href });
    return null;
  });

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
  const withHandle = async <T extends { startInHandle?: Grant }>(options: T) => {
    const { startInHandle, ...rest } = options;
    return { ...rest, startInHandle: startInHandle ? await startInHandle.id().catch(() => undefined) : undefined };
  };
  installFilePickers({
    open: async (options) => (await request('files.open', await withHandle(options))).map((d) => grant(d)),
    save: async (options) => {
      const result = await request('files.save', await withHandle(options));
      return result ? grant(result) : null;
    },
  });
  const files: DinFiles = {
    path: (handle) => grantFor(handle).path,
    url: async (handle) => request('files.url', { handle: await idOf(handle) }),
    parent: async (handle) => {
      const p = await request('files.parent', { handle: await idOf(handle) });
      return p ? (wrap(p) as FileSystemDirectoryHandle) : null;
    },
    fromPath: async (path) => {
      await ready;
      needFs();
      return wrap(await request('files.fromPath', { path }));
    },
    requestAccess: async (paths, reason) => (await request('files.requestAccess', { paths, reason })).map(wrap),
    upload: async (handle) => {
      await ready;
      need('nostr');
      return request('files.upload', { handle: await idOf(handle) });
    },
    pathUrl: (path) => {
      needFs();
      if (!h?.fsUrlBase) throw new Error('File URLs are only available inside Din');
      return `${h.fsUrlBase}${path.split('/').map(encodeURIComponent).join('/')}`;
    },
  };

  // ---- drag and drop ----
  let currentDrag: DragInfo | null = null;
  const drags = new Emitter<DragInfo | null>();
  pushes.on((p) => {
    if (p.type !== 'drag') return;
    currentDrag = p.drag;
    drags.emit(currentDrag);
    reportDragOver(currentDrag !== null);
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

  // Files dragged out: the web's dragstart, carrying handles or file: URLs.
  installDraggedFiles({
    byPath: () => permissions.has('fs') || !!h?.scopedFs,
    start: async (token, list, label) => {
      if ('grants' in list) await request('drag.startFiles', { token, handles: await Promise.all(list.grants.map((g) => g.id())), label });
      else await request('drag.startPaths', { token, paths: list.paths, label });
    },
    finish: (token, dropEffect, at) => tell('drag.finish', { token, dropEffect, at }),
  });
  // A drop of files from another app: the web's file items, whose
  // getAsFileSystemHandle() trades the drag's token for grants to them.
  installDroppedFiles({
    drag: () => currentDrag,
    accept: async (token, operation) => {
      const result = await request('drag.accept', { token, operation });
      return result ? result.files.map(wrap) : [];
    },
  });
  const drag: DinDrag = {
    get current() {
      return currentDrag;
    },
    onChange: (cb) => drags.on(cb),
  };

  // ---- clipboard ----
  let clipboardFiles = 0;
  // The Clipboard API draft's clipboardchange, when files come or go.
  pushes.on((p) => {
    if (p.type !== 'clipboardFiles') return;
    clipboardFiles = p.has?.count ?? 0;
    if (!navigator.clipboard) return;
    const event = new Event('clipboardchange');
    Object.defineProperty(event, 'types', { value: Object.freeze(p.has ? ['Files'] : []), enumerable: true });
    navigator.clipboard.dispatchEvent(event);
  });
  const readClipboard = async () => {
    const r = await request('clipboard.readFiles');
    return r ? { files: r.files.map(wrap), cut: r.cut } : null;
  };
  const writeClipboard = (handles: Promise<string[] | undefined>, cut: boolean) => {
    void handles.then((ids) => tell('clipboard.writeFiles', { handles: ids ?? [], cut }), (e: unknown) => console.warn('din: clipboard.writeFiles:', e));
  };
  // The web's copy, cut and paste events, carrying handles.
  installClipboardFiles({
    count: () => clipboardFiles,
    read: async () => (await readClipboard())?.files ?? [],
    write: (list, cut) => writeClipboard(Promise.all(list.map((g) => g.id())), cut),
  });
  const clipboard: DinClipboard = {
    readFiles: readClipboard,
    writeFiles: (list, cut) => writeClipboard(idsOf(list), cut),
  };

  // ---- theme ----
  const loadedFaces = new Set<string>();
  let themeSnapshot: ThemeSnapshot = { tokens: {}, fontFaces: [], icons: {} };
  const themes = new Emitter<ThemeSnapshot>();
  const takeTheme = ({ scheme: _, ...snapshot }: ThemeData) => (themeSnapshot = snapshot);
  pushes.on((p) => {
    if (p.type !== 'theme') return;
    applyTheme(p.theme, loadedFaces);
    themes.emit(takeTheme(p.theme));
  });
  const theme: DinTheme = {
    get current() {
      return themeSnapshot;
    },
    onChange: (cb) => themes.on(cb),
  };

  // ---- window.nostr ----
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

  // ---- notifications and permissions (the web's own APIs) ----
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
  installPermissionsQuery({ ready, has: (p) => permissions.has(p) });
  Object.defineProperty(navigator, 'getInstalledRelatedApps', { value: () => request('app.relatedApps'), configurable: true });

  // ---- media session, wallpaper, dictation ----
  const mediaActions = new Emitter<MediaAction>();
  pushes.on((p) => {
    if (p.type === 'mediaAction') mediaActions.emit(p.action);
  });
  bridgeMediaSession({
    report: (session) => tell('media.setSession', { session }),
    onAction: (cb) => mediaActions.on(cb),
  });
  const desktop: DinDesktop = {
    setWallpaper: async (file) => {
      await ready;
      need('wallpaper');
      await request('desktop.setWallpaper', { handle: await idOf(file) });
    },
    setCursor: async (file) => {
      await ready;
      need('cursor');
      await request('desktop.setCursor', { handle: await idOf(file) });
    },
  };
  installSpeechRecognition({
    available: async () => {
      await ready;
      return h?.dictation.available ?? false;
    },
    start: (id, continuous) => request('speech.start', { id, continuous }),
    stop: () => tell('speech.stop'),
    abort: () => tell('speech.abort'),
    onEvent: (cb) => pushes.on((p) => {
      if (p.type === 'speech') cb(p);
    }),
  });

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

  // ---- din.fetch: requests without CORS, to the manifest's `din.fetch` hosts (electron/napp-fetch.mts) ----
  const NULL_BODY = new Set([101, 103, 204, 205, 304]);
  const aborted = (signal: AbortSignal) => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  /** A bridge call, its refusal thrown as fetch's own TypeError. */
  const fetchCall = async (channel: string, args: unknown[]): Promise<unknown> => {
    try {
      return await bridges!.call('fetch', channel, args);
    } catch (error) {
      throw new TypeError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  };
  const dinFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const hello = await helloArrived;
    if (!hello.fetch || !bridges) throw new DinPermissionError('fetch', "This app's manifest names no hosts for din.fetch");
    await bridges.ready('fetch');
    const request = new Request(input, init);
    const { signal } = request;
    if (signal.aborted) throw aborted(signal);
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
    const head = (await fetchCall('fetch:start', [
      { url: request.url, method: request.method, headers: [...request.headers], body, redirect: request.redirect },
    ])) as { id: number; status: number; statusText: string; headers: [string, string][] };
    const abort = () => void bridges.call('fetch', 'fetch:abort', [head.id]).catch(() => {});
    signal.addEventListener('abort', abort, { once: true });
    const nullBody = NULL_BODY.has(head.status) || request.method === 'HEAD';
    if (nullBody) abort();
    const stream = nullBody
      ? null
      : new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (signal.aborted) {
                controller.error(aborted(signal));
                return;
              }
              const chunk = (await fetchCall('fetch:read', [head.id])) as Uint8Array | null;
              if (chunk === null) {
                signal.removeEventListener('abort', abort);
                controller.close();
              } else {
                controller.enqueue(chunk);
              }
            },
            cancel: abort,
          },
          { highWaterMark: 0 },
        );
    return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers });
  };

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
    desktop,
    assistant,
    system,
    fetch: dinFetch,
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

    // Handles kept from before they went in IndexedDB, put there now.
    if (hello.unstoredHandles.length > 0) {
      void seedHandles(hello.unstoredHandles.map((s) => [s.token, s]))
        .then((tokens) => tell('files.stored', { tokens }))
        .catch((e: unknown) => console.warn('din: keeping file handles:', e));
    }

    for (const p of hello.permissions) permissions.add(p);
    launched(hello.launch);
    state = hello.state;
    helloed = true;
    states.emit();
    frameStyle = hello.frameStyle;
    takeTheme(hello.theme);
    applyTheme(hello.theme, loadedFaces);
    markAccessibility();
    currentDrag = hello.drag;
    clipboardFiles = hello.clipboardFiles?.count ?? 0;
    reportDragOver(hello.drag !== null);
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
      if (permissions.has('drive')) {
        await sys.ready('drive');
        system.drive = {
          state: () => sys.call('drive', 'drive:state', []),
          setUp: () => sys.call('drive', 'drive:setup', []),
        } as unknown as DriveSetupBridge;
      }
      if (permissions.has('indd')) {
        await sys.ready('indd');
        system.indd = { convert: (...args: unknown[]) => sys.call('indd', 'indd:convert', args) } as unknown as InddBridge;
      }
      if (permissions.has('mail')) {
        await sys.ready('mail');
        const m: Record<string, unknown> = {};
        for (const c of ['accounts', 'discover', 'addAccount', 'updateAccount', 'removeAccount', 'mailboxes', 'messages', 'message', 'conversation', 'attachment', 'setFlags', 'labels', 'createLabel', 'updateLabel', 'deleteLabel', 'setLabels', 'markAllRead', 'avatar', 'avatarLookups', 'setAvatarLookups', 'inboxTabs', 'setInboxTabs', 'tabCounts', 'tabRules', 'setTabRule', 'move', 'remove', 'send', 'saveDraft', 'subscriptions', 'unsubscribe', 'unsubscribeMessage']) {
          m[c] = (...args: unknown[]) => sys.call('mail', `mail:${c}`, args);
        }
        m.onChanged = (cb: (change: unknown) => void) => sys.on('mail', 'mail:changed', (c) => cb(c));
        system.mail = m as unknown as MailBridge;
      }
      if (permissions.has('phone')) {
        await sys.ready('phone');
        const p: Record<string, unknown> = {};
        for (const m of ['state', 'conversations', 'messages', 'contacts', 'send', 'markRead', 'deleteConversation', 'refresh']) {
          p[m] = (...args: unknown[]) => sys.call('phone', `phone:${m}`, args);
        }
        p.onChanged = (cb: (state: unknown) => void) => sys.on('phone', 'phone:changed', (s) => cb(s));
        p.onMessages = (cb: (change: unknown) => void) => sys.on('phone', 'phone:messages', (c) => cb(c));
        p.onIncoming = (cb: (incoming: unknown) => void) => sys.on('phone', 'phone:incoming', (i) => cb(i));
        system.phone = p as unknown as PhoneAppBridge;
      }
      if (permissions.has('passwords')) {
        await sys.ready('passwords');
        const p: Record<string, unknown> = {};
        for (const m of [
          'state', 'create', 'createWithComputerPassword', 'unlock', 'lock', 'setAutoUnlock', 'forgetNever',
          'changePassword', 'list', 'get', 'save', 'setFavorite', 'move', 'trash', 'restore', 'removePasskey', 'deleteForever', 'emptyTrash', 'createGroup', 'renameGroup',
          'deleteGroup', 'import', 'generate', 'copy',
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
      if (permissions.has('games')) {
        await sys.ready('games');
        const g: Record<string, unknown> = {};
        for (const m of ['status', 'library', 'play', 'stop', 'setFavorite', 'setVersion', 'resumeImage', 'forgetResume']) {
          g[m] = (...args: unknown[]) => sys.call('games', `games:${m}`, args);
        }
        g.onChanged = (cb: (change: unknown) => void) => sys.on('games', 'games:changed', (change) => cb(change));
        system.games = g as unknown as GamesBridge;
      }
      if (permissions.has('capture')) {
        await sys.ready('capture');
        const c: Record<string, unknown> = {};
        for (const m of [
          'status', 'pointer', 'pointerImage', 'takes', 'take', 'rename', 'begin', 'end', 'open', 'write', 'close', 'transcribe',
          'projects', 'project', 'createProject', 'openProject', 'updateProject', 'importBegin', 'importEnd',
          'destinations', 'saveDestination', 'removeDestination', 'streamStart', 'streamStop',
        ]) {
          c[m] = (...args: unknown[]) => sys.call('capture', `capture:${m}`, args);
        }
        c.streamWrite = (...args: unknown[]) => sys.send('capture', 'capture:streamWrite', args);
        c.onState = (cb: (state: unknown) => void) => sys.on('capture', 'capture:state', (s) => cb(s));
        c.onChanged = (cb: (take: unknown) => void) => sys.on('capture', 'capture:changed', (t) => cb(t));
        c.onProjectChanged = (cb: (project: unknown) => void) => sys.on('capture', 'capture:projectChanged', (p) => cb(p));
        c.onStreamEnded = (cb: (ended: unknown) => void) => sys.on('capture', 'capture:streamEnded', (e) => cb(e));
        system.capture = c as unknown as CaptureBridge;
      }
    }

    // The splash goes on load, or now if that's been: whichever is later.
    if (document.readyState === 'complete') queueMicrotask(() => app.ready());
    else window.addEventListener('load', () => app.ready(), { once: true });
    resolveReady();
  });
}
