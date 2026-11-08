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
// an autounattend.xml on that drive.
//
// macOS is Apple's Internet Recovery, asked for the newest release as a Mac
// asks for it and checked against the chunklist Apple signs, started by
// OpenCore (acidanthera's boot loader, from its GitHub releases). Recovery
// has no answer file: electron/vms.mts opens its Terminal and types one
// command, which runs the script on the FAT drive. Runs as TypeScript
// directly via Node's native type stripping - erasable syntax only.

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, net, session } from 'electron';
import { unzipSync } from 'fflate';
import type { VmInstallerId } from '../src/lib/vms.ts';

export const INSTALLERS_DIR = path.join(os.homedir(), 'VMs', '.installers');

export interface InstallerFile {
  /** What it's kept as in INSTALLERS_DIR. */
  name: string;
  /** Where to get it now (Windows' and Apple's links are signed and expire, so it's asked each time). */
  url: () => Promise<string | { url: string; headers: Record<string, string> }>;
  /** What it's checked against; null for a file `verify` checks instead. */
  sha256: string | null;
  size: number | null;
  /** Check the downloaded file some other way, throwing when it's wrong. */
  verify?: (file: string, onProgress: (checked: number, total: number) => void) => Promise<void>;
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
  /** The hardware it gets: Windows 11's needs, a Mac's, or virtio for Linux. */
  hardware: { os: 'windows' | 'macos' | 'linux'; diskGiB: number; minMemoryMiB: number; secureBoot: boolean; tpm: boolean };
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

// ---------------------------------------------------------------------------
// macOS, from Apple's Internet Recovery
// ---------------------------------------------------------------------------

const RECOVERY = 'http://osrecovery.apple.com/';
const RECOVERY_AGENT = 'InternetRecovery/1.0';
/** iMac20,1's board, the last Intel Mac's: Apple gives it the newest macOS that runs on Intel. */
export const MACOS_BOARD = 'Mac-CFF7D910A743CAAF';
export const MACOS_MODEL = 'iMac20,1';
/**
 * 1280×800, drawn at 1×. macOS has no driver for QEMU's VGA, so it draws
 * everything on the CPU; at 2560×1600, where it chose twice the scale for
 * the same 1280×800 points, that was four times the pixels, and a click in
 * Setup Assistant took about 2 s to show instead of 0.3 s.
 */
export const MACOS_SCREEN = { width: 1280, height: 800 };

/** Apple's key for the chunklists that come with recovery images (the EFI ROM's). */
const CHUNKLIST_KEY = createPublicKey({
  key: {
    kty: 'RSA',
    e: 'AQAB',
    n: Buffer.from(
      'C3E748CAD9CD384329E10E25A91E43E1A762FF529ADE578C935BDDF9B13F2179D4855E6FC89E9E29CA12517D17DFA1EDCE0BEBF0EA7B461FFE61D94E2BDF72C196F89ACD3536B644064014DAE25A15DB6BB0852ECBD120916318D1CCDEA3C84C92ED743FC176D0BACA920D3FCF3158AFF731F88CE0623182A8ED67E650515F75745909F07D415F55FC15A35654D118C55A462D37A3ACDA08612F3F3F6571761EFCCBCC299AEE99B3A4FD6212CCFFF5EF37A2C334E871191F7E1C31960E010A54E86FA3F62E6D6905E1CD57732410A3EB0C6B4DEFDABE9F59BF1618758C751CD56CEF851D1C0EAA1C558E37AC108DA9089863D20E2E7E4BF475EC66FE6B3EFDCF',
      'hex',
    ).toString('base64url'),
  },
  format: 'jwk',
});

/** A recovery image's chunks, from its chunklist, once Apple's signature on it checks out. */
function readChunklist(list: Buffer): { size: number; sha256: Buffer }[] {
  const bad = () => new Error('Apple’s chunklist for macOS didn’t check out.');
  if (list.length < 0x24 || list.toString('latin1', 0, 4) !== 'CNKL') throw bad();
  const count = Number(list.readBigUInt64LE(12));
  const signatureAt = Number(list.readBigUInt64LE(28));
  // Version 1, SHA-256 chunks, an RSA signature (method 2 is unsigned, and turned away).
  if (list.readUInt32LE(4) !== 0x24 || list[8] !== 1 || list[9] !== 1 || list[10] !== 1) throw bad();
  if (Number(list.readBigUInt64LE(20)) !== 0x24 || signatureAt !== 0x24 + 0x24 * count || list.length !== signatureAt + 256) throw bad();
  // PKCS#1 v1.5 over SHA-256, stored little-endian.
  const signature = Buffer.from(list.subarray(signatureAt)).reverse();
  if (!verifySignature('sha256', list.subarray(0, signatureAt), CHUNKLIST_KEY, signature)) throw bad();
  return Array.from({ length: count }, (_, i) => {
    const at = 0x24 + 0x24 * i;
    return { size: list.readUInt32LE(at), sha256: list.subarray(at + 4, at + 36) };
  });
}

/** Check a recovery image chunk by chunk against its chunklist. */
async function checkChunks(file: string, chunks: { size: number; sha256: Buffer }[], onProgress: (checked: number, total: number) => void): Promise<void> {
  const total = chunks.reduce((n, c) => n + c.size, 0);
  const handle = await fsp.open(file, 'r');
  try {
    if ((await handle.stat()).size !== total) throw new Error('The macOS download isn’t the size Apple signed.');
    let at = 0;
    for (const chunk of chunks) {
      const data = await readAt(handle, at, chunk.size);
      if (data.length !== chunk.size || !createHash('sha256').update(data).digest().equals(chunk.sha256)) {
        throw new Error('The macOS download didn’t match what Apple signed, so it was thrown away.');
      }
      at += chunk.size;
      onProgress(at, total);
    }
  } finally {
    await handle.close();
  }
}

interface RecoveryImage {
  /** Apple's product number for the release ("140-93589"). */
  product: string;
  image: { url: string; token: string };
  chunklist: { url: string; token: string };
}

/** Ask Apple's recovery server for the newest recovery image, as a Mac in Internet Recovery does. */
async function recoveryImage(): Promise<RecoveryImage> {
  const ses = session.fromPartition('din-vm-downloads');
  const hello = await ses.fetch(RECOVERY, { headers: { 'user-agent': RECOVERY_AGENT }, signal: AbortSignal.timeout(30_000) });
  const cookie = /session=[^;]+/.exec(hello.headers.get('set-cookie') ?? '')?.[0];
  if (!cookie) throw new Error('Apple’s recovery server didn’t answer.');
  const id = (length: number) => randomBytes(length / 2).toString('hex').toUpperCase();
  const response = await ses.fetch(`${RECOVERY}InstallationPayload/RecoveryImage`, {
    method: 'POST',
    headers: { 'user-agent': RECOVERY_AGENT, cookie, 'content-type': 'text/plain' },
    // A serial number of zeros, which gets the board's newest release.
    body: [`cid=${id(16)}`, 'sn=00000000000000000', `bid=${MACOS_BOARD}`, `k=${id(64)}`, `fg=${id(64)}`, 'os=latest'].join('\n'),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Apple’s recovery server answered ${response.status}.`);
  const fields = new Map((await response.text()).split('\n').map((line) => line.split(': ') as [string, string]));
  const [product, imageUrl, imageToken, listUrl, listToken] = ['AP', 'AU', 'AT', 'CU', 'CT'].map((k) => fields.get(k)?.trim());
  if (!product || !imageUrl || !imageToken || !listUrl || !listToken) throw new Error('Apple’s recovery server didn’t offer macOS.');
  return { product, image: { url: imageUrl, token: imageToken }, chunklist: { url: listUrl, token: listToken } };
}

const recoveryRequest = (asset: { url: string; token: string }) => ({
  url: asset.url,
  headers: { 'user-agent': RECOVERY_AGENT, cookie: `AssetToken=${asset.token}` },
});

async function resolveMacos(): Promise<Release> {
  let fresh: RecoveryImage | null = await recoveryImage();
  const { product } = fresh;
  const listResponse = await net.fetch(fresh.chunklist.url, { ...recoveryRequest(fresh.chunklist), signal: AbortSignal.timeout(30_000) });
  if (!listResponse.ok) throw new Error(`Apple’s download server answered ${listResponse.status}.`);
  const chunks = readChunklist(Buffer.from(await listResponse.arrayBuffer()));
  return {
    label: 'macOS',
    file: {
      name: `macOS-Recovery-${product}.dmg`,
      // Its links expire within the hour: a download that's resumed later asks again.
      url: async () => {
        const image = fresh ?? (await recoveryImage());
        fresh = null;
        if (image.product !== product) throw new Error('Apple has released a newer macOS since this download began. Try again.');
        return recoveryRequest(image.image);
      },
      sha256: null,
      size: chunks.reduce((n, c) => n + c.size, 0),
      verify: (file, onProgress) => checkChunks(file, chunks, onProgress),
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
  macos: {
    name: 'macOS',
    // Apple offers recovery images only to Macs (and this).
    manualUrl: '',
    // The full installer, which Recovery downloads onto the disk, and then the system.
    installedBytes: 40 * GiB,
    hardware: { os: 'macos', diskGiB: 128, minMemoryMiB: 4096, secureBoot: false, tpm: false },
    resolve: resolveMacos,
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
  if (have && file.sha256) {
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
      const where = await file.url();
      const { url, headers } = typeof where === 'string' ? { url: where, headers: {} } : where;
      const response = await net.fetch(url, { headers: have ? { ...headers, range: `bytes=${have}-` } : headers, signal });
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
          if (file.sha256) hash.update(value);
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
  if (file.verify) {
    try {
      await file.verify(part, (checked, of) => onProgress('verifying', checked, of));
    } catch (error) {
      await fsp.rm(part, { force: true });
      throw error;
    }
  } else if (hash.digest('hex') !== file.sha256) {
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
  /** macOS's recovery image, shown as a disk (QEMU reads Apple's .dmg itself). */
  disk?: string;
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

// ---------------------------------------------------------------------------
// macOS: OpenCore, and the script Recovery runs
// ---------------------------------------------------------------------------

type Plist = string | number | boolean | Buffer | Plist[] | { [key: string]: Plist };
type PlistDict = { [key: string]: Plist };

const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** An XML property list's value: what OpenCore's sample config needs (no dates or reals). */
function parsePlist(text: string): Plist {
  const tokens = text.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)(\w+)(\/?)>([^<]*)/g);
  const next = () => {
    const t = tokens.next();
    if (t.done) throw new Error('OpenCore’s sample config ended early.');
    return { close: t.value[1] === '/', tag: t.value[2], empty: t.value[3] === '/', text: t.value[4] };
  };
  const value = (open: ReturnType<typeof next>): Plist => {
    const leaf = () => {
      if (open.empty) return '';
      const text = open.text;
      next();
      return xmlText(text);
    };
    switch (open.tag) {
      case 'dict': {
        const dict: PlistDict = {};
        if (open.empty) return dict;
        for (let t = next(); !t.close; t = next()) {
          const key = xmlText(t.text);
          next();
          dict[key] = value(next());
        }
        return dict;
      }
      case 'array': {
        const array: Plist[] = [];
        if (open.empty) return array;
        for (let t = next(); !t.close; t = next()) array.push(value(t));
        return array;
      }
      case 'string':
        return leaf();
      case 'integer':
        return Number(leaf());
      case 'data':
        return Buffer.from(leaf().replace(/\s+/g, ''), 'base64');
      case 'true':
      case 'false':
        return open.tag === 'true';
      default:
        throw new Error(`OpenCore’s sample config has a <${open.tag}>.`);
    }
  };
  return value(next());
}

function writePlist(root: Plist): string {
  const write = (v: Plist, indent: string): string => {
    if (typeof v === 'string') return `<string>${xml(v)}</string>`;
    if (typeof v === 'number') return `<integer>${v}</integer>`;
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>';
    if (Buffer.isBuffer(v)) return `<data>${v.toString('base64')}</data>`;
    const inner = `${indent}\t`;
    if (Array.isArray(v)) return v.length ? `<array>\n${v.map((x) => inner + write(x, inner)).join('\n')}\n${indent}</array>` : '<array/>';
    const entries = Object.entries(v);
    return entries.length ? `<dict>\n${entries.map(([k, x]) => `${inner}<key>${xml(k)}</key>\n${inner}${write(x, inner)}`).join('\n')}\n${indent}</dict>` : '<dict/>';
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${write(root, '')}
</plist>
`;
}

const OPENCORE_DRIVERS = ['OpenRuntime.efi', 'OpenHfsPlus.efi'];

/** A random serial number in Apple's form, for the machine's own SMBIOS. */
const serial = (length: number) => Array.from(randomBytes(length), (b) => '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 34]).join('');

/**
 * OpenCore's sample config, made for a virtual machine: no kexts or ACPI
 * tables (QEMU's applesmc is the SMC, and nothing else is missing), Apple
 * Secure Boot off, the machine's own iMac20,1 identity, and only internal
 * disks to start from, so the drive OpenCore itself is on isn't offered.
 */
function openCoreConfig(sample: string, uuid: string): string {
  const config = parsePlist(sample) as Record<string, PlistDict>;
  for (const key of Object.keys(config)) if (key.startsWith('#')) delete config[key];
  const { ACPI, Booter, DeviceProperties, Kernel, Misc, NVRAM, PlatformInfo, UEFI } = config;
  const dict = (v: Plist) => v as PlistDict;
  ACPI.Add = [];
  ACPI.Patch = [];
  Object.assign(dict(ACPI.Quirks), { ResetLogoStatus: false });
  Object.assign(dict(Booter.Quirks), { EnableSafeModeSlide: false, FixupAppleEfiImages: false, ProvideCustomSlide: false, ResizeAppleGpuBars: 0, SetupVirtualMap: false });
  DeviceProperties.Add = {};
  Kernel.Add = [];
  Kernel.Block = [];
  Kernel.Force = [];
  Kernel.Patch = [];
  Object.assign(dict(Kernel.Emulate), { DummyPowerManagement: true });
  // ThirdPartyDrives: TRIM on QEMU's disk, which says it's an SSD, so what macOS deletes leaves the disk file.
  Object.assign(dict(Kernel.Quirks), { ProvideCurrentCpuInfo: true, ThirdPartyDrives: true });
  Object.assign(dict(Misc.Boot), { HideAuxiliary: true, PickerMode: 'Builtin', PollAppleHotKeys: true, ShowPicker: false });
  Object.assign(dict(Misc.Debug), { Target: 0 });
  // Locked to APFS and HFS+ on SATA, NVMe and PCI disks.
  Object.assign(dict(Misc.Security), { AllowSetDefault: true, ScanPolicy: 0x1090303, SecureBootModel: 'Disabled', Vault: 'Optional' });
  Misc.Entries = [];
  Misc.Tools = [];
  Object.assign(dict(dict(NVRAM.Add)['7C436110-AB2A-4BBB-A880-FE41995C9F82']), { 'boot-args': 'keepsyms=1', 'prev-lang:kbd': Buffer.from('en-US:0') });
  Object.assign(dict(PlatformInfo.Generic), {
    SystemProductName: MACOS_MODEL,
    SystemSerialNumber: `C02${serial(9)}`,
    MLB: `C02${serial(14)}`,
    SystemUUID: uuid.toUpperCase(),
    ROM: randomBytes(6),
  });
  Object.assign(dict(UEFI.APFS), { MinDate: -1, MinVersion: -1 });
  UEFI.Drivers = OPENCORE_DRIVERS.map((Path) => ({ Arguments: '', Comment: Path, Enabled: true, LoadEarly: false, Path }));
  // The screen QEMU's VGA offers (vms.mts), which macOS keeps: it has no driver to change it.
  Object.assign(dict(UEFI.Output), { Resolution: MACOS_RESOLUTION });
  // New OVMF's security policy refuses OpenCore's drivers.
  Object.assign(dict(UEFI.Quirks), { DisableSecurityPolicy: true });
  return writePlist(config);
}

interface GithubRelease {
  tag_name: string;
  assets: { name: string; browser_download_url: string; digest?: string | null; size: number }[];
}

/** OpenCore's newest release, checked against the SHA-256 GitHub lists for it. */
async function openCoreRelease(): Promise<InstallerFile> {
  const release = JSON.parse(await get('https://api.github.com/repos/acidanthera/OpenCorePkg/releases/latest')) as GithubRelease;
  const asset = release.assets.find((a) => /^OpenCore-[\d.]+-RELEASE\.zip$/.test(a.name));
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest ?? '')?.[1];
  if (!asset || !sha256) throw new Error('OpenCore’s newest release has nothing Din can check.');
  return { name: asset.name, url: async () => asset.browser_download_url, sha256, size: asset.size };
}

const openCoreBoot = (dir: string) => path.join(dir, 'EFI', 'OC', 'OpenCore.efi');

export const openCoreReady = (dir: string) => fs.existsSync(openCoreBoot(dir));

const MACOS_RESOLUTION = `${MACOS_SCREEN.width}x${MACOS_SCREEN.height}@32`;

/**
 * Bring an existing boot loader's screen to `MACOS_SCREEN`, for machines
 * made when it was another size (QEMU's VGA offers the new one, and OpenCore
 * would still pick the old).
 */
export async function syncOpenCoreScreen(dir: string): Promise<void> {
  const file = path.join(dir, 'EFI', 'OC', 'config.plist');
  const config = parsePlist(await fsp.readFile(file, 'utf8')) as Record<string, PlistDict>;
  const output = config.UEFI?.Output as PlistDict | undefined;
  if (!output || output.Resolution === MACOS_RESOLUTION) return;
  output.Resolution = MACOS_RESOLUTION;
  await fsp.writeFile(`${file}.tmp`, writePlist(config));
  await fsp.rename(`${file}.tmp`, file);
}

/**
 * The machine's boot loader in `dir`, a folder QEMU shows it as a FAT drive:
 * OpenCore's newest release, with a config for this machine (`uuid` is its
 * SMBIOS UUID, and its serial numbers are made up once, here).
 */
export async function prepareOpenCore(dir: string, uuid: string, signal: AbortSignal): Promise<void> {
  const zip = await download(await openCoreRelease(), () => {}, signal);
  const wanted = new Map([
    ['X64/EFI/BOOT/BOOTx64.efi', 'EFI/BOOT/BOOTx64.efi'],
    ['X64/EFI/OC/OpenCore.efi', 'EFI/OC/OpenCore.efi'],
    ...OPENCORE_DRIVERS.map((d) => [`X64/EFI/OC/Drivers/${d}`, `EFI/OC/Drivers/${d}`] as [string, string]),
    ['Docs/Sample.plist', ''],
  ]);
  const files = unzipSync(await fsp.readFile(zip), { filter: (f) => wanted.has(f.name) });
  if (Object.keys(files).length !== wanted.size) throw new Error('OpenCore’s release isn’t laid out as Din expected.');
  const tmp = `${dir}.tmp`;
  await fsp.rm(tmp, { recursive: true, force: true });
  for (const [from, to] of wanted) {
    if (!to) continue;
    await fsp.mkdir(path.dirname(path.join(tmp, to)), { recursive: true });
    await fsp.writeFile(path.join(tmp, to), files[from]);
  }
  await fsp.writeFile(path.join(tmp, 'EFI', 'OC', 'config.plist'), openCoreConfig(Buffer.from(files['Docs/Sample.plist']).toString('utf8'), uuid));
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rename(tmp, dir);
}

/** What the script in Recovery says on the first serial port. */
export const MACOS_STARTED = 'DIN-MACOS-STARTED';
export const MACOS_FAILED = 'DIN-MACOS-FAILED';
/**
 * The commands vms.mts types into Recovery's Terminal (letters, digits,
 * spaces, slashes, dots and dashes alone). Recovery doesn't always mount
 * the answer drive by itself (started from a USB drive, it didn't).
 */
export const MACOS_COMMAND = 'diskutil mount DINSETUP\nsh /Volumes/DINSETUP/install.sh';

/**
 * Run in Recovery: erase the machine's disk (the biggest internal one) and
 * have Apple's installer download and install macOS onto it, agreeing to
 * Apple's licence as autounattend.xml does Microsoft's. The installer
 * restarts the machine to go on, and ends at Setup Assistant, where Din
 * takes over again with macosFinishScript.
 */
function macosInstallScript(): string {
  return `#!/bin/sh
# Din's hands-free install of macOS, run in Recovery's Terminal.
mkdir /tmp/din-install 2>/dev/null || exit 0
# The serial port can be slow to open: it mustn't hold the install up.
say() { echo "$*"; ( echo "$*" > /dev/cu.serial1 ) 2>/dev/null & }
say ${MACOS_STARTED}
target= best=0
for d in $(diskutil list internal physical | awk '/^\\/dev\\/disk/ {print $1}'); do
  size=$(diskutil info -plist "$d" | plutil -extract TotalSize raw -o - -)
  if [ "$size" -gt "$best" ]; then best=$size target=$d; fi
done
[ -n "$target" ] || { say ${MACOS_FAILED} "There’s no disk to install macOS on."; exit 1; }
diskutil eraseDisk APFS "Macintosh HD" GPT "$target" || { say ${MACOS_FAILED} "The disk couldn’t be erased."; exit 1; }
for app in /Install\\ macOS*.app; do
  "$app/Contents/Resources/startosinstall" --agreetolicense --volume "/Volumes/Macintosh HD" --nointeraction 2>&1 | while read -r line; do say "DIN-MACOS-LOG $line"; done
done
# Done well, it's restarting the machine by now.
sleep 120
say ${MACOS_FAILED} "Apple’s installer stopped."
`;
}

/** What the finishing script in Recovery says on the first serial port. */
export const MACOS_FINISHING = 'DIN-MACOS-FINISHING';
export const MACOS_FINISHED = 'DIN-MACOS-FINISHED';
export const MACOS_FINISH_COMMAND = 'diskutil mount DINSETUP\nsh /Volumes/DINSETUP/finish.sh';

/**
 * Run in Recovery once Apple's installer has put macOS on the disk and
 * Setup Assistant is waiting, in its place: an administrator account named
 * for this computer's user with no password, which macOS logs into by
 * itself (as Windows' and Linux's are), this computer's time zone and
 * region, and Setup Assistant marked done, its screens for the account
 * answered. Setup Assistant draws its blurred, animated screens on the CPU
 * (macOS has no driver for QEMU's display), and a click there took seconds.
 * Then it turns the machine off, and vms.mts starts macOS.
 *
 * Also, for a machine with no GPU: Reduce Transparency on, so macOS doesn't
 * blur what's behind its menus and windows every frame; never asleep (a
 * sleeping machine looks frozen, and its disk doesn't come back from it);
 * and QEMU's USB keyboard known as an ANSI one, so Keyboard Setup Assistant
 * doesn't ask.
 */
function macosFinishScript(): string {
  const { username, fullName } = account();
  const { lang, timezone } = locale();
  const appleLocale = lang.replace(/\..*$/, '');
  const country = appleLocale.split('_')[1] ?? 'US';
  const tz = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone) ? timezone : 'UTC';
  return `#!/bin/sh
# Din's hands-free end to macOS's setup, run in Recovery's Terminal.
say() { echo "$*"; ( echo "$*" > /dev/cu.serial1 ) 2>/dev/null & }
fail() { say "${MACOS_FAILED} $*"; exit 1; }
U='${username}'
NAME='${fullName}'
say ${MACOS_FINISHING}

# The installed system's volumes, mounted (Recovery mounts them, not always both).
volume() {
  for dev in $(diskutil apfs list | sed -n "s/.*Volume Disk (Role):[^d]*\\(disk[0-9s]*\\) ($1).*/\\1/p"); do
    diskutil mount "$dev" >/dev/null 2>&1
    mp=$(diskutil info -plist "$dev" | plutil -extract MountPoint raw -o - - 2>/dev/null)
    [ -d "$mp/$2" ] && { echo "$mp"; return; }
  done
}
data=$(volume Data private/var/db/dslocal/nodes/Default)
system=$(volume System "System/Library/User Template")
[ -n "$data" ] && [ -n "$system" ] || fail "There’s no macOS on the disk to finish setting up."
info="$system/System/Library/CoreServices/SystemVersion.plist"
version=$(plutil -extract ProductVersion raw -o - "$info")
build=$(plutil -extract ProductBuildVersion raw -o - "$info")

plist() { # a file, then its dictionary's XML
  printf '<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\\n<plist version="1.0">\\n<dict>\\n%s\\n</dict>\\n</plist>\\n' "$2" > "$1"
}

# The account.
node="$data/private/var/db/dslocal/nodes/Default"
user="/Local/Default/Users/$U"
if ! dscl -f "$node" localhost -read "$user" >/dev/null 2>&1; then
  dscl -f "$node" localhost -create "$user" || fail "The account couldn’t be made."
  dscl -f "$node" localhost -create "$user" RealName "$NAME"
  dscl -f "$node" localhost -create "$user" UniqueID 501
  dscl -f "$node" localhost -create "$user" PrimaryGroupID 20
  dscl -f "$node" localhost -create "$user" UserShell /bin/zsh
  dscl -f "$node" localhost -create "$user" NFSHomeDirectory "/Users/$U"
  dscl -f "$node" localhost -passwd "$user" '' || fail "The account couldn’t be given its password."
  dscl -f "$node" localhost -append /Local/Default/Groups/admin GroupMembership "$U"
  guid=$(dscl -f "$node" localhost -read "$user" GeneratedUID | awk '{print $2}')
  [ -n "$guid" ] && dscl -f "$node" localhost -append /Local/Default/Groups/admin GroupMembers "$guid"
fi
home="$data/Users/$U"
if [ ! -d "$home" ]; then
  mkdir -p "$home"
  ditto "$system/System/Library/User Template/Non_localized" "$home"
  ditto "$system/System/Library/User Template/English.lproj" "$home"
fi
mkdir -p "$home/Library/Preferences"
seen=
for k in DidSeeAccessibility DidSeeActivationLock DidSeeAppearanceSetup DidSeeApplePaySetup DidSeeAvatarSetup \\
  DidSeeCloudSetup DidSeeiCloudLoginForStorageServices DidSeeIntelligence DidSeeLockdownMode DidSeePrivacy \\
  DidSeeScreenTime DidSeeSiriSetup DidSeeSyncSetup DidSeeSyncSetup2 DidSeeTermsOfAddress DidSeeTouchIDSetup \\
  DidSeeTrueTone DidSeeTrueTonePrivacy DidSeeUpdateSetup DidSeeWallpaper SkipFirstLoginOptimization; do
  seen="$seen<key>$k</key><true/>"
done
for k in LastSeenCloudProductVersion LastSeenDiagnosticsProductVersion LastSeenSiriProductVersion \\
  LastSeenIntelligenceProductVersion LastSeenAgeRangeSelectionProductVersion LastPreLoginTasksPerformedVersion; do
  seen="$seen<key>$k</key><string>$version</string>"
done
seen="$seen<key>LastSeenBuddyBuildVersion</key><string>$build</string><key>LastPreLoginTasksPerformedBuild</key><string>$build</string>"
seen="$seen<key>LastPrivacyBundleVersion</key><integer>2</integer><key>InitialAccountOnMac</key><false/>"
plist "$home/Library/Preferences/com.apple.SetupAssistant.plist" "$seen"
plist "$home/Library/Preferences/com.apple.universalaccess.plist" '<key>reduceTransparency</key><true/>'
plist "$home/Library/Preferences/.GlobalPreferences.plist" '<key>AppleLocale</key><string>${appleLocale}</string><key>Country</key><string>${country}</string>'
chown -R 501:20 "$home"

# Setup Assistant done. The licence was agreed to for Apple's installer
# (--agreetolicense), so its cookie asking to show it again goes, as Setup
# Assistant removes it once it's agreed to.
touch "$data/private/var/db/.AppleSetupDone" "$data/private/var/db/.AppleDiagnosticsSetupDone"
rm -f "$data/private/var/db/.AppleSetupTermsOfService" "$data/private/var/db/.RunLanguageChooserToo"

# Logged into by itself: the empty password, obfuscated as loginwindow
# wants it (XORed with its key, padded to a multiple of 12 bytes).
plist "$data/Library/Preferences/com.apple.loginwindow.plist" "<key>autoLoginUser</key><string>$U</string>"
printf '\\175\\211\\122\\043\\322\\274\\335\\352\\243\\271\\037\\175' > "$data/private/etc/kcpassword"
chmod 600 "$data/private/etc/kcpassword"
mkdir -p "$data/private/etc/sudoers.d"
echo "$U ALL=(ALL) NOPASSWD: ALL" > "$data/private/etc/sudoers.d/90-din"
chmod 440 "$data/private/etc/sudoers.d/90-din"

plist "$data/Library/Preferences/com.apple.PowerManagement.plist" '<key>AC Power</key><dict><key>System Sleep Timer</key><integer>0</integer><key>Display Sleep Timer</key><integer>0</integer><key>Disk Sleep Timer</key><integer>0</integer><key>Automatic Restart On Power Loss</key><integer>0</integer></dict>'
plist "$data/Library/Preferences/com.apple.keyboardtype.plist" '<key>keyboardtype</key><dict><key>1-1575-0</key><integer>40</integer></dict>'
ln -sf "/var/db/timezone/zoneinfo/${tz}" "$data/private/etc/localtime"
g="$data/Library/Preferences/.GlobalPreferences.plist"
/usr/libexec/PlistBuddy -c "Delete :AppleLocale" "$g" >/dev/null 2>&1
/usr/libexec/PlistBuddy -c "Delete :Country" "$g" >/dev/null 2>&1
/usr/libexec/PlistBuddy -c "Add :AppleLocale string ${appleLocale}" -c "Add :Country string ${country}" "$g"

say ${MACOS_FINISHED}
sync
shutdown -h now
`;
}

/** Get macOS ready to install by itself: its recovery image, and the scripts in `dir`/seed. */
export async function prepareMacos(image: string, dir: string): Promise<InstallBoot> {
  const seedDir = path.join(dir, 'seed');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(seedDir, { recursive: true });
  await fsp.writeFile(path.join(seedDir, 'install.sh'), macosInstallScript());
  await fsp.writeFile(path.join(seedDir, 'finish.sh'), macosFinishScript());
  return { seedDir, seedLabel: 'DINSETUP', disk: image };
}

/** OpenCore's ScanPolicy: APFS and HFS+ volumes on USB devices alone. */
const SCAN_USB_ONLY = 0x200303;

/**
 * A copy of the machine's boot loader in `dst` that sees only USB drives,
 * so it starts the recovery image vms.mts plugs in as one, by itself,
 * instead of the macOS now on the disk.
 */
export async function prepareRecoveryOpenCore(src: string, dst: string): Promise<void> {
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.cp(src, dst, { recursive: true });
  const file = path.join(dst, 'EFI', 'OC', 'config.plist');
  const config = parsePlist(await fsp.readFile(file, 'utf8')) as Record<string, PlistDict>;
  const misc = config.Misc as PlistDict;
  Object.assign(misc.Security as PlistDict, { ScanPolicy: SCAN_USB_ONLY });
  Object.assign(misc.Boot as PlistDict, { HideAuxiliary: false, ShowPicker: false });
  await fsp.writeFile(file, writePlist(config));
}
