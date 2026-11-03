import { createContext } from "react";
import type { DesktopTheme, ProfileThemeMetadata } from "@/lib/profileTheme";
import type { DesktopIconSize } from "@/lib/desktopIcons";
import type { ColorFilter } from "@/lib/accessibility";

export type Theme = "dark" | "light" | "system";

/** 12- or 24-hour time, or whichever the locale uses. */
export type ClockFormat = "auto" | "12" | "24";

/**
 * How the desktop is laid out: a menu bar along the top and the Dock along
 * the bottom, or one taskbar along the bottom with a Start menu, Windows style.
 */
export type DesktopLayout = "dock" | "taskbar";

/** What the Dock sits on: nothing, or a macOS Dock's backdrop of today or of old. */
export type DockStyle = "none" | "modern" | "classic";

/**
 * The taskbar's build: tall, Windows 7 style, with bigger icons, or slim,
 * Windows Vista style.
 */
export type TaskbarStyle = "tall" | "slim";

/**
 * The screen edge the taskbar runs along: the bottom, Windows style, the
 * top, the left, Ubuntu style, or the right.
 */
export type TaskbarPosition = "bottom" | "top" | "left" | "right";

/**
 * What the taskbar's buttons stand for: an app each, its windows combined
 * (Windows 7), or a window each, labeled with its title (Windows XP, Vista).
 */
export type TaskbarButtons = "combine" | "separate";

export interface RelayMetadata {
  /** List of relays with read/write permissions */
  relays: { url: string; read: boolean; write: boolean }[];
  /** Unix timestamp of when the relay list was last updated */
  updatedAt: number;
}

/** Blossom server list metadata (BUD-03 / kind 10063), mirroring RelayMetadata for parity. */
export interface BlossomServerMetadata {
  /** Ordered list of Blossom server URLs (most trusted/reliable first per BUD-03). */
  servers: string[];
  /** Unix timestamp of when the server list was last updated (from kind 10063 created_at). */
  updatedAt: number;
}

