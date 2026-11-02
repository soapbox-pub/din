/**
 * An app's entry point in one call: the desktop's polyfills and base
 * styles, connect(), and the providers app code expects (React Query,
 * tooltips, the app's toasts, window.din through DinProvider).
 */
import '@/lib/polyfills';
import { installCpuCanvas } from '@/lib/cpuCanvas';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { connect } from '@/sdk';
import { DinProvider } from '@/sdk/react';
import { launchedFiles } from '@/shared/fileHandles';
import { Toaster } from '@/shared/Toaster';
import '@fontsource-variable/inter/index.css';
import '@/sdk/app.css';

installCpuCanvas();

/** Connect to the desktop, then render the app into #root. */
export async function startApp(render: () => ReactNode): Promise<void> {
  const din = await connect();
  // The window's launch files, so apps' first render can open them.
  await launchedFiles();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 60_000 } },
  });
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <DinProvider din={din}>
          <TooltipProvider>
            <Toaster>{render()}</Toaster>
          </TooltipProvider>
        </DinProvider>
      </QueryClientProvider>
    </ErrorBoundary>,
  );
}
