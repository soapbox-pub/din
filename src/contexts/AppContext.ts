import { createContext } from "react";
import type { DesktopTheme, ProfileThemeMetadata } from "@/lib/profileTheme";

export type Theme = "dark" | "light" | "system";

/** 12- or 24-hour time, or whichever the locale uses. */
export type ClockFormat = "auto" | "12" | "24";

/** What the Dock sits on: nothing, or a macOS Dock's backdrop of today or of old. */
export type DockStyle = "none" | "modern" | "classic";

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
   * Whether windows tile, Hyprland style, instead of floating: they share
   * each monitor's workspace between them (see src/lib/tiling.ts). Kept on
   * this device, like wobbly windows.
   */
  tilingEnabled: boolean;
  /** Pixels between tiled windows, and between them and the screen's edges. */
  tilingGap: number;
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
  /**
   * Interface zoom level, as a percentage (100 = native size). Applied via
   * Chromium page zoom in the Electron shell (DPI-style scaling of the whole
   * desktop); has no effect in a plain browser, where the browser's own zoom
   * applies. Device-specific, so it is kept local and never synced.
   */
  zoomLevel: number;
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
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
