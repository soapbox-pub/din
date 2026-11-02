/**
 * Web standards an app can use instead of `window.din`, wired to the
 * desktop by the runtime (src/sdk/runtime.ts), so a page written for the web
 * works in a Din window as it would in a browser:
 *
 * - The Media Session API (`navigator.mediaSession`) is what Din's media
 *   controls and the media keys show and drive.
 * - `document.title`, `<link rel="icon">` and `<meta name="theme-color">`
 *   are the window's title, icon and accent.
 * - File System Access (`showOpenFilePicker` and the rest) opens Din's
 *   pickers, its handles backed by the desktop's grants, and
 *   `FileSystemObserver` hears when something else changes them.
 * - Launch Handling's `launchQueue` hears each launch's files.
 * - Focus, visibility, `display-state`, `screenX` and the rest answer for
 *   the page's own window on the desktop.
 *
 * Part of the runtime's bundle, so nothing here may have side effects on
 * import.
 */
import type {
  DirectoryPickerOptions,
  LaunchParams,
  OpenFilePickerOptions,
  PickerOptions,
  SaveFilePickerOptions,
  Unsubscribe,
} from '@/sdk/din';
import type { FileTypeFilter, MediaAction, MediaReport, OpenFileOptions, SaveFileOptions, WindowState } from '@/sdk/protocol';

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
  report(session: MediaReport | null): void;
  /** Din's media controls and the media keys. */
  onAction(cb: (action: MediaAction) => void): Unsubscribe;
}

/**
 * Pass what the page tells `navigator.mediaSession` on to the desktop, and
 * the desktop's actions to the page's action handlers. Without a handler,
 * play and pause act on the page's `<audio>` and `<video>`, as a browser's
 * media controls do.
 */
