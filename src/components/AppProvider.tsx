import { ReactNode, useCallback, useEffect, useMemo } from 'react';
import { z } from 'zod';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme, type RelayMetadata, type BlossomServerMetadata } from '@/contexts/AppContext';
import { ProfileThemeMetadataSchema } from '@/lib/profileTheme';

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
  wobblyWindows: z.boolean(),
  zoomLevel: z.number(),
  customCursor: CursorThemeSchema.nullable(),
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
 * Hook to apply the interface zoom level to the document root. The stored
 * value is a percentage (100 = native), applied via the CSS `zoom` property so
 * it scales the whole desktop - windows, coordinates and hit-testing included -
 * everywhere Din runs (Electron, cage, or a plain browser).
 */
function useApplyZoom(zoomLevel: number) {
  useEffect(() => {
    const root = window.document.documentElement;
    root.style.zoom = String(zoomLevel / 100);
    return () => {
      root.style.zoom = '';
    };
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