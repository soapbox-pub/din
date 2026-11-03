import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getFeaturesBridge, type FeaturesState } from '@/lib/features';

const FEATURES_KEY = ['features', 'state'] as const;

/**
 * DinOS's optional features, and what's being done to them. The main
 * process pushes the whole state whenever it changes (a download's progress
 * included), so this never polls.
 */
export function useFeatures() {
  const features = getFeaturesBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!features) return;
    return features.onChanged((state) => queryClient.setQueryData(FEATURES_KEY, state));
  }, [features, queryClient]);

  return useQuery<FeaturesState>({
    queryKey: FEATURES_KEY,
    queryFn: () => {
      if (!features) throw new Error('Optional features bridge unavailable');
      return features.state();
    },
    enabled: features !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}