export function bridgeMediaSession(host: MediaSessionHost): void {
  if (typeof MediaSession === 'undefined' || !navigator.mediaSession) return;
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler>();
  let last = '';

  const elements = () => [...document.querySelectorAll<HTMLMediaElement>('audio, video')].filter((el) => el.currentSrc && !el.ended);

  const summarize = (): MediaReport | null => {
    const session = navigator.mediaSession;
    const metadata = session.metadata;
    if (!metadata && handlers.size === 0) return null;
    // No metadata but a play handler: stopped with something ready to play.
    // Not shown in Din's media controls, but a play key with nothing else
    // playing starts it.
    if (!metadata && handlers.has('play')) {
      return {
        title: document.title,
        subtitle: '',
        artwork: null,
        playing: false,
        canPlay: true,
        canPrevious: handlers.has('previoustrack'),
        canNext: handlers.has('nexttrack'),
        idle: true,
      };
    }
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

}

export interface DocumentHeadHost {
  title(title: string | null): void;
  icon(url: string | null): void;
  accent(color: string | null): void;
}

/**
 * The window's title, icon and accent from the page's `<title>`, icon link
 * and theme-color, as a browser's tab follows them (the last of each in the
 * head). What the page's HTML starts with is the app's own (its name, its
 * icon, its manifest's color), so only changes from that are passed on,
 * and going back to it gives the window the app's again.
 */
export function watchDocumentHead(host: DocumentHeadHost): void {
  const read = () => {
    const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i][href]');
    const themeColor = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color" i][content]')]
      .reverse()
      .find((m) => !m.media || matchMedia(m.media).matches);
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

// ---------------------------------------------------------------------------
// The window's state
// ---------------------------------------------------------------------------

export interface WindowStateHost {
  /** The desktop's view of the window, current; null before the hello. */
  state(): WindowState | null;
  onChange(cb: () => void): Unsubscribe;
}

const DISPLAY_STATE = /^\s*(not\s+)?\(\s*display-state\s*:\s*(fullscreen|maximized|minimized|normal)\s*\)\s*$/i;

/**
 * The window as the web's own state, answered from the desktop's: a page in
 * a webview (or a frame) otherwise sees the host's window, not its own.
 *
 * - `document.hasFocus()` and window `focus`/`blur`: whether it's the
 *   window keyboard input goes to (the page's own focus events for the
 *   window are held back, which a click on the menu bar would send).
 * - `document.visibilityState`, `hidden` and `visibilitychange`: hidden
 *   while minimized or on another workspace, too.
 * - `matchMedia('(display-state: …)')`, from the Additional Windowing
 *   Controls draft: `fullscreen`, `maximized`, `minimized` or `normal`.
 *   Only in script: stylesheets' @media don't know it.
 * - `screenX`/`screenLeft`, `screenY`/`screenTop`, `outerWidth` and
 *   `outerHeight`: where the window is and its size, frame included.
 * - `screen.availLeft`, `availTop`, `availWidth`, `availHeight`: the work
 *   area of the monitor it's on.
 *
 * Until the hello, each answers as the page's own.
 */
export function installWindowState(host: WindowStateHost): void {
  const get = (target: object, name: string, value: () => unknown) =>
    Object.defineProperty(target, name, { get: value, configurable: true, enumerable: true });
  const native = (target: object, name: string): (() => unknown) => {
    for (let o: object | null = target; o; o = Object.getPrototypeOf(o)) {
      const getter = Object.getOwnPropertyDescriptor(o, name)?.get;
      if (getter) return () => getter.call(target);
    }
    return () => undefined;
  };

  // Place and size.
  const sized = () => {
    const s = host.state();
    return s && s.bounds.width > 0 ? s : null;
  };
  for (const [name, read] of [
    ['screenX', (s: WindowState) => s.bounds.x],
    ['screenLeft', (s: WindowState) => s.bounds.x],
    ['screenY', (s: WindowState) => s.bounds.y],
    ['screenTop', (s: WindowState) => s.bounds.y],
    ['outerWidth', (s: WindowState) => s.bounds.width],
    ['outerHeight', (s: WindowState) => s.bounds.height],
  ] as const) {
    const own = native(window, name);
    get(window, name, () => {
      const s = sized();
      return s ? read(s) : own();
    });
  }
  for (const [name, read] of [
    ['availLeft', (s: WindowState) => s.workArea.x],
    ['availTop', (s: WindowState) => s.workArea.y],
    ['availWidth', (s: WindowState) => s.workArea.width],
    ['availHeight', (s: WindowState) => s.workArea.height],
  ] as const) {
    const own = native(screen, name);
    get(screen, name, () => {
      const s = sized();
      return s && s.workArea.width > 0 ? read(s) : own();
    });
  }

  // Focus.
  const ownHasFocus = Document.prototype.hasFocus;
  let focused: boolean | null = null;
  Object.defineProperty(document, 'hasFocus', {
    value: () => focused ?? ownHasFocus.call(document),
    configurable: true,
    writable: true,
  });
  const holdBack = (e: Event) => {
    if (e.isTrusted && e.target === window && focused !== null) e.stopImmediatePropagation();
  };
  window.addEventListener('focus', holdBack, true);
  window.addEventListener('blur', holdBack, true);

  // Visibility.
  const ownVisibility = native(document, 'visibilityState');
  let shown = true;
  const visibility = (): DocumentVisibilityState => (shown && ownVisibility() !== 'hidden' ? 'visible' : 'hidden');
  get(document, 'visibilityState', visibility);
  get(document, 'hidden', () => visibility() === 'hidden');
  let lastVisibility = visibility();
  document.addEventListener(
    'visibilitychange',
    (e) => {
      if (!e.isTrusted) return;
      const now = visibility();
      if (now === lastVisibility) e.stopImmediatePropagation();
      lastVisibility = now;
    },
    true,
  );

  // Display state.
  const displayState = () => {
    const s = host.state();
    if (document.fullscreenElement || s?.fullscreen) return 'fullscreen';
    if (s?.minimized) return 'minimized';
    return s?.maximized ? 'maximized' : 'normal';
  };
  const queries = new Set<WeakRef<DisplayStateQuery>>();
  class DisplayStateQuery extends EventTarget {
    onchange: ((this: MediaQueryList, e: MediaQueryListEvent) => unknown) | null = null;
    private last: boolean;
    constructor(
      readonly media: string,
      private readonly test: () => boolean,
    ) {
      super();
      this.last = test();
      queries.add(new WeakRef(this));
    }
    get matches(): boolean {
      return this.test();
    }
    addListener(cb: ((e: MediaQueryListEvent) => void) | null): void {
      if (cb) this.addEventListener('change', cb as EventListener);
    }
    removeListener(cb: ((e: MediaQueryListEvent) => void) | null): void {
      if (cb) this.removeEventListener('change', cb as EventListener);
    }
    /** @internal */
    update(): void {
      const now = this.test();
      if (now === this.last) return;
      this.last = now;
      const event = new MediaQueryListEvent('change', { matches: now, media: this.media });
      this.dispatchEvent(event);
      this.onchange?.call(this as unknown as MediaQueryList, event);
    }
  }
  const ownMatchMedia = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => {
      const m = DISPLAY_STATE.exec(String(query));
      if (!m) return ownMatchMedia.call(window, query);
      const want = m[2].toLowerCase();
      const negate = !!m[1];
      return new DisplayStateQuery(`${negate ? 'not ' : ''}(display-state: ${want})`, () => (displayState() === want) !== negate) as unknown as MediaQueryList;
    },
  });
  const updateQueries = () => {
    for (const ref of queries) {
      const q = ref.deref();
      if (q) q.update();
      else queries.delete(ref);
    }
  };
  document.addEventListener('fullscreenchange', updateQueries);

  host.onChange(() => {
    const s = host.state();
    if (!s) return;
    const wasFocused = focused;
    focused = s.focused;
    if (wasFocused !== null && wasFocused !== focused) window.dispatchEvent(new FocusEvent(focused ? 'focus' : 'blur'));
    shown = s.visible;
    const now = visibility();
    if (now !== lastVisibility) {
      lastVisibility = now;
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    }
    updateQueries();
  });
}

