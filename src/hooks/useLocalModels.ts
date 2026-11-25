import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getLocalModelsBridge, type LocalModelsState } from '@/lib/localModels';

export const LOCAL_MODELS_KEY = ['local-models', 'state'] as const;

/**
 * Ollama and its models (src/lib/localModels.ts). The main process pushes
 * the state as it changes (a download's progress, a model loaded), and
 * it's asked again when Settings comes back to it, for what `ollama` in a
 * Terminal changed meanwhile.
 */
export function useLocalModels() {
  const bridge = getLocalModelsBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!bridge) return;
    return bridge.onChanged((state) => queryClient.setQueryData(LOCAL_MODELS_KEY, state));
  }, [bridge, queryClient]);

  return useQuery<LocalModelsState>({
    queryKey: LOCAL_MODELS_KEY,
    queryFn: () => {
      if (!bridge) throw new Error('Local models bridge unavailable');
      return bridge.state();
    },
    enabled: bridge !== undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}
