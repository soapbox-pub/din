import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getPrintingBridge, type PrintersState } from '@/lib/printing';

export const PRINTERS_KEY = ['printing', 'state'] as const;

function requireBridge() {
  const printing = getPrintingBridge();
  if (!printing) throw new Error('Printing bridge unavailable');
  return printing;
}

/**
 * The printers CUPS knows and the jobs waiting, polled while something
 * shows them (CUPS has no change feed worth following for this).
 */
export function usePrinters(options: { refetchInterval?: number } = {}) {
  const printing = getPrintingBridge();
  return useQuery<PrintersState>({
    queryKey: PRINTERS_KEY,
    queryFn: () => requireBridge().state(),
    enabled: printing !== undefined,
    refetchInterval: options.refetchInterval ?? 4000,
    retry: false,
  });
}

/** What a printer can do: colour, two-sided, which paper. */
export function usePrinterCapabilities(printer: string | null) {
  const printing = getPrintingBridge();
  return useQuery({
    queryKey: ['printing', 'capabilities', printer],
    queryFn: () => requireBridge().capabilities(printer!),
    enabled: printing !== undefined && printer !== null,
    staleTime: 60_000,
    retry: false,
  });
}

/** Actions on printers and jobs, each refreshing the list once it's done. */
export function usePrinterActions() {
  const queryClient = useQueryClient();
  const settle = () => queryClient.invalidateQueries({ queryKey: PRINTERS_KEY });
  return {
    setDefault: useMutation({ mutationFn: (printer: string) => requireBridge().setDefault(printer), onSettled: settle }),
    testPage: useMutation({ mutationFn: (printer: string) => requireBridge().testPage(printer), onSettled: settle }),
    resume: useMutation({ mutationFn: (printer: string) => requireBridge().resume(printer), onSettled: settle }),
    remove: useMutation({ mutationFn: (printer: string) => requireBridge().remove(printer), onSettled: settle }),
    cancelJob: useMutation({ mutationFn: (job: string) => requireBridge().cancelJob(job), onSettled: settle }),
    discover: useMutation({ mutationFn: () => requireBridge().discover() }),
    add: useMutation({ mutationFn: (uri: string) => requireBridge().add(uri), onSettled: settle }),
  };
}
