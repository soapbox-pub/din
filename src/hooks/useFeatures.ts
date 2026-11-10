import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canInstallFeature, findFeature, getAppFeaturesBridge, type FeatureState, type FeaturesState } from '@/lib/features';

const FEATURES_KEY = ['features', 'state'] as const;

/**
 * The optional features, and what's being done to them, on the desktop or
 * in an app granted `features`. The main process pushes the whole state
 * whenever it changes (a download's progress included), so this never polls.
 */
export function useFeatures() {
  const features = getAppFeaturesBridge();
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

/**
 * An optional feature that this computer can install and doesn't have yet
 * (installing counts), or undefined: installed already, unknown, or not one
 * Din can install here.
 */
export function useInstallableFeature(id: string | null | undefined): FeatureState | undefined {
  const features = useFeatures();
  const feature = findFeature(features.data, id);
  return canInstallFeature(features.data, feature) ? feature : undefined;
}
