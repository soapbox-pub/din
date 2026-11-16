/**
 * The chrome.* extension APIs Electron itself lacks (tabs, windows, actions,
 * cookies, context menus, notifications, native messaging...), for the Web
 * Browser's session. Din's own copy of electron-chrome-extensions 4.10.0 by
 * Samuel Maddock (MIT, see NOTICE below), trimmed to what Din uses: its
 * action popups are drawn by the shell (ExtensionPopupHost), not a window
 * of their own, and there's one browser session.
 *
 * Pieces:
 *   chrome-extensions-router.mts   the IPC every API call and event goes over
 *   chrome-extensions-store.mts    the tabs and windows extensions see
 *   chrome-extensions-common.mts   manifests, icons, URLs
 *   chrome-api-*.mts               one per chrome.* namespace
 *   chrome-extensions-preload.cjs  the APIs in extension pages and workers
 *   browser-action-preload.cjs     the shell's <browser-action-list>
 *
 * NOTICE: Copyright (c) 2021 Samuel Maddock. Permission is hereby granted,
 * free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions: The above copyright notice and this
 * permission notice shall be included in all copies or substantial portions
 * of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { EventEmitter } from 'node:events'
import path from 'node:path'

import { BrowserActionAPI } from './chrome-api-action.mts'
import { CommandsAPI } from './chrome-api-commands.mts'
import { ContextMenusAPI } from './chrome-api-context-menus.mts'
import { CookiesAPI } from './chrome-api-cookies.mts'
import { NotificationsAPI } from './chrome-api-notifications.mts'
import { PermissionsAPI } from './chrome-api-permissions.mts'
import { RuntimeAPI } from './chrome-api-runtime.mts'
import { TabsAPI } from './chrome-api-tabs.mts'
import { WebNavigationAPI } from './chrome-api-web-navigation.mts'
import { WindowsAPI } from './chrome-api-windows.mts'
import { getExtensionUrl, validateExtensionResource } from './chrome-extensions-common.mts'
import type { ChromeExtensionImpl, ExtensionContext } from './chrome-extensions-context.mts'
import { ExtensionPermissions } from './chrome-extensions-permissions.mts'
import { ExtensionRouter, type RouterOptions } from './chrome-extensions-router.mts'
import { ExtensionStore } from './chrome-extensions-store.mts'

export type { ChromeExtensionImpl } from './chrome-extensions-context.mts'

/** The chrome.* APIs' preload, for extension pages and service workers. */
const API_PRELOAD = path.join(import.meta.dirname, 'chrome-extensions-preload.cjs')

/** The shell's <browser-action-list> element. */
export const BROWSER_ACTION_PRELOAD = path.join(import.meta.dirname, 'browser-action-preload.cjs')

export interface ChromeExtensionOptions extends ChromeExtensionImpl, RouterOptions {
  /** The session extensions run in. */
  session: Electron.Session
}

/** An extension's chrome_url_overrides (new tab, history...), as extension URLs. */
async function readUrlOverrides(ctx: ExtensionContext, extension: Electron.Extension) {
  const manifest = extension.manifest as chrome.runtime.Manifest
  const urlOverrides = ctx.store.urlOverrides
  let updated = false

  if (typeof manifest.chrome_url_overrides === 'object') {
    for (const [name, uri] of Object.entries(manifest.chrome_url_overrides!)) {
      const validatedPath = await validateExtensionResource(extension, uri)
      if (!validatedPath) {
        console.error(`Extension ${extension.id} attempted to override ${name} with invalid resource: ${uri}`)
        continue
      }

      const url = getExtensionUrl(extension, uri)!
      if (urlOverrides[name] !== url) {
        urlOverrides[name] = url
        updated = true
      }
    }
  }

  if (updated) ctx.emit('url-overrides-updated', urlOverrides)
}

/** The chrome.* extension APIs in one session. */
export class ElectronChromeExtensions extends EventEmitter {
  private ctx: ExtensionContext

  private api: {
    browserAction: BrowserActionAPI
    contextMenus: ContextMenusAPI
    commands: CommandsAPI
    cookies: CookiesAPI
    notifications: NotificationsAPI
    permissions: PermissionsAPI
    runtime: RuntimeAPI
    tabs: TabsAPI
    webNavigation: WebNavigationAPI
    windows: WindowsAPI
  }

  constructor(opts: ChromeExtensionOptions) {
    super()

    const { session, isShell, ...impl } = opts

    // What each extension holds: its manifest's, from when it loads.
    const permissions = new ExtensionPermissions()
    for (const extension of session.extensions.getAllExtensions()) permissions.load(extension)
    session.extensions.on('extension-loaded', (_event, extension) => permissions.load(extension))
    session.extensions.on('extension-unloaded', (_event, extension) => permissions.unload(extension.id))

    const router = new ExtensionRouter(session, permissions, { isShell })
    const store = new ExtensionStore(impl)

    this.ctx = {
      emit: this.emit.bind(this),
      router,
      session,
      store,
      permissions,
    }

    this.api = {
      browserAction: new BrowserActionAPI(this.ctx),
      contextMenus: new ContextMenusAPI(this.ctx),
      commands: new CommandsAPI(this.ctx),
      cookies: new CookiesAPI(this.ctx),
      notifications: new NotificationsAPI(this.ctx),
      permissions: new PermissionsAPI(this.ctx),
      runtime: new RuntimeAPI(this.ctx),
      tabs: new TabsAPI(this.ctx),
      webNavigation: new WebNavigationAPI(this.ctx),
      windows: new WindowsAPI(this.ctx),
    }

    session.extensions.addListener('extension-loaded', (_event, extension) => {
      void readUrlOverrides(this.ctx, extension)
    })

    session.registerPreloadScript({ id: 'crx-mv2-preload', type: 'frame', filePath: API_PRELOAD })
    session.registerPreloadScript({ id: 'crx-mv3-preload', type: 'service-worker', filePath: API_PRELOAD })
  }

  /**
   * Serve crx://extension-icon/<id>/<size>/<resize> in `session` (the
   * shell's), for the toolbar's <browser-action-list> and the extensions
   * manager.
   */
  handleCRXProtocol(session: Electron.Session) {
    if (session.protocol.isProtocolHandled('crx')) session.protocol.unhandle('crx')
    session.protocol.handle('crx', (request) => this.api.browserAction.handleCRXRequest(request))
  }

  private checkWebContentsArgument(wc: Electron.WebContents) {
    if (this.ctx.session !== wc.session) {
      throw new TypeError('Invalid WebContents argument: it is not in the extensions session')
    }
  }

  /** Add webContents to be tracked as a tab. */
  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.addTab(tab, window)
  }

  /** Remove webContents from being tracked as a tab. */
  removeTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.removeTab(tab)
  }

  /** Notify extension system that the active tab has changed. */
  selectTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    if (this.ctx.store.tabs.has(tab)) {
      this.api.tabs.onActivated(tab.id)
    }
  }

  /** The shell's action popup closed, so the next click on an action opens one rather than toggling it shut. */
  popupClosed() {
    this.api.browserAction.popupClosed()
  }

  /** The menu items chrome.contextMenus adds for a right-click in `webContents`. */
  getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams) {
    this.checkWebContentsArgument(webContents)
    return this.api.contextMenus.buildMenuItemsForParams(webContents, params)
  }

  /** Special pages (newtab...) extensions override, to their URLs. */
  getURLOverrides(): Record<string, string> {
    return this.ctx.store.urlOverrides
  }
}
