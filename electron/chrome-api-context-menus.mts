import { Menu, MenuItem, type MenuItemConstructorOptions } from 'electron'
import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'
import { getIconImage, type ContextMenuType } from './chrome-extensions-common.mts'
import { matchesPattern, visibleTab } from './chrome-extensions-permissions.mts'

/**
 * chrome.contextMenus, for extensions with the `contextMenus` permission:
 * their items in a page's right-click menu (main.mts adds them to Din's own
 * menu) and the toolbar button's. Choosing one gives the extension
 * activeTab on that tab, as Chrome does.
 */

type ContextItemProps = chrome.contextMenus.CreateProperties & { id: string }

type ContextItemConstructorOptions = {
  extension: Electron.Extension
  props: ContextItemProps
  webContents: Electron.WebContents
  params?: Electron.ContextMenuParams
  showIcon?: boolean
}

const DEFAULT_CONTEXTS = ['page']

const getContextTypesFromParams = (params: Electron.ContextMenuParams): Set<ContextMenuType> => {
  const contexts = new Set<ContextMenuType>(['all'])

  switch (params.mediaType) {
    case 'audio':
    case 'video':
    case 'image':
      contexts.add(params.mediaType)
  }

  if (params.pageURL) contexts.add('page')
  if (params.linkURL) contexts.add('link')
  if (params.frameURL) contexts.add('frame')
  if (params.selectionText) contexts.add('selection')
  if (params.isEditable) contexts.add('editable')

  return contexts
}

const formatTitle = (title: string, params: Electron.ContextMenuParams) => {
  if (params.selectionText && title.includes('%s')) {
    title = title.split('%s').join(params.selectionText)
  }
  return title
}

const matchesConditions = (
  props: ContextItemProps,
  conditions: {
    contextTypes: Set<ContextMenuType>
    targetUrl?: string
    documentUrl?: string
  },
) => {
  if (props.visible === false) return false

  const { contextTypes, targetUrl, documentUrl } = conditions

  const contexts = props.contexts
    ? Array.isArray(props.contexts)
      ? props.contexts
      : [props.contexts]
    : DEFAULT_CONTEXTS
  const inContext = contexts.some((context) => contextTypes.has(context as ContextMenuType))
  if (!inContext) return false

  if (props.targetUrlPatterns && props.targetUrlPatterns.length > 0 && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => matchesPattern(pattern, targetUrl))) {
      return false
    }
  }

  if (props.documentUrlPatterns && props.documentUrlPatterns.length > 0 && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => matchesPattern(pattern, documentUrl))) {
      return false
    }
  }

  return true
}

export class ContextMenusAPI {
  private menus = new Map<
    /* extensionId */ string,
    Map</* menuItemId */ string, ContextItemProps>
  >()

  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    const permission = { permission: 'contextMenus' }
    handle('contextMenus.create', this.create, permission)
    handle('contextMenus.remove', this.remove, permission)
    handle('contextMenus.removeAll', this.removeAll, permission)

    ctx.session.extensions.on('extension-unloaded', (_event, extension) => {
      if (this.menus.has(extension.id)) {
        this.menus.delete(extension.id)
      }
    })

