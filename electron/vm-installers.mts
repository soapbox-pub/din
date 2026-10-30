// The systems the Virtual Machines app installs in one click (electron/vms.mts
// runs the installs): where each one's newest release is, downloading it
// (resumably, checked against its published SHA-256), and what its installer
// needs to run by itself.
//
// Nothing about a release is written down here: each resolver asks the
// system's own servers which release is newest and what its SHA-256 is, so a
// new release is picked up by the next install.
//
// Downloads are kept in ~/VMs/.installers/ (a dot folder is never a
// machine), shared by machines installing the same release, while a newer
// one replaces them. Linux installs boot the installer's own kernel straight
// from the disc image (QEMU's -kernel), with an answer file on a small FAT
// drive QEMU makes from a folder: Ubuntu's autoinstall (cloud-init's CIDATA)
// and Fedora's kickstart (Anaconda's OEMDRV). Windows comes from Microsoft's
// download page, driven in a hidden window, and starts from its disc with
// an autounattend.xml on that drive. Runs as TypeScript directly via Node's
// native type stripping - erasable syntax only.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, net, session } from 'electron';
import type { VmInstallerId } from '../src/lib/vms.ts';

export const INSTALLERS_DIR = path.join(os.homedir(), 'VMs', '.installers');

export interface InstallerFile {
  /** What it's kept as in INSTALLERS_DIR. */
  name: string;
  /** Where to get it now (Windows' links are signed and expire, so it's asked each time). */
  url: () => Promise<string>;
  sha256: string;
  size: number | null;
}

export interface Release {
  label: string;
  file: InstallerFile;
}

export interface InstallerInfo {
  name: string;
  /** Where a person gets it by hand. */
  manualUrl: string;
  /** About what an installed system takes up on its disk, for the progress bar. */
  installedBytes: number;
  /** The hardware it gets: Windows 11's needs, or virtio for Linux. */
  hardware: { os: 'windows' | 'linux'; diskGiB: number; minMemoryMiB: number; secureBoot: boolean; tpm: boolean };
  resolve: () => Promise<Release>;
}

const GiB = 1024 ** 3;

async function get(url: string): Promise<string> {
  const response = await net.fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}.`);
  return response.text();
}

/** The newest Ubuntu LTS's desktop disc image, from Ubuntu's upgrade metadata and its SHA256SUMS. */
async function resolveUbuntu(): Promise<Release> {
  const stanzas = (await get('https://changelogs.ubuntu.com/meta-release-lts')).split(/\n\s*\n/).map((s) => {
    const fields = new Map<string, string>();
    for (const line of s.split('\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    return fields;
  });
  const newest = stanzas.filter((f) => f.get('Supported') === '1' && /^\d+\.\d+/.test(f.get('Version') ?? '')).at(-1);
  const series = /^(\d+\.\d+)/.exec(newest?.get('Version') ?? '')?.[1];
  if (!series) throw new Error('Ubuntu’s release list didn’t name a release.');
  const base = `https://releases.ubuntu.com/${series}/`;
  // Point releases share their series' folder: take the newest.
  const images = [...(await get(`${base}SHA256SUMS`)).matchAll(/^([0-9a-f]{64}) \*?(ubuntu-(\d+\.\d+(?:\.(\d+))?)-desktop-amd64\.iso)$/gm)]
    .map((m) => ({ sha256: m[1], name: m[2], version: m[3], point: Number(m[4] ?? 0) }))
    .sort((a, b) => b.point - a.point);
  const image = images[0];
  if (!image) throw new Error(`Ubuntu ${series} has no desktop disc image.`);
  return {
    label: `Ubuntu ${image.version} LTS`,
    file: { name: image.name, url: async () => base + image.name, sha256: image.sha256, size: null },
  };
}

interface FedoraRelease {
  version: string;
  arch: string;
  variant: string;
  link: string;
  sha256?: string;
  size?: string;
}

/**
 * The newest Fedora's network installer: Anaconda with a kickstart installs
 * Fedora Workstation from Fedora's mirrors, which is the only way it installs
 * hands-free (the Workstation live image has no kickstart).
 */
