// Screen sharing for web pages: navigator.mediaDevices.getDisplayMedia() in a
// browser tab or an installed web app (Meet, Jitsi, Discord in the browser).
//
// Electron refuses getDisplayMedia unless the session has a display-media
// handler, and there is no desktop picker to fall back on under din-shell. Din is
// one shell window with every page a <webview> inside it, so nothing outside
// Electron is needed: the whole screen is the shell's own main frame (every
// window, native apps, the menu bar and the dock, as Screenshot sees it), and
// a window is that guest's main frame, which can bring its audio along.
//
// The shell shows the picker (`screen-share:pick`, ScreenShareHost.tsx) and
// answers with a source; cancelling, or leaving it two minutes, refuses the
// page. It asks every time, like Chrome, so a page can't share again unseen.
//
// While a page shares, the menu bar says so and can stop it. Electron says
// nothing about the stream once granted, so screen-share-preload.cjs wraps
// getDisplayMedia in the page and reports when a granted stream starts and
// when its last track ends; Stop asks that frame to end its tracks the way
// Chrome's "Stop sharing" does. A frame navigating or a guest closing ends its
// shares too.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain, webContents, type Session, type WebContents, type WebFrameMain } from 'electron';

const PICK_TIMEOUT_MS = 2 * 60_000;
/** How long a grant waits for the page to report its stream. */
const GRANT_TTL_MS = 30_000;
const THUMB_WIDTH = 320;
const THUMB_TIMEOUT_MS = 1500;
const SCREEN_SOURCE = 'screen';

export interface ScreenShareSource {
  id: string;
  kind: 'screen' | 'window';
  title: string;
  /** The page's host, for a window. */
  subtitle: string;
  /** A JPEG data URL, or null when the window isn't drawn (a background tab). */
  thumbnail: string | null;
}

export interface ScreenShareRequest {
  requestId: number;
  /** The requesting page's origin (e.g. `https://meet.example`). */
  origin: string;
  /** Whether the page asked for audio too, which a window can give. */
  audioRequested: boolean;
  sources: ScreenShareSource[];
}

export interface ActiveScreenShare {
  id: string;
  origin: string;
  /** What's shared: 'screen', or the window's title. */
  kind: 'screen' | 'window';
  title: string;
  audio: boolean;
}

interface Options {
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  isShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;
  sendToShell: (channel: string, payload?: unknown) => void;
  shellContents: () => WebContents | null;
  /** Whether a guest belongs to the shell and may be offered as a window. */
  isShareableGuest: (contents: WebContents) => boolean;
  /** Whether a session is the private browser session. */
  isPrivate: (s: Session) => boolean;
  /** Undo software dimming in a capture of the shell. */
  undim: (image: Electron.NativeImage) => Electron.NativeImage;
}

let options: Options | null = null;

let nextRequestId = 1;
const pendingPicks = new Map<number, {
  resolve: (choice: { sourceId: string; audio: boolean } | null) => void;
  timer: NodeJS.Timeout;
}>();

interface Grant {
  origin: string;
  kind: 'screen' | 'window';
  title: string;
  audio: boolean;
  expires: number;
}

/** Granted streams the page hasn't reported yet, by requesting frame. */
const grants = new Map<string, Grant[]>();

interface Share extends ActiveScreenShare {
  frame: WebFrameMain;
  frameKey: string;
  contentsId: number;
  /** The id the page's preload gave it. */
  pageId: number;
}

const shares = new Map<string, Share>();
/** Guests whose navigations and destruction are already watched. */
const watched = new Set<number>();