// ---------------------------------------------------------------------------
// File System Access and Launch Handling
// ---------------------------------------------------------------------------

/**
 * A file the desktop granted the app, as the runtime holds it: what crosses
 * the port, and the calls on it. Apps see it only as the web handle over it.
 */
export interface Grant {
  readonly id: string;
  readonly kind: 'file' | 'directory';
  readonly name: string;
  /** Stable for the same file within the app. */
  readonly key: string;
  readonly path: string;
  readonly writable: boolean;
  getFile(): Promise<File>;
  write(data: Blob | ArrayBuffer | ArrayBufferView | string): Promise<void>;
  entries(): Promise<Grant[]>;
}

const abort = () => new DOMException('The user aborted a request.', 'AbortError');
const notAllowed = (what: string) => new DOMException(`${what} isn't allowed here.`, 'NotAllowedError');

/** The grants behind the web handles. */
const grants = new WeakMap<object, Grant>();

/** The grant behind a handle from the runtime, or null for anything else. */
export function grantOf(handle: unknown): Grant | null {
  return handle && typeof handle === 'object' ? (grants.get(handle) ?? null) : null;
}

type WriteChunk = BufferSource | Blob | string;
type WriteParams =
  | { type: 'write'; position?: number; data: WriteChunk }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number };

/**
 * A FileSystemWritableFileStream over a grant: writes gather here and the
 * file is replaced on close, as the web's swap file is.
 */
