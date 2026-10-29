import { ReactNode, useCallback, useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme, type RelayMetadata, type BlossomServerMetadata } from '@/contexts/AppContext';
import { DesktopThemeSchema, ProfileThemeMetadataSchema } from '@/lib/profileTheme';
import { getZoomBridge } from '@/lib/zoom';
import { setConfiguredTheme } from '@/lib/rootScheme';

interface AppProviderProps {
  children: ReactNode;
  /** Application storage key */
  storageKey: string;
  /** Default app configuration */
  defaultConfig: AppConfig;
}

// Zod schema for RelayMetadata validation
const RelayMetadataSchema = z.object({
  relays: z.array(z.object({
    url: z.url(),
    read: z.boolean(),
    write: z.boolean(),
  })),
  updatedAt: z.number(),
}) satisfies z.ZodType<RelayMetadata>;

// Zod schema for BlossomServerMetadata validation
const BlossomServerMetadataSchema = z.object({
  servers: z.array(z.url()),
  updatedAt: z.number(),
}) satisfies z.ZodType<BlossomServerMetadata>;

// Zod schema for AppConfig validation
const AppConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  syncToNostr: z.boolean(),
  relayMetadata: RelayMetadataSchema,
  blossomServerMetadata: BlossomServerMetadataSchema,
  useAppBlossomServers: z.boolean(),
  profileThemeMetadata: ProfileThemeMetadataSchema,
  customThemeEnabled: z.boolean(),
  syncProfileTheme: z.boolean(),
  localTheme: DesktopThemeSchema.nullable(),
  wobblyWindows: z.boolean(),
  minimizeEffect: z.string(),
  closeEffect: z.string(),
  tilingEnabled: z.boolean(),
  tilingGap: z.number().min(0).max(64),
  dockMagnification: z.boolean(),
  dockMagnificationScale: z.number().min(1).max(3),
  dockSize: z.number().min(32).max(160),
  dockStyle: z.enum(['none', 'modern', 'classic']),
  zoomLevel: z.number(),
  clockFormat: z.enum(['auto', '12', '24']),
  clockShowDate: z.boolean(),
  clockShowSeconds: z.boolean(),
  assistantEnabled: z.boolean(),
  assistantDirectory: z.string(),
  assistantColorfulReplies: z.boolean(),
}) satisfies z.ZodType<AppConfig>;

export function AppProvider(props: AppProviderProps) {
  const {
    children,
    storageKey,
    defaultConfig,
  } = props;

  // App configuration state with localStorage persistence
  const [rawConfig, setConfig] = useLocalStorage<Partial<AppConfig>>(
    storageKey,
    {},
    {
      serialize: JSON.stringify,
      deserialize: (value: string) => {
        const parsed = JSON.parse(value);
        return AppConfigSchema.partial().parse(parsed);
      }
    }
  );

  // Generic config updater with callback pattern
  const updateConfig = useCallback(
    (updater: (currentConfig: Partial<AppConfig>) => Partial<AppConfig>) => {
      setConfig(updater);
    },
    [setConfig],
  );

  // Memoized so context consumers (every desktop window reads the config)
  // only re-render when the config actually changes, not whenever an
  // ancestor re-renders this provider.
  const config = useMemo(
    () => ({ ...defaultConfig, ...rawConfig }),
    [defaultConfig, rawConfig],
  );

  const appContextValue: AppContextType = useMemo(
    () => ({ config, updateConfig }),
    [config, updateConfig],
  );

  // Apply theme effects to document
  useApplyTheme(config.theme);

  // Apply the interface zoom level to the document root
  useApplyZoom(config.zoomLevel);

  return (
    <AppContext.Provider value={appContextValue}>
      {children}
    </AppContext.Provider>
  );
}

/**
 * Hook to apply the interface zoom level. The stored value is a percentage
 * (100 = native), applied through Chromium's page zoom via the Electron
 * preload bridge - true DPI-style scaling where the layout viewport itself
 * shrinks/grows, so the window manager's pixel math and xterm's cell
 * measurements stay consistent. No-op in a plain browser (no bridge); CSS
 * `zoom` is deliberately not a fallback because it scales rendering without
 * the viewport, overflowing the desktop (see src/lib/zoom.ts).
 */
function useApplyZoom(zoomLevel: number) {
  useEffect(() => {
    getZoomBridge()?.set(zoomLevel / 100);
  }, [zoomLevel]);
}

/** Apply the Light/Dark/System setting to the document root (src/lib/rootScheme.ts). */
function useApplyTheme(theme: Theme) {
  useEffect(() => setConfiguredTheme(theme), [theme]);
}
