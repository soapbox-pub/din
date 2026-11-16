import { startApp } from '@/sdk/start';
import { AppStore } from './AppStore';
import { StoreProvider } from './StoreProvider';

void startApp(() => (
  <StoreProvider>
    <AppStore />
  </StoreProvider>
));
