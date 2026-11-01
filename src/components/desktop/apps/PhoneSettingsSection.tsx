import { useState } from 'react';
import {
  Bluetooth,
  EllipsisVertical,
  Loader2,
  MessageCircle,
  RefreshCw,
  Smartphone,
  Trash2,
  Plus,
  Wifi,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { usePhoneActions, usePhoneState } from '@/hooks/usePhone';
import { useToast } from '@/hooks/useToast';
import { describePhone, getPhoneDesktopBridge, type PhoneDevice } from '@/lib/phone';
import { cleanPhoneError } from '@/shared/phone';
import { cn } from '@/lib/utils';
import { PhoneSetupWizard } from './PhoneSetupWizard';

/**
 * Settings → Phone: the phones whose texts show up in Messages and
 * notifications (electron/phone.mts), and Add a phone, which walks through
 * pairing one in this same pane (PhoneSetupWizard). Launched with
 * `{ add: true, nonce }` (Messages' Set Up a Phone), it starts there.
 */
export function PhoneSettingsSection({ addRequest }: { addRequest?: unknown }) {
  const bridge = getPhoneDesktopBridge();
  const status = usePhoneState();
  const actions = usePhoneActions();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const [forgetting, setForgetting] = useState<PhoneDevice | null>(null);
  const [adding, setAdding] = useState(addRequest !== undefined);
  const [handledRequest, setHandledRequest] = useState(addRequest);
  if (addRequest !== handledRequest) {
    setHandledRequest(addRequest);
    if (addRequest !== undefined) setAdding(true);
  }

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanPhoneError(error), variant: 'destructive' });

  const data = status.data;

  if (adding && bridge) {
    return <PhoneSetupWizard onClose={() => setAdding(false)} onOpenMessages={(id) => open('messages', messagesParams(id))} />;
  }

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">Phone</h2>
        {bridge && data && data.phones.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add a phone
          </Button>
        )}
      </header>

      {!bridge ? (
        <Fallback>Phone settings need the Din desktop shell; they aren’t available in a plain browser.</Fallback>
      ) : status.isLoading ? (
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
      ) : status.isError || !data ? (
        <Fallback>Couldn’t read the phones: {cleanPhoneError(status.error)}</Fallback>
      ) : data.phones.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <Smartphone className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            Read and answer your texts on this computer, in Messages and in notifications. Works with iPhone and Android.
          </p>
          <Button className="mt-6" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden />
            Add a phone
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <SubHeading>My phones</SubHeading>
          <ul className="flex flex-col gap-1" aria-label="My phones">
            {data.phones.map((phone) => (
              <PhoneRow
                key={phone.id}
                phone={phone}
                onOpen={() => open('messages', messagesParams(phone.id))}
                onRefresh={() => actions.refresh.mutate(phone.id, { onError: failed(`Couldn’t reach ${phone.name}`) })}
                onForget={() => setForgetting(phone)}
              />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Messages are kept on this computer only.</p>
        </div>
      )}

      <AlertDialog open={forgetting !== null} onOpenChange={(o) => !o && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {forgetting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its messages are deleted from this computer, and it stops showing up in Messages.
              {forgetting?.kind === 'bluetooth'
                ? ' It stays paired in Bluetooth.'
                : ' The phone is unpaired too.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              onClick={() => {
                const phone = forgetting;
                if (phone) actions.forget.mutate(phone.id, { onError: failed(`Couldn’t forget ${phone.name}`) });
              }}
            >
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function messagesParams(phoneId: string) {
  return { phoneId, nonce: Date.now() };
}

function PhoneRow({
  phone,
  onOpen,
  onRefresh,
  onForget,
}: {
  phone: PhoneDevice;
  onOpen: () => void;
  onRefresh: () => void;
  onForget: () => void;
}) {
  const connected = phone.status === 'connected';
  const Kind = phone.kind === 'bluetooth' ? Bluetooth : Wifi;
  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="relative shrink-0">
              <Smartphone className={cn('size-5', connected ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
              <Kind className="absolute -bottom-1 -right-1.5 size-3 rounded-full bg-background text-muted-foreground" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{phone.name}</p>
              <p className={cn('flex items-center gap-1.5 truncate text-xs', connected ? 'text-primary' : 'text-muted-foreground')}>
                {phone.status === 'connecting' && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />}
                {describePhone(phone)}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={onOpen}>
              Messages
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`More for ${phone.name}`}>
                  <EllipsisVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onOpen}>
                  <MessageCircle aria-hidden />
                  Open in Messages
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onRefresh}>
                  <RefreshCw aria-hidden />
                  {connected ? 'Check for new messages' : 'Connect'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onForget}>
                  <Trash2 aria-hidden />
                  Forget
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>
            <MessageCircle aria-hidden />
            Open in Messages
          </ContextMenuItem>
          <ContextMenuItem onSelect={onRefresh}>
            <RefreshCw aria-hidden />
            {connected ? 'Check for new messages' : 'Connect'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onForget}>
            <Trash2 aria-hidden />
            Forget
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {phone.error && (
        <p role="alert" className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {phone.error}
        </p>
      )}
    </li>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium text-muted-foreground">{children}</h3>;
}

function Fallback({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <Smartphone className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