async function resolveFedora(): Promise<Release> {
  const releases = JSON.parse(await get('https://fedoraproject.org/releases.json')) as FedoraRelease[];
  const netinst = releases
    .filter((r) => r.arch === 'x86_64' && r.variant === 'Everything' && /^\d+$/.test(r.version) && /netinst.*\.iso$/.test(r.link) && r.sha256)
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  if (!netinst) throw new Error('Fedora’s release list has no network installer.');
  return {
    label: `Fedora Workstation ${netinst.version}`,
    file: {
      name: netinst.link.slice(netinst.link.lastIndexOf('/') + 1),
      url: async () => netinst.link,
      sha256: netinst.sha256!.toLowerCase(),
      size: Number(netinst.size) || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Windows, from Microsoft's own download page
// ---------------------------------------------------------------------------

const WINDOWS_PAGE = 'https://www.microsoft.com/en-us/software-download/windows11';

/** Microsoft's names for its disc images' languages, and the culture each installs as. */
const WINDOWS_LANGUAGES: [language: string, culture: string, matches: RegExp][] = [
  ['English', 'en-US', /^en-US$/i],
  ['English International', 'en-GB', /^en/i],
  ['Arabic', 'ar-SA', /^ar/i],
  ['Brazilian Portuguese', 'pt-BR', /^pt-BR$/i],
  ['Portuguese', 'pt-PT', /^pt/i],
  ['Bulgarian', 'bg-BG', /^bg/i],
  ['Chinese (Simplified)', 'zh-CN', /^zh-(CN|SG|Hans)/i],
  ['Chinese (Traditional)', 'zh-TW', /^zh/i],
  ['Croatian', 'hr-HR', /^hr/i],
  ['Czech', 'cs-CZ', /^cs/i],
  ['Danish', 'da-DK', /^da/i],
  ['Dutch', 'nl-NL', /^nl/i],
  ['Estonian', 'et-EE', /^et/i],
  ['Finnish', 'fi-FI', /^fi/i],
  ['French Canadian', 'fr-CA', /^fr-CA$/i],
  ['French', 'fr-FR', /^fr/i],
  ['German', 'de-DE', /^de/i],
  ['Greek', 'el-GR', /^el/i],
  ['Hebrew', 'he-IL', /^(he|iw)/i],
  ['Hungarian', 'hu-HU', /^hu/i],
  ['Italian', 'it-IT', /^it/i],
  ['Japanese', 'ja-JP', /^ja/i],
  ['Korean', 'ko-KR', /^ko/i],
  ['Latvian', 'lv-LV', /^lv/i],
  ['Lithuanian', 'lt-LT', /^lt/i],
  ['Norwegian', 'nb-NO', /^(nb|no|nn)/i],
  ['Polish', 'pl-PL', /^pl/i],
  ['Romanian', 'ro-RO', /^ro/i],
  ['Russian', 'ru-RU', /^ru/i],
  ['Serbian Latin', 'sr-Latn-RS', /^sr/i],
  ['Slovak', 'sk-SK', /^sk/i],
  ['Slovenian', 'sl-SI', /^sl/i],
  ['Spanish (Mexico)', 'es-MX', /^es-(MX|419|US)/i],
  ['Spanish', 'es-ES', /^es/i],
  ['Swedish', 'sv-SE', /^sv/i],
  ['Thai', 'th-TH', /^th/i],
  ['Turkish', 'tr-TR', /^tr/i],
  ['Ukrainian', 'uk-UA', /^uk/i],
];

/** The language of Windows this computer's user wants, as Microsoft names it. */
function windowsLanguage(): string {
  return WINDOWS_LANGUAGES.find(([, , matches]) => matches.test(app.getLocale()))?.[0] ?? 'English';
}

/** The culture a Windows disc image installs as, from its file's name ("…_en-us_…", "Win11_German_x64"). */
function windowsCulture(iso: string): string {
  const file = path.basename(iso);
  const code = /[_-]([a-z]{2}-[a-z]{2})[_.-]/i.exec(file)?.[1];
  if (code) return WINDOWS_LANGUAGES.find(([, culture]) => culture.toLowerCase() === code.toLowerCase())?.[1] ?? code;
  const named = [...WINDOWS_LANGUAGES].sort((a, b) => b[0].length - a[0].length).find(([language]) => file.toLowerCase().replace(/[_-]+/g, ' ').includes(language.toLowerCase()));
  return named?.[1] ?? 'en-US';
}

interface WindowsLink {
  url: string;
  /** The SHA-256 Microsoft's page lists for this language's disc image. */
  sha256: string;
  version: string;
}

/**
 * Ask Microsoft's download page for a disc image's link, as a person would:
 * Microsoft turns away requests that don't come from a real browser, so it's
 * Chromium, in a hidden window of its own, that fills in the page's form.
 * The SHA-256 comes from the table on the same page.
 */
async function windowsLink(language: string): Promise<WindowsLink> {
  const ses = session.fromPartition('din-vm-windows-download');
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|din)\/\S+/gi, ''));
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, offscreen: true, sandbox: true, javascript: true } });
  const js = <T,>(code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
  const waitFor = async <T,>(code: string, ms: number, what: string): Promise<T> => {
    for (const deadline = Date.now() + ms; ; ) {
      const value = await js<T | null>(code);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Microsoft’s download page didn’t offer ${what}.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  try {
    await win.loadURL(WINDOWS_PAGE);
    const version = (await js<string>(`(/Version\\s+(\\w+)/.exec(document.body.innerText) || [])[1] || ''`)) || '';
    await waitFor<number>(`document.querySelectorAll('#product-edition option').length > 1`, 20_000, 'Windows');
    await js(`(() => {
      const s = document.querySelector('#product-edition');
      s.value = [...s.options].find((o) => /^[0-9]+$/.test(o.value)).value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#submit-product-edition').click();
    })()`);
    await waitFor<boolean>(`document.querySelectorAll('#product-languages option').length > 1`, 30_000, 'its languages');
    // Each option's value is JSON naming the language as the hash table does.
    const chosen = await js<string | null>(`(() => {
      const s = document.querySelector('#product-languages');
      const lang = (o) => { try { return JSON.parse(o.value).language; } catch { return null; } };
      const o = [...s.options].find((o) => lang(o) === ${JSON.stringify(language)}) || [...s.options].find((o) => lang(o) === 'English');
      if (!o) return null;
      s.value = o.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#submit-sku').click();
      return lang(o);
    })()`);
    if (!chosen) throw new Error('Microsoft’s download page didn’t offer English.');
    const result = await waitFor<{ links?: string[]; error?: string }>(
      `(() => {
        const links = [...document.querySelectorAll('a[href*="prss.microsoft.com"]')].map((a) => a.href).filter((h) => /x64/i.test(h));
        if (links.length) return { links };
        const error = [...document.querySelectorAll('#errorModalMessage, [role=alert]')].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).filter(Boolean).join(' ');
        return error ? { error } : null;
      })()`,
      30_000,
      'a download link',
    );
    if (!result.links?.length) throw new Error('Microsoft wouldn’t let Din download Windows automatically.', { cause: result.error });
    const sha256 = await js<string | null>(`(() => {
      for (const row of document.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
        if (cells.length >= 2 && cells[0] === ${JSON.stringify(`${chosen} 64-bit`)} && /^[0-9A-Fa-f]{64}$/.test(cells[1])) return cells[1].toLowerCase();
      }
      return null;
    })()`);
    if (!sha256) throw new Error('Microsoft’s download page didn’t list the SHA-256 to check Windows against.');
    return { url: result.links[0], sha256, version };
  } finally {
    win.destroy();
  }
}

async function resolveWindows(): Promise<Release> {
  const language = windowsLanguage();
  let link: WindowsLink | null = await windowsLink(language);
  const name = decodeURIComponent(new URL(link.url).pathname.split('/').pop() ?? 'Windows11.iso');
  return {
    label: `Windows 11${link.version ? ` ${link.version}` : ''}`,
    file: {
      name,
      // Links are signed and expire within a day: a download that's resumed later asks again.
      url: async () => {
        const fresh = link ?? (await windowsLink(language));
        link = null;
        return fresh.url;
      },
      sha256: link.sha256,
      size: null,
    },
  };
}

const LINUX = { os: 'linux', diskGiB: 64, minMemoryMiB: 2048, secureBoot: false, tpm: false } as const;

export const INSTALLERS: Partial<Record<VmInstallerId, InstallerInfo>> = {
  windows: {
    name: 'Windows 11',
    manualUrl: WINDOWS_PAGE,
    installedBytes: 20 * GiB,
    hardware: { os: 'windows', diskGiB: 128, minMemoryMiB: 4096, secureBoot: true, tpm: true },
    resolve: resolveWindows,
  },
  ubuntu: { name: 'Ubuntu', manualUrl: 'https://ubuntu.com/download/desktop', installedBytes: 10 * GiB, hardware: LINUX, resolve: resolveUbuntu },
  fedora: { name: 'Fedora', manualUrl: 'https://fedoraproject.org/workstation/download', installedBytes: 7 * GiB, hardware: LINUX, resolve: resolveFedora },
};

export function installer(id: unknown): InstallerInfo {
  const info = typeof id === 'string' && Object.hasOwn(INSTALLERS, id) ? INSTALLERS[id as VmInstallerId] : undefined;
  if (!info) throw new Error('Din can’t install that system by itself.');
  return info;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

export type DownloadProgress = (phase: 'downloading' | 'verifying', received: number, total: number) => void;

const downloads = new Map<string, { promise: Promise<string>; listeners: Set<DownloadProgress>; controller: AbortController }>();

const fileOf = (name: string) => path.join(INSTALLERS_DIR, name);
const partOf = (name: string) => `${fileOf(name)}.part`;

/**
 * The file, downloaded and checked, resolving with its path. Machines
 * fetching the same file share one download; it stops when every one of
 * them has let go (`signal`). An interrupted download carries on from where
 * it got to, here or after Din restarts.
 */
export function download(file: InstallerFile, onProgress: DownloadProgress, signal: AbortSignal): Promise<string> {
  let entry = downloads.get(file.name);
  if (!entry) {
    const listeners = new Set<DownloadProgress>();
    const controller = new AbortController();
    const promise = fetchFile(file, (...a) => listeners.forEach((l) => l(...a)), controller.signal).finally(() => {
      if (downloads.get(file.name)?.promise === promise) downloads.delete(file.name);
    });
    entry = { promise, listeners, controller };
    downloads.set(file.name, entry);
  }
  const current = entry;
  current.listeners.add(onProgress);
  const leave = () => {
    current.listeners.delete(onProgress);
    if (current.listeners.size) return;
    current.controller.abort();
    if (downloads.get(file.name) === current) downloads.delete(file.name);
  };
  signal.addEventListener('abort', leave, { once: true });
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true });
    current.promise.then(resolve, reject).finally(() => {
      current.listeners.delete(onProgress);
      signal.removeEventListener('abort', leave);
    });
  });
}

