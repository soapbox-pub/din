/**
 * Printing from an app, the web's way: what's printed goes into a hidden
 * frame, and the frame's own `print()` is called, as sites print a receipt.
 * In Din that opens Din's print dialog, which prints the frame's document
 * (or, for a file, the file itself: a PDF as the PDF); in a plain browser,
 * the browser's. The frame goes once the dialog has what it needs.
 */

/** How long a frame stays after print(), for a dialog still reading it. */
const LINGER_MS = 60_000;

function printFrame(setUp: (frame: HTMLIFrameElement) => void, title: string, cleanUp?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.title = title;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    // Laid out (a frame that isn't won't print), but out of sight.
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;opacity:0;pointer-events:none';
    const done = () => {
      setTimeout(() => {
        frame.remove();
        cleanUp?.();
      }, LINGER_MS);
    };
    frame.addEventListener(
      'load',
      () => {
        try {
          frame.contentWindow!.print();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        done();
      },
      { once: true },
    );
    setUp(frame);
    document.body.appendChild(frame);
  });
}

/** Print a document the app drew: a whole HTML page, with its styles and pictures inline. */
export function printDocument(html: string, title: string): Promise<void> {
  return printFrame((frame) => {
    // Its scripts never run; the parent reaches in to print it.
    frame.sandbox.add('allow-same-origin', 'allow-modals');
    frame.srcdoc = html;
  }, title);
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

/**
 * Print a file the app holds: a PDF, a picture, or text. It's printed as
 * it is, not as the app shows it.
 */
export async function printFile(file: File): Promise<void> {
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const type = TYPES[ext] ?? (file.type.startsWith('image/') || file.type === 'application/pdf' ? file.type : 'text/plain');
  const url = URL.createObjectURL(new Blob([file], { type: type === 'text/plain' ? 'text/plain; charset=utf-8' : type }));
  try {
    await printFrame((frame) => (frame.src = url), file.name, () => URL.revokeObjectURL(url));
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
