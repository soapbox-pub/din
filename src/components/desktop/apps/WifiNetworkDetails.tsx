import { useEffect, useState } from 'react';
import { Check, Copy, Loader2, Pencil, QrCode, Trash2, Wifi, WifiOff } from 'lucide-react';
import { WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import {
  ActionButton,
  ActionButtons,
  DetailsError,
  DetailsGroup,
  DetailsHero,
  DetailsPage,
  DetailsSkeleton,
  DetailsSubHeading,
  InfoList,
  InfoRow,
  ToggleRow,
} from '@/components/desktop/apps/DetailsPage';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { Skeleton } from '@/components/ui/skeleton';
import { useWifiDetails, useWifiMutations } from '@/hooks/useWifi';
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
    <DetailsPage title={data?.ssid ?? 'Network details'} backLabel="Back to Wi-Fi" onBack={onBack}>

      {details.isLoading ? (
        <DetailsSkeleton />
      ) : details.isError || !data ? (
        <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center text-sm text-muted-foreground">
          {details.isError ? cleanWifiError(details.error) : 'This network is no longer saved.'}
        </div>
      ) : (
        <>
          <DetailsHero
            icon={
              data.active || scanned ? (
                <WifiSignalIcon signal={data.live?.signal || scanned?.signal || 0} />
              ) : (
                <WifiOff aria-hidden />
              )
            }
            name={data.ssid}
            status={data.active ? 'Connected' : scanned ? 'Saved' : 'Not in range'}
            active={data.active}
          />

          <ActionButtons>
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
          </ActionButtons>

          {error !== null && <DetailsError>{error}</DetailsError>}

          <DetailsGroup>
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
          </DetailsGroup>

          {data.live && <LiveDetailsGroup details={data} />}

          <DetailsSubHeading>Advanced</DetailsSubHeading>
          <DetailsGroup>
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
          </DetailsGroup>
        </>
      )}

      {sharing && data && <ShareDialog details={data} onClose={() => setSharing(false)} />}
    </DetailsPage>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3">{children}</div>;
}

function LiveDetailsGroup({ details }: { details: WifiDetails }) {
  const live = details.live;
  if (!live) return null;
  const speed = live.linkSpeed || live.maxSpeed;
  return (
    <>
      <DetailsSubHeading>Network details</DetailsSubHeading>
      <InfoList>
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
      </InfoList>
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