/** Throw away a partial download nothing's waiting for. */
export function forgetPartial(name: string): void {
  if (!downloads.has(name)) void fsp.rm(partOf(name), { force: true });
}

async function hashFile(file: string, upTo: number, hash: ReturnType<typeof createHash>, onBytes: (n: number) => void): Promise<void> {
  if (!upTo) return;
  const stream = fs.createReadStream(file, { start: 0, end: upTo - 1, highWaterMark: 4 * 1024 * 1024 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
    onBytes((chunk as Buffer).length);
  }
}

async function fetchFile(file: InstallerFile, onProgress: DownloadProgress, signal: AbortSignal): Promise<string> {
  await fsp.mkdir(INSTALLERS_DIR, { recursive: true });
  const done = fileOf(file.name);
  const part = partOf(file.name);
  if (fs.existsSync(done)) return done;

  let total = file.size ?? 0;
  // What's already here goes into the hash first.
  let have = await fsp.stat(part).then((s) => s.size, () => 0);
  let hash = createHash('sha256');
  if (have) {
    let hashed = 0;
    await hashFile(part, have, hash, (n) => onProgress('verifying', (hashed += n), have));
  }
  const restart = async () => {
    have = 0;
    hash = createHash('sha256');
    await fsp.rm(part, { force: true });
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await net.fetch(await file.url(), { headers: have ? { range: `bytes=${have}-` } : {}, signal });
      if (response.status === 416 && have && have === total) break;
      if (!response.ok || !response.body) throw new Error(`The download server answered ${response.status}.`);
      // A server that won't resume sends it all again.
      if (have && response.status !== 206) await restart();
      const length = Number(response.headers.get('content-length')) || 0;
      if (length) total = have + length;
      const out = await fsp.open(part, 'a');
      try {
        let last = 0;
        const reader = response.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          await out.write(value);
          hash.update(value);
          have += value.byteLength;
          const now = Date.now();
          if (now - last > 250) {
            last = now;
            onProgress('downloading', have, total);
          }
        }
      } finally {
        await out.close();
      }
      if (total && have < total) throw new Error('The download stopped early.');
      break;
    } catch (error) {
      if (signal.aborted) throw new Error('Cancelled.', { cause: error });
      if (attempt >= 5) throw error instanceof Error ? error : new Error(String(error));
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      // Carry on from what reached the disk, unless a write was cut short.
      const size = await fsp.stat(part).then((s) => s.size, () => 0);
      if (size !== have) await restart();
    }
  }

  onProgress('verifying', have, have);
  if (hash.digest('hex') !== file.sha256) {
    await fsp.rm(part, { force: true });
    throw new Error('The download didn’t match its published SHA-256, so it was thrown away.');
  }
  await fsp.rename(part, done);
  return done;
}

