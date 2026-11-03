import { useState } from 'react';
import type { AppComponentProps } from '@/lib/apps';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { AddProvider } from '@/shared/assistant/Providers';

/**
 * Adding an AI provider, or reconnecting one, in a window of its own
 * (src/shared/assistant/providerWindow.ts): launch params `provider`, the
 * one to reconnect or null to pick, and `at`, which starts it over when
 * it's opened again. It closes once the provider is connected.
 */
export function ProviderWindow({ windowId, params }: AppComponentProps) {
  const { close } = useWindowActions();
  const [title, setTitle] = useState('Add an AI Provider');
  useWindowTitle(title);
  const provider = typeof params?.provider === 'string' ? params.provider : null;

  return (
    <div className="h-full bg-background">
      <AddProvider
        key={`${String(params?.at)}:${provider}`}
        provider={provider}
        onTitle={setTitle}
        onDone={() => close(windowId)}
      />
    </div>
  );
}
