/**
 * The Chrome Web Store in the Web Browser: its Add to Chrome button
 * (chrome.webstorePrivate, from chrome-web-store-preload.cjs), the
 * extensions it installed, loaded at startup from Extensions/<id>/, and
 * their updates. Din's own copy of electron-chrome-web-store 0.13.0 by Samuel
 * Maddock (MIT, see chrome-extensions.mts for the notice), changed where it
 * trusted too much:
 *
 *   - Only the store's own top document is answered: its exact origin, not a
 *     host that starts with it (chromewebstore.google.com.<anything>), as
 *     upstream's prefix check allowed.
 *   - What's installed is what Google's update server sends, checked
 *     (every signature, and the id) and shown to the user from its own
 *     manifest, by browser-extensions.mts's unpackCrx, the same as a .crx or
 *     Nostr install: never the manifest the page claims. Updates go through
 *     it too, so one that wants more asks first.
 *   - Removing one from the store asks first, and only reaches what the
 *     store installed.
 *   - Main fetches nothing the page names (upstream fetched its icon URL).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { app, ipcMain, powerMonitor } from 'electron'
import { readCrx } from './crx.mts'
import { debug } from './chrome-extensions-debug.mts'

const d = debug('webstore')

export const WEB_STORE_ORIGIN = 'https://chromewebstore.google.com'

const EXTENSION_ID = /^[a-p]{32}$/

/** The biggest package worth downloading. */
const MAX_CRX_BYTES = 256 * 1024 * 1024

const ExtensionInstallStatus = {
  BLOCKED_BY_POLICY: 'blocked_by_policy',
  DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version',
  ENABLED: 'enabled',
  INSTALLABLE: 'installable',
}

const MV2DeprecationStatus = { INACTIVE: 'inactive', SOFT_DISABLE: 'soft_disable' }

const Result = {
  ALREADY_INSTALLED: 'already_installed',
  INSTALL_ERROR: 'install_error',
  INSTALL_IN_PROGRESS: 'install_in_progress',
  INVALID_ID: 'invalid_id',
  MANIFEST_ERROR: 'manifest_error',
  SUCCESS: 'success',
  UNKNOWN_ERROR: 'unknown_error',
  USER_CANCELLED: 'user_cancelled',
}

const WebGlStatus = { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' }

export interface WebStoreOptions {
  session: Electron.Session
  /** Where the store's installs live, each in <id>/. */
  extensionsPath: string
  /** The oldest manifest version installed (2: uBlock Origin and the like still need it). */
  minimumManifestVersion: number
  /**
   * Check a package, ask the user (comparing with `previous`, an install
   * being updated), and unpack it at `dest`; its id.
   * browser-extensions.mts's unpackCrx; it throws if the user says no.
   */
  unpackCrx: (data: Buffer, dest: string, fallbackName: string, previous?: string) => Promise<string>
  /** Ask the user to remove an extension the store asks to remove. */
  confirmRemove: (name: string) => Promise<boolean>
}

/** Where an install's files go: one copy per extension. */
const installDir = (options: WebStoreOptions, id: string) => path.join(options.extensionsPath, id, 'current')

/** Whether an extension was installed by the store (it lives in Extensions/). */
function isStoreInstall(options: WebStoreOptions, extension: Electron.Extension) {
  const relative = path.relative(options.extensionsPath, extension.path)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Take a store install off the session and out of Extensions/. */
export async function removeWebStoreInstall(session: Electron.Session, extensionsPath: string, id: string) {
  if (!EXTENSION_ID.test(id)) throw new Error('Invalid extension id')
  if (session.extensions.getExtension(id)) session.extensions.removeExtension(id)
  await fs.rm(path.join(extensionsPath, id), { recursive: true, force: true })
}

/** What chrome.management tells the store about an extension. */
function extensionInfo(ext: Electron.Extension) {
  const manifest = ext.manifest as chrome.runtime.Manifest
  return {
    description: manifest.description || '',
    enabled: true,
    homepageUrl: manifest.homepage_url || '',
    hostPermissions: (manifest as { host_permissions?: string[] }).host_permissions || [],
    icons: [],
    id: ext.id,
    installType: 'normal',
    isApp: false,
    mayDisable: true,
    name: manifest.name,
    offlineEnabled: !!manifest.offline_enabled,
    optionsUrl: manifest.options_page ? `chrome-extension://${ext.id}/${manifest.options_page}` : '',
    permissions: manifest.permissions || [],
    shortName: manifest.short_name || manifest.name,
    type: 'extension',
    updateUrl: manifest.update_url || '',
    version: manifest.version,
  }
}

/** Google's address for an extension's newest package. */
function crxUrl(extensionId: string) {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.append('response', 'redirect')
  url.searchParams.append('acceptformat', 'crx3')
  url.searchParams.append('x', new URLSearchParams({ id: extensionId, uc: '' }).toString())
  url.searchParams.append('prodversion', process.versions.chrome)
  return url.href
}

/** Download a package, over https only, no bigger than MAX_CRX_BYTES. */
async function download(url: string): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new Error('Packages come over https only')
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.url.startsWith('https://')) throw new Error('The extension couldn’t be downloaded')
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_CRX_BYTES) throw new Error('The extension is too big')
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length > MAX_CRX_BYTES) throw new Error('The extension is too big')
  return data
}

