import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'

/**
 * chrome.cookies, as Chrome gives it: only to an extension with the
 * `cookies` permission, and only for sites its host permissions reach. A
 * cookie is reached if the extension could reach a page the cookie is sent
 * to (its domain, over https, or http for one that isn't Secure). So
 * getAll({}) is every cookie of the extension's own sites, not the whole
 * session's, and onChanged tells each extension only of those.
 */

const DEFAULT_STORE = '0'

const onChangedCauseTranslation: Record<string, string> = {
  'expired-overwrite': 'expired_overwrite',
}

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
  ...cookie,
  domain: cookie.domain || '',
  hostOnly: Boolean(cookie.hostOnly),
  session: Boolean(cookie.session),
  path: cookie.path || '',
  httpOnly: Boolean(cookie.httpOnly),
  secure: Boolean(cookie.secure),
  sameSite: (cookie.sameSite === 'no_restriction' || cookie.sameSite === 'lax' || cookie.sameSite === 'strict'
    ? cookie.sameSite
    : 'unspecified') as chrome.cookies.SameSiteStatus,
  storeId: DEFAULT_STORE,
})

/** The pages a cookie is sent to, as URLs to check host access against. */
function cookieUrls(cookie: Electron.Cookie): string[] {
  const host = (cookie.domain || '').replace(/^\./, '')
  if (!host) return []
  const path = cookie.path || '/'
  return cookie.secure ? [`https://${host}${path}`] : [`https://${host}${path}`, `http://${host}${path}`]
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

export class CookiesAPI {
  private ctx: ExtensionContext

  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    const permission = { permission: 'cookies' }
    handle('cookies.get', this.get.bind(this), permission)
    handle('cookies.getAll', this.getAll.bind(this), permission)
    handle('cookies.set', this.set.bind(this), permission)
    handle('cookies.remove', this.remove.bind(this), permission)
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this), permission)

    this.cookies.addListener('changed', this.onChanged)
  }

  private canReach(extensionId: string, cookie: Electron.Cookie) {
    return cookieUrls(cookie).some((url) => this.ctx.permissions.canAccessUrl(extensionId, url))
  }

  /** A `url` argument the extension may use, or a thrown error. */
  private reachableUrl({ extension }: ExtensionEvent, url: unknown): string {
    const href = str(url)
    if (!href || !/^https?:\/\//i.test(href)) throw new Error('A http(s) url is required')
    if (!this.ctx.permissions.canAccessUrl(extension.id, href)) {
      throw new Error(`No host permissions for cookies at ${href}`)
    }
    return href
  }

  private async get(event: ExtensionEvent, details: chrome.cookies.CookieDetails): Promise<chrome.cookies.Cookie | null> {
    const url = this.reachableUrl(event, details?.url)
    const cookies = await this.cookies.get({ url, name: str(details.name) })
    // The longest path first, as Chrome picks.
    const found = cookies
      .filter((cookie) => this.canReach(event.extension.id, cookie))
      .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))
    return found.length > 0 ? createCookieDetails(found[0]) : null
  }

  private async getAll(event: ExtensionEvent, details: chrome.cookies.GetAllDetails = {}): Promise<chrome.cookies.Cookie[]> {
    const url = details?.url !== undefined ? this.reachableUrl(event, details.url) : undefined
    const cookies = await this.cookies.get({
      url,
      name: str(details?.name),
      domain: str(details?.domain),
      path: str(details?.path),
      secure: typeof details?.secure === 'boolean' ? details.secure : undefined,
      session: typeof details?.session === 'boolean' ? details.session : undefined,
    })
    return cookies.filter((cookie) => this.canReach(event.extension.id, cookie)).map(createCookieDetails)
  }

  private async set(event: ExtensionEvent, details: chrome.cookies.SetDetails): Promise<chrome.cookies.Cookie | null> {
    const url = this.reachableUrl(event, details?.url)
    // Setting a cookie for another domain than the URL's would reach a site
    // the extension can't: the domain must be the URL's host or a parent of it.
    const host = new URL(url).hostname
    const domain = str(details.domain)?.replace(/^\./, '')
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) throw new Error(`${url} can't set cookies for ${domain}`)
    await this.cookies.set({
      url,
      name: str(details.name),
      value: str(details.value),
      domain: str(details.domain),
      path: str(details.path),
      secure: typeof details.secure === 'boolean' ? details.secure : undefined,
      httpOnly: typeof details.httpOnly === 'boolean' ? details.httpOnly : undefined,
      expirationDate: typeof details.expirationDate === 'number' ? details.expirationDate : undefined,
      sameSite: details.sameSite === 'unspecified' ? undefined : details.sameSite,
    })
    const cookies = await this.cookies.get({ url, name: str(details.name) })
    return cookies.length > 0 ? createCookieDetails(cookies[0]) : null
  }

  private async remove(event: ExtensionEvent, details: chrome.cookies.CookieDetails): Promise<chrome.cookies.CookieDetails | null> {
    const url = this.reachableUrl(event, details?.url)
    const name = str(details.name)
    if (!name) return null
    try {
      await this.cookies.remove(url, name)
    } catch {
      return null
    }
    return { url, name, storeId: DEFAULT_STORE }
  }

  private async getAllCookieStores(): Promise<chrome.cookies.CookieStore[]> {
    const tabIds = [...this.ctx.store.tabs].filter((tab) => !tab.isDestroyed()).map((tab) => tab.id)
    return [{ id: DEFAULT_STORE, tabIds }]
  }

  private onChanged = (_event: Electron.Event, cookie: Electron.Cookie, cause: string, removed: boolean) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: onChangedCauseTranslation[cause] || cause,
      cookie: createCookieDetails(cookie),
      removed,
    }
    this.ctx.router.broadcastEach('cookies.onChanged', (extensionId) =>
      this.ctx.permissions.hasApi(extensionId, 'cookies') && this.canReach(extensionId, cookie) ? [changeInfo] : null,
    )
  }
}
