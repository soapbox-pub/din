import { createRoot } from 'react-dom/client';

// Import polyfills first
import './lib/polyfills.ts';
import { installWebNotification } from './lib/webNotification.ts';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import App from './App.tsx';
import './index.css';

import '@fontsource-variable/inter/index.css';

installWebNotification();

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
