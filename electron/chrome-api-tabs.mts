import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'
import { getAllWindows, matchesTitlePattern, type TabContents } from './chrome-extensions-common.mts'
import { extensionTabUrl, matchesPattern, visibleTab } from './chrome-extensions-permissions.mts'
import { debug } from './chrome-extensions-debug.mts'

/**
 * chrome.tabs over the Web Browser's tabs (the store's), as Chrome limits
 * it: a tab's address, title and icon only for an extension with `tabs` or
 * access to the page (or activeTab on it), in answers and events alike; CSS
 * only into pages it can reach; and tabs opened or sent only where a link
 * could go (extensionTabUrl), since main loads them without the checks a
 * page's navigation gets.
 */

const d = debug('tabs')

const TAB_ID_NONE = -1
const WINDOW_ID_NONE = -1
const WINDOW_ID_CURRENT = -2

/** What tabs.onUpdated compares between one look at a tab and the next. */
const COMPARE: (keyof chrome.tabs.Tab)[] = ['audible', 'autoDiscardable', 'discarded', 'favIconUrl', 'groupId', 'pinned', 'status', 'title', 'url']

/** What of a change an extension that can't see the tab doesn't get. */
const PRIVATE: (keyof chrome.tabs.TabChangeInfo)[] = ['url', 'title', 'favIconUrl']

export class TabsAPI {
  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private observeTab(tab: TabContents) {
    const tabId = tab.id

    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible
      'did-start-navigation', // url
      'did-redirect-navigation', // url
      'did-navigate-in-page', // url
      // What has no Electron event of its own (Din emits it).
      'tab-updated',
    ] as const

    const updateHandler = () => this.onUpdated(tabId)
    for (const name of updateEvents) tab.on(name as 'did-start-loading', updateHandler)

