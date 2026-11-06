import type { ComponentType, ReactNode } from 'react';
import { Check, Loader2, MoreHorizontal, Plus, Printer as PrinterIcon, TriangleAlert, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
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
import { cleanPrintingError, getPrintingBridge, type Printer, type PrintJob } from '@/lib/printing';
import { ADD_PRINTER_APP_ID, addPrinterParams } from '@/lib/settingsWindows';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cn } from '@/lib/utils';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSection } from '@/shared/settingsSection';
import { StatusPill } from '@/shared/appChrome';
import { SettingsToken } from '@/shared/settingsChrome';

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
  const { open } = useWindowActions();

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanPrintingError(error), variant: 'destructive' });

  const data = printers.data;
  const list = data?.printers ?? [];

  return (
    <SettingsSection
      title="Printers"
      actions={
        bridge &&
        data?.available && (
          <Button variant="outline" size="sm" onClick={() => open(ADD_PRINTER_APP_ID, addPrinterParams())}>
            <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
            Add printer
          </Button>
        )
      }
    >

      {!bridge ? (
        <Fallback>Printer settings need the Din desktop shell; they aren’t available in a plain browser.</Fallback>
      ) : printers.isLoading ? (
        <div className={settingsGroup}>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
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
        <ul className={settingsGroup} aria-label="Printers">
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

    </SettingsSection>
  );
}

function Fallback({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-8 py-12 text-center">
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
        {printer.isDefault ? <Check className="size-4.5" strokeWidth={1.75} aria-hidden /> : <span className="size-4" aria-hidden />}
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
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 py-2 pr-2 pl-4">
            <SettingsToken icon={PrinterIcon} className={cn(printer.problem && 'text-warning')} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm text-foreground">
                <span className="truncate">{printer.displayName}</span>
                {printer.isDefault && (
                  <StatusPill>Default</StatusPill>
                )}
              </p>
              <p
                className={cn(
                  'flex items-center gap-1.5 truncate text-xs',
                  printer.problem ? 'text-warning' : 'text-muted-foreground',
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
                  <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
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
        <ul className="pb-1" aria-label={`Waiting to print on ${printer.displayName}`}>
          {jobs.map((job) => (
            <ContextMenu key={job.id}>
              <ContextMenuTrigger asChild>
                <li className="flex items-center gap-3 py-1.5 pl-8">
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
