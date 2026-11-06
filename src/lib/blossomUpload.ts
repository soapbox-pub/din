import { formatBytes, getFsBridge } from '@/lib/fs';
import { mimeOf } from '@/lib/mime';
import { sanitizeUrl } from '@/lib/sanitizeUrl';

/**
 * The biggest file uploaded from this computer. It's read whole (Blossom
 * names a file by its hash), and servers turn away far smaller ones anyway.
 */
export const MAX_BLOSSOM_UPLOAD_BYTES = 512 * 1024 * 1024;

/** A file on a Blossom server: where anyone can get it, and what it is. */
export interface BlossomUpload {
  url: string;
  sha256: string;
  size: number;
  type: string;
}

/**
 * Upload a file on this computer to the account's Blossom servers, where
 * anyone with the URL can get it. `upload` is the desktop's uploader
 * (useUploadFile, or a command's `ctx.upload`), so it goes to the servers
 * Settings → Nostr & Storage lists.
 */
export async function uploadLocalFile(path: string, upload: (file: File) => Promise<string[][]>): Promise<BlossomUpload> {
  const fs = getFsBridge();
  if (!fs) throw new Error('Files on this computer need the Din shell');
  const name = path.slice(path.lastIndexOf('/') + 1);
  const stat = await fs.stat(path);
  if (stat.kind === 'directory') throw new Error(`${name} is a folder; compress it to upload it`);
  if (stat.size > MAX_BLOSSOM_UPLOAD_BYTES) {
    throw new Error(`${name} is ${formatBytes(stat.size)}; files up to ${formatBytes(MAX_BLOSSOM_UPLOAD_BYTES)} can be uploaded`);
  }
  const { data, truncated } = await fs.readFile(path, MAX_BLOSSOM_UPLOAD_BYTES);
  if (truncated) throw new Error(`${name} is too big to upload`);
  const type = mimeOf(name) || 'application/octet-stream';
  const tags = await upload(new File([new Uint8Array(data)], name, { type }));
  const tag = (key: string) => tags.find(([k]) => k === key)?.[1];
  const url = sanitizeUrl(tag('url') ?? '');
  if (!url) throw new Error('The server gave back no address for the file');
  return { url: withExtension(url, name), sha256: tag('x') ?? '', size: Number(tag('size')) || data.length, type: tag('m') ?? type };
}

/**
 * The blob's URL ending in the file's own extension: a server names it by
 * the type it was sent as (`.bin` for one it doesn't know), but BUD-01
 * serves `/<sha256>` under any extension, and a link to a .glb should end
 * in .glb. A URL that isn't `…/<sha256>[.ext]`, or a file with no
 * extension, keeps the server's.
 */
export function withExtension(url: string, name: string): string {
  const ext = /\.([A-Za-z0-9]{1,16})$/.exec(name)?.[1];
  if (!ext || name.startsWith('.') && name.lastIndexOf('.') === 0) return url;
  const u = new URL(url);
  const m = /\/([0-9a-f]{64})(\.[^/]*)?$/.exec(u.pathname);
  if (!m) return url;
  u.pathname = `${u.pathname.slice(0, m.index)}/${m[1]}.${ext.toLowerCase()}`;
  return u.href;
}

/** Why an upload failed, for a person: Promise.any's AggregateError says nothing on its own. */
export function cleanUploadError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length) {
    const reasons = [...new Set(error.errors.map((e) => (e instanceof Error ? e.message : String(e))))];
    return `No server took the file: ${reasons.join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Files' upload window (Upload to Blossom…), as launch params for Files,
 * sized for `count` files. The files go with it as the launch's files:
 * `din.app.launch(appLink('file-browser', …), handles)` from an app,
 * `open('file-browser', { ...this, paths })` from the desktop (whose
 * `paths` the window gets as handles, not as a param).
 */
export function uploadWindowParams(count: number): Record<string, unknown> {
  return { window: 'upload', floating: true, width: 480, height: Math.min(232 + count * 64, 560) };
}
