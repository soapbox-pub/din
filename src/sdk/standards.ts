/**
 * Web standards an app can use instead of `window.din`, wired to the
 * desktop by the runtime (src/sdk/runtime.ts), so a page written for the web
 * works in a Din window as it would in a browser:
 *
 * - The Media Session API (`navigator.mediaSession`) is what Din's media
 *   controls and the media keys show and drive.
 * - `document.title`, `<link rel="icon">` and `<meta name="theme-color">`
 *   are the window's title, icon and accent, as `din.window.setTitle`,
 *   `setIcon` and `setAccent` are.
 * - File System Access (`showOpenFilePicker` and the rest) opens Din's
 *   pickers, its handles backed by `din.files`' handles.
 * - Launch Handling's `launchQueue` hears the launch and its files, as
 *   `din.app.launch` and `onLaunch` do.
 *
 * Part of the runtime's bundle, so nothing here may have side effects on
 * import.
 */
import type {
  DinApp,
  DinFileHandle,
  DinFiles,
  FileTypeFilter,
  LaunchContext,
  OpenFileOptions,
  Unsubscribe,
} from '@/sdk/din';
import type { MediaAction, MediaReport } from '@/sdk/protocol';

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
 * and theme-color, as a browser's tab follows them. What the page's HTML
 * starts with is the app's own (its name, its icon, its manifest's color),
 * so only changes from that are passed on, and going back to it gives the
 * window the app's again.
 */
export function watchDocumentHead(host: DocumentHeadHost): void {
  const read = () => {
    const icons = document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i][href]');
    const themeColor = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color" i][content]')].find(
      (m) => !m.media || matchMedia(m.media).matches,
    );
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
// File System Access and Launch Handling
// ---------------------------------------------------------------------------

const abort = () => new DOMException('The user aborted a request.', 'AbortError');
const notAllowed = (what: string) => new DOMException(`${what} isn't allowed here.`, 'NotAllowedError');

/** The handles behind the web ones, for `startIn` and for `din.*` calls given a web handle. */
const dinHandles = new WeakMap<object, DinFileHandle>();

/** The `DinFileHandle` behind a handle from `showOpenFilePicker` and the rest, or null. */
export function dinHandleOf(handle: unknown): DinFileHandle | null {
  return handle && typeof handle === 'object' ? (dinHandles.get(handle) ?? null) : null;
}

type WriteChunk = BufferSource | Blob | string;
type WriteParams =
  | { type: 'write'; position?: number; data: WriteChunk }
  | { type: 'seek'; position: number }
  | { type: 'truncate'; size: number };

/**
 * A FileSystemWritableFileStream over a Din handle: writes gather here and
 * the file is replaced on close, as the web's swap file is.
 */
function writableStream(handle: DinFileHandle, initial: Uint8Array): WritableStream & {
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
    close: () => handle.write(bytes),
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
function permission(handle: DinFileHandle, descriptor?: { mode?: 'read' | 'readwrite' }): PermissionState {
  return descriptor?.mode === 'readwrite' && !handle.writable ? 'denied' : 'granted';
}

/** Put a class's prototype on the web's, so `instanceof FileSystemFileHandle` holds. */
function inherit(cls: { prototype: object }, native: string): void {
  const base = (globalThis as unknown as Record<string, { prototype: object } | undefined>)[native];
  if (base) Object.setPrototypeOf(cls.prototype, base.prototype);
}

/**
 * A handle's `kind` and `name`, as its own: the web's prototype, under ours,
 * has them as getters that only its own handles answer.
 */
function own(target: object, kind: 'file' | 'directory', handle: DinFileHandle): void {
  Object.defineProperties(target, {
    kind: { value: kind, enumerable: true },
    name: { value: handle.name, enumerable: true },
  });
  dinHandles.set(target, handle);
}

class WebFileHandle {
  declare readonly kind: 'file';
  declare readonly name: string;
  constructor(handle: DinFileHandle) {
    own(this, 'file', handle);
  }
  private get din(): DinFileHandle {
    return dinHandles.get(this)!;
  }
  getFile(): Promise<File> {
    return this.din.getFile();
  }
  async createWritable(options?: { keepExistingData?: boolean }): Promise<ReturnType<typeof writableStream>> {
    if (!this.din.writable) throw notAllowed('Writing to this file');
    const initial = options?.keepExistingData ? new Uint8Array(await (await this.din.getFile()).arrayBuffer()) : new Uint8Array();
    return writableStream(this.din, initial);
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return dinHandleOf(other)?.key === this.din.key;
  }
  async queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.din, descriptor);
  }
  async requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.din, descriptor);
  }
}

