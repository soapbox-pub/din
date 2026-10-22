import { createContext } from "react";
import type { ProfileThemeMetadata } from "@/lib/profileTheme";
import type { CursorTheme } from "@/lib/cursorTheme";

export type Theme = "dark" | "light" | "system";

/** 12- or 24-hour time, or whichever the locale uses. */
export type ClockFormat = "auto" | "12" | "24";

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
   * desktop state (settings, taskbar pins, …) is NIP-44 encrypted and synced
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
   * When true (default), dragging a window runs the Compiz wobbly-windows
   * spring model so it wriggles like jelly. Automatically suppressed when
   * the system prefers reduced motion.
   */
  wobblyWindows: boolean;
  /**
   * Interface zoom level, as a percentage (100 = native size). Applied via
   * Chromium page zoom in the Electron shell (DPI-style scaling of the whole
   * desktop); has no effect in a plain browser, where the browser's own zoom
   * applies. Device-specific, so it is kept local and never synced.
   */
  zoomLevel: number;
  /**
   * User-selected custom cursor theme (e.g. a `.CurXPTheme`), parsed into
   * source-format-agnostic cursor images. `null` uses the native OS cursor.
   * Stored inline (cursor frames are PNG data URLs) so the cursor persists
   * across reloads without re-selecting the file.
   */
  customCursor: CursorTheme | null;
  /** Whether clocks (menu bar, boot and lock screens) show 12- or 24-hour time. */
  clockFormat: ClockFormat;
  /** Whether the menu-bar clock shows the weekday and date beside the time. */
  clockShowDate: boolean;
  /** Whether the menu-bar clock shows seconds. */
  clockShowSeconds: boolean;
}

export interface AppContextType {
  /** Current application configuration */
  config: AppConfig;
  /** Update configuration using a callback that receives current config and returns new config */
  updateConfig: (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => void;
}

export const AppContext = createContext<AppContextType | undefined>(undefined);
