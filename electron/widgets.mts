// Desktop widgets (docs/widgets.md): napplets (NIP-5D) on the desktop.
//
// Every widget is a <webview> in its own session (persist:widgets) and its
// own process. Its page is a host Din serves, empty but for a policy, at
//
//   widget://<id>/       a built-in widget, src/widgets/<id>/ built into one
//                        file by scripts/build-widgets.mjs (dist/widgets/<id>/,
//                        in development too: widgets aren't hot-reloaded)
//   napplet://<hash>/    a widget from Nostr: the artifact whose sha256 is the
//                        host (base32), fetched from Blossom and verified here
//
// The host's preload (widget-preload.cjs) puts the widget's bytes in a
// sandbox="allow-scripts" srcdoc iframe, with the NIP-5D CSP and
// window.napplet (@napplet/shim's prelude) ahead of them, exactly as NIP-5D's
// web projection has it, and relays the napplet's postMessage envelopes to
// the desktop over a port. Widgets get nothing else: no window.din, no
// window.nostr, no storage of their own (the iframe's origin is opaque), and
// no network (the CSP, and this session refuses every web request).
//
// Trust: which widget a port belongs to is the host of the frame's URL, never
// anything the widget says, and the bytes behind napplet://<hash>/ are only
// ever bytes whose hash is that host. The desktop decides which NAP domains
// a widget gets and answers every message.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ipcMain, MessageChannelMain, net, session } from 'electron';

export const WIDGET_SCHEME = 'widget';
export const NAPPLET_SCHEME = 'napplet';
export const WIDGETS_PARTITION = 'persist:widgets';

/** A built-in widget's id: the host of widget://<id>/. */
const WIDGET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A napplet's host: its artifact's sha256 in lowercase base32, unpadded (52 characters). */
const NAPPLET_HOST = /^[a-z2-7]{52}$/;

/** The biggest artifact fetched: napplets are one self-contained page. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * NIP-5D's baseline policy. The host page carries it as a header, so the
 * srcdoc iframe inherits it; the preload repeats it as a meta element there.
 */
export const NAPPLET_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; media-src 'none'; " +
  "object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";

const HOST_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;height:100%;overflow:hidden;background:transparent}' +
  'iframe{display:block;border:0;width:100%;height:100%;background:transparent;color-scheme:normal}' +
  '</style></head><body></body></html>';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A sha256 (hex) as a napplet:// host. */
export function nappletHost(sha256: string): string {
  const bytes = Buffer.from(sha256, 'hex');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The sha256 (hex) a napplet:// host names, or null. */
function hostSha256(host: string): string | null {
  if (!NAPPLET_HOST.test(host)) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of host) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return bytes.length === 32 ? Buffer.from(bytes).toString('hex') : null;
}

export type WidgetSource = { kind: 'builtin'; id: string } | { kind: 'napplet'; sha256: string };

