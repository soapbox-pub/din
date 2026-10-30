import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import RFB from '@novnc/novnc';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VmsBridge } from '@/lib/vms';

type ReadyState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * A machine's screen as noVNC wants a WebSocket: the RFB bytes go through
 * din.system.vms to QEMU's VNC socket in main, since apps can't open
 * sockets. noVNC checks the shape (these fields and methods) and sets the
 * handlers itself.
 */
class DisplayChannel {
  binaryType = 'arraybuffer';
  protocol = '';
  readyState: ReadyState = 'connecting';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  private conn: number | null = null;
  /** What arrived before openDisplay said which connection is ours. */
  private early = new Map<number, Uint8Array[]>();
  private offs: (() => void)[] = [];
  private bridge: VmsBridge;

  constructor(bridge: VmsBridge, id: string) {
    this.bridge = bridge;
    this.offs.push(
      bridge.onDisplayData((conn, data) => {
        if (this.conn === null) {
          if (!this.early.has(conn)) this.early.set(conn, []);
          this.early.get(conn)!.push(data);
        } else if (conn === this.conn) {
          this.deliver(data);
        }
      }),
      bridge.onDisplayClosed((conn) => {
        if (conn === this.conn) this.closed(1000, '');
      }),
    );
    bridge.openDisplay(id).then(
      (conn) => {
        if (this.readyState !== 'connecting') {
          bridge.closeDisplay(conn);
          return;
        }
        this.conn = conn;
        this.readyState = 'open';
        this.onopen?.(new Event('open'));
        for (const data of this.early.get(conn) ?? []) this.deliver(data);
        this.early.clear();
      },
      (error: unknown) => {
        this.onerror?.(new Event('error'));
        this.closed(1006, error instanceof Error ? error.message : String(error));
      },
    );
  }

  private deliver(data: Uint8Array): void {
    // noVNC reads e.data as a whole ArrayBuffer.
    const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
    const buffer = (whole ? data.buffer : data.slice().buffer) as ArrayBuffer;
    this.onmessage?.(new MessageEvent('message', { data: buffer }));
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    for (const off of this.offs) off();
    this.offs = [];
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.conn === null || this.readyState !== 'open') return;
    // noVNC reuses its send buffer: copy what's in it now.
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data.slice(0))
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    this.bridge.displayWrite(this.conn, bytes);
  }

  close(): void {
    if (this.conn !== null) this.bridge.closeDisplay(this.conn);
    this.closed(1000, '');
  }
}

export interface ConsoleHandle {
  sendCtrlAltDel(): void;
  sendKeys(keys: { keysym: number; code: string }[]): void;
  fullscreen(): void;
  focus(): void;
  screenshot(): Promise<Blob | null>;
}

/**
 * A running machine's screen, scaled to fit, with its keyboard, pointer and
 * clipboard. Reconnects if the connection drops while it's still mounted.
 */
export function Console({
  bridge,
  vmId,
  scale,
  ref,
  className,
}: {
  bridge: VmsBridge;
  vmId: string;
  /** Fit the window (true), or show it 1:1 with scrolling. */
  scale: boolean;
  ref?: Ref<ConsoleHandle>;
  className?: string;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastClipboard = useRef('');

  useEffect(() => {
    const target = screenRef.current;
    if (!target) return;
    setConnected(false);
    const channel = new DisplayChannel(bridge, vmId);
    const rfb = new RFB(target, channel as unknown as WebSocket, { shared: true });
    rfb.scaleViewport = scale;
    rfb.clipViewport = !scale;
    rfb.resizeSession = true;
    rfb.background = 'transparent';
    rfb.focusOnClick = true;
    rfb.qualityLevel = 9;
    rfb.compressionLevel = 0;
    rfbRef.current = rfb;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    rfb.addEventListener('connect', () => {
      setConnected(true);
      rfb.focus();
    });
    rfb.addEventListener('disconnect', () => {
      setConnected(false);
      // A machine rebooting into new firmware, or QEMU not listening yet.
      if (!disposed) retry = setTimeout(() => setAttempt((n) => n + 1), 1000);
    });
    rfb.addEventListener('clipboard', (e) => {
      const text = (e as CustomEvent<{ text: string }>).detail.text;
      lastClipboard.current = text;
      void navigator.clipboard.writeText(text).catch(() => {});
    });
    return () => {
      disposed = true;
      clearTimeout(retry);
      rfbRef.current = null;
      try {
        rfb.disconnect();
      } catch {
        // Never connected.
      }
    };
    // `scale` is applied below, without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, vmId, attempt]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.scaleViewport = scale;
    rfb.clipViewport = !scale;
  }, [scale, connected]);

  // This computer's clipboard goes to the machine whenever the screen gets
  // focus (a guest with spice-vdagent pastes it).
  useEffect(() => {
    const target = screenRef.current;
    if (!target || !connected) return;
    const push = () => {
      void navigator.clipboard.readText().then(
        (text) => {
          if (!text || text === lastClipboard.current) return;
          lastClipboard.current = text;
          rfbRef.current?.clipboardPasteFrom(text);
        },
        () => {},
      );
    };
    target.addEventListener('focusin', push);
    target.addEventListener('pointerenter', push);
    return () => {
      target.removeEventListener('focusin', push);
      target.removeEventListener('pointerenter', push);
    };
  }, [connected]);

  useImperativeHandle(ref, () => ({
    sendCtrlAltDel: () => rfbRef.current?.sendCtrlAltDel(),
    sendKeys: (keys) => {
      const rfb = rfbRef.current;
      if (!rfb) return;
      for (const k of keys) rfb.sendKey(k.keysym, k.code, true);
      for (const k of [...keys].reverse()) rfb.sendKey(k.keysym, k.code, false);
      rfb.focus();
    },
    fullscreen: () => void screenRef.current?.parentElement?.requestFullscreen().catch(() => {}),
    focus: () => rfbRef.current?.focus(),
    screenshot: async () => {
      const canvas = screenRef.current?.querySelector('canvas');
      if (!canvas) return null;
      return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    },
  }));

  return (
    <div className={cn('relative min-h-0 flex-1 bg-black', className)}>
      <div ref={screenRef} className="absolute inset-0" />
      {!connected && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-white/70">
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Connecting to the screen…
          </span>
        </div>
      )}
    </div>
  );
}
