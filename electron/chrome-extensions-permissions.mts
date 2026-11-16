/**
 * What each extension may do, as Chrome decides it: the API permissions and
 * host permissions its manifest asks for (which Din showed the user when it
 * was added), plus optional ones the user granted since
 * (chrome.permissions.request), plus activeTab: the tab whose toolbar
 * button the user clicked, until it goes elsewhere.
 *
 * The extension APIs (chrome-api-*.mts) ask this before they read or change
 * anything belonging to a site: cookies, a tab's address and title, CSS
 * injected into a page.
 */

/** A parsed match pattern (https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns). */
interface MatchPattern {
  /** `*` is http and https; `<all_urls>` is null. */
  schemes: string[] | null
  /** `*` alone matches every host; a leading `*.` matches the host and its subdomains. */
  host: string
  path: RegExp
}

const SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'file', 'urn']

const escape = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

/** A match pattern, or null where it isn't one. */
export function parseMatchPattern(pattern: string): MatchPattern | null {
  if (pattern === '<all_urls>') return { schemes: null, host: '*', path: /^/ }
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/*]+|[^/*]+)?(\/.*)$/.exec(pattern)
  if (!m) return null
  const [, scheme, host = '', path] = m
  if (scheme !== '*' && !SCHEMES.includes(scheme)) return null
  if (scheme !== 'file' && !host) return null
  return {
    schemes: scheme === '*' ? ['http', 'https', 'ws', 'wss'] : [scheme],
    host: host.toLowerCase(),
    path: new RegExp(`^${path.split('*').map(escape).join('.*')}$`),
  }
}

/** Whether `url` matches `pattern`: by scheme, host and path, each on its own, never as one string. */
export function matchesPattern(pattern: string | MatchPattern, url: string | URL): boolean {
  const p = typeof pattern === 'string' ? parseMatchPattern(pattern) : pattern
  if (!p) return false
  let u: URL
  try {
    u = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  const scheme = u.protocol.slice(0, -1)
  if (p.schemes ? !p.schemes.includes(scheme) : !SCHEMES.includes(scheme)) return false
  if (p.host !== '*') {
    // A pattern naming a port (http://localhost:8080/*) matches only it.
    const host = (/:\d+$/.test(p.host) ? u.host : u.hostname).toLowerCase()
    if (p.host.startsWith('*.')) {
      const base = p.host.slice(2)
      if (host !== base && !host.endsWith(`.${base}`)) return false
    } else if (host !== p.host) {
      return false
    }
  }
  return p.path.test(u.pathname + u.search)
}

/** The patterns that grant every site. */
export const ALL_SITES = ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']

/** A manifest's API permissions and host patterns, MV2 (both in `permissions`) or MV3. */
export function manifestAccess(manifest: chrome.runtime.Manifest, optional = false): { apis: string[]; origins: string[] } {
  const m = manifest as chrome.runtime.Manifest & {
    optional_host_permissions?: string[]
    host_permissions?: string[]
  }
  const listed = ((optional ? m.optional_permissions : m.permissions) ?? []) as string[]
  const hosts = (optional ? m.optional_host_permissions : m.host_permissions) ?? []
  const isPattern = (p: string) => p === '<all_urls>' || p.includes('://')
  return {
    apis: listed.filter((p) => typeof p === 'string' && !isPattern(p)),
    origins: [...listed.filter((p) => typeof p === 'string' && isPattern(p)), ...hosts.filter((p) => typeof p === 'string')],
  }
}

interface Grant {
  apis: Set<string>
  origins: string[]
}

export class ExtensionPermissions {
  /** What each extension holds now, by id. */
  private grants = new Map<string, Grant>()
  /** Tabs each extension was given by a click on its button (activeTab). */
  private activeTabs = new Map<string, Set<number>>()

  /** Start from an extension's manifest (on load). */
  load(extension: Electron.Extension) {
    const { apis, origins } = manifestAccess(extension.manifest)
    this.grants.set(extension.id, { apis: new Set(apis), origins })
  }

  unload(extensionId: string) {
    this.grants.delete(extensionId)
    this.activeTabs.delete(extensionId)
  }

  get(extensionId: string): { permissions: string[]; origins: string[] } {
    const grant = this.grants.get(extensionId)
    return { permissions: [...(grant?.apis ?? [])], origins: [...(grant?.origins ?? [])] }
  }

  /** Add what the user granted (chrome.permissions.request). */
  add(extensionId: string, apis: string[], origins: string[]) {
    const grant = this.grants.get(extensionId)
    if (!grant) return
    for (const api of apis) grant.apis.add(api)
    for (const origin of origins) if (!grant.origins.includes(origin)) grant.origins.push(origin)
  }

  /** Take back what the extension gives up (chrome.permissions.remove), never what its manifest requires. */
  remove(extension: Electron.Extension, apis: string[], origins: string[]) {
    const grant = this.grants.get(extension.id)
    if (!grant) return
    const required = manifestAccess(extension.manifest)
    for (const api of apis) if (!required.apis.includes(api)) grant.apis.delete(api)
    grant.origins = grant.origins.filter((o) => required.origins.includes(o) || !origins.includes(o))
  }

  hasApi(extensionId: string, api: string): boolean {
    return this.grants.get(extensionId)?.apis.has(api) ?? false
  }

  /** Whether the extension's host permissions reach `url`. */
  canAccessUrl(extensionId: string, url: string): boolean {
    const grant = this.grants.get(extensionId)
    if (!grant) return false
    // An extension always reaches its own pages.
    if (url.startsWith(`chrome-extension://${extensionId}/`)) return true
    return grant.origins.some((pattern) => matchesPattern(pattern, url))
  }

  /** The user clicked the extension's button on this tab: it may act on it until it navigates. */
  grantActiveTab(extensionId: string, tabId: number) {
    if (!this.hasApi(extensionId, 'activeTab')) return
    let tabs = this.activeTabs.get(extensionId)
    if (!tabs) this.activeTabs.set(extensionId, (tabs = new Set()))
    tabs.add(tabId)
  }

  /** A tab went to another page, or closed: activeTab no longer reaches it. */
  revokeActiveTab(tabId: number) {
    for (const tabs of this.activeTabs.values()) tabs.delete(tabId)
  }

  /** Whether the extension may act on the page in this tab (insert CSS, see its address). */
  canAccessTab(extensionId: string, tabId: number, url: string): boolean {
    return this.activeTabs.get(extensionId)?.has(tabId) || this.canAccessUrl(extensionId, url)
  }

  /** Whether it may see a tab's address, title and icon: `tabs`, or access to the page. */
  canSeeTab(extensionId: string, tabId: number, url: string): boolean {
    return this.hasApi(extensionId, 'tabs') || this.canAccessTab(extensionId, tabId, url)
  }
}

/**
 * Where an extension may send a tab (chrome.tabs.create and update,
 * chrome.windows.create): the web, nsites and Blossom files, as anywhere in
 * the browser, and its own pages; never another extension's, Din's own
 * schemes, files, data:, javascript:, chrome: or devtools: pages, which
 * main would load with none of the checks a link gets. Relative URLs are its
 * own pages'.
 */
export function extensionTabUrl(url: unknown, extension: Electron.Extension): string {
  let u: URL
  try {
    u = new URL(String(url), extension.url)
  } catch {
    throw new Error('Invalid URL')
  }
  if (['https:', 'http:', 'nsite:', 'blossom:'].includes(u.protocol)) return u.href
  if (u.protocol === 'chrome-extension:' && u.host === extension.id) return u.href
  throw new Error(`Extensions can't open ${u.protocol} URLs`)
}

/** What of a tab an extension may see: without `tabs` or access to its page, not its address, title or icon. */
export function visibleTab<T extends Partial<chrome.tabs.Tab>>(
  permissions: ExtensionPermissions,
  extensionId: string,
  details: T,
): T
export function visibleTab<T extends Partial<chrome.tabs.Tab>>(
  permissions: ExtensionPermissions,
  extensionId: string,
  details: T | undefined,
): T | undefined
export function visibleTab<T extends Partial<chrome.tabs.Tab>>(
  permissions: ExtensionPermissions,
  extensionId: string,
  details: T | undefined,
): T | undefined {
  if (!details) return details
  if (typeof details.id === 'number' && permissions.canSeeTab(extensionId, details.id, details.url ?? '')) return details
  const { url: _url, pendingUrl: _pendingUrl, title: _title, favIconUrl: _favIconUrl, ...rest } = details
  return rest as T
}
