// DevTools bridge for the web browser app's docked devtools panes.
//
// Din's browser tabs are <webview> guests inside a DOM desktop, and each
// tab's devtools pane is a second <webview> below the page. The obvious
// wiring - webContents.setDevToolsWebContents(host) + openDevTools() - does
// NOT work when the devtools WebContents is a <webview> guest: the embedder
// binding (window.DevToolsAPI) is only installed on primary main frames, so
// the frontend silently falls back to its hosted-mode stub and every panel
// stays empty (verified on Electron 41; the webview example was dropped from
// the Electron docs). A native devtools surface (BrowserWindow /
// WebContentsView) does work but paints over the shell's DOM, breaking the
// desktop's window layering (overlapping windows, popovers, toasts).
//
// So the devtools frontend runs in hosted mode instead, exactly like Chrome
// remote debugging: the host <webview> loads
// devtools://devtools/bundled/devtools_app.html?ws=127.0.0.1:PORT/TOKEN and
// the frontend speaks CDP over a WebSocket served by this bridge, which
// proxies to the inspected tab via webContents.debugger:
//
//   devtools <webview>  --WebSocket-->  bridge (this file)  --debugger-->  tab
//
// Unlike --remote-debugging-port (which would expose every target in the
// app, including the shell and its privileged IPC surface, on a well-known
// port), the bridge exposes exactly one validated browser-tab guest per
// session:
//   - listens on 127.0.0.1 with an ephemeral port
//   - sessions are keyed by unguessable 128-bit tokens minted per open
//   - upgrades must carry Origin devtools://devtools, so web content can
//     never connect (a page's Origin is https://...) even with the token
//   - one WebSocket per session at a time (reconnects allowed - the
//     frontend offers "Reconnect DevTools" if the guest crashes)

const http = require('node:http');
const crypto = require('node:crypto');
const { webContents } = require('electron');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEVTOOLS_ORIGIN = 'devtools://devtools';
const FRONTEND_URL = 'devtools://devtools/bundled/devtools_app.html';

/** Frame a text message as a single unmasked WebSocket frame (RFC 6455). */
function wsEncodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Incrementally decode WebSocket frames (client -> server, RFC 6455).
 * Handles fragmentation and control frames; calls onMessage with each
 * complete text message and onClose on close frames or malformed input.
 */
function decodeWsStream(socket, { onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          onClose();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskStart = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;

      let payload = buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = buffer.subarray(maskStart, maskStart + 4);
        payload = Buffer.from(payload); // copy before unmasking in place
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);

      switch (opcode) {
        case 0x0: // continuation
        case 0x1: // text
        case 0x2: // binary (CDP is text, but tolerate it)
          fragments.push(payload);
          if (fin) {
            const message = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            onMessage(message);
          }
          break;
        case 0x8: // close
          try {
            socket.end(Buffer.from([0x88, 0x00]));
          } catch {
            // already gone
          }
          onClose();
          return;
        case 0x9: // ping -> pong (control payloads are <= 125 bytes)
          try {
            socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
          } catch {
            // already gone
          }
          break;
        default: // pong / reserved: ignore
          break;
      }
    }
  });
}

class DevtoolsBridge {
  /**
   * @param {object} [options]
   * @param {(targetId: number) => void} [options.onSessionEnded] Called when
   *   a session dies because its tab or pane was destroyed (not when closed
   *   explicitly via close()) - lets the shell reconcile its pane UI.
   */
  constructor({ onSessionEnded } = {}) {
    this._onSessionEnded = onSessionEnded;
    /** @type {Promise<number> | null} resolves to the listening port */
    this._listening = null;
    /** token -> session */
    this._sessions = new Map();
  }

