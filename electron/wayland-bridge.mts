// The Wayland half of Din's embedded display: spawns din-compositor
// (native/din-compositor, a headless Smithay compositor) and translates its
// pipe protocol into the messages the shell already understands.
//
// Apps that speak Wayland (GTK, Qt, Firefox, Electron/Chromium, SDL) connect
// to the compositor; the rest stay on the Xvfb server next to it. Both feed
// the same renderer protocol, so a window looks and behaves the same in Din
// whichever server it lives on. Wayland window ids start at 0x40000001,
// clear of X resource ids, which is how messages are routed back.
//
// Window pixels don't pass through here: the compositor streams them
// straight to the renderer over a token-guarded localhost WebSocket (see
// native/din-compositor/src/frames.rs), because Node in the frame path -
// reassembling pipe chunks, then a MessagePort deep-copying the result -
// capped a full-window repaint at ~130 MB/s. What remains is control:
// announcements, input, geometry, focus, clipboard, cursors.
//
// Wire format (see native/din-compositor/src/wire.rs): each record is a u32
// little-endian length, a kind byte, and a payload. JSON both ways, plus
// cursor images in binary from the compositor.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';

/** First Wayland window id; everything below is an X window. */
export const FIRST_WAYLAND_ID = 0x40000001;

const KIND_JSON = 0;
const KIND_CURSOR = 3;

export class WaylandBridge {
  private child: ChildProcess;
  private chunks: Buffer[] = [];
  private queued = 0;

  /** Messages for the shell renderer, already in its vocabulary. */
  onShell: ((message: unknown) => void) | null = null;
  /** The compositor exited. */
  onExit: (() => void) | null = null;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.ingest(chunk));
    child.stdin?.on('error', () => {});
    child.on('exit', () => this.onExit?.());
  }

  /**
   * Start the compositor; resolves with the bridge, its socket name (for
   * WAYLAND_DISPLAY) and its frame-stream URL, or null if it can't run.
   */
  static start(
    binary: string,
    screen: { width: number; height: number },
  ): Promise<{ bridge: WaylandBridge; socket: string; frames: string } | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(binary, [], {
          env: {
            ...process.env,
            DIN_SCREEN_WIDTH: String(screen.width),
            DIN_SCREEN_HEIGHT: String(screen.height),
          },
          stdio: ['pipe', 'pipe', 'inherit'],
        });
      } catch {
        resolve(null);
        return;
      }
      const bridge = new WaylandBridge(child);
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 10_000);
      bridge.onShell = (message) => {
        const m = message as { type?: string; socket?: string; frames?: string };
        if (m.type !== 'ready' || typeof m.socket !== 'string' || typeof m.frames !== 'string') {
          return;
        }
        clearTimeout(timer);
        bridge.onShell = null;
        resolve({ bridge, socket: m.socket, frames: m.frames });
      };
      child.once('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /** Send a message to the compositor. */
  send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(5);
    header.writeUInt32LE(body.length + 1, 0);
    header.writeUInt8(KIND_JSON, 4);
    this.child.stdin?.write(Buffer.concat([header, body]));
  }

  kill(): void {
    this.child.kill();
  }

  private ingest(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.queued += chunk.length;
    while (this.queued >= 4) {
      const length = this.peek(4).readUInt32LE(0);
      if (this.queued < 4 + length) return;
      this.take(4);
      this.dispatch(this.take(length));
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length < n) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0];
  }

  /** Remove and return the next `n` bytes, in a buffer of their own. */
  private take(n: number): Buffer {
    this.queued -= n;
    const out = Buffer.allocUnsafeSlow(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0];
      const count = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, count);
      offset += count;
      if (count === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(count);
    }
    return out;
  }

  private dispatch(record: Buffer): void {
    const kind = record.readUInt8(0);
    if (kind === KIND_JSON) {
      let message: { type?: string; name?: string };
      try {
        message = JSON.parse(record.toString('utf8', 1));
      } catch {
        return;
      }
      // Named cursors (cursor-shape-v1, CSS names) share the image message.
      if (message.type === 'cursor-name') {
        this.onShell?.({ type: 'cursor', name: message.name });
      } else {
        this.onShell?.(message);
      }
    } else if (kind === KIND_CURSOR) {
      this.onShell?.({
        type: 'cursor',
        width: record.readUInt32LE(1),
        height: record.readUInt32LE(5),
        xhot: record.readInt32LE(9),
        yhot: record.readInt32LE(13),
        data: new Uint8Array(record.buffer, record.byteOffset + 17, record.length - 17),
      });
    }
  }
}
