// YouTube's embedded player won't play without an HTTP Referer naming who
// embedded it: it shows "Error 153, Video player configuration error"
// (PLAYABILITY_ERROR_CODE_EMBEDDER_IDENTITY_MISSING_REFERRER). Chromium sends
// a Referer only from http(s) pages, so an installed nsite (nsite://), or a
// Din app (din://, din+file://), sends none, whatever its referrer policy,
// and every YouTube video in Ditto or Armada running as a Din app failed.
//
// So a YouTube embed one of those pages frames is sent the page's origin, as
// an https page's strict-origin-when-cross-origin policy (the default, and
// what YouTube asks for) would send it. Only that: other requests, and pages
// that send a Referer of their own, are left as they are. YouTube takes any
// Referer, nsite:// too; it only refuses none.
//
// The persistent browser session's headers go through the ad blocker's
// extension, which does the same (electron/adblock-extension/background.js),
// asking here for the page's origin (referrerForFrame): Chromium hides it
// from the extension, which has no permission for those schemes.

import { webContents } from 'electron';

/** Hosts serving YouTube's embedded player. */
const YOUTUBE_EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

/** Din's own schemes, whose pages Chromium sends no Referer from. */
const REFERRERLESS_SCHEMES = new Set(['nsite:', 'din:', 'din+file:']);

/** Whether a URL is YouTube's embedded player. */
export function isYouTubeEmbedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && YOUTUBE_EMBED_HOSTS.has(url.hostname) && url.pathname.startsWith('/embed/');
  } catch {
    return false;
  }
}

/** The Referer for a page on one of Din's own schemes: its origin. */
export function referrerForOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (!REFERRERLESS_SCHEMES.has(url.protocol) || !url.host) return null;
    if (url.username || url.password) return null;
    return `${url.protocol}//${url.host}/`;
  } catch {
    return null;
  }
}

/**
 * The Referer for the page framing a frame, by the frame's FrameTreeNode id
 * (what an extension's webRequest calls its frameId), if that page is on
 * one of Din's own schemes. For the ad blocker's extension, which isn't told
 * the initiator of a request from a scheme it has no permission for.
 */
export function referrerForFrame(frameTreeNodeId: unknown): string | null {
  if (typeof frameTreeNodeId !== 'number' || !Number.isInteger(frameTreeNodeId) || frameTreeNodeId <= 0) return null;
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const frame = contents.mainFrame.framesInSubtree.find((f) => f.frameTreeNodeId === frameTreeNodeId);
    if (frame) return referrerForOrigin(frame.parent?.origin);
  }
  return null;
}

/**
 * Names a Din page's YouTube embed to YouTube in its Referer, when it has
 * none. Changes `headers` in place; for a session.webRequest
 * onBeforeSendHeaders listener.
 */
export function addYouTubeEmbedReferrer(
  details: { url: string; resourceType: string; initiatorOrigin?: string; frame?: Electron.WebFrameMain | null },
  headers: Record<string, string>,
): void {
  if (details.resourceType !== 'subFrame' || !isYouTubeEmbedUrl(details.url)) return;
  const names = Object.keys(headers).filter((name) => name.toLowerCase() === 'referer');
  if (names.some((name) => /^https?:/i.test(headers[name]))) return;
  let parentOrigin: string | undefined;
  try {
    parentOrigin = details.frame?.parent?.origin;
  } catch {
    // The frame is gone.
  }
  const referrer = referrerForOrigin(details.initiatorOrigin) ?? referrerForOrigin(parentOrigin);
  if (!referrer) return;
  for (const name of names) delete headers[name];
  headers.Referer = referrer;
}
