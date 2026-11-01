import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPhoneDesktopBridge, type PhoneState } from '@/lib/phone';

const PHONE_KEY = ['phone', 'state'] as const;

function requireBridge() {
  const phone = getPhoneDesktopBridge();
  if (!phone) throw new Error('Phones aren’t available here');
  return phone;
}

/** The phones, and the paired ones that could be added; main pushes changes, so this never polls. */
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

export function usePhoneActions() {
  return {
    add: useMutation({ mutationFn: (id: string) => requireBridge().add(id) }),
    refresh: useMutation({ mutationFn: (id: string) => requireBridge().refresh(id) }),
    forget: useMutation({ mutationFn: (id: string) => requireBridge().forget(id) }),
  };
}
