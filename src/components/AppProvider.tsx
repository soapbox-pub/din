import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { AppContext, type AppConfig, type AppContextType, type Theme } from '@/contexts/AppContext';
import { AppConfigSchema } from '@/lib/appConfigSchema';
import { getZoomBridge } from '@/lib/zoom';
import { getSystemCursorBridge } from '@/lib/systemCursor';
import { autoZoomForOutputs } from '@/lib/autoZoom';
import { scalesToApply, withDisplayZoom } from '@/lib/displayZoom';
import { getDisplayBridge } from '@/lib/display';
import { getMonitorsBridge } from '@/lib/monitors';
import { applyAccessibility, getAccessibilityBridge } from '@/lib/accessibility';
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
  // Zoom the user hasn't set is the display's own (src/lib/autoZoom.ts).
  // Under din-shell each display has its own (src/lib/displayZoom.ts), and
  // the page itself isn't zoomed.
  const perDisplayZoom = usePerDisplayZoom(rawConfig.displayZoom, rawConfig.zoomLevel, updateConfig);
  const autoZoom = useAutoZoom(!perDisplayZoom);
  const zoomAutomatic = rawConfig.zoomLevel === undefined;
  const config = useMemo(
    () => ({
      ...defaultConfig,
      ...(autoZoom !== null && { zoomLevel: autoZoom }),
      ...rawConfig,
      ...(perDisplayZoom && { zoomLevel: 100 }),
    }),
    [defaultConfig, autoZoom, rawConfig, perDisplayZoom],
  );

  const appContextValue: AppContextType = useMemo(
    () => ({ config, updateConfig, zoomAutomatic, perDisplayZoom }),
    [config, updateConfig, zoomAutomatic, perDisplayZoom],
  );

  // Apply theme effects to document
  useApplyTheme(config.theme);

  // Apply the interface zoom level to the document root
  useApplyZoom(config.zoomLevel);

  useApplyAccessibility(config);

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
 * the viewport, overflowing the desktop (see src/lib/zoom.ts). The pointer
 * grows with it (electron/cursor.mts).
 */
function useApplyZoom(zoomLevel: number) {
  useEffect(() => {
    getZoomBridge()?.set(zoomLevel / 100);
    void getSystemCursorBridge()?.setScale(zoomLevel / 100).catch(() => {});
  }, [zoomLevel]);
}

const AUTO_ZOOM_KEY = 'din:auto-zoom';
const PER_DISPLAY_ZOOM_KEY = 'din:per-display-zoom';

/**
 * Whether each display has its own zoom (din-shell), kept from the last run
 * so the desktop starts unzoomed rather than zooming and then not. Where it
 * does, keeps every display at its zoom: CHOSEN's, else its automatic one,
 * as displays come and go and the user changes them. A zoom the user chose
 * for the whole desktop before (LEGACY) becomes the primary display's.
 */
function usePerDisplayZoom(
  chosen: Record<string, number> | undefined,
  legacy: number | undefined,
  updateConfig: AppContextType['updateConfig'],
): boolean {
  const [perDisplay, setPerDisplay] = useState(
    () => !!getDisplayBridge() && localStorage.getItem(PER_DISPLAY_ZOOM_KEY) === '1',
  );
  useEffect(() => {
    const display = getDisplayBridge();
    if (!display) return;
    let stale = false;
    // One at a time: applying scales changes the displays, which reads them again.
    let busy: Promise<void> = Promise.resolve();
    const sync = () => {
      busy = busy.then(async () => {
        if (stale) return;
        const status = await display.status();
        if (stale) return;
        const supported = status.available && status.perDisplayZoom === true;
        localStorage.setItem(PER_DISPLAY_ZOOM_KEY, supported ? '1' : '0');
        setPerDisplay(supported);
        if (!supported) return;
        const primary = status.outputs.find((o) => o.primary && o.enabled);
        if (chosen === undefined && legacy !== undefined && primary) {
          updateConfig((c) => withDisplayZoom(c, primary, legacy));
          return;
        }
        const scales = scalesToApply(status.outputs, chosen);
        if (scales) await display.setScales(scales);
      }).catch((error: unknown) => {
        console.warn('Could not zoom the displays:', error);
      });
    };
    sync();
    const off = getMonitorsBridge()?.onChange(sync);
    return () => {
      stale = true;
      off?.();
    };
  }, [chosen, legacy, updateConfig]);
  return perDisplay;
}

/**
 * The zoom for the primary display's pixel density, or null outside the
 * Electron shell or where its displays can't be read (or while ENABLED is
 * false, where each display has its own). Read again whenever the displays
 * change (one plugged in, the lid shut, a new resolution), and kept from the
 * last run so the desktop starts at it rather than jumping to it.
 */
function useAutoZoom(enabled: boolean): number | null {
  const [zoom, setZoom] = useState<number | null>(() => {
    if (!getDisplayBridge()) return null;
    const saved = Number(localStorage.getItem(AUTO_ZOOM_KEY));
    return saved > 0 ? saved : null;
  });
  useEffect(() => {
    const display = getDisplayBridge();
    if (!display || !enabled) return;
    let stale = false;
    const read = () => {
      display.status().then((status) => {
        if (stale || !status.available) return;
        const next = autoZoomForOutputs(status.outputs);
        if (next === null) return;
        localStorage.setItem(AUTO_ZOOM_KEY, String(next));
        setZoom(next);
      }, () => {});
    };
    read();
    const off = getMonitorsBridge()?.onChange(read);
    return () => {
      stale = true;
      off?.();
    };
  }, [enabled]);
  return zoom;
}

/**
 * Apply Settings → Accessibility to the document root, and pass it on to
 * guests and Linux apps, and to din-shell for the screen.
 */
function useApplyAccessibility(config: AppConfig) {
  const { reduceMotion, reduceTransparency, increaseContrast, textSize, glass } = config;
  const { screenZoomKeys: zoomKeys, colorFilter, stickyKeys, slowKeys, bounceKeys } = config;
  useEffect(() => {
    void getAccessibilityBridge()?.setScreen({ zoomKeys, colorFilter, stickyKeys, slowKeys, bounceKeys }).catch(() => {});
  }, [zoomKeys, colorFilter, stickyKeys, slowKeys, bounceKeys]);
  useEffect(() => {
    applyAccessibility({ reduceMotion, reduceTransparency, increaseContrast, textSize, glass });
  }, [reduceMotion, reduceTransparency, increaseContrast, textSize, glass]);
  useEffect(() => {
    void getAccessibilityBridge()?.set({ reduceMotion, reduceTransparency, highContrast: increaseContrast }).catch(() => {});
  }, [reduceMotion, reduceTransparency, increaseContrast]);
}

/** Apply the Light/Dark/System setting to the document root (src/lib/rootScheme.ts). */
function useApplyTheme(theme: Theme) {
  useEffect(() => setConfiguredTheme(theme), [theme]);
}
