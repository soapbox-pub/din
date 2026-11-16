import type { ExtensionContext } from './chrome-extensions-context.mts'
import type { ExtensionEvent } from './chrome-extensions-router.mts'
import { manifestAccess, matchesPattern, parseMatchPattern } from './chrome-extensions-permissions.mts'

/**
 * chrome.permissions over what each extension holds (ExtensionPermissions).
 * request() asks the user (main.mts's requestPermissions, Din's add-an-
 * extension prompt) for permissions and sites the manifest lists as
 * optional, and nothing else; with no one to ask, the answer is no. What's
 * granted lasts until Din quits.
 */

/** The permissions and origins asked about, as strings. */
function asked(request: chrome.permissions.Permissions | undefined) {
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [])
  return { apis: strings(request?.permissions), origins: strings(request?.origins) }
}

/** Whether `origin` (a match pattern) is covered by one of `patterns`. */
function covered(origin: string, patterns: string[]): boolean {
  if (patterns.includes(origin)) return true
  const parsed = parseMatchPattern(origin)
  if (!parsed) return false
  // A pattern for one host is covered by any pattern its sample URL matches.
  if (parsed.host === '*' || parsed.host.startsWith('*.')) return false
  const sample = `${parsed.schemes?.[0] ?? 'https'}://${parsed.host}/`
  return patterns.some((pattern) => matchesPattern(pattern, sample) && (pattern === '<all_urls>' || pattern.endsWith('/*')))
}

export class PermissionsAPI {
  private ctx: ExtensionContext

  constructor(ctx: ExtensionContext) {
    this.ctx = ctx
    const handle = this.ctx.router.apiHandler()
    handle('permissions.contains', this.contains)
    handle('permissions.getAll', this.getAll)
    handle('permissions.remove', this.remove)
    handle('permissions.request', this.request)
  }

  private contains = ({ extension }: ExtensionEvent, request: chrome.permissions.Permissions) => {
    const held = this.ctx.permissions.get(extension.id)
    const { apis, origins } = asked(request)
    return apis.every((api) => held.permissions.includes(api)) && origins.every((origin) => covered(origin, held.origins))
  }

  private getAll = ({ extension }: ExtensionEvent) => this.ctx.permissions.get(extension.id)

  private remove = ({ extension }: ExtensionEvent, request: chrome.permissions.Permissions) => {
    const { apis, origins } = asked(request)
    this.ctx.permissions.remove(extension, apis, origins)
    this.ctx.router.sendEvent(extension.id, 'permissions.onRemoved', { permissions: apis, origins })
    return true
  }

  private request = async ({ extension }: ExtensionEvent, request: chrome.permissions.Permissions) => {
    const { apis, origins } = asked(request)
    if (this.contains({ extension } as ExtensionEvent, request)) return true

    // Only what the manifest says it may ask for.
    const optional = manifestAccess(extension.manifest, true)
    const required = manifestAccess(extension.manifest)
    const declaredApis = new Set([...optional.apis, ...required.apis])
    const declaredOrigins = [...optional.origins, ...required.origins]
    if (!apis.every((api) => declaredApis.has(api))) throw new Error('Permissions request includes undeclared permission')
    if (!origins.every((origin) => covered(origin, declaredOrigins))) throw new Error('Permissions request includes undeclared origin')

    const granted = (await this.ctx.store.impl.requestPermissions?.(extension, { permissions: apis, origins })) === true
    if (!granted) return false

    this.ctx.permissions.add(extension.id, apis, origins)
    this.ctx.router.sendEvent(extension.id, 'permissions.onAdded', { permissions: apis, origins })
    return true
  }
}
