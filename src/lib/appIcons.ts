import { nip19 } from 'nostr-tools';
import { parseCanonicalNsiteHost } from '@/lib/nsite';

/** Icon for a web app with no favicon, or one that fails to load. */
export const WEB_APP_ICON = '/icons/apps/web-app.png';

/** Icon for a Linux app or window the icon theme has nothing for. */
export const NATIVE_APP_ICON = '/icons/apps/native-window.png';

/**
 * What an icon theme calls Din's own app icons: for each bundled icon, the
 * freedesktop names of its counterpart, best first (standard names, then
 * the well-known apps of its kind). An icon theme that has one of them
 * replaces Din's icon with it; the rest (the Assistant, web apps) keep
 * Din's in every theme.
 */
export const THEMED_APP_ICONS: Record<string, string[]> = {
  '/icons/apps/app-store.png': ['org.gnome.Software', 'system-software-install', 'gnome-software'],
  '/icons/apps/cad.png': ['freecad', 'org.freecad.FreeCAD'],
  '/icons/apps/calculator.png': ['accessories-calculator', 'org.gnome.Calculator'],
  '/icons/apps/devtools.png': ['applications-development'],
  '/icons/apps/file-browser.png': ['system-file-manager', 'org.gnome.Nautilus'],
  '/icons/apps/installer.png': ['calamares', 'system-installer'],
  '/icons/apps/media-player.png': ['multimedia-video-player', 'org.gnome.Totem', 'totem'],
  [NATIVE_APP_ICON]: ['application-x-executable'],
  '/icons/apps/paint.png': ['kolourpaint', 'org.kde.kolourpaint'],
  '/icons/apps/photo-editor.png': ['gimp', 'org.gimp.GIMP'],
  '/icons/apps/preview.png': ['org.gnome.Evince', 'evince', 'document-viewer'],
  '/icons/apps/preview-photo.png': ['image-viewer', 'org.gnome.Loupe', 'eog'],
  '/icons/apps/preview-video.png': ['multimedia-video-player', 'org.gnome.Totem', 'totem'],
  '/icons/apps/publisher.png': ['scribus', 'libreoffice-draw'],
  '/icons/apps/screenshot.png': ['applets-screenshooter', 'org.gnome.Screenshot'],
  '/icons/apps/settings.png': ['preferences-system', 'org.gnome.Settings'],
  '/icons/apps/slides.png': ['libreoffice-impress', 'x-office-presentation'],
  '/icons/apps/spreadsheet.png': ['libreoffice-calc', 'x-office-spreadsheet'],
  '/icons/apps/system-monitor.png': ['utilities-system-monitor', 'org.gnome.SystemMonitor'],
  '/icons/apps/terminal.png': ['utilities-terminal', 'org.gnome.Terminal'],
  '/icons/apps/text-editor.png': ['accessories-text-editor', 'org.gnome.TextEditor'],
  '/icons/apps/vector-editor.png': ['inkscape', 'org.inkscape.Inkscape'],
  '/icons/apps/web-browser.png': ['web-browser', 'internet-web-browser'],
  '/icons/apps/word-processor.png': ['libreoffice-writer', 'x-office-document'],
};

/**
 * What an icon theme calls an installed nsite's icon: `nsite-<npub>` for a
 * root site, `nsite-<npub>-<d-tag>` for a named one. A theme that has it
 * replaces the site's own icon.
 */
export function nsiteIconName(host: string): string | null {
  const site = parseCanonicalNsiteHost(host);
  if (!site) return null;
  const npub = nip19.npubEncode(site.pubkey);
  return site.dtag ? `nsite-${npub}-${site.dtag}` : `nsite-${npub}`;
}

/**
 * What an icon theme calls an installed website's icon: `web-<hostname>`,
 * lowercase and without `www.`, e.g. `web-github.com`. Null for a host no
 * icon could be named after (an IP address in brackets, say).
 */
export function webIconName(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return /^[a-z0-9.-]+$/.test(host) ? `web-${host}` : null;
}
