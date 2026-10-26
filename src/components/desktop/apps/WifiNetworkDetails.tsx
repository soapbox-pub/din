import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Loader2, Pencil, QrCode, Trash2, Wifi, WifiOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useWifiDetails, useWifiMutations } from '@/hooks/useWifi';
import { cn } from '@/lib/utils';
import {
  bandLabel,
  cleanWifiError,
  getWifiBridge,
  SECURITY_LABELS,
  signalLabel,
  subnetMask,
  wifiQrPayload,
} from '@/lib/wifi';
import type { WifiChanges, WifiDetails, WifiNetwork } from '@/lib/wifi';
import { EapFields, IpFields, PasswordField, ProxyFields, SelectField } from '@/components/desktop/apps/WifiForms';
import {
  eapDraftFrom,
  eapFromDraft,
  ipDraftFrom,
  ipFromDraft,
  ipSummary,
  MAC_OPTIONS,
  METERED_OPTIONS,
  passwordError,
  proxyDraftFrom,
  proxyFromDraft,
  proxySummary,
  shownMac,
} from '@/lib/wifiForm';

/**
 * One saved network, the way Android shows it: what it's connected with
 * (signal, speed, addresses), the switches that matter (auto-connect,
 * metered, MAC privacy), and its settings - password or sign-in, IP, proxy,
 * hidden - each edited on its own. Forget, connect and share up top.
 */
export function WifiNetworkDetails({
  uuid,
  scanned,
  onBack,
}: {
  uuid: string;
  /** The network as last scanned, when it's in range. */
  scanned: WifiNetwork | undefined;
  onBack: () => void;
}) {
  const details = useWifiDetails(uuid);
  const { activate, disconnect, forget, update } = useWifiMutations();
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  const data = details.data;
  const onError = (e: unknown) => setError(cleanWifiError(e));
  const save = (changes: WifiChanges, onSuccess?: () => void) => {
    setError(null);
    update.mutate({ uuid, changes }, { onSuccess, onError });
  };

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="Back to Wi-Fi" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <h2 className="truncate text-lg font-semibold text-foreground">{data?.ssid ?? 'Network details'}</h2>
      </header>

      {details.isLoading ? (
        <DetailsSkeleton />
      ) : details.isError || !data ? (
        <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center text-sm text-muted-foreground">
          {details.isError ? cleanWifiError(details.error) : 'This network is no longer saved.'}
        </div>
      ) : (
        <>
          <DetailsHero details={data} scanned={scanned} />

          <div className="grid grid-cols-3 gap-2">
            <ActionButton
              icon={Trash2}
              label="Forget"
              pending={forget.isPending}
              onClick={() => {
                setError(null);
                forget.mutate(uuid, { onSuccess: onBack, onError });
              }}
            />
            {data.active ? (
              <ActionButton
                icon={WifiOff}
                label="Disconnect"
                pending={disconnect.isPending}
                onClick={() => {
                  setError(null);
                  disconnect.mutate(undefined, { onError });
                }}
              />
            ) : (
              <ActionButton
                icon={Wifi}
                label="Connect"
                pending={activate.isPending}
                disabled={!scanned && !data.hidden}
                onClick={() => {
                  setError(null);
                  activate.mutate(uuid, { onError });
                }}
              />
            )}
            <ActionButton
              icon={QrCode}
              label="Share"
              disabled={data.security === 'wpa-eap'}
              onClick={() => setSharing(true)}
            />
          </div>

          {error !== null && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <Group>
            <ToggleRow
              label="Auto-connect"
              description="Join this network whenever it's in range."
              checked={data.settings.autoconnect}
              disabled={update.isPending}
              onChange={(autoconnect) => save({ autoconnect })}
            />
            <Row>
              <SelectField
                label="Metered"
                value={data.settings.metered}
                options={METERED_OPTIONS}
                disabled={update.isPending}
                description="A metered network is one with limited data, like a phone's hotspot."
                onChange={(metered) => save({ metered })}
              />
            </Row>
            <Row>
              <SelectField
                label="Privacy"
                value={shownMac(data.settings.mac)}
                options={MAC_OPTIONS}
                disabled={update.isPending}
                description={data.active ? 'Changing this reconnects to the network.' : undefined}
                onChange={(mac) => save({ mac })}
              />
            </Row>
          </Group>

          {data.live && <LiveDetailsGroup details={data} />}

          <SubHeading>Advanced</SubHeading>
          <Group>
            {data.security === 'wpa-eap' ? (
              <EapEditor details={data} pending={update.isPending} onSave={save} />
            ) : data.security === 'wpa-psk' || data.security === 'sae' || data.security === 'wep' ? (
              <PasswordEditor details={data} pending={update.isPending} onSave={save} />
            ) : (
              <InfoRow label="Security" value={SECURITY_LABELS[data.security]} />
            )}
            <ToggleRow
              label="Hidden network"
              description="Look for this network even when it doesn't broadcast its name."
              checked={data.settings.hidden}
              disabled={update.isPending}
              onChange={(hidden) => save({ hidden })}
            />
            <IpEditor details={data} pending={update.isPending} onSave={save} />
            <ProxyEditor details={data} pending={update.isPending} onSave={save} />
          </Group>
        </>
      )}

      {sharing && data && <ShareDialog details={data} onClose={() => setSharing(false)} />}
    </section>
  );
}

