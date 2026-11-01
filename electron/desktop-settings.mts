// Who keeps the look-and-feel settings Din shows under Settings → Appearance
// (the icon theme, the pointer): GSettings (org.gnome.desktop.interface),
// on DinOS and on the desktops that use it too, or a desktop of its own.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

/** Desktops whose appearance settings are GSettings' (XDG_CURRENT_DESKTOP names). */
const GSETTINGS_DESKTOPS = ['gnome', 'unity', 'cinnamon', 'x-cinnamon', 'budgie', 'budgie-desktop', 'mate', 'pantheon'];

/**
 * - `din`: Din is the desktop (DinOS, DIN_DESKTOP_SESSION), and GSettings is its.
 * - `shared`: a GSettings desktop like GNOME; Din can change its settings,
 *   which change the desktop's too.
 * - `other`: a desktop that keeps them elsewhere (KDE's kdeglobals, XFCE's
 *   xfconf), so writing GSettings would only make the two disagree.
 */
export type SettingsOwner = 'din' | 'shared' | 'other';

export function settingsOwner(): SettingsOwner {
  if (process.env.DIN_DESKTOP_SESSION === '1') return 'din';
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().split(':');
  return desktops.some((desktop) => GSETTINGS_DESKTOPS.includes(desktop)) ? 'shared' : 'other';
}