export interface AppConfig {
  /** Current theme */
  theme: Theme;
  /**
   * Master switch for Din's encrypted app-data sync. When true (default),
   * desktop state (settings, installed web apps, …) is NIP-44 encrypted and synced
   * to the user's relays as kind 30078 events. When false, Din operates
   * entirely locally and never publishes app data.
   */
  syncToNostr: boolean;
  /** NIP-65 relay list metadata */
  relayMetadata: RelayMetadata;
  /** User's kind 10063 Blossom server list. */
  blossomServerMetadata: BlossomServerMetadata;
  /**
   * When true, the app's default Blossom servers are merged with the user's
   * servers (app servers first, deduped). When false, only the user's servers
   * are used.
   */
  useAppBlossomServers: boolean;
  /**
   * The logged-in user's active profile theme (kind 16767, Profile Themes
   * NIP). When present and matching the current user's pubkey, it is applied
   * as the theme of the entire OS.
   */
  profileThemeMetadata: ProfileThemeMetadata;
  /**
   * Whether the desktop wears a custom theme (colors, fonts and background)
   * rather than the built-in light or dark one `theme` names. When there is
   * no custom theme to wear, `theme` applies either way.
   */
  customThemeEnabled: boolean;
  /**
   * When true (default), the custom theme is the profile theme: Din wears
   * the one the user publishes, and publishes their edits. When false, this
   * computer keeps `localTheme` and leaves the profile theme alone.
   */
  syncProfileTheme: boolean;
  /** The custom theme kept on this computer, worn while `syncProfileTheme` is off. */
  localTheme: DesktopTheme | null;
  /**
   * When true (default), dragging a window runs the Compiz wobbly-windows
   * spring model so it wriggles like jelly. Automatically suppressed when
   * the system prefers reduced motion.
   */
  wobblyWindows: boolean;
  /**
   * When true (default), the computer runs in the performance power mode
   * while a game is in full screen, and goes back to the mode it was in
   * after (GamePerformanceHost.tsx).
   */
  gamePerformance: boolean;
  /**
   * The effect a window minimizes with, and plays backwards to restore: an
   * id from src/lib/effects, `random` or `none`. Kept as a plain string so
   * a choice this version doesn't know falls back rather than failing to
   * load the config.
   */
  minimizeEffect: string;
  /** The effect a window closes with: an id from src/lib/effects, `random`, `pop` or `none`. */
  closeEffect: string;
  /**
   * What the pointer leaves behind as it moves: a trail's id from
   * src/lib/cursorEffects, `cursorfx:…` for an imported one, or `none`.
   * Imported ones are this computer's, like everything here.
   */
  cursorTrail: string;
  /** What a click sets off: an id from src/lib/cursorEffects, `cursorfx:…`, or `none`. */
  cursorClick: string;
  /** Compiz's Show Mouse: Super+Shift+K, or shaking the mouse, rings the pointer with light. */
  cursorShowMouse: boolean;
  /** As on a Mac: shaking the mouse makes the pointer big for a moment, so it's easy to find. */
  cursorShakeToFind: boolean;
  /** Compiz's Fire Paint: Super+Shift and drag to draw in fire; Super+Shift+C puts it out. */
  cursorFirePaint: boolean;
  /** Compiz's Water: hold Super+Ctrl and move the mouse to stir the screen like a pond. */
  cursorWater: boolean;
  /** Whether cursor effects take on the theme's color instead of their own. */
  cursorThemeColor: boolean;
  /**
   * Power mode (after activate-power-mode): once you've typed a while without
   * stopping, every keystroke throws sparks from the caret (src/lib/powerMode.ts).
   */
  powerMode: boolean;
  /** Whether power mode also shakes the window being typed in. */
  powerModeShake: boolean;
  /**
   * Which way scrolling moves the page: `natural` with the finger, as on a
   * phone, `traditional` the way a wheel turns, or `auto`, natural where a
   * finger slides (a touchpad, a Magic Mouse) and a wheel's way with a wheel.
   * Settings → Mouse; din-shell applies these (src/lib/mouse.ts).
   */
  mouseScrollDirection: 'auto' | 'natural' | 'traditional';
  /** How fast the pointer goes, -1 to 1, 0 as it comes. */
  mouseTrackingSpeed: number;
  /** How far a scroll goes, 0.25 to 4 times as far as it comes. */
  mouseScrollSpeed: number;
  /** The secondary click: the right button, the left (swapping them), or none. */
  mouseSecondaryClick: 'right' | 'left' | 'off';
  /** A Magic Mouse's middle third clicks the middle button; a Mac has none. */
  mouseMiddleClick: boolean;
  /** What two fingers swiped sideways on a Magic Mouse do. */
  mouseSwipe: 'pages' | 'workspaces' | 'off';
  /**
   * Whether windows tile, Hyprland style, instead of floating: they share
   * each monitor's workspace between them (see src/lib/tiling.ts). Kept on
   * this device, like wobbly windows.
   */
  tilingEnabled: boolean;
  /** Pixels between tiled windows, and between them and the screen's edges. */
  tilingGap: number;
  /**
   * Whether Din reopens the windows it had open when it starts again, each
   * where it was (src/lib/windowSession.ts). Kept on this device.
   */
  restoreWindows: boolean;
  /**
   * The menu bar and Dock (default), or a taskbar along an edge of the
   * screen in their place, with the Start menu, open windows and status icons.
   */
  desktopLayout: DesktopLayout;
  /** Whether Dock icons grow as the pointer sweeps across them. */
  dockMagnification: boolean;
  /** How large an icon under the pointer grows, as a multiple of its size (1.5 = half again). */
  dockMagnificationScale: number;
  /** The width and height of a Dock icon's slot, in px. */
  dockSize: number;
  /**
   * The Dock's backdrop: none (icons over the wallpaper), modern (macOS's
   * frosted panel since Big Sur) or classic (Leopard's glass shelf).
   */
  dockStyle: DockStyle;
  /** The taskbar's build: tall (Windows 7) or slim (Windows Vista). */
  taskbarStyle: TaskbarStyle;
  /** The screen edge the taskbar runs along: bottom, top, left, or right. */
  taskbarPosition: TaskbarPosition;
  /** Whether the taskbar has a button per app, its windows combined, or one per window. */
  taskbarButtons: TaskbarButtons;
  /** Whether what's in ~/Desktop shows as icons on the wallpaper (docs/desktop-icons.md). */
  desktopIcons: boolean;
  /** How large desktop icons are. */
  desktopIconSize: DesktopIconSize;
  /**
   * Interface zoom level, as a percentage (100 = native size). Applied via
   * Chromium page zoom in the Electron shell (DPI-style scaling of the whole
   * desktop); has no effect in a plain browser, where the browser's own zoom
   * applies. Device-specific, so it is kept local and never synced. Unset,
   * it's the primary display's automatic zoom (src/lib/autoZoom.ts).
   */
  zoomLevel: number;
  /**
   * Accessibility (src/lib/accessibility.ts): Din's own motion is cut down
   * to what's needed, as if the system preferred reduced motion, in the
   * desktop and its apps.
   */
  reduceMotion: boolean;
  /** Panels, menus and windows are solid instead of frosted glass. */
  reduceTransparency: boolean;
  /** Stronger borders, secondary text and focus rings; implies reduceTransparency. */
  increaseContrast: boolean;
  /** Text size, as a percentage (100 = normal), without scaling the rest of the layout as zoom does. */
  textSize: number;
  /**
   * The screen, done by din-shell so it reaches every app
   * (src/lib/accessibility.ts): Super+Alt+8, = and - zoom the screen.
   */
  screenZoomKeys: boolean;
  /** A colour filter on the whole screen: inverted, greyscale, or corrected for a colour blindness. */
  colorFilter: ColorFilter;
  /** Shift, Ctrl, Alt or Super pressed on its own stays down for the next key. */
  stickyKeys: boolean;
  /** A key only counts once it's been held a moment. */
  slowKeys: boolean;
  /** A key pressed again just after it came up is left out. */
  bounceKeys: boolean;
  /** Whether clocks (menu bar, boot and lock screens) show 12- or 24-hour time. */
  clockFormat: ClockFormat;
  /** Whether the menu-bar clock shows the weekday and date beside the time. */
  clockShowDate: boolean;
  /** Whether the menu-bar clock shows seconds. */
  clockShowSeconds: boolean;
  /**
   * Whether the assistant is on: Din keeps OpenCode's server running and
   * shows the assistant in the menu bar (see electron/assistant.mts). Kept on
   * this device, like everything OpenCode itself keeps.
   */
  assistantEnabled: boolean;
  /** The folder new assistant conversations work in; empty for the home folder. */
  assistantDirectory: string;
  /** Whether the assistant's replies color their headings, emphasis, code and links. */
  assistantColorfulReplies: boolean;
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
  /** Whether `config.zoomLevel` is the display's automatic zoom, the user having set none. */
  zoomAutomatic: boolean;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
