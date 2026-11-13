// Download Video: the Web Browser saving the video (or audio) a page plays,
// on any site yt-dlp knows, YouTube's included, where the page's own
// <video> plays a stream that can't simply be saved.
//
// yt-dlp runs as the user, never through a shell, with the page's address
// as its one argument after `--`. It works in a folder of its own under
// ~/.cache/din (parts and merges can be gigabytes, too big for a tmpfs /tmp),
// then moves the finished file into ~/Downloads, where FFmpeg (DinOS's) has
// put the best video and audio together. Its progress is reported as a
// browser download (`browser:download`), so the download shelf shows it, and
// Cancel stops it, like any other.
//
// It asks without the user's cookies first: signed in, yt-dlp asks YouTube
// as other players do, and their streams answer 403. Only when that fails
// does the page's cookies go with a second try, so a video the user can see
// signed in (members-only, age-checked) downloads too: just the cookies the
// browser would send that address, written for that run alone to a file
// only the user can read, deleted when it ends. A private tab's are never written
// out, and a Tor tab can't use this at all: yt-dlp would fetch the video
// without Tor.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { app } from 'electron';

interface Options {
  sendToShell: (channel: string, payload?: unknown) => void;
  /** An id for a new download, from the same series as the browser's own. */
  nextId: () => number;
}

export interface VideoDownloadRequest {
  /** The page whose video to save: http(s) only. */
  url: string;
  /** The tab that asked (its WebContents id), or -1. */
  wcId: number;
  /** Its title, to name the download until yt-dlp names it. */
  title?: string;
  /** The session to send cookies from: the persistent browser one, or null for none. */
  cookies: Electron.Session | null;
  /** The session whose proxy settings yt-dlp should follow. */
  proxy: Electron.Session | null;
}

interface Job {
  child: ChildProcess;
  workDir: string;
  cancelled: boolean;
}

let options: Options | null = null;
const jobs = new Map<number, Job>();

/** yt-dlp: DinOS's, else one on PATH. */
export function ytDlp(): string | null {
  const named = process.env.DIN_YTDLP;
  if (named) return fs.existsSync(named) ? named : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'yt-dlp');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** FFmpeg for joining video and audio: DinOS's, else whatever yt-dlp finds. */
function ffmpeg(): string | null {
  const named = process.env.DIN_FFMPEG;
  return named && fs.existsSync(named) ? named : null;
}

function cacheRoot(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'din', 'video-downloads');
}

/** A field of yt-dlp's progress line as a number, or null for its "NA". */
function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The cookies a page's address would be sent, in the Netscape cookies.txt yt-dlp reads. */
async function writeCookies(s: Electron.Session, url: string, file: string): Promise<boolean> {
  const cookies = await s.cookies.get({ url });
  if (cookies.length === 0) return false;
  const clean = (v: string) => v.replace(/[\t\r\n]/g, '');
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    if (!c.domain) continue;
    const domain = c.hostOnly ? c.domain.replace(/^\./, '') : c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    lines.push([
      `${c.httpOnly ? '#HttpOnly_' : ''}${clean(domain)}`,
      c.hostOnly ? 'FALSE' : 'TRUE',
      clean(c.path || '/'),
      c.secure ? 'TRUE' : 'FALSE',
      String(Math.floor(c.expirationDate ?? 0)),
      clean(c.name),
      clean(c.value),
    ].join('\t'));
  }
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return true;
}

