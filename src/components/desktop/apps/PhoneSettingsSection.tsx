import { useState } from 'react';
import {
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  Loader2,
  MessageCircle,
  RefreshCw,
  Settings2,
  Share2,
  Smartphone,
  Trash2,
  Plus,
} from 'lucide-react';
import {
  ActionButton,
  ActionButtons,
  DetailsError,
  DetailsHero,
  DetailsGroup,
  DetailsPage,
  DeviceRowButton,
  InfoList,
  InfoRow,
  ToggleRow,
} from '@/components/desktop/apps/DetailsPage';
import { BluetoothDeviceIcon } from '@/components/desktop/BluetoothIndicator';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { usePhoneActions, usePhoneState } from '@/hooks/usePhone';
import { useToast } from '@/hooks/useToast';
import { describePhone, getPhoneDesktopBridge, type PhoneDevice } from '@/lib/phone';
import { cleanPhoneError } from '@/shared/phone';
import { PhoneSetupWizard } from './PhoneSetupWizard';

/**
 * Settings → Phone: the phones whose texts show up in Messages and
 * notifications (electron/phone.mts), connected ones first, as Android lists
 * Bluetooth devices. A connected phone's row opens its page (PhoneDetails),
 * where it's disconnected; any other connects with a click, and its gear
 * opens the page. Add a phone walks through pairing one in this same pane
 * (PhoneSetupWizard). Launched with `{ add: true, nonce }` (Messages' Set Up
 * a Phone), it starts there. Quick Share, for any Android device on the same
 * network, is its own app; a button at the bottom of the page opens it.
 */
export function PhoneSettingsSection({ addRequest }: { addRequest?: unknown }) {
  const bridge = getPhoneDesktopBridge();
  const status = usePhoneState();
  const actions = usePhoneActions();
  const { open } = useWindowActions();
  const { toast } = useToast();
  const [forgetting, setForgetting] = useState<PhoneDevice | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
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

  const rowActions = (phone: PhoneDevice) => ({
    onOpen: () => open('messages', messagesParams(phone.id)),
    onConnect: () => actions.refresh.mutate(phone.id, { onError: failed(`Couldn’t reach ${phone.name}`) }),
    onDisconnect: () => actions.disconnect.mutate(phone.id, { onError: failed(`Couldn’t disconnect ${phone.name}`) }),
    onDetails: () => setViewing(phone.id),
    onForget: () => setForgetting(phone),
  });

  const forgetDialog = (
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
              if (!phone) return;
              actions.forget.mutate(phone.id, {
                onSuccess: () => setViewing((id) => (id === phone.id ? null : id)),
                onError: failed(`Couldn’t forget ${phone.name}`),
              });
            }}
          >
            Forget
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (viewing !== null && bridge) {
    const phone = data?.phones.find((p) => p.id === viewing);
    return (
      <>
        <PhoneDetails
          phone={phone}
          connectPending={actions.refresh.isPending && actions.refresh.variables === viewing}
          disconnectPending={actions.disconnect.isPending && actions.disconnect.variables === viewing}
          onBack={() => setViewing(null)}
          onReceiveFiles={(on) =>
            phone &&
            actions.setReceiveFiles.mutate({ id: phone.id, on }, { onError: failed(`Couldn’t change ${phone.name}`) })
          }
          {...(phone ? rowActions(phone) : NO_ACTIONS)}
        />
        {forgetDialog}
      </>
    );
  }

  const connected = data?.phones.filter((p) => p.status === 'connected') ?? [];
  const others = data?.phones.filter((p) => p.status !== 'connected') ?? [];

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
        <div className="flex flex-col gap-4">
          {connected.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>Connected phones</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="Connected phones">
                {connected.map((phone) => (
                  <PhoneRow key={phone.id} phone={phone} {...rowActions(phone)} />
                ))}
              </ul>
            </div>
          )}
          {others.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>{connected.length > 0 ? 'Other phones' : 'My phones'}</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="My phones">
                {others.map((phone) => (
                  <PhoneRow key={phone.id} phone={phone} {...rowActions(phone)} />
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Messages are kept on this computer only.</p>
        </div>
      )}

      {/* Quick Share has its own window, visible to nearby devices only while it's open (electron/quickshare.mts). */}
      <Button
        variant="outline"
        className="self-start"
        title="Android phones and tablets nearby can share files and links here while Quick Share is open"
        onClick={() => open('quick-share')}
      >
        <Share2 className="size-4" aria-hidden />
        Receive with Quick Share
      </Button>

      {forgetDialog}
    </section>
  );
}

function messagesParams(phoneId: string) {
  return { phoneId, nonce: Date.now() };
}

interface PhoneActions {
  onOpen: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onDetails: () => void;
  onForget: () => void;
}

const noop = () => {};
const NO_ACTIONS: PhoneActions = { onOpen: noop, onConnect: noop, onDisconnect: noop, onDetails: noop, onForget: noop };

