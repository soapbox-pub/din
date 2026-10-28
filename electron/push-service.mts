// The push service web-push.mts subscribes sites with: a WebSocket to a
// server speaking Mozilla's autopush protocol, Firefox's own push service by
// default. This is Firefox's side of it (PushServiceWebSocket.sys.mjs):
//
//   - `hello` names the user agent ID (UAID) the server keeps channels and
//     undelivered messages under. It's only sent while there are channels:
//     without any, the server hands out a fresh one each time, so nothing
//     ties one connection to the next. If the server answers one that was
//     sent with a different one, every channel is gone.
//   - `register` asks for a channel; the reply's endpoint is what the site's
//     server sends to. `unregister` gives one back.
//   - `notification` is a message, acked once the site's worker has had it
//     (100 delivered, 101 unreadable, 102 not delivered). Unacked ones come
//     again on the next connection.
//   - `{}` is a ping, sent after half an hour of quiet; one unanswered for
//     ten seconds means the connection is dead.
//
// It's connected only while a channel exists or a registration is waiting,
// comes back with backoff when dropped (at once when the computer wakes),
// and stays away for half an hour when the server says to back off.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import type { PushHeaders } from './push-crypto.mts';

export const DEFAULT_PUSH_SERVER = 'wss://push.services.mozilla.com/';

const PING_INTERVAL_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = PING_INTERVAL_MS;
/** The close code a server sends to say: don't reconnect soon. */
const BACKOFF_CLOSE_CODE = 4774;
const MAX_UAID_LENGTH = 128;

/** What a message's ack says happened to it. */
export type AckCode = 100 | 101 | 102;

/** Why a channel is given back. */
export type UnregisterCode = 200 | 201 | 202;

export interface PushServiceOptions {
  log: (line: string) => void;
  /** The UAID from last time, or null. */
  uaid: string | null;
  /** How many channels are registered under the UAID. */
  channelCount: () => number;
  /**
   * The server named the UAID for this connection. `reset` when it isn't
   * the one sent: every channel registered before is gone.
   */
  onHello: (uaid: string, reset: boolean) => void;
  /** A message for a channel; resolves with its ack. */
  onMessage: (channelID: string, version: string, data: Buffer | null, headers: PushHeaders | null) => Promise<AckCode>;
  onStatusChanged: () => void;
}

export interface PushServiceStatus {
  url: string;
  state: 'idle' | 'connecting' | 'ready';
  connectedAt: number | null;
  lastError: string | null;
  retryAt: number | null;
}