/** The proxy a session would use for `url`, as yt-dlp's --proxy takes it ('' for none). */
async function proxyFor(s: Electron.Session, url: string): Promise<string> {
  const rule = (await s.resolveProxy(url)).split(';')[0]?.trim() ?? '';
  const m = /^(PROXY|HTTPS|SOCKS5?|SOCKS4)\s+(\S+)$/i.exec(rule);
  if (!m) return '';
  const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5', SOCKS5: 'socks5', SOCKS4: 'socks4' }[m[1].toUpperCase()];
  return scheme ? `${scheme}://${m[2]}` : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Start saving a page's video to ~/Downloads. Returns the download's id, as
 * its `browser:download` reports carry it; throws if it can't start.
 */
export async function startVideoDownload(request: VideoDownloadRequest): Promise<number> {
  if (!options) throw new Error('Not ready');
  const { sendToShell } = options;
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    throw new Error('Not a web address');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only a website’s videos can be downloaded');
  if (parsed.hostname.endsWith('.onion')) throw new Error('Videos can’t be downloaded from onion sites');
  const tool = ytDlp();
  if (!tool) throw new Error('yt-dlp isn’t installed');

  const url = parsed.href;
  const downloads = app.getPath('downloads');
  await fs.promises.mkdir(downloads, { recursive: true });
  await fs.promises.mkdir(cacheRoot(), { recursive: true, mode: 0o700 });
  const workDir = await fs.promises.mkdtemp(path.join(cacheRoot(), 'job-'));

  const args = [
    '--newline',
    '--no-playlist',
    '--no-colors',
    '--no-mtime',
    // The best there is, kept in an MP4 where its codecs allow, which plays anywhere.
    '-f', 'bv*+ba/b',
    '-S', 'res,ext:mp4:m4a',
    '--merge-output-format', 'mp4/mkv',
    '-P', downloads,
    '-P', `temp:${workDir}`,
    '-o', '%(title).150B [%(id)s].%(ext)s',
    '--progress-template', 'download:DINPROGRESS %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
    '-O', 'video:DINTITLE %(title)s',
    '-O', 'after_move:DINFILE %(filepath)s',
    '--no-simulate',
    '--no-quiet',
  ];
  const ff = ffmpeg();
  if (ff) args.push('--ffmpeg-location', ff);
  if (request.proxy) {
    const proxy = await proxyFor(request.proxy, url).catch(() => '');
    if (proxy) args.push('--proxy', proxy);
  }

  const id = options.nextId();
  const spawnYtDlp = (cookies: string | null) =>
    spawn(tool, [...args, ...(cookies ? ['--cookies', cookies] : []), '--', url], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so Cancel stops the FFmpeg it runs as well.
      detached: true,
    });
  // First without the user's cookies: signed in, yt-dlp asks YouTube as
  // other players do, whose streams then answer 403. Only what fails
  // without them (a members-only video, one that wants your age, or a
  // site that's sure you're a bot) is tried again with them.
  const job: Job = { child: spawnYtDlp(null), workDir, cancelled: false };
  jobs.set(id, job);
  let triedCookies = !request.cookies;

  let filename = request.title?.trim() || `Video from ${hostOf(url)}`;
  let savePath = path.join(downloads, filename);
  let finishedBytes = 0;
  let current = 0;
  let currentTotal = 0;
  let error = '';
  let lastReport = 0;
  const report = (state: 'progressing' | 'completed' | 'cancelled' | 'interrupted', force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < 250) return;
    lastReport = now;
    sendToShell('browser:download', {
      id,
      wcId: request.wcId,
      url,
      filename,
      savePath,
      state,
      paused: false,
      receivedBytes: finishedBytes + current,
      totalBytes: currentTotal > 0 ? finishedBytes + currentTotal : 0,
      video: true,
      ...(error && state === 'interrupted' ? { error } : {}),
    });
  };
  report('progressing', true);

  const onLine = (line: string) => {
    if (line.startsWith('DINPROGRESS ')) {
      const [, status, done, total, estimate] = line.split(' ');
      const bytes = num(done) ?? 0;
      if (status === 'finished') {
        finishedBytes += bytes;
        current = 0;
        currentTotal = 0;
      } else {
        current = bytes;
        currentTotal = num(total) ?? num(estimate) ?? 0;
      }
      report('progressing');
    } else if (line.startsWith('DINTITLE ')) {
      const title = line.slice('DINTITLE '.length).trim();
      if (title) {
        filename = title;
        report('progressing', true);
      }
    } else if (line.startsWith('DINFILE ')) {
      const file = line.slice('DINFILE '.length).trim();
      if (file) {
        savePath = file;
        filename = path.basename(file);
      }
    } else if (line.startsWith('ERROR:')) {
      error = line.slice('ERROR:'.length).trim().slice(0, 300);
    }
  };
  const watch = (child: ChildProcess) => {
    createInterface({ input: child.stdout! }).on('line', onLine);
    createInterface({ input: child.stderr! }).on('line', onLine);
    child.once('error', (err) => {
      error = err.message;
      void ended(child, null);
    });
    child.once('close', (code) => void ended(child, code));
  };

  const succeeded = (code: number | null) =>
    code === 0 && savePath.startsWith(downloads + path.sep) && fs.existsSync(savePath);

  // One run is over: finish, or try again with cookies.
  const ended = async (child: ChildProcess, code: number | null) => {
    if (job.child !== child || !jobs.has(id)) return;
    if (!job.cancelled && !succeeded(code) && !triedCookies && request.cookies) {
      triedCookies = true;
      const file = path.join(workDir, 'cookies.txt');
      if (await writeCookies(request.cookies, url, file).catch(() => false)) {
        if (job.cancelled) return finish(code);
        error = '';
        finishedBytes = 0;
        current = 0;
        currentTotal = 0;
        report('progressing', true);
        job.child = spawnYtDlp(file);
        watch(job.child);
        return;
      }
    }
    finish(code);
  };

  const finish = (code: number | null) => {
    if (!jobs.has(id)) return;
    jobs.delete(id);
    void fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (job.cancelled) report('cancelled', true);
    else if (succeeded(code)) {
      try {
        const size = fs.statSync(savePath).size;
        finishedBytes = size;
        current = 0;
        currentTotal = size;
      } catch {
        // Reported with what was counted.
      }
      report('completed', true);
    } else {
      if (!error) error = 'yt-dlp couldn’t download it';
      console.warn(`[video-download] ${url}: ${error}`);
      report('interrupted', true);
    }
  };
  watch(job.child);
  return id;
}

function killJob(job: Job): void {
  const pid = job.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    job.child.kill('SIGTERM');
  }
}

/** Stop a video download. False if `id` isn't one. */
export function cancelVideoDownload(id: number): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  killJob(job);
  return true;
}

export function registerVideoDownloads(opts: Options): void {
  options = opts;
  // Nothing survives a restart: whatever was left half done is just space.
  void fs.promises.rm(cacheRoot(), { recursive: true, force: true }).catch(() => {});
  app.on('will-quit', () => {
    for (const job of jobs.values()) {
      job.cancelled = true;
      killJob(job);
    }
  });
}
