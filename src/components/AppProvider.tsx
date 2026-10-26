import { ReactNode, useCallback, useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme, type RelayMetadata, type BlossomServerMetadata } from '@/contexts/AppContext';
import { DesktopThemeSchema, ProfileThemeMetadataSchema } from '@/lib/profileTheme';
import { getZoomBridge } from '@/lib/zoom';

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

// Zod schema for a parsed custom cursor theme. Cursor frames are stored as
// PNG data URLs; we validate the shape but keep the data URLs opaque.
const CursorImageSchema = z.object({
  frames: z.array(z.string().startsWith('data:image/')).min(1),
  intervalMs: z.number(),
  width: z.number(),
  height: z.number(),
  hotX: z.number(),
  hotY: z.number(),
});

const CursorThemeSchema = z.object({
  name: z.string(),
  format: z.literal('curxptheme'),
  cursors: z.record(z.string(), CursorImageSchema),
});

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
  zoomLevel: z.number(),
  customCursor: CursorThemeSchema.nullable(),
  clockFormat: z.enum(['auto', '12', '24']),
  clockShowDate: z.boolean(),
  clockShowSeconds: z.boolean(),
  assistantEnabled: z.boolean(),
  assistantDirectory: z.string(),
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

/**
 * Hook to apply theme changes to the document root
 */
function useApplyTheme(theme: Theme) {
  useEffect(() => {
    const root = window.document.documentElement;

    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light';

      root.classList.add(systemTheme);
      return;
    }

    root.classList.add(theme);
  }, [theme]);

  // Handle system theme changes when theme is set to "system"
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = () => {
      const root = window.document.documentElement;
      root.classList.remove('light', 'dark');

      const systemTheme = mediaQuery.matches ? 'dark' : 'light';
      root.classList.add(systemTheme);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);
}