import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getKeyboardBridge } from '@/lib/keyboard';
import type { KeyboardLayout, KeyboardLayoutChoice, KeyboardStatus } from '@/lib/keyboard';

/** TanStack Query hooks over the keyboard layout bridge (window.keyboard). */

function requireBridge() {
  const keyboard = getKeyboardBridge();
  if (!keyboard) throw new Error('Keyboard bridge unavailable');
  return keyboard;
}

/** The OS's layout and the one picked in Settings. */
export function useKeyboardStatus() {
  return useQuery<KeyboardStatus>({
    queryKey: ['keyboard', 'status'],
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

/** Pick a layout for native apps, or null to follow the OS. */
export function useSetKeyboardLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: KeyboardLayoutChoice | null) => requireBridge().set(choice),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['keyboard', 'status'] }),
  });
}