function DetailsHero({ details, scanned }: { details: WifiDetails; scanned: WifiNetwork | undefined }) {
  const signal = details.live?.signal || scanned?.signal || 0;
  const inRange = details.active || scanned !== undefined;
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-gradient-to-b from-primary/10 to-transparent px-4 py-6 text-center">
      <div
        className={cn(
          'flex size-14 items-center justify-center rounded-full',
          details.active ? 'bg-primary text-primary-foreground' : 'bg-foreground/10 text-muted-foreground',
        )}
      >
        {inRange ? <WifiSignalIcon signal={signal} className="size-7" /> : <WifiOff className="size-7" aria-hidden />}
      </div>
      <p className="max-w-full truncate text-base font-semibold text-foreground">{details.ssid}</p>
      <p className={cn('text-sm', details.active ? 'text-primary' : 'text-muted-foreground')}>
        {details.active ? 'Connected' : inRange ? 'Saved' : 'Not in range'}
      </p>
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  pending,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pending?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      className="h-auto flex-col gap-1.5 py-3"
      disabled={disabled || pending}
      onClick={onClick}
    >
      {pending ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Icon className="size-5" aria-hidden />}
      <span className="text-xs">{label}</span>
    </Button>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-2 text-sm font-medium text-muted-foreground">{children}</h3>;
}

function Group({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3">{children}</div>;
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-sm text-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-sm text-muted-foreground select-text sm:text-right">{value}</dd>
    </div>
  );
}

function LiveDetailsGroup({ details }: { details: WifiDetails }) {
  const live = details.live;
  if (!live) return null;
  const speed = live.linkSpeed || live.maxSpeed;
  return (
    <>
      <SubHeading>Network details</SubHeading>
      <dl className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60 bg-background/40">
        <InfoRow label="Signal strength" value={live.signal ? `${signalLabel(live.signal)} (${live.signal}%)` : 'Unknown'} />
        {speed > 0 && <InfoRow label="Link speed" value={`${speed} Mbps`} />}
        <InfoRow
          label="Frequency"
          value={live.freqMhz ? `${bandLabel(live.freqMhz)} · channel ${live.channel} (${live.freqMhz} MHz)` : 'Unknown'}
        />
        <InfoRow label="Security" value={live.security || SECURITY_LABELS[details.security]} />
        <InfoRow label="MAC address" value={live.macAddress || 'Unknown'} />
        {live.deviceMacAddress && live.deviceMacAddress !== live.macAddress && (
          <InfoRow label="Device MAC address" value={live.deviceMacAddress} />
        )}
        {live.bssid && <InfoRow label="Access point" value={live.bssid} />}
        <InfoRow label="IP address" value={live.ipAddress || 'None yet'} />
        {live.gateway && <InfoRow label="Gateway" value={live.gateway} />}
        {live.prefix > 0 && <InfoRow label="Subnet mask" value={subnetMask(live.prefix)} />}
        {live.dns.length > 0 && (
          <InfoRow
            label="DNS"
            value={live.dns.map((dns) => (
              <span key={dns} className="block">
                {dns}
              </span>
            ))}
          />
        )}
        {live.ipv6Addresses.length > 0 && (
          <InfoRow
            label="IPv6 addresses"
            value={live.ipv6Addresses.map((address) => (
              <span key={address} className="block">
                {address}
              </span>
            ))}
          />
        )}
      </dl>
    </>
  );
}

/** A row that shows a summary and opens its own little form to change it. */
function EditableRow({
  label,
  summary,
  editing,
  onEdit,
  children,
}: {
  label: string;
  summary: React.ReactNode;
  editing: boolean;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-foreground">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{summary}</p>
        </div>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden />
            Edit
          </Button>
        )}
      </div>
      {editing && <div className="mt-3">{children}</div>}
    </div>
  );
}

