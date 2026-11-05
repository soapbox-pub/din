// Import polyfills first
import './lib/polyfills.ts';
// Before anything opens a 2D canvas: keep them all off the GPU (see the module).
import { installCpuCanvas } from './lib/cpuCanvas.ts';
installCpuCanvas();
// Profiling builds only: probes wrapping WebSocket/timers/the React DevTools
// hook, which must be in place before react-dom loads and any socket opens.
import '@/lib/perfRuntimeInstall';

import { createRoot } from 'react-dom/client';
import { installWebNotification } from './lib/webNotification.ts';
import { installCapturePointer } from './lib/capturePointer.ts';
import { installLiquidGlass } from '@/shared/liquidGlass';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';

import '@fontsource-variable/inter/index.css';

installWebNotification();
installCapturePointer();
installLiquidGlass();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
