import { useEffect, useState } from 'react';
import { Loader2, Network, Plus, Usb } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { usePrinterActions } from '@/hooks/usePrinting';
import { useToast } from '@/hooks/useToast';
import type { AppComponentProps } from '@/lib/apps';
import { cleanPrintingError, type FoundDevice } from '@/lib/printing';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * Settings → Printers → Add printer, in a window of its own
 * (src/lib/settingsWindows.ts): looks for printers that need setting up
 * (CUPS asks USB and the network) and adds one with the best driver
 * installed, in one click, then closes. Its `at` launch param starts it over.
 */
export function AddPrinterWindow({ windowId, params }: AppComponentProps) {
  useWindowTitle('Add a Printer');
  return <AddPrinter key={String(params?.at)} windowId={windowId} />;
}

function AddPrinter({ windowId }: { windowId: string }) {
  const { close } = useWindowActions();
  const actions = usePrinterActions();
  const { toast } = useToast();
  const [devices, setDevices] = useState<FoundDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingUri, setAddingUri] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const discover = actions.discover.mutate;

  useEffect(() => {
    discover(undefined, {
      onSuccess: setDevices,
      onError: (e) => setError(cleanPrintingError(e)),
    });
  }, [discover, attempt]);

  const add = (device: FoundDevice) => {
    setError(null);
    setAddingUri(device.uri);
    actions.add.mutate(device.uri, {
      onSuccess: () => {
        toast({ title: `${device.name} is ready`, description: 'You can print to it now.' });
        close(windowId);
      },
      onError: (e) => {
        setAddingUri(null);
        setError(cleanPrintingError(e));
      },
    });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-background p-4 [&>*]:shrink-0">
      <p className="px-1 text-sm text-muted-foreground">
        Printers on your network that need no setup are on the list already. These need a driver, which Din picks for
        you.
      </p>

      {devices === null && !error ? (
        <div className="flex items-center gap-3 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
          Looking for printers…
        </div>
      ) : devices && devices.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          No other printers found. Check that the printer is on and plugged in, then try again.
        </div>
      ) : (
        devices && (
          <ul className={settingsGroup} aria-label="Printers found">
            {devices.map((device) => {
              const Icon = device.connection === 'usb' ? Usb : Network;
              return (
                <ContextMenu key={device.uri}>
                  <ContextMenuTrigger asChild>
                    <li className="flex items-center gap-3 py-2 pr-2 pl-4">
                      <Icon className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm">{device.name}</span>
                      <Button size="sm" variant="outline" disabled={addingUri !== null} onClick={() => add(device)}>
                        {addingUri === device.uri && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
                        Add
                      </Button>
                    </li>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem disabled={addingUri !== null} onSelect={() => add(device)}>
                      <Plus aria-hidden />
                      Add
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </ul>
        )
      )}

      {error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {(devices !== null || error) && addingUri === null && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDevices(null);
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            Look again
          </Button>
        </div>
      )}
    </div>
  );
}