function FormButtons({
  pending,
  valid,
  onSave,
  onCancel,
  note,
}: {
  pending: boolean;
  valid: boolean;
  onSave: () => void;
  onCancel: () => void;
  note?: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      {note && <p className="mr-auto text-xs text-muted-foreground">{note}</p>}
      <Button variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" disabled={!valid || pending} onClick={onSave}>
        {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        Save
      </Button>
    </div>
  );
}

interface EditorProps {
  details: WifiDetails;
  pending: boolean;
  onSave: (changes: WifiChanges, onSuccess?: () => void) => void;
}

const RECONNECT_NOTE = 'Saving reconnects to the network.';

function PasswordEditor({ details, pending, onSave }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [password, setPassword] = useState('');
  const error = passwordError(details.security, password);
  return (
    <EditableRow
      label="Password"
      summary={SECURITY_LABELS[details.security]}
      editing={editing}
      onEdit={() => {
        setPassword('');
        setEditing(true);
      }}
    >
      <PasswordField label="New password" value={password} autoFocus onChange={setPassword} error={password ? error : null} />
      <FormButtons
        pending={pending}
        valid={password.length > 0 && !error}
        note={details.active ? RECONNECT_NOTE : undefined}
        onCancel={() => setEditing(false)}
        onSave={() => onSave({ password }, () => setEditing(false))}
      />
    </EditableRow>
  );
}

function EapEditor({ details, pending, onSave }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => eapDraftFrom(details.settings.eap));
  const result = eapFromDraft(draft, false);
  const eap = details.settings.eap;
  return (
    <EditableRow
      label="Sign-in"
      summary={eap ? `${eap.method.toUpperCase()} · ${eap.identity || 'no identity'}` : SECURITY_LABELS[details.security]}
      editing={editing}
      onEdit={() => {
        setDraft(eapDraftFrom(details.settings.eap));
        setEditing(true);
      }}
    >
      <EapFields draft={draft} onChange={setDraft} passwordPlaceholder="(unchanged)" />
      <FormButtons
        pending={pending}
        valid={result !== null}
        note={details.active ? RECONNECT_NOTE : undefined}
        onCancel={() => setEditing(false)}
        onSave={() => result && onSave(result, () => setEditing(false))}
      />
    </EditableRow>
  );
}

/** The editor's starting point: the saved settings, with what DHCP gave filled in to switch to static from. */
function initialIpDraft(details: WifiDetails) {
  const draft = ipDraftFrom(details.settings.ip);
  const live = details.live;
  if (details.settings.ip.method === 'static' || !live?.ipAddress) return draft;
  const ipv4Dns = live.dns.filter((dns) => !dns.includes(':'));
  return {
    ...draft,
    address: live.ipAddress,
    prefix: String(live.prefix || 24),
    gateway: live.gateway,
    dns1: draft.dns1 || ipv4Dns[0] || '',
    dns2: draft.dns2 || (draft.dns1 ? '' : ipv4Dns[1] || ''),
  };
}

function IpEditor({ details, pending, onSave }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => initialIpDraft(details));
  const ip = ipFromDraft(draft);
  return (
    <EditableRow
      label="IP settings"
      summary={ipSummary(details.settings.ip)}
      editing={editing}
      onEdit={() => {
        setDraft(initialIpDraft(details));
        setEditing(true);
      }}
    >
      <IpFields draft={draft} onChange={setDraft} />
      <FormButtons
        pending={pending}
        valid={ip !== null}
        note={details.active ? RECONNECT_NOTE : undefined}
        onCancel={() => setEditing(false)}
        onSave={() => ip && onSave({ ip }, () => setEditing(false))}
      />
    </EditableRow>
  );
}

function ProxyEditor({ details, pending, onSave }: EditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => proxyDraftFrom(details.settings.proxy));
  const proxy = proxyFromDraft(draft);
  return (
    <EditableRow
      label="Proxy"
      summary={proxySummary(details.settings.proxy)}
      editing={editing}
      onEdit={() => {
        setDraft(proxyDraftFrom(details.settings.proxy));
        setEditing(true);
      }}
    >
      <ProxyFields draft={draft} onChange={setDraft} />
      <FormButtons
        pending={pending}
        valid={proxy !== null}
        onCancel={() => setEditing(false)}
        onSave={() => proxy && onSave({ proxy }, () => setEditing(false))}
      />
    </EditableRow>
  );
}

/** A QR code a phone's camera joins the network from, and the password in words. */
function ShareDialog({ details, onClose }: { details: WifiDetails; onClose: () => void }) {
  const [state, setState] = useState<{ password: string | null; error: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const bridge = getWifiBridge();
    if (!bridge) return;
    bridge
      .secret(details.uuid)
      .then((password) => !cancelled && setState({ password, error: null }))
      .catch((e: unknown) => !cancelled && setState({ password: null, error: cleanWifiError(e) }));
    return () => {
      cancelled = true;
    };
  }, [details.uuid]);

  const payload = state ? wifiQrPayload(details, state.password) : null;
  const open = details.security === 'open' || details.security === 'owe';

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Share “{details.ssid}”</DialogTitle>
          <DialogDescription>Scan this QR code with a phone's camera to join the network.</DialogDescription>
        </DialogHeader>
        {state === null ? (
          <Skeleton className="mx-auto size-56 rounded-lg" />
        ) : state.error || !payload ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error ?? "This network's password isn't saved, so it can't be shared."}
          </p>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-xl bg-white p-3">
              <QRCodeCanvas value={payload} size={224} />
            </div>
            {!open && state.password && (
              <div className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">Wi-Fi password</p>
                  <p className="break-all font-mono text-sm text-foreground select-text">{state.password}</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Copy password"
                  onClick={() => {
                    if (!state.password) return;
                    void navigator.clipboard.writeText(state.password).then(() => setCopied(true));
                  }}
                >
                  {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-40 rounded-xl bg-foreground/10" />
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-md bg-foreground/10" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl bg-foreground/10" />
    </div>
  );
}