function writableStream(grant: Grant, initial: Uint8Array): WritableStream & {
  write(data: WriteChunk | WriteParams): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
} {
  let bytes = initial;
  let position = 0;
  const resize = (size: number) => {
    const next = new Uint8Array(size);
    next.set(bytes.subarray(0, Math.min(size, bytes.length)));
    bytes = next;
  };
  const apply = async (chunk: WriteChunk | WriteParams) => {
    const params: WriteParams =
      chunk && typeof chunk === 'object' && 'type' in chunk && !(chunk instanceof Blob) ? chunk : { type: 'write', data: chunk as WriteChunk };
    if (params.type === 'seek') {
      position = params.position;
      return;
    }
    if (params.type === 'truncate') {
      resize(params.size);
      position = Math.min(position, params.size);
      return;
    }
    if (params.position !== undefined) position = params.position;
    const data = params.data;
    const add =
      typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data instanceof Blob
          ? new Uint8Array(await data.arrayBuffer())
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
    if (position + add.length > bytes.length) resize(position + add.length);
    bytes.set(add, position);
    position += add.length;
  };
  const stream = new WritableStream<WriteChunk | WriteParams>({
    write: apply,
    close: () => grant.write(bytes),
  });
  const writeVia = (chunk: WriteChunk | WriteParams) => {
    const writer = stream.getWriter();
    return writer.write(chunk).finally(() => writer.releaseLock());
  };
  return Object.assign(stream, {
    write: writeVia,
    seek: (p: number) => writeVia({ type: 'seek', position: p }),
    truncate: (size: number) => writeVia({ type: 'truncate', size }),
  });
}

/** A handle's permission: what it was granted is all it has. */
function permission(grant: Grant, descriptor?: { mode?: 'read' | 'readwrite' }): PermissionState {
  return descriptor?.mode === 'readwrite' && !grant.writable ? 'denied' : 'granted';
}


/**
 * A handle's `kind` and `name`, as its own: the web's prototype, under ours,
 * has them as getters that only its own handles answer.
 */
function own(target: object, grant: Grant): void {
  Object.defineProperties(target, {
    kind: { value: grant.kind, enumerable: true },
    name: { value: grant.name, enumerable: true },
  });
  grants.set(target, grant);
}

class Handle {
  declare readonly kind: 'file' | 'directory';
  declare readonly name: string;
  constructor(grant: Grant) {
    own(this, grant);
  }
  protected get grant(): Grant {
    return grants.get(this)!;
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return grantOf(other)?.key === this.grant.key;
  }
  async queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.grant, descriptor);
  }
  async requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.grant, descriptor);
  }
}

class WebFileHandle extends Handle {
  getFile(): Promise<File> {
    return this.grant.getFile();
  }
  async createWritable(options?: { keepExistingData?: boolean }): Promise<ReturnType<typeof writableStream>> {
    if (!this.grant.writable) throw notAllowed('Writing to this file');
    const initial = options?.keepExistingData ? new Uint8Array(await (await this.grant.getFile()).arrayBuffer()) : new Uint8Array();
    return writableStream(this.grant, initial);
  }
}

