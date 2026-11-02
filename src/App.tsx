// NOTE: This file should normally not be modified unless you are adding a new provider.
// To add new routes, edit the AppRouter.tsx file.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHead, UnheadProvider } from '@unhead/react/client';
import { InferSeoMetaPlugin } from 'unhead/plugins';
import { Suspense } from 'react';
import NostrProvider from '@/components/NostrProvider';
import { NostrSync } from '@/components/NostrSync';
import { NostrdSync } from '@/components/NostrdSync';
import { AppDataSync } from '@/components/AppDataSync';
import { ProfileThemeApplier } from '@/components/ProfileThemeApplier';
import { IconThemeSync } from '@/components/IconThemeSync';
import { TooltipProvider } from "@/components/ui/tooltip";
import { NostrLoginProvider } from '@nostrify/react/login';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';
import { APP_RELAYS } from '@/lib/appRelays';
import { instrumentQueryCache } from '@/lib/perfRuntime';
import AppRouter from './AppRouter';

const head = createHead({
  plugins: [
    InferSeoMetaPlugin(),
  ],
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60000, // 1 minute
      gcTime: Infinity,
    },
  },
});

// Profiling builds only (`__dinPerf.runtime()`).
if (import.meta.env.VITE_PROFILE === "1") instrumentQueryCache(queryClient.getQueryCache());

const defaultConfig: AppConfig = {
  theme: "dark",
  syncToNostr: true,
  relayMetadata: APP_RELAYS,
  blossomServerMetadata: {
    servers: [
      'https://blossom.ditto.pub/',
      'https://blossom.dreamith.to/',
      'https://blossom.primal.net/',
    ],
    updatedAt: 0,
  },
  useAppBlossomServers: true,
  profileThemeMetadata: {
    theme: null,
    pubkey: null,
    updatedAt: 0,
  },
  customThemeEnabled: true,
  syncProfileTheme: true,
  localTheme: null,
  wobblyWindows: true,
  minimizeEffect: 'magic-lamp',
  closeEffect: 'pop',
  cursorTrail: 'none',
  cursorClick: 'fireworks',
  cursorShowMouse: false,
  cursorShakeToFind: true,
  cursorFirePaint: false,
  cursorWater: false,
  cursorThemeColor: false,
  powerMode: false,
  powerModeShake: true,
  mouseScrollDirection: 'auto',
  mouseTrackingSpeed: 0,
  mouseScrollSpeed: 1,
  mouseSecondaryClick: 'right',
  mouseMiddleClick: false,
  mouseSwipe: 'pages',
  tilingEnabled: false,
  tilingGap: 8,
  restoreWindows: true,
  desktopLayout: 'dock',
  dockMagnification: true,
  dockMagnificationScale: 1.5,
  dockSize: 80,
  dockStyle: 'none',
  taskbarStyle: 'tall',
  taskbarPosition: 'bottom',
  taskbarButtons: 'combine',
  desktopIcons: true,
  desktopIconSize: 'medium',
  zoomLevel: 100,
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
  textSize: 100,
  screenZoomKeys: false,
  colorFilter: 'none',
  stickyKeys: false,
  slowKeys: false,
  bounceKeys: false,
  clockFormat: 'auto',
  clockShowDate: true,
  clockShowSeconds: false,
  assistantEnabled: true,
  assistantDirectory: '',
  assistantColorfulReplies: true,
};

export function App() {
  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey="nostr:app-config" defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey='nostr:login'>
            <NostrProvider>
              <NostrSync />
              <NostrdSync />
              <AppDataSync />
              <ProfileThemeApplier />
              <IconThemeSync />
              <TooltipProvider>
                <Suspense>
                  <AppRouter />
                </Suspense>
              </TooltipProvider>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default App;
