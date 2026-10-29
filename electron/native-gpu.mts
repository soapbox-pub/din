// Zero-copy display of Wayland windows: GPU buffers from din-compositor,
// shown in the shell without a CPU ever touching their pixels.
//
// The compositor renders each window into a ring of dmabufs, or passes on
// the app's own buffer where there's nothing to composite, and sends their
// file descriptors over a Unix socket. Node can't receive descriptors, so
// native/din-fd (a tiny N-API addon) does, and hands them here. Each buffer
// is imported once with Electron's sharedTexture API - which wraps it as a
// Chromium SharedImage in the GPU process - and sent once to the shell
// renderer. From then on a frame is just "window W is in buffer B": the
// shell's preload draws that buffer into the window's canvas, on the GPU.
//
// Measured on the dev box: 0.05 ms per frame here and ~0.3 ms in the shell
// at 1600x900, against ~5.7 MB copied (twice) per frame by the CPU path.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { sharedTexture } from 'electron';

/** What din-fd exports (see native/din-fd/src/lib.rs). */
interface DinFd {
  connect(
    path: string,
    onMessage: (message: { payload: Buffer; fds: number[] }) => void,
    onClose: () => void,
  ): void;
  close(fd: number): void;
  notify(socket: string, state: string): void;
}

let addon: DinFd | null | undefined;

/** The din-fd addon, or null when it isn't built (the CPU path runs then). */
export function dinFd(): DinFd | null {
  if (addon !== undefined) return addon;
  addon = null;
  const candidates = [
    process.env.DIN_FD_ADDON,
    path.join(import.meta.dirname, '..', 'native/din-fd/target/release/libdin_fd.so'),
  ];
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const module = { exports: {} as DinFd };
      process.dlopen(module, candidate);
      addon = module.exports;
      break;
    } catch (error) {
      console.error('native-gpu: failed to load din-fd:', error);
    }
  }
  return addon;
}

/** Messages on the buffer socket (see native/din-compositor/src/gpu.rs). */
type BufferMessage =
  | {
      type: 'buffer';
      buffer: number;
      width: number;
      height: number;
      /** A ring buffer is BGRA; an app's own may be RGBA. */
      format: 'bgra' | 'rgba';
      /** One per descriptor, in order. */
      planes: { stride: number; offset: number; size: number }[];
      modifier: string;
    }
  | { type: 'drop'; buffer: number }
  | { type: 'present'; windows: { id: number; buffer: number }[] };

/**
 * Connect to the compositor's buffer socket and relay its buffers and frames
 * to the shell. `shell` returns the shell's WebContents (null while there
 * is none).
 */
export function connectGpuBuffers(socketPath: string, shell: () => Electron.WebContents | null): boolean {
  const fd = dinFd();
  if (!fd) return false;

  const imported = new Map<number, Electron.SharedTextureImported>();

  /** Hand one imported buffer to the shell; it keeps it until 'drop'. */
  const sendToShell = (id: number, texture: Electron.SharedTextureImported) => {
    const contents = shell();
    if (!contents || contents.isDestroyed()) return;
    sharedTexture
      .sendSharedTexture({ frame: contents.mainFrame, importedSharedTexture: texture }, id)
      .catch(() => {
        // The page went away mid-transfer; a reload re-requests everything.
      });
  };

  const onMessage = ({ payload, fds }: { payload: Buffer; fds: number[] }) => {
    let message: BufferMessage;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      for (const descriptor of fds) fd.close(descriptor);
      return;
    }
    const contents = shell();
    switch (message.type) {
      case 'buffer': {
        if (fds.length === 0 || fds.length !== message.planes?.length) {
          for (const descriptor of fds) fd.close(descriptor);
          return;
        }
        let texture: Electron.SharedTextureImported;
        try {
          // Chromium takes ownership of the descriptors from here.
          texture = sharedTexture.importSharedTexture({
            textureInfo: {
              pixelFormat: message.format === 'rgba' ? 'rgba' : 'bgra',
              codedSize: { width: message.width, height: message.height },
              // Apps draw in sRGB, like the rest of the page.
              colorSpace: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', range: 'full' },
              handle: {
                nativePixmap: {
                  planes: message.planes.map((plane, i) => ({ ...plane, fd: fds[i] })),
                  modifier: message.modifier,
                  supportsZeroCopyWebGpuImport: false,
                },
              },
            },
          });
        } catch (error) {
          console.error('native-gpu: import failed:', error);
          for (const descriptor of fds) fd.close(descriptor);
          return;
        }
        imported.set(message.buffer, texture);
        sendToShell(message.buffer, texture);
        return;
      }
      case 'drop': {
        imported.get(message.buffer)?.release();
        imported.delete(message.buffer);
        if (contents && !contents.isDestroyed()) {
          contents.send('native-display:drop', message.buffer);
        }
        return;
      }
      case 'present':
        if (contents && !contents.isDestroyed()) {
          contents.send('native-display:present', message.windows);
        }
        return;
    }
  };

  const onClose = () => {
    for (const texture of imported.values()) texture.release();
    imported.clear();
  };

  try {
    fd.connect(socketPath, onMessage, onClose);
  } catch (error) {
    console.error('native-gpu:', error);
    return false;
  }
  return true;
}