function frameKey(frame: WebFrameMain): string {
  return `${frame.processId}:${frame.routingId}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function thumbnailOf(contents: WebContents, shell: boolean): Promise<string | null> {
  try {
    let image = await withTimeout(contents.capturePage(), THUMB_TIMEOUT_MS);
    if (!image || image.isEmpty()) return null;
    if (shell && options) image = options.undim(image);
    const { width } = image.getSize();
    if (width > THUMB_WIDTH) image = image.resize({ width: THUMB_WIDTH, quality: 'good' });
    return `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`;
  } catch {
    return null;
  }
}

/** The guests a page in `s` may be offered: private tabs only to private pages. */
function shareableGuests(s: Session): WebContents[] {
  if (!options) return [];
  const { isShareableGuest, isPrivate } = options;
  const privateRequester = isPrivate(s);
  return webContents.getAllWebContents().filter((contents) => {
    if (contents.isDestroyed() || !isShareableGuest(contents)) return false;
    if (isPrivate(contents.session) && !privateRequester) return false;
    return /^(https?|nsite|file):/.test(contents.getURL());
  });
}

async function listSources(s: Session): Promise<ScreenShareSource[]> {
  const shell = options?.shellContents();
  const sources: Promise<ScreenShareSource>[] = [];
  if (shell) {
    sources.push(thumbnailOf(shell, true).then((thumbnail) => ({
      id: SCREEN_SOURCE,
      kind: 'screen',
      title: 'Entire screen',
      subtitle: '',
      thumbnail,
    })));
  }
  for (const contents of shareableGuests(s)) {
    const url = contents.getURL();
    sources.push(thumbnailOf(contents, false).then((thumbnail) => ({
      id: `wc:${contents.id}`,
      kind: 'window',
      title: contents.getTitle() || hostOf(url) || 'Untitled',
      subtitle: hostOf(url),
      thumbnail,
    })));
  }
  return Promise.all(sources);
}

function askShell(request: Omit<ScreenShareRequest, 'requestId'>): Promise<{ sourceId: string; audio: boolean } | null> {
  return new Promise((resolve) => {
    const shell = options?.shellContents();
    if (!options || !shell) {
      resolve(null);
      return;
    }
    const requestId = nextRequestId++;
    const timer = setTimeout(() => {
      pendingPicks.delete(requestId);
      options?.sendToShell('screen-share:cancel', { requestId });
      resolve(null);
    }, PICK_TIMEOUT_MS);
    pendingPicks.set(requestId, { resolve, timer });
    options.sendToShell('screen-share:pick', { requestId, ...request } satisfies ScreenShareRequest);
  });
}

function addGrant(frame: WebFrameMain, grant: Grant): void {
  const key = frameKey(frame);
  const now = Date.now();
  const list = (grants.get(key) ?? []).filter((g) => g.expires > now);
  list.push(grant);
  grants.set(key, list);
}

function publish(): void {
  const list: ActiveScreenShare[] = [...shares.values()].map(({ id, origin, kind, title, audio }) => ({
    id,
    origin,
    kind,
    title,
    audio,
  }));
  options?.sendToShell('screen-share:active', list);
}

function endShares(match: (share: Share) => boolean): void {
  let changed = false;
  for (const [id, share] of shares) {
    if (!match(share)) continue;
    shares.delete(id);
    changed = true;
  }
  if (changed) publish();
}

/** End a guest's shares when it closes, or when the sharing frame navigates. */
function watch(contents: WebContents): void {
  if (watched.has(contents.id)) return;
  watched.add(contents.id);
  const id = contents.id;
  contents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame, processId, routingId) => {
    const key = `${processId}:${routingId}`;
    endShares((share) => share.contentsId === id && (isMainFrame || share.frameKey === key));
  });
  contents.once('destroyed', () => {
    watched.delete(id);
    endShares((share) => share.contentsId === id);
  });
}

/**
 * Answer one getDisplayMedia() call: the user picks the screen or a window in
 * the shell, or nothing.
 */
async function handleRequest(
  s: Session,
  request: Electron.DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Electron.Streams) => void,
): Promise<void> {
  const frame = request.frame;
  const origin = request.securityOrigin || frame?.origin || '';
  if (!frame || !request.videoRequested || !/^(https?|nsite|file):/.test(origin)) {
    callback({});
    return;
  }
  const sources = await listSources(s);
  const choice = await askShell({ origin, audioRequested: request.audioRequested, sources });
  if (!choice || frame.detached) {
    callback({});
    return;
  }
  const requester = webContents.fromFrame(frame);
  if (choice.sourceId === SCREEN_SOURCE) {
    const shell = options?.shellContents();
    if (!shell || !requester) {
      callback({});
      return;
    }
    addGrant(frame, { origin, kind: 'screen', title: 'Entire screen', audio: false, expires: Date.now() + GRANT_TTL_MS });
    watch(requester);
    callback({ video: shell.mainFrame });
    return;
  }
  const wcId = Number(choice.sourceId.replace(/^wc:/, ''));
  const target = shareableGuests(s).find((contents) => contents.id === wcId);
  if (!target || !requester) {
    callback({});
    return;
  }
  const audio = choice.audio && request.audioRequested;
  const title = target.getTitle() || hostOf(target.getURL()) || 'a window';
  addGrant(frame, { origin, kind: 'window', title, audio, expires: Date.now() + GRANT_TTL_MS });
  watch(requester);
  callback(audio ? { video: target.mainFrame, audio: target.mainFrame } : { video: target.mainFrame });
}

/** Let pages in `s` ask to share the screen or a window. */
export function allowScreenSharing(s: Session): void {
  s.setDisplayMediaRequestHandler((request, callback) => {
    handleRequest(s, request, callback).catch((error) => {
      console.error('screen share request failed:', error);
      callback({});
    });
  });
}

export function registerScreenShareHandlers(opts: Options): void {
  options = opts;
  const { assertShellSender, isShellSender } = opts;

  ipcMain.on('screen-share:choice', (event, response) => {
    if (!isShellSender(event)) return;
    const pending = response && pendingPicks.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPicks.delete(response.requestId);
    pending.resolve(
      typeof response.sourceId === 'string' ? { sourceId: response.sourceId, audio: response.audio === true } : null,
    );
  });

  ipcMain.handle('screen-share:list', (event) => {
    assertShellSender(event);
    return [...shares.values()].map(({ id, origin, kind, title, audio }) => ({ id, origin, kind, title, audio }));
  });

  ipcMain.handle('screen-share:stop', (event, id: unknown) => {
    assertShellSender(event);
    const share = typeof id === 'string' ? shares.get(id) : undefined;
    if (!share) return;
    shares.delete(share.id);
    publish();
    if (!share.frame.detached) share.frame.send('screen-share:stop', share.pageId);
  });

  // From screen-share-preload.cjs: a stream this frame was granted started.
  ipcMain.on('screen-share:started', (event, pageId: unknown) => {
    const frame = event.senderFrame;
    if (!frame || typeof pageId !== 'number') return;
    const key = frameKey(frame);
    const now = Date.now();
    const pending = (grants.get(key) ?? []).filter((g) => g.expires > now);
    const grant = pending.shift();
    if (pending.length > 0) grants.set(key, pending);
    else grants.delete(key);
    if (!grant) return;
    const id = `${event.sender.id}:${key}:${pageId}`;
    shares.set(id, {
      id,
      origin: grant.origin,
      kind: grant.kind,
      title: grant.title,
      audio: grant.audio,
      frame,
      frameKey: key,
      contentsId: event.sender.id,
      pageId,
    });
    publish();
  });

  // Its last track ended: the page stopped it, or the shared window closed.
  ipcMain.on('screen-share:ended', (event, pageId: unknown) => {
    const frame = event.senderFrame;
    if (!frame || typeof pageId !== 'number') return;
    const key = frameKey(frame);
    endShares((share) => share.contentsId === event.sender.id && share.frameKey === key && share.pageId === pageId);
  });
}
