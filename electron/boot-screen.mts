// The boot screen bridge (window.dinos.bootScreen, for the shell): gives DinOS's
// boot and unlock screen the wallpaper Din is showing.
//
// The boot screen asks for the disk's password before anything on the disk
// can be read, so it gets its own copy of the wallpaper on the boot
// partition, written by os/din-boot-screen.sh, which DinOS's launcher names
// in DIN_BOOT_SCREEN and the shell's user runs through sudo. Plymouth only
// reads PNGs, so the image is fetched and converted here, at no more than
// screen size. Where DIN_BOOT_SCREEN isn't set the bridge does nothing.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { ipcMain, nativeImage, net } from 'electron';
import { LOCAL_FILE_SCHEME } from './files.mts';

const HELPER = process.env.DIN_BOOT_SCREEN;

/** Bigger than any screen the boot screen draws on is wasted ESP space. */
const MAX_WIDTH = 2560;
const MAX_HEIGHT = 1600;
const MAX_FETCH_BYTES = 32 * 1024 * 1024;

/** What was last written, so an unchanged wallpaper isn't written again. */
let written: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function wallpaperBytes(url: URL): Promise<Buffer> {
  if (url.protocol === `${LOCAL_FILE_SCHEME}:`) {
    const file = decodeURIComponent(url.pathname);
    const { size } = await fsp.stat(file);
    if (size > MAX_FETCH_BYTES) throw new Error('The wallpaper is too big');
    return fsp.readFile(file);
  }
  const response = await net.fetch(url.toString());
  if (!response.ok) throw new Error(`The wallpaper didn't load (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function wallpaperPng(url: URL): Promise<Buffer> {
  const bytes = await wallpaperBytes(url);
  if (bytes.length > MAX_FETCH_BYTES) throw new Error('The wallpaper is too big');
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("The wallpaper isn't an image Din can read");
  const { width, height } = image.getSize();
  const factor = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  if (factor < 1) {
    image = image.resize({
      width: Math.round(width * factor),
      height: Math.round(height * factor),
      quality: 'best',
    });
  }
  return image.toPNG();
}

function runHelper(helper: string, hour12: boolean, png: Buffer | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', helper, 'wallpaper', hour12 ? '12' : '24'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', () => {
      // The helper exited before reading it; its stderr says why.
    });
    child.stdin.end(png ?? Buffer.alloc(0));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').pop() || `din-boot-screen exited ${code}`));
    });
  });
}

export function registerBootScreenHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  /**
   * The wallpaper (a URL: https, the shell's own, or a local file) and whether the clock is
   * 12-hour. A null wallpaper leaves the boot screen its plain background.
   */
  ipcMain.handle('boot-screen:update', (event, wallpaper: unknown, hour12: unknown) => {
    assertShellSender(event);
    if (!HELPER) return;
    if (typeof hour12 !== 'boolean') throw new Error('hour12 must be a boolean');
    let url: URL | null = null;
    if (wallpaper !== null) {
      if (typeof wallpaper !== 'string') throw new Error('The wallpaper must be a URL');
      const shell = new URL(event.sender.getURL());
      url = new URL(wallpaper, shell);
      const local = url.protocol === `${LOCAL_FILE_SCHEME}:` && url.host === 'localhost';
      if (url.protocol !== 'https:' && url.origin !== shell.origin && !local) {
        throw new Error('The wallpaper must be https, part of Din, or a local file');
      }
    }
    const key = `${url?.toString() ?? ''}|${hour12}`;
    const run = queue.then(async () => {
      if (key === written) return;
      const png = url ? await wallpaperPng(url) : null;
      await runHelper(HELPER, hour12, png);
      written = key;
    });
    queue = run.catch(() => {});
    return run;
  });
}