/** Battery and unread messages, for a connected phone's row. */
function connectedDetail(phone: PhoneDevice): string {
  const parts: string[] = [];
  if (phone.battery !== null) parts.push(`${phone.battery}%${phone.charging ? ', charging' : ''}`);
  if (phone.unread > 0) parts.push(`${phone.unread} unread`);
  return parts.join(' · ');
}

/** An iPhone or an Android phone when Bluetooth can tell, else a plain phone. */
function PlatformIcon({ phone }: { phone: PhoneDevice }) {
  return <BluetoothDeviceIcon device={{ icon: 'phone', kind: phone.platform }} />;
}

function PhoneIcon({ phone }: { phone: PhoneDevice }) {
  return (
    <span className="relative block">
      <PlatformIcon phone={phone} />
      <Bluetooth className="absolute -bottom-1 -right-1.5 size-3! rounded-full bg-background text-muted-foreground" aria-hidden />
    </span>
  );
}

function PhoneRow({
  phone,
  onOpen,
  onConnect,
  onDisconnect,
  onDetails,
  onForget,
}: { phone: PhoneDevice } & PhoneActions) {
  const connected = phone.status === 'connected';
  const connecting = phone.status === 'connecting';
  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <DeviceRowButton
            icon={<PhoneIcon phone={phone} />}
            name={phone.name}
            detail={connected ? connectedDetail(phone) : describePhone(phone)}
            connected={connected}
            pending={connecting}
            chevron={connected || connecting}
            onClick={connected || connecting ? onDetails : onConnect}
            trailing={
              !connected &&
              !connecting && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Settings for ${phone.name}`}
                  title="Phone details"
                  onClick={onDetails}
                >
                  <Settings2 className="size-4" />
                </Button>
              )
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onOpen}>
            <MessageCircle aria-hidden />
            Open in Messages
          </ContextMenuItem>
          {connected ? (
            <>
              <ContextMenuItem onSelect={onConnect}>
                <RefreshCw aria-hidden />
                Check for new messages
              </ContextMenuItem>
              <ContextMenuItem onSelect={onDisconnect}>
                <BluetoothOff aria-hidden />
                Disconnect
              </ContextMenuItem>
            </>
          ) : (
            <ContextMenuItem disabled={connecting} onSelect={onConnect}>
              <BluetoothConnected aria-hidden />
              Connect
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={onDetails}>
            <Settings2 aria-hidden />
            Phone details
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

/** One phone's page: open its texts, connect or disconnect it, forget it, whether it can send files, and how it's doing. */
function PhoneDetails({
  phone,
  connectPending,
  disconnectPending,
  onBack,
  onReceiveFiles,
  onOpen,
  onConnect,
  onDisconnect,
  onForget,
}: {
  phone: PhoneDevice | undefined;
  connectPending: boolean;
  disconnectPending: boolean;
  onBack: () => void;
  onReceiveFiles: (on: boolean) => void;
} & PhoneActions) {
  const connected = phone?.status === 'connected';
  return (
    <DetailsPage title={phone?.name ?? 'Phone details'} backLabel="Back to Phone" onBack={onBack}>
      {!phone ? (
        <Fallback>This phone is no longer here.</Fallback>
      ) : (
        <>
          <DetailsHero
            icon={<PlatformIcon phone={phone} />}
            name={phone.name}
            status={
              <>
                {phone.status === 'connecting' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {describePhone(phone)}
              </>
            }
            active={connected}
          />

          <ActionButtons>
            <ActionButton icon={Trash2} label="Forget" onClick={onForget} />
            {connected ? (
              <ActionButton icon={BluetoothOff} label="Disconnect" pending={disconnectPending} onClick={onDisconnect} />
            ) : (
              <ActionButton
                icon={BluetoothConnected}
                label="Connect"
                pending={connectPending || phone.status === 'connecting'}
                onClick={onConnect}
              />
            )}
            <ActionButton icon={MessageCircle} label="Messages" onClick={onOpen} />
          </ActionButtons>

          {phone.error && <DetailsError>{phone.error}</DetailsError>}

          <DetailsGroup>
            <ToggleRow
              label="Receive files"
              description="Share from the phone to this computer over Bluetooth, or with Quick Share while it’s connected, without being asked. Files are saved to Downloads."
              checked={phone.receiveFiles}
              onChange={onReceiveFiles}
            />
          </DetailsGroup>

          <InfoList>
            <InfoRow label="Connects over" value="Bluetooth" />
            {phone.battery !== null && (
              <InfoRow label="Battery" value={`${phone.battery}%${phone.charging ? ', charging' : ''}`} />
            )}
            <InfoRow label="Unread messages" value={phone.unread} />
            <InfoRow
              label="Last connected"
              value={
                connected
                  ? 'Now'
                  : phone.lastSeen
                    ? new Date(phone.lastSeen).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
                    : 'Never'
              }
            />
          </InfoList>
          <p className="text-xs text-muted-foreground">
            Messages are kept on this computer only. Disconnecting lasts until you connect again or restart Din.
          </p>
        </>
      )}
    </DetailsPage>
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
