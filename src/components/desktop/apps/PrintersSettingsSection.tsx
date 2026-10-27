import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { Check, EllipsisVertical, Loader2, Network, Plus, Printer as PrinterIcon, TriangleAlert, Usb, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { usePrinterActions, usePrinters } from '@/hooks/usePrinting';
import { useToast } from '@/hooks/useToast';
import { cleanPrintingError, getPrintingBridge, type FoundDevice, type Printer, type PrintJob } from '@/lib/printing';
import { cn } from '@/lib/utils';

/**
 * Settings → Printers: the printers this computer can print to, which one is
 * the default, and what's waiting to print. Printers on the network appear
 * by themselves (CUPS finds them; see electron/printing.mts); "Add printer"
 * sets up the ones that need a driver, usually older USB printers.
 */
export function PrintersSettingsSection() {
  const bridge = getPrintingBridge();
  const printers = usePrinters({ refetchInterval: 3000 });
  const actions = usePrinterActions();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanPrintingError(error), variant: 'destructive' });

  const data = printers.data;
  const list = data?.printers ?? [];

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Printers</h2>
        {bridge && data?.available && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add printer
          </Button>
        )}
      </header>

      {!bridge ? (
        <Fallback>Printer settings need the Din desktop shell; they aren’t available in a plain browser.</Fallback>
      ) : printers.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-3">
              <Skeleton className="size-5 rounded" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      ) : printers.isError ? (
        <Fallback>Couldn’t read the printers: {cleanPrintingError(printers.error)}</Fallback>
      ) : !data?.available ? (
        <Fallback>The printing service isn’t running on this computer, so printers can’t be used here.</Fallback>
      ) : list.length === 0 ? (
        <Fallback>
          No printers yet. Turn your printer on and connect it to the same Wi-Fi as this computer and it shows up
          here by itself. A printer plugged in with USB usually does too; if it doesn’t, choose Add printer.
        </Fallback>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Printers">
          {list.map((printer) => (
            <PrinterRow
              key={printer.name}
              printer={printer}
              jobs={data.jobs.filter((j) => j.printer === printer.name)}
              onSetDefault={() =>
                actions.setDefault.mutate(printer.name, { onError: failed('Couldn’t change the default printer') })
              }
              onTestPage={() =>
                actions.testPage.mutate(printer.name, {
                  onSuccess: () => toast({ title: 'Printing a test page', description: printer.displayName }),
                  onError: failed('Couldn’t print a test page'),
                })
              }
              onResume={() =>
                actions.resume.mutate(printer.name, { onError: failed(`Couldn’t start ${printer.displayName} again`) })
              }
              onRemove={() =>
                actions.remove.mutate(printer.name, { onError: failed(`Couldn’t remove ${printer.displayName}`) })
              }
              onCancelJob={(job) => actions.cancelJob.mutate(job, { onError: failed('Couldn’t cancel it') })}
            />
          ))}
        </ul>
      )}

      {adding && <AddPrinterDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function Fallback({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <PrinterIcon className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function describePrinter(printer: Printer): string {
  if (printer.problem) return printer.problem;
  if (printer.state === 'printing') return 'Printing';
  if (printer.state === 'stopped') return 'Paused';
  return 'Ready';
}

/** The pieces a printer's ⋯ menu and its right-click menu are both built from. */
interface MenuParts {
  Item: ComponentType<{
    disabled?: boolean;
    variant?: 'default' | 'destructive';
    onSelect?: () => void;
    children?: ReactNode;
  }>;
  Separator: ComponentType;
}

const DROPDOWN_PARTS: MenuParts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator };
const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

function PrinterMenuItems({
  parts: { Item, Separator },
  printer,
  onSetDefault,
  onTestPage,
  onRemove,
}: {
  parts: MenuParts;
  printer: Printer;
  onSetDefault: () => void;
  onTestPage: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <Item disabled={printer.isDefault} onSelect={onSetDefault}>
        {printer.isDefault ? <Check className="size-4" aria-hidden /> : <span className="size-4" aria-hidden />}
        Use as default
      </Item>
      <Item onSelect={onTestPage}>
        <span className="size-4" aria-hidden />
        Print a test page
      </Item>
      {printer.configured && (
        <>
          <Separator />
          <Item variant="destructive" onSelect={onRemove}>
            <span className="size-4" aria-hidden />
            Remove
          </Item>
        </>
      )}
    </>
  );
}

function PrinterRow({
  printer,
  jobs,
  onSetDefault,
  onTestPage,
  onResume,
  onRemove,
  onCancelJob,
}: {
  printer: Printer;
  jobs: PrintJob[];
  onSetDefault: () => void;
  onTestPage: () => void;
  onResume: () => void;
  onRemove: () => void;
  onCancelJob: (job: string) => void;
}) {
  const status = describePrinter(printer);
  const menu = { printer, onSetDefault, onTestPage, onRemove };
  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 px-3 py-2">
            <PrinterIcon
              className={cn('size-5 shrink-0', printer.problem ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm text-foreground">
                <span className="truncate">{printer.displayName}</span>
                {printer.isDefault && (
                  <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                    Default
                  </span>
                )}
              </p>
              <p
                className={cn(
                  'flex items-center gap-1.5 truncate text-xs',
                  printer.problem ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                )}
              >
                {printer.problem && <TriangleAlert className="size-3 shrink-0" aria-hidden />}
                {status}
                {printer.location && ` · ${printer.location}`}
              </p>
            </div>
            {printer.state === 'stopped' && (
              <Button variant="outline" size="sm" onClick={onResume}>
                Resume
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`${printer.displayName} options`}>
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <PrinterMenuItems parts={DROPDOWN_PARTS} {...menu} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {printer.state === 'stopped' && (
            <>
              <ContextMenuItem onSelect={onResume}>
                <span className="size-4" aria-hidden />
                Resume
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <PrinterMenuItems parts={CONTEXT_PARTS} {...menu} />
        </ContextMenuContent>
      </ContextMenu>

      {jobs.length > 0 && (
        <ul className="border-t border-border/60" aria-label={`Waiting to print on ${printer.displayName}`}>
          {jobs.map((job) => (
            <ContextMenu key={job.id}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 px-3 py-1.5 pl-11">
                  {job.active ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Printing" />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{job.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{job.active ? 'Printing' : 'Waiting'}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Cancel “${job.title}”`}
                    title="Cancel"
                    onClick={() => onCancelJob(job.id)}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onCancelJob(job.id)}>
                  <X aria-hidden />
                  Cancel
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Looks for printers that need setting up (CUPS asks USB and the network)
 * and adds one with the best driver installed, in one click.
 */
function AddPrinterDialog({ onClose }: { onClose: () => void }) {
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
        onClose();
      },
      onError: (e) => {
        setAddingUri(null);
        setError(cleanPrintingError(e));
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && addingUri === null && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a printer</DialogTitle>
          <DialogDescription>
            Printers on your network that need no setup are on the list already. These need a driver, which Din
            picks for you.
          </DialogDescription>
        </DialogHeader>

        {devices === null && !error ? (
          <div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Looking for printers…
          </div>
        ) : devices && devices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
            No other printers found. Check that the printer is on and plugged in, then try again.
          </div>
        ) : (
          devices && (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label="Printers found">
              {devices.map((device) => {
                const Icon = device.connection === 'usb' ? Usb : Network;
                return (
                  <li key={device.uri} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm">{device.name}</span>
                    <Button size="sm" variant="outline" disabled={addingUri !== null} onClick={() => add(device)}>
                      {addingUri === device.uri && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          )
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
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
      </DialogContent>
    </Dialog>
  );
}