    // activeTab reaches the page it was given on, not the next one.
    const navigationHandler = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (details.isMainFrame && !details.isSameDocument) this.ctx.permissions.revokeActiveTab(tabId)
    }
    tab.on('did-start-navigation', navigationHandler)

    const faviconHandler = (_event: Electron.Event, favicons: string[]) => {
      tab.favicon = favicons[0]
      this.onUpdated(tabId)
    }
    tab.on('page-favicon-updated', faviconHandler)

    tab.once('destroyed', () => {
      for (const name of updateEvents) tab.off(name as 'did-start-loading', updateHandler)
      tab.off('did-start-navigation', navigationHandler)
      tab.off('page-favicon-updated', faviconHandler)
      this.ctx.permissions.revokeActiveTab(tabId)
      this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })

    this.onCreated(tabId)
    this.onActivated(tabId)

    d(`observing tab ${tabId}`)
  }

  private createTabDetails(tab: TabContents) {
    const tabId = tab.id
    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    let win = this.ctx.store.tabToWindow.get(tab)
    if (win?.isDestroyed()) win = undefined
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      height,
      highlighted: false,
      id: tabId,
      incognito: false,
      index: -1,
      groupId: -1,
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      status: tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(),
      width,
      windowId: win ? win.id : -1,
    }

    this.ctx.store.impl.assignTabDetails?.(details, tab)
    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  private getTabDetails(tab: TabContents): chrome.tabs.Tab {
    return (this.ctx.store.tabDetailsCache.get(tab.id) as chrome.tabs.Tab | undefined) ?? this.createTabDetails(tab)
  }

  /** A tab's details, as the extension may see them. */
  private detailsFor(extensionId: string, tab: TabContents) {
    return visibleTab(this.ctx.permissions, extensionId, this.getTabDetails(tab))
  }

  private get({ extension }: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return { id: TAB_ID_NONE }
    return this.detailsFor(extension.id, tab)
  }

  private getAllInWindow({ extension }: ExtensionEvent, windowId: number = WINDOW_ID_CURRENT) {
    if (windowId === WINDOW_ID_CURRENT) windowId = this.ctx.store.lastFocusedWindowId!
    return [...this.ctx.store.tabs]
      .filter((tab) => {
        if (tab.isDestroyed()) return false
        const window = this.ctx.store.tabToWindow.get(tab)
        return !!window && !window.isDestroyed() && window.id === windowId
      })
      .map((tab) => this.detailsFor(extension.id, tab))
  }

  private getCurrent({ extension }: ExtensionEvent) {
    const tab = this.ctx.store.getActiveTabOfCurrentWindow()
    return tab ? this.detailsFor(extension.id, tab) : undefined
  }

  private async create({ extension }: ExtensionEvent, details: chrome.tabs.CreateProperties = {}) {
    const url = details?.url ? extensionTabUrl(details.url, extension) : undefined
    const tab = await this.ctx.store.createTab({ active: details?.active, windowId: details?.windowId, url })
    if (details?.active) queueMicrotask(() => this.onActivated(tab.id))
    return this.detailsFor(extension.id, tab)
  }

  /** CSS into a page the extension can reach (host permissions, or activeTab on it). */
  private insertCSS({ extension }: ExtensionEvent, arg1: unknown, arg2?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const details = (typeof arg1 === 'object' ? arg1 : arg2) as chrome.tabs.InjectDetails | undefined
    const tab = tabId !== undefined ? this.ctx.store.getTabById(tabId) : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab || typeof details?.code !== 'string') return
    if (!this.ctx.permissions.canAccessTab(extension.id, tab.id, tab.getURL())) {
      throw new Error(`Cannot access contents of ${tab.getURL() ? 'the page' : 'the tab'}: the extension has no access to it`)
    }
    void tab.insertCSS(details.code)
  }

  private query({ extension }: ExtensionEvent, info: chrome.tabs.QueryInfo = {}) {
    const isSet = (value: unknown) => typeof value !== 'undefined'
    info = info ?? {}

    return [...this.ctx.store.tabs]
      .filter((tab) => !tab.isDestroyed())
      // Filters on what the extension can see: a tab it can't see the address of matches no url pattern.
      .map((tab) => this.detailsFor(extension.id, tab))
      .filter((tab) => {
        if (isSet(info.active) && info.active !== tab.active) return false
        if (isSet(info.pinned) && info.pinned !== tab.pinned) return false
        if (isSet(info.audible) && info.audible !== tab.audible) return false
        if (isSet(info.muted) && info.muted !== tab.mutedInfo?.muted) return false
        if (isSet(info.highlighted) && info.highlighted !== tab.highlighted) return false
        if (isSet(info.discarded) && info.discarded !== tab.discarded) return false
        if (isSet(info.autoDiscardable) && info.autoDiscardable !== tab.autoDiscardable) return false
        if (isSet(info.groupId) && info.groupId !== tab.groupId) return false
        if (isSet(info.status) && info.status !== tab.status) return false
        if (typeof info.title === 'string' && (typeof tab.title !== 'string' || !matchesTitlePattern(info.title, tab.title))) return false
        if (isSet(info.url)) {
          const patterns = Array.isArray(info.url) ? info.url : [info.url]
          if (typeof tab.url !== 'string' || !patterns.some((pattern) => typeof pattern === 'string' && matchesPattern(pattern, tab.url!))) {
            return false
          }
        }
        if (isSet(info.windowId)) {
          if (info.windowId === WINDOW_ID_CURRENT) {
            if (this.ctx.store.lastFocusedWindowId !== tab.windowId) return false
          } else if (info.windowId !== tab.windowId) {
            return false
          }
        }
        return true
      })
      .map((tab, index) => ({ ...tab, index }))
  }

  private tabOf(arg: unknown) {
    return typeof arg === 'number' ? this.ctx.store.getTabById(arg) : this.ctx.store.getActiveTabOfCurrentWindow()
  }

  private reload(_event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const props = (typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}) as chrome.tabs.ReloadProperties | null
    const tab = this.tabOf(arg1)
    if (!tab) return
    if (props?.bypassCache) tab.reloadIgnoringCache()
    else tab.reload()
  }

  private async update({ extension }: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const props = ((typeof arg1 === 'object' ? arg1 : arg2) || {}) as chrome.tabs.UpdateProperties
    const tab = this.tabOf(arg1)
    if (!tab) return

    const url = props.url ? extensionTabUrl(props.url, extension) : undefined
    if (url) await tab.loadURL(url)
    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)
    if (props.active) this.onActivated(tab.id)
    this.onUpdated(tab.id)

    return visibleTab(this.ctx.permissions, extension.id, this.createTabDetails(tab))
  }

  private remove(_event: ExtensionEvent, id: number | number[]) {
    for (const tabId of Array.isArray(id) ? id : [id]) {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab) this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    }
  }

  private goForward(_event: ExtensionEvent, arg1?: unknown) {
    this.tabOf(arg1)?.navigationHistory.goForward()
  }

  private goBack(_event: ExtensionEvent, arg1?: unknown) {
    this.tabOf(arg1)?.navigationHistory.goBack()
  }

  onCreated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return
    const details = this.getTabDetails(tab)
    this.ctx.router.broadcastEach('tabs.onCreated', (extensionId) => [visibleTab(this.ctx.permissions, extensionId, details)])
  }

  onUpdated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const prevDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    let didUpdate = false
    const changeInfo: Record<string, unknown> = {}
    for (const prop of COMPARE) {
      if (details[prop] !== prevDetails[prop]) {
        changeInfo[prop] = details[prop]
        didUpdate = true
      }
    }
    if (details.mutedInfo?.muted !== prevDetails.mutedInfo?.muted) {
      changeInfo.mutedInfo = details.mutedInfo
      didUpdate = true
    }
    if (!didUpdate) return

    this.ctx.router.broadcastEach('tabs.onUpdated', (extensionId) => {
      if (this.ctx.permissions.canSeeTab(extensionId, tab.id, details.url ?? '')) return [tab.id, changeInfo, details]
      const seen = Object.fromEntries(Object.entries(changeInfo).filter(([key]) => !PRIVATE.includes(key as keyof chrome.tabs.TabChangeInfo)))
      // A change it can't see is no change to it.
      return Object.keys(seen).length > 0 ? [tab.id, seen, visibleTab(this.ctx.permissions, extensionId, details)] : null
    })
  }

  onRemoved(tabId: number) {
    const details = this.ctx.store.tabDetailsCache.get(tabId)
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = details?.windowId ?? WINDOW_ID_NONE
    const win = windowId > -1 ? getAllWindows().find((w) => w.id === windowId) : null

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false,
    })
  }

  onActivated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    if (activeTab?.id === tabId) return

    const win = this.ctx.store.tabToWindow.get(tab)
    this.ctx.store.setActiveTab(tab)

    // 'active' changed for every cached tab.
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      tabInfo.active = tabId === cacheTabId
    })

    this.ctx.router.broadcastEvent('tabs.onActivated', { tabId, windowId: win?.id })
  }
}