/** Older downloads of an installer's, which no machine is using. */
export async function pruneDownloads(keep: Set<string>): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(INSTALLERS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(INSTALLERS_DIR, name);
    const base = name.replace(/\.part$/, '');
    if (keep.has(path.join(INSTALLERS_DIR, base)) || downloads.has(base)) continue;
    await fsp.rm(file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Reading files out of a disc image (ISO 9660, with Rock Ridge's long names)
// ---------------------------------------------------------------------------

const SECTOR = 2048;

interface IsoEntry {
  name: string;
  extent: number;
  size: number;
  dir: boolean;
}

async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function rockRidgeName(record: Buffer, start: number): string | null {
  let name = '';
  let found = false;
  for (let p = start; p + 4 <= record.length; ) {
    const sig = record.toString('latin1', p, p + 2);
    const len = record[p + 2];
    if (len < 4 || p + len > record.length) break;
    if (sig === 'NM') {
      name += record.toString('utf8', p + 5, p + len);
      found = true;
      if (!(record[p + 4] & 1)) break;
    }
    p += len;
  }
  return found ? name : null;
}

async function readDir(handle: fsp.FileHandle, extent: number, size: number): Promise<IsoEntry[]> {
  const data = await readAt(handle, extent * SECTOR, size);
  const entries: IsoEntry[] = [];
  for (let p = 0; p < data.length; ) {
    const len = data[p];
    if (!len) {
      // Records don't cross sectors: the rest of this one is padding.
      p = (Math.floor(p / SECTOR) + 1) * SECTOR;
      continue;
    }
    const record = data.subarray(p, p + len);
    const nameLength = record[32];
    const raw = record.subarray(33, 33 + nameLength);
    p += len;
    if (nameLength === 1 && raw[0] <= 1) continue; // . and ..
    const plain = raw.toString('latin1').replace(/;\d+$/, '').replace(/\.$/, '');
    const susp = 33 + nameLength + (nameLength % 2 ? 0 : 1);
    entries.push({
      name: rockRidgeName(record, susp) ?? plain,
      extent: record.readUInt32LE(2),
      size: record.readUInt32LE(10),
      dir: !!(record[25] & 2),
    });
  }
  return entries;
}

/** A disc image's volume label, and its files by path. */
export async function openIso(iso: string): Promise<{ label: string; read: (file: string) => Promise<Buffer | null>; close: () => Promise<void> }> {
  const handle = await fsp.open(iso, 'r');
  const pvd = await readAt(handle, 16 * SECTOR, SECTOR);
  if (pvd[0] !== 1 || pvd.toString('latin1', 1, 6) !== 'CD001') {
    await handle.close();
    throw new Error('That isn’t a disc image.');
  }
  const root = pvd.subarray(156, 156 + 34);
  return {
    label: pvd.toString('latin1', 40, 72).trim(),
    read: async (file) => {
      let entry: IsoEntry = { name: '', extent: root.readUInt32LE(2), size: root.readUInt32LE(10), dir: true };
      for (const part of file.split('/').filter(Boolean)) {
        if (!entry.dir) return null;
        const next = (await readDir(handle, entry.extent, entry.size)).find((e) => e.name.toLowerCase() === part.toLowerCase());
        if (!next) return null;
        entry = next;
      }
      return entry.dir ? null : readAt(handle, entry.extent * SECTOR, entry.size);
    },
    close: () => handle.close(),
  };
}

// ---------------------------------------------------------------------------
// Setting up hands-free
// ---------------------------------------------------------------------------

/** The account a new system gets: this computer's user's name. */
export function account(): { username: string; fullName: string } {
  let username = os.userInfo().username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!/^[a-z_]/.test(username) || ['root', 'admin', 'daemon', 'bin', 'sys', 'nobody', 'guest', 'administrator'].includes(username)) username = 'user';
  return { username, fullName: username.charAt(0).toUpperCase() + username.slice(1) };
}

function locale(): { lang: string; timezone: string } {
  const [language, region] = app.getLocale().split(/[-_]/);
  const lang = `${language.toLowerCase()}${region ? `_${region.toUpperCase()}` : language === 'en' ? '_US' : `_${language.toUpperCase()}`}.UTF-8`;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { lang, timezone };
}

/** How the installer starts: its kernel from the disc, and the answer file it reads. */
export interface InstallBoot {
  /** Linux's installer kernel, started directly; Windows starts from its disc. */
  kernel?: string;
  initrd?: string;
  append?: string;
  /** A folder QEMU shows the machine as a FAT drive with this label. */
  seedDir: string;
  seedLabel: string;
}

// A throwaway password's hash: the installers want one, and it's removed
// again so the account has none (the system logs in by itself).
const THROWAWAY_HASH = '$6$l5AbEpqWSTP4vD.R$MY6amhOJ1FS1V50TEKoekDxAH3wF5RyhozQiJd1LFlLDZg9PBGgvsmGIcd12ox5OG8GbxU6hN4mihOufh4mUD/';

function ubuntuUserData(): string {
  const { username, fullName } = account();
  const { lang, timezone } = locale();
  // Quoted (JSON's strings are YAML's), so nothing in them reads as YAML.
  const lateCommands = [
    `curtin in-target -- passwd -d ${username}`,
    `echo '${username} ALL=(ALL) NOPASSWD:ALL' > /target/etc/sudoers.d/90-din && chmod 440 /target/etc/sudoers.d/90-din`,
    `mkdir -p /target/etc/gdm3 && printf '[daemon]\\nAutomaticLoginEnable=true\\nAutomaticLogin=${username}\\n' > /target/etc/gdm3/custom.conf`,
    // Ubuntu's first-login setup runs despite gnome-initial-setup-done, so it goes.
    `curtin in-target -- apt-get -y purge gnome-initial-setup || true`,
  ];
  return `#cloud-config
autoinstall:
  version: 1
  interactive-sections: []
  locale: ${lang}
  keyboard:
    layout: us
  timezone: ${JSON.stringify(timezone)}
  identity:
    realname: ${JSON.stringify(fullName)}
    username: ${username}
    hostname: ubuntu
    password: ${JSON.stringify(THROWAWAY_HASH)}
  storage:
    layout:
      name: direct
  codecs:
    install: false
  drivers:
    install: false
  packages:
    - spice-vdagent
  late-commands:
${lateCommands.map((c) => `    - ${JSON.stringify(c)}`).join('\n')}
  shutdown: poweroff
`;
}

function fedoraKickstart(release: number): string {
  const { username, fullName } = account();
  const { lang, timezone } = locale();
  return `# Din's hands-free install of Fedora Workstation.
text
lang ${lang}
keyboard us
timezone ${timezone} --utc
url --mirrorlist="https://mirrors.fedoraproject.org/mirrorlist?repo=fedora-${release}&arch=x86_64"
repo --name=updates --mirrorlist="https://mirrors.fedoraproject.org/mirrorlist?repo=updates-released-f${release}&arch=x86_64"
network --bootproto=dhcp --hostname=fedora
zerombr
clearpart --all --initlabel --disklabel=gpt
autopart
bootloader
rootpw --lock
user --name=${username} --gecos="${fullName.replace(/"/g, '')}" --groups=wheel --iscrypted --password=${THROWAWAY_HASH}
firstboot --disable
poweroff

%packages
@^workstation-product-environment
spice-vdagent
%end

%post
# Installed in text mode, it would start to a console.
systemctl set-default graphical.target
passwd -d ${username}
echo '${username} ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-din
chmod 440 /etc/sudoers.d/90-din
mkdir -p /etc/gdm
cat > /etc/gdm/custom.conf <<'EOF'
[daemon]
AutomaticLoginEnable=True
AutomaticLogin=${username}
EOF
mkdir -p /home/${username}/.config
echo yes > /home/${username}/.config/gnome-initial-setup-done
chown -R ${username}: /home/${username}/.config
%end
`;
}

/** Kernel command line quoting for a volume label: spaces as \x20, as dracut reads them. */
const labelArg = (label: string) => label.replace(/ /g, '\\x20');

/**
 * Get a Linux installer ready to run by itself: its kernel and initrd out of
 * the disc image into `dir`, and its answer file in `dir`/seed.
 */
export async function prepareLinux(installerId: VmInstallerId, iso: string, dir: string): Promise<InstallBoot> {
  const disc = await openIso(iso);
  try {
    const paths =
      installerId === 'ubuntu'
        ? { kernel: 'casper/vmlinuz', initrd: 'casper/initrd' }
        : { kernel: 'images/pxeboot/vmlinuz', initrd: 'images/pxeboot/initrd.img' };
    const [kernel, initrd] = await Promise.all([disc.read(paths.kernel), disc.read(paths.initrd)]);
    if (!kernel || !initrd) throw new Error('That disc image doesn’t have the installer Din expected.');
    const seedDir = path.join(dir, 'seed');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(seedDir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'vmlinuz'), kernel);
    await fsp.writeFile(path.join(dir, 'initrd'), initrd);
    if (installerId === 'ubuntu') {
      await fsp.writeFile(path.join(seedDir, 'user-data'), ubuntuUserData());
      await fsp.writeFile(path.join(seedDir, 'meta-data'), '');
      return {
        kernel: path.join(dir, 'vmlinuz'),
        initrd: path.join(dir, 'initrd'),
        append: 'boot=casper autoinstall ds=nocloud quiet splash ---',
        seedDir,
        seedLabel: 'CIDATA',
      };
    }
    const release = Number(/(\d+)/.exec(disc.label.replace(/x86_64/, ''))?.[1]) || Number(/-(\d+)-/.exec(path.basename(iso))?.[1]);
    if (!release) throw new Error('Din couldn’t tell which Fedora that disc image is.');
    await fsp.writeFile(path.join(seedDir, 'ks.cfg'), fedoraKickstart(release));
    return {
      kernel: path.join(dir, 'vmlinuz'),
      initrd: path.join(dir, 'initrd'),
      append: `inst.stage2=hd:LABEL=${labelArg(disc.label)} inst.ks=hd:LABEL=OEMDRV:/ks.cfg quiet`,
      seedDir,
      seedLabel: 'OEMDRV',
    };
  } finally {
    await disc.close();
  }
}

// ---------------------------------------------------------------------------
// Windows Setup's answer file
// ---------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** What Windows Setup says when it's done: written to the first serial port at first logon. */
export const WINDOWS_READY = 'DIN-WINDOWS-READY';

/**
 * autounattend.xml, which Windows Setup finds at the root of any drive: no
 * questions, Windows 11 Pro (Microsoft's generic key, which installs it but
 * doesn't activate it), the whole disk, and a local account named for this
 * computer's user with no password, which Windows signs straight into. No
 * Microsoft account, and no network needed.
 */
function windowsAnswerFile(culture: string): string {
  const { username, fullName } = account();
  const user = xml(username);
  const arch = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"';
  const component = (name: string, body: string) =>
    `<component name="${name}" ${arch} xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</component>`;
  const locales = `<InputLocale>${culture}</InputLocale><SystemLocale>${culture}</SystemLocale><UILanguage>${culture}</UILanguage><UserLocale>${culture}</UserLocale>`;
  // Windows 11's checks, for a computer that can't give it a TPM, Secure Boot or 4 GB.
  const bypass = ['BypassTPMCheck', 'BypassSecureBootCheck', 'BypassRAMCheck', 'BypassStorageCheck', 'BypassCPUCheck'].map(
    (name, i) =>
      `<RunSynchronousCommand wcm:action="add"><Order>${i + 1}</Order><Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v ${name} /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>`,
  );
  const partition = (order: number, type: string, size?: number) =>
    `<CreatePartition wcm:action="add"><Order>${order}</Order><Type>${type}</Type>${size ? `<Size>${size}</Size>` : '<Extend>true</Extend>'}</CreatePartition>`;
  const modify = (order: number, format: string, label?: string) =>
    `<ModifyPartition wcm:action="add"><Order>${order}</Order><PartitionID>${order}</PartitionID>${format ? `<Format>${format}</Format>` : ''}${label ? `<Label>${label}</Label>` : ''}</ModifyPartition>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
<settings pass="windowsPE">
${component('Microsoft-Windows-International-Core-WinPE', `<SetupUILanguage><UILanguage>${culture}</UILanguage></SetupUILanguage>${locales}`)}
${component(
  'Microsoft-Windows-Setup',
  `<RunSynchronous>${bypass.join('')}</RunSynchronous>
<DiskConfiguration><Disk wcm:action="add"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk>
<CreatePartitions>${partition(1, 'EFI', 300)}${partition(2, 'MSR', 16)}${partition(3, 'Primary')}</CreatePartitions>
<ModifyPartitions>${modify(1, 'FAT32', 'System')}${modify(2, '')}${modify(3, 'NTFS', 'Windows')}</ModifyPartitions>
</Disk></DiskConfiguration>
<ImageInstall><OSImage><InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo></OSImage></ImageInstall>
<UserData><AcceptEula>true</AcceptEula><ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>OnError</WillShowUI></ProductKey></UserData>`,
)}
</settings>
<settings pass="specialize">
${component('Microsoft-Windows-Shell-Setup', `<ComputerName>WINDOWS</ComputerName>`)}
</settings>
<settings pass="oobeSystem">
${component('Microsoft-Windows-International-Core', locales)}
${component(
  'Microsoft-Windows-Shell-Setup',
  `<OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC></OOBE>
<UserAccounts><LocalAccounts><LocalAccount wcm:action="add"><Name>${user}</Name><DisplayName>${xml(fullName)}</DisplayName><Group>Administrators</Group><Password><Value></Value><PlainText>true</PlainText></Password></LocalAccount></LocalAccounts></UserAccounts>
<AutoLogon><Enabled>true</Enabled><Username>${user}</Username><Password><Value></Value><PlainText>true</PlainText></Password><LogonCount>1</LogonCount></AutoLogon>
<FirstLogonCommands>
<SynchronousCommand wcm:action="add"><Order>1</Order><CommandLine>cmd /c "mode COM1: baud=115200 &amp; echo ${WINDOWS_READY} &gt; COM1"</CommandLine></SynchronousCommand>
</FirstLogonCommands>`,
)}
</settings>
</unattend>
`;
}

/** Get Windows Setup ready to run by itself: its answer file in `dir`/seed, for a FAT drive beside its disc. */
export async function prepareWindows(iso: string, dir: string): Promise<InstallBoot> {
  const seedDir = path.join(dir, 'seed');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(seedDir, { recursive: true });
  await fsp.writeFile(path.join(seedDir, 'autounattend.xml'), windowsAnswerFile(windowsCulture(iso)));
  return { seedDir, seedLabel: 'WINSETUP' };
}
