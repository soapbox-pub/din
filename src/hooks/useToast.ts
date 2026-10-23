import { useCallback } from 'react';
import { useWindowAppId } from '@/contexts/WindowAppContext';
import { notify, type NotificationAction, type NotificationSource } from '@/lib/notificationCenter';

/**
 * A short message from Din or one of its apps, shown through the
 * notification center (NotificationPopups). Confirmations ("Link copied")
 * only pop up; failures and ones with actions stay in the list too, so they
 * can still be read and acted on after the popup goes.
 */
export interface Toast {
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
  /** Buttons on the notification; `onAction` gets the picked one's id. */
  actions?: NotificationAction[];
  onAction?: (action: string) => void;
}

const DIN: NotificationSource = { name: 'Din' };

function show({ title, description, variant, actions, onAction }: Toast, source: NotificationSource): string {
  return notify({
    source,
    title,
    body: description ?? '',
    actions,
    history: variant === 'destructive' || !!actions?.length,
    onActivate: onAction,
  });
}

/** Show a toast from outside any app window. */
export function toast(props: Toast): string {
  return show(props, DIN);
}

/** `toast`, attributed to the app whose window it's called in. */
export function useToast(): { toast: (props: Toast) => string } {
  const appId = useWindowAppId();
  const toastFromApp = useCallback(
    (props: Toast) => show(props, appId ? { appId, name: 'Din' } : DIN),
    [appId],
  );
  return { toast: toastFromApp };
}
