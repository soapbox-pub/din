import { MonitorUp } from 'lucide-react';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { useDesktopIcons } from '@/contexts/DesktopIconsContext';
import { useToast } from '@/hooks/useToast';
import { cleanFsError } from '@/lib/fs';

/** "Add to Desktop" for an app's menus: a shortcut to it in ~/Desktop. */
export function AddToDesktopItem({ appId }: { appId: string }) {
  const icons = useDesktopIcons();
  const { toast } = useToast();
  if (!icons.dir) return null;
  return (
    <ContextMenuItem
      onSelect={() =>
        void icons.addApp(appId).catch((error: unknown) =>
          toast({ title: 'Couldn’t add the app to the desktop', description: cleanFsError(error), variant: 'destructive' }))}
    >
      <MonitorUp aria-hidden /> Add to Desktop
    </ContextMenuItem>
  );
}