class WebDirectoryHandle extends Handle {
  private async list(): Promise<(WebFileHandle | WebDirectoryHandle)[]> {
    return (await this.grant.entries()).map(toWebHandle);
  }
  async *entries(): AsyncGenerator<[string, WebFileHandle | WebDirectoryHandle]> {
    for (const handle of await this.list()) yield [handle.name, handle];
  }
  async *keys(): AsyncGenerator<string> {
    for (const handle of await this.list()) yield handle.name;
  }
  async *values(): AsyncGenerator<WebFileHandle | WebDirectoryHandle> {
    yield* await this.list();
  }
  [Symbol.asyncIterator](): AsyncGenerator<[string, WebFileHandle | WebDirectoryHandle]> {
    return this.entries();
  }
  private async child(name: string, kind: 'file' | 'directory', options?: { create?: boolean }) {
    const found = (await this.list()).find((h) => h.name === name);
    if (found && found.kind !== kind) throw new DOMException(`${name} isn't a ${kind}.`, 'TypeMismatchError');
    if (found) return found;
    if (options?.create) throw notAllowed('Creating files in a folder');
    throw new DOMException(`${name} wasn't found.`, 'NotFoundError');
  }
  getFileHandle(name: string, options?: { create?: boolean }): Promise<WebFileHandle> {
    return this.child(name, 'file', options) as Promise<WebFileHandle>;
  }
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<WebDirectoryHandle> {
    return this.child(name, 'directory', options) as Promise<WebDirectoryHandle>;
  }
  async removeEntry(): Promise<void> {
    throw notAllowed('Removing files from a folder');
  }
  async resolve(possibleDescendant: unknown): Promise<string[] | null> {
    const other = grantOf(possibleDescendant);
    const root = this.grant.path.replace(/\/+$/, '');
    if (!other || !other.path.startsWith(`${root}/`)) return other?.key === this.grant.key ? [] : null;
    return other.path.slice(root.length + 1).split('/');
  }
}

/**
 * Put a handle class over the web's, so `instanceof FileSystemFileHandle`
 * (and `FileSystemHandle`) holds: its prototype, then Handle's methods, then
 * the web's prototype, whose own methods answer only the browser's handles.
 */
function inherit(cls: { prototype: object }, native: string): void {
  const base = (globalThis as unknown as Record<string, { prototype: object } | undefined>)[native];
  if (!base) return;
  const { constructor: _, ...methods } = Object.getOwnPropertyDescriptors(Handle.prototype);
  Object.setPrototypeOf(cls.prototype, Object.create(base.prototype, methods));
}

/** The web's handle over a grant: a FileSystemFileHandle or FileSystemDirectoryHandle. */
export function toWebHandle(grant: Grant): WebFileHandle | WebDirectoryHandle {
  return grant.kind === 'directory' ? new WebDirectoryHandle(grant) : new WebFileHandle(grant);
}

const NAMED_FOLDERS = ['documents', 'pictures', 'music', 'videos', 'downloads'] as const;
type NamedFolder = (typeof NAMED_FOLDERS)[number];

/** A picker's `startIn`, as the desktop takes it. */
export function pickerStart(startIn: unknown): { startIn?: NamedFolder; startInHandle?: Grant } {
  if (typeof startIn === 'string') return (NAMED_FOLDERS as readonly string[]).includes(startIn) ? { startIn: startIn as NamedFolder } : {};
  const grant = grantOf(startIn);
  return grant ? { startInHandle: grant } : {};
}

function pickerTypes(types: PickerOptions['types']): FileTypeFilter[] | undefined {
  const filters = (types ?? []).map((t) => ({
    description: t.description ?? '',
    extensions: Object.values(t.accept ?? {})
      .flat()
      .map((e) => (e.startsWith('.') ? e : `.${e}`)),
  }));
  return filters.length ? filters : undefined;
}

export interface PickerHost {
  open(options: OpenFileOptions & { startInHandle?: Grant }): Promise<Grant[]>;
  save(options: SaveFileOptions & { startInHandle?: Grant }): Promise<Grant | null>;
}

/**
 * The web's file pickers, as Din's: `showOpenFilePicker`,
 * `showSaveFilePicker` and `showDirectoryPicker` open Din's dialogs and
 * resolve with handles over what was chosen, or reject with an
 * `AbortError` when it's cancelled. Din's `title` and `confirmLabel` come
 * along, and `mode: 'read'` picks files the app won't write back.
 */
