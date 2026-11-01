import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { PhoneAppBridge, PhoneConversation, PhoneState } from '@/lib/phone';

export function usePhone(): PhoneAppBridge | null {
  return useDin().system.phone ?? null;
}

const STATE = ['phone', 'state'] as const;
const CONVERSATIONS = ['phone', 'conversations'] as const;

export function messagesKey(phoneId: string, threadId: string) {
  return ['phone', 'messages', phoneId, threadId] as const;
}

/** Keeps the queries current with what main pushes; mounted once. */
export function usePhoneSync(): void {
  const phone = usePhone();
  const qc = useQueryClient();
  useEffect(() => {
    if (!phone) return;
    const offState = phone.onChanged((state) => qc.setQueryData(STATE, state));
    const offMessages = phone.onMessages(({ phoneId, threadIds }) => {
      void qc.invalidateQueries({ queryKey: CONVERSATIONS });
      for (const threadId of threadIds) void qc.invalidateQueries({ queryKey: messagesKey(phoneId, threadId) });
    });
    return () => {
      offState();
      offMessages();
    };
  }, [phone, qc]);
}

export function usePhoneState() {
  const phone = usePhone();
  return useQuery<PhoneState>({
    queryKey: STATE,
    queryFn: () => phone!.state(),
    enabled: !!phone,
    staleTime: Infinity,
  });
}

export function useConversations() {
  const phone = usePhone();
  return useQuery<PhoneConversation[]>({
    queryKey: CONVERSATIONS,
    queryFn: () => phone!.conversations(),
    enabled: !!phone,
    staleTime: Infinity,
  });
}

export function useMessages(phoneId: string | null, threadId: string | null) {
  const phone = usePhone();
  return useQuery({
    queryKey: messagesKey(phoneId ?? '', threadId ?? ''),
    queryFn: () => phone!.messages(phoneId!, threadId!),
    enabled: !!phone && !!phoneId && !!threadId,
    staleTime: Infinity,
  });
}

export function useContacts(phoneId: string | null) {
  const phone = usePhone();
  return useQuery({
    queryKey: ['phone', 'contacts', phoneId],
    queryFn: () => phone!.contacts(phoneId!),
    enabled: !!phone && !!phoneId,
    staleTime: 60_000,
  });
}