interface Pending {
  data: Record<string, unknown>;
  sentAt: number;
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class PushService {
  readonly url: string;
  #options: PushServiceOptions;
  #uaid: string | null;
  #socket: WebSocket | null = null;
  #state: PushServiceStatus['state'] = 'idle';
  /** The UAID the last hello named, to tell whether the reply kept it. */
  #sentUaid: string | null = null;
  #pending = new Map<string, Pending>();
  #backoff = BACKOFF_MIN_MS;
  #retry: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;
  #pongTimer: NodeJS.Timeout | null = null;
  #requestTimer: NodeJS.Timeout | null = null;
  #closed = false;
  #connectedAt: number | null = null;
  #lastError: string | null = null;
  #retryAt: number | null = null;

  constructor(url: string, options: PushServiceOptions) {
    this.url = url;
    this.#options = options;
    this.#uaid = options.uaid;
  }

  status(): PushServiceStatus {
    return {
      url: this.url,
      state: this.#state,
      connectedAt: this.#connectedAt,
      lastError: this.#lastError,
      retryAt: this.#retryAt,
    };
  }

  /** Ask for a channel; resolves with its endpoint. */
  async register(channelID: string, key: string | null): Promise<string> {
    const data: Record<string, unknown> = { messageType: 'register', channelID };
    if (key) data.key = key;
    const reply = await this.#request(data);
    if (reply.status !== 200) throw new Error(`The push service refused (${String(reply.status)})`);
    const endpoint = reply.pushEndpoint;
    if (typeof endpoint !== 'string' || !/^https:\/\//i.test(endpoint) || endpoint.length > 2048) {
      throw new Error('The push service sent no usable endpoint');
    }
    return endpoint;
  }

  /** Give a channel back. Not waited on: a channel it misses is given back when it next sends to it. */
  unregister(channelID: string, code: UnregisterCode): void {
    if (this.#state !== 'ready') return;
    this.#send({ messageType: 'unregister', channelID, code });
  }

  /** Connect if there's a reason to and disconnect if there isn't. */
  sync(): void {
    if (this.#closed) return;
    const wanted = this.#options.channelCount() > 0 || this.#pending.size > 0;
    if (wanted && !this.#socket && !this.#retry) this.#connect();
    else if (!wanted && this.#socket) this.#disconnect();
  }

  /** Reconnect now if down (the computer woke, or the network came back). */
  wake(): void {
    if (this.#closed || this.#socket) return;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#retryAt = null;
    this.#backoff = BACKOFF_MIN_MS;
    this.sync();
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#disconnect();
    for (const pending of this.#pending.values()) pending.reject(new Error('The push service was closed'));
    this.#pending.clear();
  }

  #request(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error('The push service was closed'));
    const key = `${String(data.messageType)}|${String(data.channelID)}`.toLowerCase();
    return new Promise((resolve, reject) => {
      this.#pending.set(key, { data, sentAt: Date.now(), resolve, reject });
      this.#watchRequests();
      if (this.#state === 'ready') this.#send(data);
      else this.wake();
    });
  }

  /** Fail requests unanswered for too long, and start over: the connection is likely dead. */
  #watchRequests(): void {
    if (this.#requestTimer) return;
    this.#requestTimer = setInterval(() => {
      if (this.#pending.size === 0) {
        if (this.#requestTimer) clearInterval(this.#requestTimer);
        this.#requestTimer = null;
        return;
      }
      const now = Date.now();
      const late = [...this.#pending].filter(([, p]) => now - p.sentAt > REQUEST_TIMEOUT_MS);
      if (late.length === 0) return;
      for (const [key, pending] of late) {
        this.#pending.delete(key);
        pending.reject(new Error('The push service did not answer'));
      }
      this.#lastError = 'request timed out';
      this.#reconnect();
    }, 1_000);
  }

  #connect(): void {
    let socket: WebSocket;
    try {
      // Firefox asks for the `push-notification` subprotocol, but autopush
      // never names it back, and a client that asked must then hang up.
      socket = new WebSocket(this.url);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#options.log(`${this.url}: cannot connect: ${this.#lastError}`);
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    this.#state = 'connecting';
    this.#options.onStatusChanged();
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      // A UAID is named only for the channels under it (as Firefox does).
      this.#sentUaid = this.#options.channelCount() > 0 ? this.#uaid : null;
      const hello: Record<string, unknown> = { messageType: 'hello', use_webpush: true, broadcasts: {} };
      if (this.#sentUaid) hello.uaid = this.#sentUaid;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (message) => {
      if (this.#socket !== socket || typeof message.data !== 'string') return;
      this.#onMessage(message.data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      const wasReady = this.#state === 'ready';
      this.#socket = null;
      this.#state = 'idle';
      this.#connectedAt = null;
      this.#clearPing();
      const why = [event.code, event.reason].filter(Boolean).join(' ');
      if (!wasReady || why) this.#lastError = why || 'connection failed';
      this.#options.log(`${this.url}: ${wasReady ? 'disconnected' : 'connection failed'}${why ? ` (${why})` : ''}`);
      if (event.code === BACKOFF_CLOSE_CODE) this.#backoff = BACKOFF_MAX_MS;
      this.#scheduleRetry();
      this.#options.onStatusChanged();
    };
    socket.onerror = () => {
      // onclose follows.
    };
  }

  #disconnect(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#state = 'idle';
    this.#connectedAt = null;
    this.#clearPing();
    socket?.close();
    this.#options.onStatusChanged();
  }

  #reconnect(): void {
    this.#disconnect();
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    if (this.#options.channelCount() === 0 && this.#pending.size === 0) return;
    const delay = this.#backoff * (0.75 + Math.random() * 0.5);
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    this.#retryAt = Date.now() + delay;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#retryAt = null;
      this.sync();
    }, delay);
  }

  #send(data: Record<string, unknown>): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(data));
  }

  #clearPing(): void {
    if (this.#pingTimer) clearTimeout(this.#pingTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
  }

  /** Anything from the server shows the connection is alive: ping after the next quiet spell. */
  #heard(): void {
    this.#clearPing();
    if (this.#state !== 'ready') return;
    this.#pingTimer = setTimeout(() => {
      this.#send({});
      this.#pongTimer = setTimeout(() => {
        this.#lastError = 'no answer to a ping';
        this.#options.log(`${this.url}: no answer to a ping; reconnecting`);
        this.#reconnect();
      }, REQUEST_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  #onMessage(text: string): void {
    let reply: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      reply = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    this.#heard();
    switch (reply.messageType) {
      case 'hello':
        this.#onHello(reply);
        return;
      case 'register':
      case 'unregister': {
        const key = `${reply.messageType}|${String(reply.channelID)}`.toLowerCase();
        const pending = this.#pending.get(key);
        if (!pending) return;
        this.#pending.delete(key);
        pending.resolve(reply);
        return;
      }
      case 'notification':
        this.#onNotification(reply);
        return;
      default:
        // Pongs ({}), pings and broadcasts: nothing to do.
        return;
    }
  }

  #onHello(reply: Record<string, unknown>): void {
    if (this.#state !== 'connecting') return;
    const uaid = reply.uaid;
    if (reply.status !== 200 || typeof uaid !== 'string' || !uaid || uaid.length > MAX_UAID_LENGTH) {
      this.#lastError = `bad hello (${String(reply.status)})`;
      this.#options.log(`${this.url}: refused the handshake (${String(reply.status)})`);
      this.#reconnect();
      return;
    }
    const reset = this.#sentUaid !== null && uaid !== this.#sentUaid;
    this.#uaid = uaid;
    this.#state = 'ready';
    this.#connectedAt = Date.now();
    this.#backoff = BACKOFF_MIN_MS;
    this.#lastError = null;
    this.#options.log(`${this.url}: connected, ${this.#options.channelCount()} channel(s)${reset ? '; the server forgot them' : ''}`);
    this.#options.onHello(uaid, reset);
    this.#heard();
    for (const pending of this.#pending.values()) {
      pending.sentAt = Date.now();
      this.#send(pending.data);
    }
    this.#options.onStatusChanged();
    // With no channels and nothing asked, there's no reason to stay.
    this.sync();
  }

  #onNotification(reply: Record<string, unknown>): void {
    const { channelID, version } = reply;
    if (typeof channelID !== 'string' || typeof version !== 'string') return;
    let data: Buffer | null = null;
    if (typeof reply.data === 'string') {
      data = Buffer.from(reply.data.replace(/=+$/, ''), 'base64url');
    }
    const raw = reply.headers && typeof reply.headers === 'object' ? (reply.headers as Record<string, unknown>) : null;
    const headers: PushHeaders | null = raw
      ? {
          encoding: typeof raw.encoding === 'string' ? raw.encoding : undefined,
          encryption: typeof raw.encryption === 'string' ? raw.encryption : undefined,
          crypto_key: typeof raw.crypto_key === 'string' ? raw.crypto_key : undefined,
        }
      : null;
    const socket = this.#socket;
    this.#options.onMessage(channelID, version, data, headers).then(
      (code) => {
        // An ack on a later connection would be for nothing: it's sent again.
        if (this.#socket === socket) this.#send({ messageType: 'ack', updates: [{ channelID, version, code }] });
      },
      () => {
        if (this.#socket === socket) this.#send({ messageType: 'ack', updates: [{ channelID, version, code: 102 }] });
      },
    );
  }
}
