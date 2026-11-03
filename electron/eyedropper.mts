// The EyeDropper API for web pages: `new EyeDropper().open()` in a browser
// tab or an installed web app (Canva, Figma, Photopea), picking a color from
// anywhere on the screen.
//
// Chromium's own eyedropper doesn't work under din-shell: it hides the
// cursor, then fills its magnifier from a capture of the screen, which on
// Wayland it asks of xdg-desktop-portal's ScreenCast, which DinOS has no
// portal for. The capture fails and the magnifier draws nothing, so the page
// is left with no cursor at all and nothing to pick.
//
// So eyedropper-preload.cjs puts Din's EyeDropper in the page's world in
// place of Chromium's, and its open() comes here. The whole screen is the
// shell's own main frame (as Screenshot and screen sharing see it), so the
// shell does the picking (`eyedropper:pick`, EyeDropperHost.tsx): it freezes
// the screen, shows a magnifier on it, and answers with the color clicked,
// or null for Esc. The page can abort its pick, and a page that navigates or
// closes takes its pick with it. One pick at a time, on the whole desktop.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { ipcMain, type WebContents, type WebFrameMain } from 'electron';

interface Options {
  isShellSender: (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => boolean;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** Whether a guest is a web page of the shell's that may pick. */
  isPageGuest: (contents: WebContents) => boolean;
}

export interface EyeDropperRequest {
  requestId: number;
  /** The requesting page's origin (e.g. `https://www.canva.com`). */
  origin: string;
}

/** What open() comes to: a color, the user cancelling, or no pick at all. */
export type EyeDropperResult = { color: string } | { cancelled: true } | { error: 'busy' | 'unavailable' };

interface Pick {
  requestId: number;
  frame: WebFrameMain;
  contents: WebContents;
  resolve: (result: EyeDropperResult) => void;
  cleanup: () => void;
}

let options: Options | null = null;
let nextRequestId = 1;
let current: Pick | null = null;

const PAGE_PROTOCOL = /^(https?|nsite|file):/;
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Ends the pick under way with RESULT, telling the shell to take its overlay down if it asked. */
function finish(result: EyeDropperResult, cancelShell: boolean): void {
  const pick = current;
  if (!pick) return;
  current = null;
  pick.cleanup();
  if (cancelShell) options?.sendToShell('eyedropper:cancel', { requestId: pick.requestId });
  pick.resolve(result);
}

export function registerEyeDropperHandlers(opts: Options): void {
  options = opts;
  const { isShellSender, sendToShell, isPageGuest } = opts;

  // From eyedropper-preload.cjs: the page's open(), already past its checks
  // for a user gesture and a pick of its own under way.
  ipcMain.handle('eyedropper:open', (event): Promise<EyeDropperResult> | EyeDropperResult => {
    const frame = event.senderFrame;
    const contents = event.sender;
    // The frame's URL as well as its origin: an about:blank or srcdoc frame
    // borrows its parent's origin.
    if (!frame || !isPageGuest(contents) || !PAGE_PROTOCOL.test(frame.url) || !PAGE_PROTOCOL.test(frame.origin)) {
      return { error: 'unavailable' };
    }
    if (current) return { error: 'busy' };
    return new Promise((resolve) => {
      const requestId = nextRequestId++;
      // Its frame navigating or its guest closing ends the pick.
      const onNavigate = (
        _event: Electron.Event,
        _url: string,
        _code: number,
        _status: string,
        isMainFrame: boolean,
        processId: number,
        routingId: number,
      ) => {
        if (isMainFrame || (processId === frame.processId && routingId === frame.routingId)) {
          finish({ cancelled: true }, true);
        }
      };
      const onDestroyed = () => finish({ cancelled: true }, true);
      contents.on('did-frame-navigate', onNavigate);
      contents.once('destroyed', onDestroyed);
      current = {
        requestId,
        frame,
        contents,
        resolve,
        cleanup: () => {
          if (contents.isDestroyed()) return;
          contents.removeListener('did-frame-navigate', onNavigate);
          contents.removeListener('destroyed', onDestroyed);
        },
      };
      sendToShell('eyedropper:pick', { requestId, origin: frame.origin } satisfies EyeDropperRequest);
    });
  });

  // The page aborted its open() (an AbortSignal).
  ipcMain.on('eyedropper:abort', (event) => {
    const frame = event.senderFrame;
    if (
      current &&
      frame &&
      current.contents === event.sender &&
      current.frame.processId === frame.processId &&
      current.frame.routingId === frame.routingId
    ) {
      finish({ cancelled: true }, true);
    }
  });

  // The shell's answer: a color like `#1a2b3c`, or null when the user
  // cancelled (or the screen couldn't be captured, `unavailable`).
  ipcMain.on('eyedropper:choice', (event, response) => {
    if (!isShellSender(event) || !current || response?.requestId !== current.requestId) return;
    const color = typeof response.color === 'string' ? response.color.toLowerCase() : null;
    if (color && HEX_COLOR.test(color)) finish({ color }, false);
    else if (response.unavailable === true) finish({ error: 'unavailable' }, false);
    else finish({ cancelled: true }, false);
  });
}