export function installFilePickers(host: PickerHost): void {
  inherit(WebFileHandle, 'FileSystemFileHandle');
  inherit(WebDirectoryHandle, 'FileSystemDirectoryHandle');
  const define = <O>(name: string, value: (options?: O) => Promise<unknown>) =>
    Object.defineProperty(window, name, { value, writable: true, configurable: true });

  define<OpenFilePickerOptions>('showOpenFilePicker', async (options = {}) => {
    const chosen = await host.open({
      title: options.title,
      multiple: options.multiple,
      writable: options.mode !== 'read',
      confirmLabel: options.confirmLabel,
      types: pickerTypes(options.types),
      ...pickerStart(options.startIn),
    });
    if (!chosen.length) throw abort();
    return chosen.map(toWebHandle);
  });
  define<SaveFilePickerOptions>('showSaveFilePicker', async (options = {}) => {
    const chosen = await host.save({
      title: options.title,
      suggestedName: options.suggestedName,
      types: pickerTypes(options.types),
      ...pickerStart(options.startIn),
    });
    if (!chosen) throw abort();
    return toWebHandle(chosen);
  });
  define<DirectoryPickerOptions>('showDirectoryPicker', async (options = {}) => {
    const [chosen] = await host.open({
      title: options.title,
      directory: true,
      writable: options.mode === 'readwrite',
      confirmLabel: options.confirmLabel,
      ...pickerStart(options.startIn),
    });
    if (!chosen) throw abort();
    return toWebHandle(chosen);
  });
}

/** Hear when something else changes or removes the file behind a grant. */
export type WatchHost = (grant: Grant, cb: (change: 'modified' | 'removed') => void) => Unsubscribe;

/**
 * The File System Observer API's `FileSystemObserver`, over Din's watches:
 * each observed handle's changes come to the callback as records, with the
 * handle itself as both root and changed handle (`modified`, or
 * `disappeared` when it's removed).
 */
export function installFileSystemObserver(watch: WatchHost): void {
  class DinFileSystemObserver {
    private readonly callback: (records: object[], observer: DinFileSystemObserver) => void;
    private readonly watches = new Map<string, Unsubscribe>();
    constructor(callback: (records: object[], observer: DinFileSystemObserver) => void) {
      if (typeof callback !== 'function') throw new TypeError('FileSystemObserver needs a callback');
      this.callback = callback;
    }
    async observe(handle: FileSystemHandle): Promise<void> {
      const grant = grantOf(handle);
      if (!grant) throw new DOMException('That handle can’t be observed here.', 'NotFoundError');
      if (this.watches.has(grant.key)) return;
      this.watches.set(
        grant.key,
        watch(grant, (change) => {
          const record = {
            root: handle,
            changedHandle: handle,
            relativePathComponents: [],
            relativePathMovedFrom: null,
            type: change === 'removed' ? 'disappeared' : 'modified',
          };
          try {
            this.callback([record], this);
          } catch (e) {
            console.error('din: FileSystemObserver callback threw:', e);
          }
        }),
      );
    }
    unobserve(handle: FileSystemHandle): void {
      const key = grantOf(handle)?.key;
      if (key === undefined) return;
      this.watches.get(key)?.();
      this.watches.delete(key);
    }
    disconnect(): void {
      for (const stop of this.watches.values()) stop();
      this.watches.clear();
    }
  }
  Object.defineProperty(window, 'FileSystemObserver', { value: DinFileSystemObserver, writable: true, configurable: true });
}

/**
 * Launch Handling's `window.launchQueue`: the consumer hears this window's
 * launch, with the files it was opened with, and each launch after it (a
 * single-instance app opened again, a Dock shortcut). Launches that come
 * before there's a consumer wait for it.
 */
export function installLaunchQueue(): (files: Grant[]) => void {
  const queued: LaunchParams[] = [];
  let consumer: ((params: LaunchParams) => void) | null = null;
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: {
      setConsumer(cb: (params: LaunchParams) => void) {
        consumer = cb;
        for (const params of queued.splice(0)) cb(params);
      },
    },
  });
  return (files) => {
    const params: LaunchParams = { targetURL: location.href, files: files.map(toWebHandle) };
    if (consumer) consumer(params);
    else queued.push(params);
  };
}
