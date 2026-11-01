import { useState } from 'react';
import {
  Bluetooth,
  EllipsisVertical,
  Loader2,
  MessageCircle,
  RefreshCw,
  Smartphone,
  Trash2,
  TriangleAlert,
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
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { Skeleton } from '@/components/ui/skeleton';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { usePhoneActions, usePhoneDiscovery, usePhoneState } from '@/hooks/usePhone';
import { useToast } from '@/hooks/useToast';
import { describePhone, getPhoneDesktopBridge, type PhoneCandidate, type PhoneDevice, type PhonePairing } from '@/lib/phone';
import { cleanPhoneError } from '@/shared/phone';
import { cn } from '@/lib/utils';

/** KDE Connect on Google Play; F-Droid has it too. */
const KDE_CONNECT_URL = 'https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp';

/**
 * Settings → Phone: the phones whose texts show up in Messages and
 * notifications (electron/phone.mts), and adding one. An iPhone is paired in
 * Bluetooth first and then picked here; an Android phone runs KDE Connect on
 * the same network and is paired here, with a key to compare on both
 * screens. While this is open, Din looks for Android phones and takes their
 * pairing requests; at other times it ignores them.
 */
export function PhoneSettingsSection() {
  const bridge = getPhoneDesktopBridge();
  const status = usePhoneState();
  const actions = usePhoneActions();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const [forgetting, setForgetting] = useState<PhoneDevice | null>(null);
  usePhoneDiscovery();

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanPhoneError(error), variant: 'destructive' });

  const data = status.data;
  const bluetooth = data?.candidates.filter((c) => c.kind === 'bluetooth') ?? [];
  const android = data?.candidates.filter((c) => c.kind === 'kdeconnect') ?? [];

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">Phone</h2>
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
      ) : (
        <div className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">
            Read and answer your texts on this computer, in Messages and in notifications. Messages are kept on this
            computer only.
          </p>

          {data.pairing && (
            <PairingCard
              pairing={data.pairing}
              busy={actions.answer.isPending}
              onAnswer={(accept) =>
                actions.answer.mutate({ id: data.pairing!.id, accept }, { onError: failed('Couldn’t answer the phone') })
              }
            />
          )}

          {data.phones.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>My phones</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="My phones">
                {data.phones.map((phone) => (
                  <PhoneRow
                    key={phone.id}
                    phone={phone}
                    onOpen={() => open('messages', messagesParams(phone))}
                    onRefresh={() => actions.refresh.mutate(phone.id, { onError: failed(`Couldn’t reach ${phone.name}`) })}
                    onForget={() => setForgetting(phone)}
                  />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <SubHeading>Add an iPhone</SubHeading>
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-foreground/90">
              <li>
                Pair it with this computer in{' '}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => open('settings', { section: 'bluetooth' })}
                >
                  Bluetooth settings
                </button>
                .
              </li>
              <li>
                On the iPhone, open Settings → Bluetooth, tap ⓘ beside this computer, and turn on{' '}
                <span className="font-medium">Show Notifications</span> (and{' '}
                <span className="font-medium">Sync Contacts</span>, for names).
              </li>
              <li>Add it here.</li>
            </ol>
            {!data.bluetooth ? (
              <Hint icon={Bluetooth}>Bluetooth isn’t available, so iPhones can’t be added.</Hint>
            ) : bluetooth.length === 0 ? (
              <Hint icon={Bluetooth}>No paired phones yet.</Hint>
            ) : (
              <CandidateList candidates={bluetooth} action="Add" pending={actions.add.isPending ? actions.add.variables : undefined} onAdd={(c) => actions.add.mutate(c.id, { onError: failed(`Couldn’t add ${c.name}`) })} />
            )}
            <p className="text-xs text-muted-foreground">
              An iPhone shares texts that arrive while it’s nearby and connected, not older ones, and no pictures or
              group conversations. That’s up to Apple, and the same on Windows.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <SubHeading>Add an Android phone</SubHeading>
            <div className="flex items-start gap-4">
              <ol className="flex flex-1 list-decimal flex-col gap-1.5 pl-5 text-sm text-foreground/90">
                <li>
                  Install <span className="font-medium">KDE Connect</span> from Google Play or F-Droid (scan the code).
                </li>
                <li>Open it while the phone is on the same Wi-Fi as this computer.</li>
                <li>
                  Pair it here, or tap “{data.name}” in the app. Check that both screens show the same key.
                </li>
                <li>In KDE Connect, allow SMS and Contacts when it asks.</li>
              </ol>
              <div className="shrink-0 rounded-lg bg-white p-1.5">
                <QRCodeCanvas value={KDE_CONNECT_URL} size={96} className="size-24" />
              </div>
            </div>
            {data.network.error ? (
              <Hint icon={TriangleAlert} tone="error">
                {data.network.error}
              </Hint>
            ) : android.length === 0 ? (
              <Hint icon={Wifi} busy={data.network.listening}>
                Looking for phones with KDE Connect open…
              </Hint>
            ) : (
              <CandidateList candidates={android} action="Pair" pending={actions.add.isPending ? actions.add.variables : undefined} onAdd={(c) => actions.add.mutate(c.id, { onError: failed(`Couldn’t pair with ${c.name}`) })} />
            )}
          </div>
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

function messagesParams(phone: PhoneDevice) {
  return { phoneId: phone.id, nonce: Date.now() };
}

function PairingCard({ pairing, busy, onAnswer }: { pairing: PhonePairing; busy: boolean; onAnswer: (accept: boolean) => void }) {
  return (
    <div role="alertdialog" aria-label={`Pair with ${pairing.name}`} className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4">
      <div className="flex items-center gap-3">
        <Smartphone className="size-5 shrink-0 text-primary" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          {pairing.incoming ? `${pairing.name} wants to pair` : `Pairing with ${pairing.name}…`}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {pairing.incoming
          ? 'Pair only if the phone shows this key too:'
          : 'Accept on the phone if it shows this key too:'}
      </p>
      <p className="font-mono text-2xl font-semibold tracking-[0.3em] text-foreground">{pairing.key}</p>
      <div className="flex gap-2">
        {pairing.incoming && (
          <Button size="sm" disabled={busy} onClick={() => onAnswer(true)}>
            Pair
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onAnswer(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
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

function CandidateList({
  candidates,
  action,
  pending,
  onAdd,
}: {
  candidates: PhoneCandidate[];
  action: string;
  pending: string | undefined;
  onAdd: (candidate: PhoneCandidate) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {candidates.map((c) => (
        <li key={c.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
          <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{c.name}</span>
          <Button variant="outline" size="sm" disabled={pending !== undefined} onClick={() => onAdd(c)}>
            {pending === c.id && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {action}
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Hint({
  icon: Icon,
  busy,
  tone,
  children,
}: {
  icon: typeof Wifi;
  busy?: boolean;
  tone?: 'error';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-sm',
        tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-border/60 text-muted-foreground',
      )}
    >
      {busy ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : <Icon className="size-4 shrink-0" aria-hidden />}
      <span>{children}</span>
    </div>
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