class WebDirectoryHandle {
  declare readonly kind: 'directory';
  declare readonly name: string;
  constructor(handle: DinFileHandle) {
    own(this, 'directory', handle);
  }
  private get din(): DinFileHandle {
    return dinHandles.get(this)!;
  }
  private async list(): Promise<(WebFileHandle | WebDirectoryHandle)[]> {
    return ((await this.din.entries?.()) ?? []).map(toWebHandle);
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
    const other = dinHandleOf(possibleDescendant);
    const root = this.din.path.replace(/\/+$/, '');
    if (!other || !other.path.startsWith(`${root}/`)) return other?.key === this.din.key ? [] : null;
    return other.path.slice(root.length + 1).split('/');
  }
  async isSameEntry(other: unknown): Promise<boolean> {
    return dinHandleOf(other)?.key === this.din.key;
  }
  async queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.din, descriptor);
  }
  async requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState> {
    return permission(this.din, descriptor);
  }
}

/** The web's handle for a Din one: a FileSystemFileHandle or FileSystemDirectoryHandle. */
export function toWebHandle(handle: DinFileHandle): WebFileHandle | WebDirectoryHandle {
  return handle.kind === 'directory' ? new WebDirectoryHandle(handle) : new WebFileHandle(handle);
}

interface WebPickerOptions {
  types?: { description?: string; accept?: Record<string, string | string[]> }[];
  startIn?: string | object;
  multiple?: boolean;
  suggestedName?: string;
  mode?: 'read' | 'readwrite';
}

const NAMED_FOLDERS = ['documents', 'pictures', 'music', 'videos', 'downloads'] as const;

function pickerTypes(types: WebPickerOptions['types']): FileTypeFilter[] | undefined {
  const filters = (types ?? []).map((t) => ({
    description: t.description ?? '',
    extensions: Object.values(t.accept ?? {})
      .flat()
      .map((e) => (e.startsWith('.') ? e : `.${e}`)),
  }));
  return filters.length ? filters : undefined;
}

function pickerStart(startIn: WebPickerOptions['startIn']): OpenFileOptions['startIn'] {
  if (typeof startIn === 'string') return (NAMED_FOLDERS as readonly string[]).includes(startIn) ? (startIn as OpenFileOptions['startIn']) : undefined;
  return dinHandleOf(startIn) ?? undefined;
}

/**
 * The web's file pickers, as Din's: `showOpenFilePicker`,
 * `showSaveFilePicker` and `showDirectoryPicker` open Din's dialogs and
 * resolve with FileSystemHandles over what was chosen.
 */
export function installFilePickers(files: DinFiles): void {
  inherit(WebFileHandle, 'FileSystemFileHandle');
  inherit(WebDirectoryHandle, 'FileSystemDirectoryHandle');
  const define = (name: string, value: (options?: WebPickerOptions) => Promise<unknown>) =>
    Object.defineProperty(window, name, { value, writable: true, configurable: true });

  define('showOpenFilePicker', async (options = {}) => {
    const chosen = await files.open({ multiple: options.multiple, types: pickerTypes(options.types), startIn: pickerStart(options.startIn) });
    if (!chosen.length) throw abort();
    return chosen.map(toWebHandle);
  });
  define('showSaveFilePicker', async (options = {}) => {
    const chosen = await files.save({ suggestedName: options.suggestedName, types: pickerTypes(options.types), startIn: pickerStart(options.startIn) });
    if (!chosen) throw abort();
    return toWebHandle(chosen);
  });
  define('showDirectoryPicker', async (options = {}) => {
    const [chosen] = await files.open({ directory: true, writable: options.mode === 'readwrite', startIn: pickerStart(options.startIn) });
    if (!chosen) throw abort();
    return toWebHandle(chosen);
  });
}

/**
 * Launch Handling's `window.launchQueue`: the consumer hears this window's
 * launch, with the files it was opened with as FileSystemHandles, and each
 * launch after it (a single-instance app opened again, a Dock shortcut).
 */
export function installLaunchQueue(app: { onLaunch: DinApp['onLaunch'] }, ready: Promise<LaunchContext>): void {
  type Params = { targetURL: string; files: (WebFileHandle | WebDirectoryHandle)[] };
  const queued: Params[] = [];
  let consumer: ((params: Params) => void) | null = null;
  const deliver = (launch: LaunchContext) => {
    const params = { targetURL: location.href, files: launch.files.map(toWebHandle) };
    if (consumer) consumer(params);
    else queued.push(params);
  };
  void ready.then((launch) => {
    deliver(launch);
    app.onLaunch(deliver);
  });
  Object.defineProperty(window, 'launchQueue', {
    configurable: true,
    value: {
      setConsumer(cb: (params: Params) => void) {
        consumer = cb;
        for (const params of queued.splice(0)) cb(params);
      },
    },
  });
}