  /** Lazily start the loopback server; resolves to its ephemeral port. */
  _ensureServer() {
    this._listening ??= new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        // No HTTP surface - the bridge only speaks WebSocket upgrades.
        res.statusCode = 404;
        res.end();
      });
      server.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    return this._listening;
  }

  /**
   * Open a devtools session: mint a token, wire session lifetime to both
   * WebContents, and navigate the host to the hosted devtools frontend.
   * The caller must have validated `target` (the inspected browser tab)
   * and `host` (the devtools pane guest).
   */
  async open(target, host) {
    // One session per tab: reopening replaces any previous session.
    this.close(target.id);

    const port = await this._ensureServer();
    if (target.isDestroyed() || host.isDestroyed()) return;

    const token = crypto.randomBytes(16).toString('hex');
    const session = {
      token,
      targetId: target.id,
      hostId: host.id,
      /** Send a CDP object to the connected frontend, if any. */
      send: null,
      /** Tear down the active WebSocket, if any. */
      closeSocket: null,
      /** The frontend enabled Overlay - ready for inspect requests. */
      overlayReady: false,
      /** Inspect requests queued until the frontend is ready. */
      pendingInspects: [],
      dispose: null,
    };
    this._sessions.set(token, session);

    const ended = () => this._endSession(session, true);
    target.once('destroyed', ended);
    host.once('destroyed', ended);
    session.dispose = () => {
      target.removeListener('destroyed', ended);
      host.removeListener('destroyed', ended);
    };

    host.loadURL(`${FRONTEND_URL}?ws=127.0.0.1:${port}/${token}`).catch(() => {
      // Navigation aborted (e.g. pane unmounted mid-flight); lifetime
      // hooks above clean the session up.
    });
  }

  /** Close the session inspecting the given tab, if any. */
  close(targetId) {
    const session = this._sessionForTarget(targetId);
    if (session) this._endSession(session, false);
  }

  /**
   * Reveal the element at page coordinates in the tab's devtools (the
   * context menu's "Inspect"). Queued until the frontend is ready.
   */
  inspect(targetId, x, y) {
    const session = this._sessionForTarget(targetId);
    if (!session) return;
    const point = { x, y };
    if (session.overlayReady) this._inspectNow(session, point);
    else session.pendingInspects.push(point);
  }

  /** The tab a devtools host guest is inspecting, or undefined. */
  targetIdForHost(hostId) {
    for (const session of this._sessions.values()) {
      if (session.hostId === hostId) return session.targetId;
    }
    return undefined;
  }

  _sessionForTarget(targetId) {
    for (const session of this._sessions.values()) {
      if (session.targetId === targetId) return session;
    }
    return undefined;
  }

  _endSession(session, notify) {
    if (!this._sessions.delete(session.token)) return;
    session.dispose?.();
    session.closeSocket?.();
    const target = webContents.fromId(session.targetId);
    if (target && !target.isDestroyed()) {
      try {
        if (target.debugger.isAttached()) target.debugger.detach();
      } catch {
        // best effort
      }
    }
    if (notify) this._onSessionEnded?.(session.targetId);
  }

  /** Ask the page for the node at (x, y), then make the frontend reveal it
   *  by synthesizing the Overlay.inspectNodeRequested event it listens to
   *  (the same event real inspect-element flows use). */
  async _inspectNow(session, { x, y }) {
    const target = webContents.fromId(session.targetId);
    if (!target || target.isDestroyed() || !session.send) return;
    try {
      const { backendNodeId } = await target.debugger.sendCommand(
        'DOM.getNodeForLocation',
        { x, y, includeUserAgentShadowDOM: false },
      );
      session.send?.({
        method: 'Overlay.inspectNodeRequested',
        params: { backendNodeId },
      });
    } catch {
      // No node at that location, or the DOM agent isn't ready.
    }
  }

  _handleUpgrade(req, socket) {
    const token = (req.url || '').replace(/^\//, '');
    const session = this._sessions.get(token);
    const key = req.headers['sec-websocket-key'];
    if (
      !session ||
      session.closeSocket || // one connection at a time
      typeof key !== 'string' ||
      req.headers.origin !== DEVTOOLS_ORIGIN ||
      String(req.headers.upgrade).toLowerCase() !== 'websocket'
    ) {
      socket.destroy();
      return;
    }

    const target = webContents.fromId(session.targetId);
    if (!target || target.isDestroyed()) {
      socket.destroy();
      this._endSession(session, true);
      return;
    }

    const dbg = target.debugger;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch {
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const send = (message) => {
      try {
        socket.write(wsEncodeText(JSON.stringify(message)));
      } catch {
        // socket died; close handler below cleans up
      }
    };

    // Backend -> frontend: protocol events and sub-target session traffic.
    const onDebuggerMessage = (_event, method, params, sessionId) => {
      send(sessionId ? { method, params, sessionId } : { method, params });
    };
    const onDebuggerDetach = () => closeSocket();
    dbg.on('message', onDebuggerMessage);
    dbg.on('detach', onDebuggerDetach);

    const closeSocket = () => {
      if (session.closeSocket !== closeSocket) return;
      session.closeSocket = null;
      session.send = null;
      session.overlayReady = false;
      dbg.removeListener('message', onDebuggerMessage);
      dbg.removeListener('detach', onDebuggerDetach);
      socket.destroy();
    };

    session.send = send;
    session.closeSocket = closeSocket;
    socket.on('close', closeSocket);
    socket.on('error', closeSocket);

    // Frontend -> backend: commands, proxied through the debugger (which
    // manages real protocol ids; we echo the frontend's own ids back).
    decodeWsStream(socket, {
      onMessage: (text) => {
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof message?.method !== 'string' || typeof message.id !== 'number') {
          return;
        }
        const { id, method, params, sessionId } = message;
        dbg
          .sendCommand(method, params ?? {}, sessionId)
          .then((result) => {
            send(sessionId ? { id, result, sessionId } : { id, result });
            // Overlay coming up on the main target is the signal that the
            // frontend can handle inspect-element requests.
            if (method === 'Overlay.enable' && !sessionId) {
              session.overlayReady = true;
              for (const point of session.pendingInspects.splice(0)) {
                this._inspectNow(session, point);
              }
            }
          })
          .catch((error) => {
            const payload = {
              id,
              error: { code: -32000, message: String(error?.message ?? error) },
            };
            send(sessionId ? { ...payload, sessionId } : payload);
          });
      },
      onClose: closeSocket,
    });
  }
}

module.exports = { DevtoolsBridge };