/** A package's id, checked: it must be the one asked for. */
function checkedId(data: Buffer, expected: string) {
  const { id } = readCrx(data)
  if (id !== expected) throw new Error(`The package is ${id}, not ${expected}`)
  return id
}

async function load(session: Electron.Session, dir: string) {
  const extension = await session.extensions.loadExtension(dir)
  const manifest = extension.manifest as chrome.runtime.ManifestV3
  if (manifest.manifest_version === 3 && manifest.background?.service_worker) {
    await session.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`).catch(() => {
      console.error(`Failed to start worker for extension ${extension.id}`)
    })
  }
  return extension
}

/** The newest copy of each extension in Extensions/ (dirs with a manifest, at most two deep). */
async function discover(extensionsPath: string): Promise<{ dir: string; manifest: chrome.runtime.Manifest }[]> {
  const found: { dir: string; manifest: chrome.runtime.Manifest }[] = []
  const search = async (dir: string, depth: number) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sub = path.join(dir, entry.name)
      const text = await fs.readFile(path.join(sub, 'manifest.json'), 'utf8').catch(() => null)
      if (text !== null) {
        try {
          found.push({ dir: sub, manifest: JSON.parse(text.replace(/^\uFEFF/, '')) as chrome.runtime.Manifest })
        } catch {
          console.error(`Unreadable manifest in ${sub}`)
        }
      } else if (depth < 1) {
        await search(sub, depth + 1)
      }
    }
  }
  await search(extensionsPath, 0)
  // One per <id>/ folder: the newest version.
  const newest = new Map<string, { dir: string; manifest: chrome.runtime.Manifest }>()
  for (const item of found) {
    const key = path.relative(extensionsPath, item.dir).split(path.sep)[0]
    const had = newest.get(key)
    if (!had || compareVersions(had.manifest.version, item.manifest.version) < 0) newest.set(key, item)
  }
  return [...newest.values()]
}

export function compareVersions(a: string, b: string) {
  const v1 = String(a).split('.').map(Number)
  const v2 = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
    const x = v1[i] || 0
    const y = v2[i] || 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

export function setupChromeWebStore(options: WebStoreOptions) {
  const { session } = options
  const installing = new Set<string>()

  const status = (id: string, manifestVersion?: number) => {
    if (typeof manifestVersion === 'number' && manifestVersion < options.minimumManifestVersion) {
      return ExtensionInstallStatus.DEPRECATED_MANIFEST_VERSION
    }
    return session.extensions.getExtension(id) ? ExtensionInstallStatus.ENABLED : ExtensionInstallStatus.INSTALLABLE
  }

  /** Answer `channel` for the store's own top document in the browser's session, and nothing else. */
  const handle = (channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame
      if (
        event.sender.session !== session ||
        !frame ||
        frame !== event.sender.mainFrame ||
        frame.origin !== WEB_STORE_ORIGIN
      ) {
        d('ignoring %s from %s', channel, frame?.origin)
        return undefined
      }
      return handler(event, ...args)
    })
  }

  const install = async (event: Electron.IpcMainInvokeEvent, raw: unknown) => {
    const details = (raw ?? {}) as { id?: unknown; manifest?: unknown; localizedName?: unknown }
    const id = typeof details.id === 'string' ? details.id : ''
    if (!EXTENSION_ID.test(id)) return { result: Result.INVALID_ID }
    if (installing.has(id)) return { result: Result.INSTALL_IN_PROGRESS }
    if (session.extensions.getExtension(id)) return { result: Result.ALREADY_INSTALLED }

    // The page's manifest only says whether to bother: what's shown and
    // installed is the package's own.
    let claimed: { manifest_version?: unknown }
    try {
      claimed = JSON.parse(String(details.manifest))
    } catch {
      return { result: Result.MANIFEST_ERROR }
    }
    if (typeof claimed.manifest_version === 'number' && claimed.manifest_version < options.minimumManifestVersion) {
      return { result: Result.MANIFEST_ERROR }
    }

    installing.add(id)
    try {
      const data = await download(crxUrl(id))
      checkedId(data, id)
      const name = typeof details.localizedName === 'string' ? details.localizedName.slice(0, 200) : 'This extension'
      const dir = installDir(options, id)
      try {
        await options.unpackCrx(data, dir, name)
      } catch (error) {
        if (error instanceof Error && /didn’t add/.test(error.message)) return { result: Result.USER_CANCELLED }
        throw error
      }
      const extension = await load(session, dir)
      if ((extension.manifest as chrome.runtime.Manifest).manifest_version < options.minimumManifestVersion) {
        await removeWebStoreInstall(session, options.extensionsPath, id)
        return { result: Result.MANIFEST_ERROR }
      }
      const frame = event.senderFrame
      queueMicrotask(() => {
        if (frame && !frame.isDestroyed()) frame.send('chrome.management.onInstalled', extensionInfo(extension))
      })
      return { result: Result.SUCCESS }
    } catch (error) {
      console.error('Extension installation failed:', error)
      return { result: Result.INSTALL_ERROR, message: error instanceof Error ? error.message : String(error) }
    } finally {
      installing.delete(id)
    }
  }

  handle('chromeWebstore.beginInstall', (event, details) => install(event, details))
  handle('chromeWebstore.completeInstall', () => Result.SUCCESS)
  handle('chromeWebstore.enableAppLauncher', () => true)
  handle('chromeWebstore.getBrowserLogin', () => '')
  handle('chromeWebstore.getExtensionStatus', (_event, id, manifestJson) => {
    if (typeof id !== 'string' || !EXTENSION_ID.test(id)) return ExtensionInstallStatus.BLOCKED_BY_POLICY
    let manifestVersion: number | undefined
    try {
      const parsed = JSON.parse(String(manifestJson)) as { manifest_version?: unknown }
      if (typeof parsed.manifest_version === 'number') manifestVersion = parsed.manifest_version
    } catch {
      // Unknown: judge by whether it's installed.
    }
    return status(id, manifestVersion)
  })
  handle('chromeWebstore.getFullChromeVersion', () => ({ version_number: process.versions.chrome, app_name: app.getName() }))
  handle('chromeWebstore.getIsLauncherEnabled', () => true)
  handle('chromeWebstore.getMV2DeprecationStatus', () =>
    options.minimumManifestVersion > 2 ? MV2DeprecationStatus.SOFT_DISABLE : MV2DeprecationStatus.INACTIVE,
  )
  handle('chromeWebstore.getReferrerChain', () => 'EgIIAA==')
  handle('chromeWebstore.getStoreLogin', () => '')
  handle('chromeWebstore.getWebGLStatus', async () => {
    await app.getGPUInfo('basic')
    return app.getGPUFeatureStatus().webgl.startsWith('enabled') ? WebGlStatus.WEBGL_ALLOWED : WebGlStatus.WEBGL_BLOCKED
  })
  // The old install path: everything goes through beginInstall now.
  handle('chromeWebstore.install', () => Result.UNKNOWN_ERROR)
  handle('chromeWebstore.isInIncognitoMode', () => false)
  handle('chromeWebstore.isPendingCustodianApproval', () => false)
  handle('chromeWebstore.setStoreLogin', () => true)
  handle('chrome.runtime.getManifest', () => ({}))
  handle('chrome.management.getAll', () => session.extensions.getAllExtensions().map(extensionInfo))
  handle('chrome.management.setEnabled', () => true)
  handle('chrome.management.uninstall', async (event, id) => {
    if (typeof id !== 'string' || !EXTENSION_ID.test(id)) return Result.UNKNOWN_ERROR
    const extension = session.extensions.getExtension(id)
    // Only what the store installed, and only if the user says so.
    if (!extension || !isStoreInstall(options, extension)) return Result.UNKNOWN_ERROR
    if (!(await options.confirmRemove(extension.name))) return Result.USER_CANCELLED
    try {
      await removeWebStoreInstall(session, options.extensionsPath, id)
      queueMicrotask(() => {
        if (!event.sender.isDestroyed()) event.sender.mainFrame.send('chrome.management.onUninstalled', id)
      })
      return Result.SUCCESS
    } catch (error) {
      console.error(error)
      return Result.UNKNOWN_ERROR
    }
  })

  /** Load what the store installed before. */
  const loadAll = async () => {
    for (const { dir, manifest } of await discover(options.extensionsPath)) {
      if (session.extensions.getAllExtensions().some((e) => e.path === dir)) continue
      try {
        d(`loading ${manifest.name}@${manifest.version}`)
        await load(session, dir)
      } catch (error) {
        console.error(`Failed to load extension from ${dir}`, error)
      }
    }
  }

  return { loadAll, startUpdates: () => startUpdates(options) }
}

// ---------------------------------------------------------------------------
// Updates: Chrome's (the Omaha protocol), for what the store installed
// ---------------------------------------------------------------------------

const UPDATE_URL = 'https://clients2.google.com/service/update2/crx'
const SYSTEM_IDLE_DURATION = 60 * 60 * 1000
const UPDATE_CHECK_INTERVAL = 5 * 60 * 60 * 1000
const MIN_UPDATE_INTERVAL = 3 * 60 * 60 * 1000

interface OmahaApp {
  appid: string
  updatecheck: {
    status: string
    urls?: { url: { codebase: string }[] }
    manifest?: { version: string }
  }
}

let lastUpdateCheck: number | undefined

async function availableUpdates(extensions: Electron.Extension[]) {
  if (extensions.length === 0) return []
  const chromeVersion = process.versions.chrome
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
  const arch = process.arch === 'ia32' ? 'x86' : process.arch
  const response = await fetch('https://update.googleapis.com/service/update2/json', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Update-Interactivity': 'bg',
      'X-Goog-Update-AppId': extensions.map((e) => e.id).join(','),
      'X-Goog-Update-Updater': `chromiumcrx-${chromeVersion}`,
    },
    body: JSON.stringify({
      request: {
        '@updater': 'din',
        acceptformat: 'crx3',
        app: extensions.map((e) => ({ appid: e.id, updatecheck: {} })),
        os: { platform, arch },
        prodversion: chromeVersion,
        protocol: '3.1',
        requestid: crypto.randomUUID(),
        sessionid: crypto.randomUUID(),
      },
    }),
  })
  if (!response.ok) return []
  const text = await response.text()
  const prefix = ")]}'\n"
  if (!text.startsWith(prefix)) return []
  const apps = ((JSON.parse(text.slice(prefix.length)) as { response?: { app?: OmahaApp[] } }).response?.app ?? [])
  const byId = new Map(extensions.map((e) => [e.id, e]))
  return apps.flatMap((item) => {
    const extension = byId.get(item.appid)
    const version = item.updatecheck.manifest?.version
    const url = item.updatecheck.urls?.url[0]?.codebase
    if (item.updatecheck.status !== 'ok' || !extension || !version || !url) return []
    return compareVersions(extension.version, version) < 0 ? [{ extension, url, version }] : []
  })
}

async function checkForUpdates(options: WebStoreOptions) {
  const extensions = options.session.extensions
    .getAllExtensions()
    .filter((e) => isStoreInstall(options, e) && (e.manifest as chrome.runtime.Manifest).update_url === UPDATE_URL)
  for (const { extension, url, version } of await availableUpdates(extensions)) {
    try {
      d(`updating ${extension.id} ${extension.version} -> ${version}`)
      const data = await download(url)
      checkedId(data, extension.id)
      const dir = installDir(options, extension.id)
      // Asks only if it wants more than the version installed has.
      await options.unpackCrx(data, dir, extension.name, extension.path)
      if (!options.session.extensions.getExtension(extension.id)) await load(options.session, dir)
      // An install from before lived beside it, in a folder named for its version.
      if (extension.path !== dir) await fs.rm(extension.path, { recursive: true, force: true })
    } catch (error) {
      console.error(`Couldn't update extension ${extension.id}`, error)
    }
  }
}

function startUpdates(options: WebStoreOptions) {
  const check = () => {
    if (powerMonitor.getSystemIdleState(SYSTEM_IDLE_DURATION) !== 'active') return
    if (lastUpdateCheck && Date.now() - lastUpdateCheck < MIN_UPDATE_INTERVAL) return
    lastUpdateCheck = Date.now()
    void checkForUpdates(options).catch((error) => console.error('Extension update check failed', error))
  }
  app.on('browser-window-focus', check)
  const timer = setInterval(check, UPDATE_CHECK_INTERVAL)
  app.once('before-quit', () => clearInterval(timer))
  check()
}
