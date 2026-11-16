import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { BaseWindow, BrowserWindow, nativeImage } from 'electron'

export interface TabContents extends Electron.WebContents {
  favicon?: string
}

export type ContextMenuType =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio'
  | 'launcher'
  | 'browser_action'
  | 'page_action'
  | 'action'

/** The extension's manifest, typed (Electron's is any). */
export const getExtensionManifest = (extension: Electron.Extension): chrome.runtime.Manifest =>
  extension.manifest

export const getExtensionUrl = (extension: Electron.Extension, uri: string) => {
  try {
    return new URL(uri, extension.url).href
  } catch {
    return undefined
  }
}

export const resolveExtensionPath = (
  extension: Electron.Extension,
  uri: string,
  requestPath?: string,
) => {
  // Resolve any relative paths.
  const relativePath = path.join(requestPath || '/', uri)
  const resPath = path.join(extension.path, relativePath)

  // prevent any parent traversals
  if (!resPath.startsWith(extension.path)) return

  return resPath
}

export const validateExtensionResource = async (extension: Electron.Extension, uri: string) => {
  const resPath = resolveExtensionPath(extension, uri)
  if (!resPath) return

  try {
    await fs.stat(resPath)
  } catch {
    return // doesn't exist
  }

  return resPath
}

export const ResizeType = { Exact: 0, Up: 1, Down: 2 } as const
export type ResizeType = (typeof ResizeType)[keyof typeof ResizeType]

/**
 * The image in a set by size (`{ 16: …, 32: … }`) for `size`: that size, or
 * the nearest bigger one to scale down (Up) or smaller one to scale up
 * (Down), else the nearest there is.
 */
export const matchSize = (imageSet: { [key: number]: string }, size: number, match: ResizeType): string | undefined => {
  const sizes = Object.keys(imageSet)
    .map((key) => parseInt(key, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b)
  if (sizes.length === 0) return undefined
  const chosen =
    sizes.find((n) => n === size) ??
    (match === ResizeType.Up ? sizes.find((n) => n > size) : match === ResizeType.Down ? [...sizes].reverse().find((n) => n < size) : undefined) ??
    sizes.reduce((best, n) => (Math.abs(n - size) < Math.abs(best - size) ? n : best))
  return imageSet[chosen]
}

/** Gets the relative path to the extension's default icon. */
export const getIconPath = (
  extension: Electron.Extension,
  iconSize: number = 32,
  resizeType = ResizeType.Up,
) => {
  const manifest = getExtensionManifest(extension)
  const { icons } = manifest

  const default_icon: chrome.runtime.ManifestIcons | undefined = (
    manifest.manifest_version === 3 ? manifest.action : manifest.browser_action
  )?.default_icon

  if (typeof default_icon === 'string') {
    const iconPath = default_icon
    return iconPath
  } else if (typeof default_icon === 'object') {
    const iconPath = matchSize(default_icon, iconSize, resizeType)
    return iconPath
  } else if (typeof icons === 'object') {
    const iconPath = matchSize(icons, iconSize, resizeType)
    return iconPath
  }
}

export const getIconImage = (extension: Electron.Extension) => {
  const iconPath = getIconPath(extension)
  const iconAbsolutePath = iconPath && resolveExtensionPath(extension, iconPath)
  return iconAbsolutePath ? nativeImage.createFromPath(iconAbsolutePath) : undefined
}

const escapePattern = (pattern: string) => pattern.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')

/** A tabs.query title pattern: `*` matches anything. */
export const matchesTitlePattern = (pattern: string, title: string) => {
  const regexp = new RegExp(`^${pattern.split('*').map(escapePattern).join('.*')}$`)
  return title.match(regexp)
}

export const getAllWindows = () => [...BaseWindow.getAllWindows(), ...BrowserWindow.getAllWindows()]
