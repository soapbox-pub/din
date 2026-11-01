import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPhoneDesktopBridge, type PhoneState } from '@/lib/phone';

const PHONE_KEY = ['phone', 'state'] as const;

function requireBridge() {
  const phone = getPhoneDesktopBridge();
  if (!phone) throw new Error('Phones aren’t available here');
  return phone;
}

/** The phones, the ones that could be added, and any pairing; main pushes changes, so this never polls. */
export function usePhoneState() {
  const phone = getPhoneDesktopBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!phone) return;
    return phone.onChanged((state) => queryClient.setQueryData(PHONE_KEY, state));
  }, [phone, queryClient]);

  return useQuery<PhoneState>({
    queryKey: PHONE_KEY,
    queryFn: () => requireBridge().state(),
    enabled: phone !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Look for Android phones on the network, and take their pairing requests,
 * while a component showing them is mounted. Main gives up on a search after
 * ten minutes, so this asks again every few.
 */
export function usePhoneDiscovery() {
  useEffect(() => {
    const phone = getPhoneDesktopBridge();
    if (!phone) return;
    const start = () => void phone.discover(true).catch(() => {});
    start();
    const timer = setInterval(start, 5 * 60_000);
    return () => {
      clearInterval(timer);
      void phone.discover(false).catch(() => {});
    };
  }, []);
}

export function usePhoneActions() {
  return {
    add: useMutation({ mutationFn: (id: string) => requireBridge().add(id) }),
    answer: useMutation({ mutationFn: ({ id, accept }: { id: string; accept: boolean }) => requireBridge().answer(id, accept) }),
    refresh: useMutation({ mutationFn: (id: string) => requireBridge().refresh(id) }),
    forget: useMutation({ mutationFn: (id: string) => requireBridge().forget(id) }),
  };
}