    this.ctx.store.buildMenuItems = this.buildMenuItemsForExtension.bind(this)
  }

  private addContextItem(extensionId: string, props: ContextItemProps) {
    let contextItems = this.menus.get(extensionId)
    if (!contextItems) {
      contextItems = new Map()
      this.menus.set(extensionId, contextItems)
    }
    contextItems.set(props.id, props)
  }

  private buildMenuItem = (opts: ContextItemConstructorOptions) => {
    const { extension, props, webContents, params } = opts

    let icon = opts.showIcon ? getIconImage(extension) : undefined
    if (icon) {
      icon = icon.resize({ width: 16, height: 16 })
    }

    const menuItemOptions: MenuItemConstructorOptions = {
      id: props.id,
      type: props.type as MenuItemConstructorOptions['type'],
      label: params ? formatTitle(props.title || '', params) : props.title || '',
      icon,
      enabled: props.enabled,
      click: () => {
        this.onClicked(extension.id, props.id, webContents, params)
      },
    }

    return menuItemOptions
  }

  private buildMenuItemsFromTemplate = (menuItemTemplates: ContextItemConstructorOptions[]) => {
    const itemMap = new Map<string, MenuItemConstructorOptions>()

    // Group by ID
    for (const item of menuItemTemplates) {
      const menuItem = this.buildMenuItem(item)
      itemMap.set(item.props.id, menuItem)
    }

    // Organize in tree
    for (const item of menuItemTemplates) {
      const menuItem = itemMap.get(item.props.id)
      if (item.props.parentId) {
        const parentMenuItem = itemMap.get(`${item.props.parentId}`)
        if (parentMenuItem) {
          const submenu = (parentMenuItem.submenu || []) as Electron.MenuItemConstructorOptions[]
          submenu.push(menuItem!)
          parentMenuItem.submenu = submenu
        }
      }
    }

    const menuItems: Electron.MenuItem[] = []

    const buildFromTemplate = (opts: Electron.MenuItemConstructorOptions) => {
      if (Array.isArray(opts.submenu)) {
        const submenu = new Menu()
        opts.submenu.forEach((item) => submenu.append(buildFromTemplate(item)))
        opts.submenu = submenu
      }
      return new MenuItem({
        ...opts,
        // Force submenu type when submenu items are present
        type: opts.type === 'normal' && opts.submenu ? 'submenu' : opts.type,
      })
    }

    // Build all final MenuItems in-order
    for (const item of menuItemTemplates) {
      // Items with parents will be handled recursively
      if (item.props.parentId) continue

      const menuItem = itemMap.get(item.props.id)!
      menuItems.push(buildFromTemplate(menuItem))
    }

    return menuItems
  }

  buildMenuItemsForParams(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams,
  ): Electron.MenuItem[] {
    if (webContents.session !== this.ctx.session) return []

    let menuItemOptions: ContextItemConstructorOptions[] = []

    const conditions = {
      contextTypes: getContextTypesFromParams(params),
      targetUrl: params.srcURL || params.linkURL,
      documentUrl: params.frameURL || params.pageURL,
    }

    const sessionExtensions = this.ctx.session.extensions

    for (const [extensionId, propItems] of this.menus) {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) continue

      const extensionMenuItemOptions: ContextItemConstructorOptions[] = []

      for (const [, props] of propItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = {
            extension,
            props,
            webContents,
            params,
          }
          extensionMenuItemOptions.push(menuItem)
        }
      }

      const topLevelItems = extensionMenuItemOptions.filter((opt) => !opt.props.parentId)

      if (topLevelItems.length > 1) {
        // Create new top-level item to group children
        const groupId = `group${extension.id}`
        const groupMenuItemOptions: ContextItemConstructorOptions = {
          extension,
          webContents,
          props: {
            id: groupId,
            title: extension.name,
          },
          params,
          showIcon: true,
        }

        // Reassign children to group item
        const children = extensionMenuItemOptions.map((opt) =>
          opt.props.parentId
            ? opt
            : {
                ...opt,
                props: {
                  ...opt.props,
                  parentId: groupId,
                },
              },
        )

        menuItemOptions = [...menuItemOptions, groupMenuItemOptions, ...children]
      } else if (extensionMenuItemOptions.length > 0) {
        // Set all top-level children to show icon
        const children = extensionMenuItemOptions.map((opt) => ({
          ...opt,
          showIcon: !opt.props.parentId,
        }))
        menuItemOptions = [...menuItemOptions, ...children]
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private buildMenuItemsForExtension(
    extensionId: string,
    menuType: ContextMenuType,
  ): Electron.MenuItem[] {
    const extensionItems = this.menus.get(extensionId)
    const sessionExtensions = this.ctx.session.extensions
    const extension = sessionExtensions.getExtension(extensionId)
    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()

    const menuItemOptions = []

    if (extensionItems && extension && activeTab) {
      const conditions = {
        contextTypes: new Set<ContextMenuType>(['all', menuType]),
      }

      for (const [, props] of extensionItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = { extension, props, webContents: activeTab }
          menuItemOptions.push(menuItem)
        }
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private create = ({ extension }: ExtensionEvent, createProperties: ContextItemProps) => {
    const { id, type, title } = createProperties

    if (this.menus.has(id)) {
      // TODO: duplicate error
      return
    }

    if (!title && type !== 'separator') {
      // TODO: error
      return
    }

    this.addContextItem(extension.id, createProperties)
  }

  private remove = ({ extension }: ExtensionEvent, menuItemId: string) => {
    const items = this.menus.get(extension.id)
    if (items && items.has(menuItemId)) {
      items.delete(menuItemId)
      if (items.size === 0) {
        this.menus.delete(extension.id)
      }
    }
  }

  private removeAll = ({ extension }: ExtensionEvent) => {
    this.menus.delete(extension.id)
  }

  private onClicked(
    extensionId: string,
    menuItemId: string,
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams,
  ) {
    if (webContents.isDestroyed()) return

    const tab = this.ctx.store.tabDetailsCache.get(webContents.id) as chrome.tabs.Tab | undefined
    if (!tab) {
      console.error(`[Extensions] Unable to find tab for id=${webContents.id}`)
      return
    }

    // The user chose the extension for this page.
    this.ctx.permissions.grantActiveTab(extensionId, webContents.id)

    const data: chrome.contextMenus.OnClickData = {
      selectionText: params?.selectionText,
      checked: false,
      menuItemId,
      frameId: -1,
      frameUrl: params?.frameURL,
      editable: params?.isEditable || false,
      mediaType: (params?.mediaType === 'none' ? undefined : params?.mediaType) as chrome.contextMenus.OnClickData['mediaType'],
      wasChecked: false,
      pageUrl: params?.pageURL ?? '',
      linkUrl: params?.linkURL,
      parentMenuItemId: -1,
      srcUrl: params?.srcURL,
    }

    this.ctx.router.sendEvent(extensionId, 'contextMenus.onClicked', data, visibleTab(this.ctx.permissions, extensionId, tab))
  }
}
