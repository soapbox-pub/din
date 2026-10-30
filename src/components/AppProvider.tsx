import { ReactNode, useCallback, useEffect, useMemo } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme } from '@/contexts/AppContext';
import { AppConfigSchema } from '@/lib/appConfigSchema';
import { getZoomBridge } from '@/lib/zoom';
import { setConfiguredTheme } from '@/lib/rootScheme';

interface AppProviderProps {
  children: ReactNode;
  /** Application storage key */
  storageKey: string;
  /** Default app configuration */
  defaultConfig: AppConfig;
}

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
