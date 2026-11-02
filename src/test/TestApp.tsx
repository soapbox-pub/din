import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createHead, UnheadProvider } from '@unhead/react/client';
import { BrowserRouter } from 'react-router-dom';
import { NostrLoginProvider } from '@nostrify/react/login';
import NostrProvider from '@/components/NostrProvider';
import { AppProvider } from '@/components/AppProvider';
import { AppConfig } from '@/contexts/AppContext';

interface TestAppProps {
  children: React.ReactNode;
}

export function TestApp({ children }: TestAppProps) {
  const head = createHead();

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const defaultConfig: AppConfig = {
    theme: 'light',
    syncToNostr: true,
    relayMetadata: {
      relays: [
        { url: 'wss://relay.primal.net', read: true, write: true },
      ],
      updatedAt: 0,
    },
    blossomServerMetadata: {
      servers: ['https://blossom.primal.net/'],
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
    cursorClick: 'none',
    cursorShowMouse: false,
    cursorFirePaint: false,
    cursorWater: false,
    cursorThemeColor: false,
    powerMode: false,
    powerModeShake: true,
    tilingEnabled: false,
    tilingGap: 8,
    restoreWindows: true,
    desktopLayout: 'dock',
    dockMagnification: true,
    dockMagnificationScale: 1.5,
    dockSize: 80,
    dockStyle: 'none',
    taskbarStyle: 'tall',
    taskbarButtons: 'combine',
    zoomLevel: 100,
    clockFormat: 'auto',
    clockShowDate: true,
    clockShowSeconds: false,
    assistantEnabled: true,
    assistantDirectory: '',
    assistantColorfulReplies: true,
  };

  return (
    <UnheadProvider head={head}>
      <AppProvider storageKey='test-app-config' defaultConfig={defaultConfig}>
        <QueryClientProvider client={queryClient}>
          <NostrLoginProvider storageKey='test-login'>
            <NostrProvider>
              <BrowserRouter>
                {children}
              </BrowserRouter>
            </NostrProvider>
          </NostrLoginProvider>
        </QueryClientProvider>
      </AppProvider>
    </UnheadProvider>
  );
}

export default TestApp;