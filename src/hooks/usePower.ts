import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPowerBridge, setChargeLimit, setChargeLimitPercent } from '@/lib/power';
import type { ChargeLimitStatus, PowerProfilesStatus, PowerStatus } from '@/lib/power';

/**
 * TanStack Query hook over the OS power bridge (window.dinos.power).
 *
 * Polls on a short interval so the menu-bar indicator and Settings panel track
 * charge level and charging state as they change.
 */
export function useBatteryStatus() {
  const power = getPowerBridge();
  return useQuery<PowerStatus>({
    queryKey: ['power', 'status'],
    queryFn: () => {
      const bridge = getPowerBridge();
      if (!bridge) throw new Error('Power bridge unavailable');
      return bridge.status();
    },
    enabled: power !== undefined,
    refetchInterval: 10_000,
    retry: false,
  });
}

/**
 * Available system power profiles and the active one, over the power bridge
 * (window.dinos.power). Polls slowly since profiles rarely change on their own (a
 * laptop unplug can flip it), and refetches after a manual switch.
 */
export function usePowerProfiles() {
  const power = getPowerBridge();
  return useQuery<PowerProfilesStatus>({
    queryKey: ['power', 'profiles'],
    queryFn: () => {
      const bridge = getPowerBridge();
      if (!bridge) throw new Error('Power bridge unavailable');
      return bridge.profiles();
    },
    enabled: power !== undefined,
    refetchInterval: 15_000,
    retry: false,
  });
}

/** The battery's charge limit (UPower), polled slowly: only Settings or `din` changes it. */
export function useChargeLimit() {
  const power = getPowerBridge();
  return useQuery<ChargeLimitStatus>({
    queryKey: ['power', 'chargeLimit'],
    queryFn: () => {
      const bridge = getPowerBridge();
      if (!bridge) throw new Error('Power bridge unavailable');
      return bridge.chargeLimit();
    },
    enabled: power !== undefined,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Turn the charge limit on or off, priming the cache with the new state. */
export function useSetChargeLimit() {
  const queryClient = useQueryClient();
  return useMutation<ChargeLimitStatus, Error, boolean>({
    mutationFn: setChargeLimit,
    onSuccess: (limit) => {
      queryClient.setQueryData(['power', 'chargeLimit'], limit);
      void queryClient.invalidateQueries({ queryKey: ['power', 'status'] });
    },
  });
}

/** Choose where the charge limit stops charging, priming the cache with the new state. */
export function useSetChargeLimitPercent() {
  const queryClient = useQueryClient();
  return useMutation<ChargeLimitStatus, Error, number>({
    mutationFn: setChargeLimitPercent,
    onSuccess: (limit) => {
      queryClient.setQueryData(['power', 'chargeLimit'], limit);
      void queryClient.invalidateQueries({ queryKey: ['power', 'status'] });
    },
  });
}

/** Switch the active power profile, priming the cache with the new state. */
export function useSetPowerProfile() {
  const queryClient = useQueryClient();
  return useMutation<PowerProfilesStatus, Error, string>({
    mutationFn: (name: string) => {
      const bridge = getPowerBridge();
      if (!bridge) throw new Error('Power bridge unavailable');
      return bridge.setProfile(name);
    },
    onSuccess: (status) => {
      queryClient.setQueryData(['power', 'profiles'], status);
    },
  });
}