/** Which widget a widget:// or napplet:// URL is. Compares scheme and host, never `URL.origin`. */
export function widgetOf(url: string): WidgetSource | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${WIDGET_SCHEME}:`) {
      return WIDGET_ID.test(parsed.hostname) ? { kind: 'builtin', id: parsed.hostname } : null;
    }
    if (parsed.protocol === `${NAPPLET_SCHEME}:`) {
      const sha256 = hostSha256(parsed.hostname);
      return sha256 ? { kind: 'napplet', sha256 } : null;
    }
  } catch {
    // Not a URL.
  }
  return null;
}

/** The widgets' session. */
export function widgetsSession(): Electron.Session {
  return session.fromPartition(WIDGETS_PARTITION);
}

/** Whether a WebContents is a widget. */
export function isWidgetGuest(contents: Electron.WebContents | null | undefined): boolean {
  return !!contents && !contents.isDestroyed() && contents.getType() === 'webview' && contents.session === widgetsSession();
}

interface Options {
  /** Where scripts/build-widgets.mjs put the built-in widgets (dist/widgets/): <id>/index.html each, and the prelude. */
  widgetsDir: string;
  /** Where verified napplet artifacts are kept, by sha256. */
  cacheDir: string;
  shell: () => Electron.WebContents | null;
  assertShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
}

let options: Options | null = null;

/** Serve widgets and answer their preloads and the shell. Call once the app is ready. */
export function registerWidgets(opts: Options, preloadPath: string): void {
  options = opts;
  const s = widgetsSession();
  const host = (request: Request) =>
    widgetOf(request.url) && new URL(request.url).pathname === '/'
      ? new Response(HOST_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': NAPPLET_CSP, 'cache-control': 'no-store' },
      })
      : new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  s.protocol.handle(WIDGET_SCHEME, host);
  s.protocol.handle(NAPPLET_SCHEME, host);
  s.registerPreloadScript({ id: 'din-widget', type: 'frame', filePath: preloadPath });
  // Nothing a widget could ask for is granted, and nothing reaches the web.
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(widget|napplet|data|blob|about|devtools):/i.test(details.url) });
  });
  s.on('will-download', (event) => event.preventDefault());

  // A widget's preload asking for its port to the desktop.
  ipcMain.on('widget:connect', (event) => {
    const contents = event.sender;
    const frame = event.senderFrame;
    const shell = opts.shell();
    if (!frame || frame !== contents.mainFrame || !isWidgetGuest(contents) || !shell) return;
    if (contents.hostWebContents !== shell) return;
    const source = widgetOf(frame.url);
    if (!source) return;
    const { port1, port2 } = new MessageChannelMain();
    shell.postMessage('dinos-widgets:port', { webContentsId: contents.id, source }, [port1]);
    frame.postMessage('widget:port', null, [port2]);
  });

  // The widget's bytes and the napplet runtime, for the preload to put in its iframe.
  ipcMain.handle('widget:artifact', async (event) => {
    const contents = event.sender;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame || !isWidgetGuest(contents)) throw new Error('Not a widget');
    const source = widgetOf(frame.url);
    if (!source) throw new Error('Not a widget');
    const html = source.kind === 'builtin' ? builtinArtifact(source.id) : await cachedArtifact(source.sha256);
    if (html === null) throw new Error('This widget is not available');
    return { html, prelude: prelude(), csp: NAPPLET_CSP };
  });

  // Fetch a napplet's artifact by hash from Blossom (the servers its
  // manifest names, then the user's), keep it if the bytes match, and say
  // the host it's served at.
  ipcMain.handle('dinos-widgets:fetch', async (event, sha256, servers) => {
    opts.assertShellSender(event);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Not a sha256 hash');
    const list = Array.isArray(servers) ? servers.filter((s): s is string => typeof s === 'string') : [];
    await fetchArtifact(sha256, list);
    return nappletHost(sha256);
  });
}

/** Per-guest policy, from main's web-contents-created. */
export function attachWidgetGuest(
  contents: Electron.WebContents,
  src: string,
  send: (channel: string, payload: unknown) => void,
): void {
  const home = widgetOf(src);
  const same = (url: string) => {
    const other = widgetOf(url);
    if (!home || !other || other.kind !== home.kind) return false;
    return home.kind === 'builtin' ? other.kind === 'builtin' && other.id === home.id : other.kind === 'napplet' && other.sha256 === home.sha256;
  };
  // The host page stays where it is, and its one iframe holds the srcdoc.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame ? same(event.url) : event.url === 'about:srcdoc') return;
    event.preventDefault();
  });
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Right-clicks outside text fields are the desktop's: Size, Remove, ….
  contents.on('context-menu', (event, params) => {
    if (params.isEditable) return;
    event.preventDefault();
    send('dinos-widgets:contextMenu', { webContentsId: contents.id, x: params.x, y: params.y });
  });
}

function builtinArtifact(id: string): string | null {
  if (!options || !WIDGET_ID.test(id)) return null;
  try {
    return fs.readFileSync(path.join(options.widgetsDir, id, 'index.html'), 'utf8');
  } catch {
    return null;
  }
}

let preludeSource: string | null = null;

/** @napplet/shim's prelude, which build-widgets.mjs copies into dist/widgets/. */
function prelude(): string {
  if (preludeSource === null && options) {
    preludeSource = fs
      .readFileSync(path.join(options.widgetsDir, 'napplet-prelude.js'), 'utf8')
      .replace(/\n\/\/# sourceMappingURL=.*$/m, '');
  }
  return preludeSource ?? '';
}

function cacheFile(sha256: string): string {
  return path.join(options!.cacheDir, `${sha256}.html`);
}

async function cachedArtifact(sha256: string): Promise<string | null> {
  if (!options) return null;
  try {
    const bytes = await fs.promises.readFile(cacheFile(sha256));
    // Checked again on the way out: the cache is only a file on disk.
    return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes.toString('utf8') : null;
  } catch {
    return null;
  }
}

const fetching = new Map<string, Promise<void>>();

function fetchArtifact(sha256: string, servers: string[]): Promise<void> {
  let pending = fetching.get(sha256);
  if (!pending) {
    pending = downloadArtifact(sha256, servers).finally(() => fetching.delete(sha256));
    fetching.set(sha256, pending);
  }
  return pending;
}

async function downloadArtifact(sha256: string, servers: string[]): Promise<void> {
  if (!options) throw new Error('Widgets are not ready');
  if ((await cachedArtifact(sha256)) !== null) return;
  const origins = [...new Set(servers.map(serverOrigin).filter((s): s is string => s !== null))];
  if (origins.length === 0) throw new Error('No Blossom server has this widget');
  let lastError = 'No Blossom server has this widget';
  for (const origin of origins) {
    try {
      const response = await net.fetch(`${origin}/${sha256}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok || !response.body) {
        lastError = `${origin} answered ${response.status}`;
        continue;
      }
      const bytes = await readCapped(response.body, MAX_ARTIFACT_BYTES);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
        lastError = `${origin} sent bytes that don't match the widget's hash`;
        continue;
      }
      await fs.promises.mkdir(options.cacheDir, { recursive: true });
      const temp = `${cacheFile(sha256)}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, bytes);
      await fs.promises.rename(temp, cacheFile(sha256));
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
}

/** An https server's origin, or null. */
function serverOrigin(server: string): string | null {
  try {
    const url = new URL(server);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error('The widget is too big');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
