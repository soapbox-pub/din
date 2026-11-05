import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getKeyboardBridge } from '@/lib/keyboard';
import type { KeyboardLayout, KeyboardLayoutChoice, KeyboardStatus } from '@/lib/keyboard';

/** TanStack Query hooks over the keyboard layout bridge (window.dinos.keyboard). */

function requireBridge() {
  const keyboard = getKeyboardBridge();
  if (!keyboard) throw new Error('Keyboard bridge unavailable');
  return keyboard;
}

const STATUS_KEY = ['keyboard', 'status'] as const;

/**
 * The system's layouts, the one typing, and what can be done with them here.
 * Kept current as they change, Ctrl+Space's switches included.
 */
export function useKeyboardStatus() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const bridge = getKeyboardBridge();
    if (!bridge?.onChanged) return;
    return bridge.onChanged((status) => queryClient.setQueryData(STATUS_KEY, status));
  }, [queryClient]);
  return useQuery<KeyboardStatus>({
    queryKey: STATUS_KEY,
    queryFn: () => requireBridge().status(),
    enabled: getKeyboardBridge() !== undefined,
    retry: false,
  });
}

/** Every installed layout and variant (they don't change while Din runs). */
export function useKeyboardLayouts() {
  return useQuery<KeyboardLayout[]>({
    queryKey: ['keyboard', 'layouts'],
    queryFn: () => requireBridge().layouts(),
    enabled: getKeyboardBridge() !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/** Make a layout the system's only one. */
export function useSetKeyboardLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: KeyboardLayoutChoice) => requireBridge().set(choice),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

/** Make these the system's layouts, the first the default. */
export function useSetKeyboardLayouts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choices: KeyboardLayoutChoice[]) => requireBridge().setLayouts(choices),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

/** Type with the system's layout at an index. */
export function useSelectKeyboardLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => requireBridge().select(index),
    onSettled: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  });
}

/** Restart Din, so its own windows take a changed layout (DinOS). */
export function useRestartForKeyboardLayout() {
  return useMutation({
    mutationFn: () => requireBridge().restart(),
  });
}
