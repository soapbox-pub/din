// How Windows programs look on Din: like Windows programs. Din's Wine prefix
// (windows-apps.mts) keeps Wine's own Windows 10-like "Light" visual style
// and its colors, as Windows itself keeps classic desktop programs light
// whatever its app mode. Din adds what Windows has and Wine lacks:
//
//   - Windows' app mode (Personalize's AppsUseLightTheme) follows Din's
//     light/dark mode, so programs that opt into dark mode (Electron,
//     Chromium, Qt and WinUI ones, WinForms ones that ask for the system's
//     color mode) go dark with Din, and the rest stay light, as on Windows.
//   - Windows' UI font: Selawik, Microsoft's open stand-in for Segoe UI
//     with its metrics (DinOS installs it), for Segoe UI, the dialog font
//     and Tahoma, where Wine would draw its own Tahoma clone. Layouts made
//     for Segoe UI fit as designed.
//   - Windows' defaults for hover effects (on) and keyboard cues (access
//     key underlines and focus rectangles only once the keyboard is used).
//
// Pure functions: no Electron, no Wine.

/** Wine's Light style, from drive_c. */
export const LIGHT_STYLE = 'windows/resources/themes/light/light.msstyles';

/** Microsoft's metric-compatible stand-in for Segoe UI. */
export const UI_FONT = 'Selawik';

/**
 * Light's system colors (the ones Wine gives a new prefix), so a prefix
 * whose colors an older Din changed gets Windows' back.
 */
const LIGHT_COLORS: Record<string, string> = {
  ActiveBorder: '255 255 255',
  ActiveTitle: '50 150 250',
  AppWorkSpace: '128 128 128',
  Background: '37 111 149',
  ButtonAlternateFace: '255 255 255',
  ButtonDkShadow: '106 106 106',
  ButtonFace: '245 245 245',
  ButtonHilight: '255 255 255',
  ButtonLight: '227 227 227',
  ButtonShadow: '166 166 166',
  ButtonText: '0 0 0',
  GradientActiveTitle: '50 150 250',
  GradientInactiveTitle: '128 128 128',
  GrayText: '106 106 106',
  Hilight: '48 150 250',
  HilightText: '255 255 255',
  HotTrackingColor: '48 150 250',
  InactiveBorder: '255 255 255',
  InactiveTitle: '128 128 128',
  InactiveTitleText: '200 200 200',
  InfoText: '0 0 0',
  InfoWindow: '255 255 255',
  Menu: '255 255 255',
  MenuBar: '255 255 255',
  MenuHilight: '48 150 250',
  MenuText: '0 0 0',
  Scrollbar: '255 255 255',
  TitleText: '0 0 0',
  Window: '255 255 255',
  WindowFrame: '158 158 158',
  WindowText: '0 0 0',
};

/** A LOGFONTW for the UI font, SIZE pixels tall, as regedit hex. */
function logFont(size: number, bold = false): string {
  const font = Buffer.alloc(92);
  font.writeInt32LE(-size, 0);
  font.writeInt32LE(bold ? 700 : 400, 16);
  font.writeUInt8(1, 23); // DEFAULT_CHARSET
  font.write(UI_FONT, 28, 'utf16le');
  return `hex:${[...font].map((b) => b.toString(16).padStart(2, '0')).join(',')}`;
}

/** Windows' UI size: 9 points, 12 pixels at 96 dpi. */
const UI_FONT_PX = 12;

/**
 * The regedit script that gives Din's prefix Windows' look, in Din's
 * light or dark mode. STYLE is Light's Windows path, or null for an older
 * Wine without it.
 */
export function lookRegistry(dark: boolean, style: string | null): string {
  const light = dark ? 0 : 1;
  const font = logFont(UI_FONT_PX);
  return [
    'REGEDIT4',
    '',
    '[HKEY_CURRENT_USER\\Control Panel\\Colors]',
    ...Object.entries(LIGHT_COLORS).map(([name, color]) => `"${name}"="${color}"`),
    '',
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\ThemeManager]',
    ...(style
      ? ['"ThemeActive"="1"', `"DllName"="${style.replaceAll('\\', '\\\\')}"`, '"ColorName"="Blue"', '"SizeName"="NormalSize"']
      : ['"ThemeActive"="0"']),
    '',
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize]',
    `"AppsUseLightTheme"=dword:0000000${light}`,
    `"SystemUsesLightTheme"=dword:0000000${light}`,
    '',
    // Menus, message boxes, status bars, title bars: Windows' Segoe UI 9.
    '[HKEY_CURRENT_USER\\Control Panel\\Desktop\\WindowMetrics]',
    `"CaptionFont"=${font}`,
    `"SmCaptionFont"=${font}`,
    `"MenuFont"=${font}`,
    `"StatusFont"=${font}`,
    `"MessageFont"=${font}`,
    `"IconFont"=${font}`,
    '',
    '[HKEY_CURRENT_USER\\Control Panel\\Desktop]',
    '"FontSmoothing"="2"',
    '"FontSmoothingType"=dword:00000001',
    // Hover effects on; keyboard cues only once the keyboard is used.
    '"UserPreferencesMask"=hex:90,00,02,80,12,00,00,00',
    '',
    // Dialogs, and programs that name Windows' UI fonts. Substitutes win
    // over fonts Wine has (its Tahoma); replacements fill in ones it hasn't.
    '[HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes]',
    `"MS Shell Dlg"="${UI_FONT}"`,
    `"MS Shell Dlg 2"="${UI_FONT}"`,
    `"Tahoma"="${UI_FONT}"`,
    '',
    '[HKEY_CURRENT_USER\\Software\\Wine\\Fonts\\Replacements]',
    `"Segoe UI"="${UI_FONT}"`,
    `"Microsoft Sans Serif"="${UI_FONT}"`,
    `"Tahoma"=-`,
    '',
  ].join('\r\n');
}
