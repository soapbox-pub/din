import { useId, useState } from 'react';
import { ChevronDown, Eye, EyeOff, FileKey, Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWifiMutations } from '@/hooks/useWifi';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';
import { cleanWifiError, SECURITY_LABELS } from '@/lib/wifi';
import type { WifiMacMode, WifiMetered, WifiSecurity } from '@/lib/wifi';
import {
  DEFAULT_IP,
  eapDraftFrom,
  eapFromDraft,
  ipDraftFrom,
  ipErrors,
  ipFromDraft,
  MAC_OPTIONS,
  METERED_OPTIONS,
  NO_PROXY,
  passwordError,
  PHASE2_OPTIONS,
  proxyDraftFrom,
  proxyErrors,
  proxyFromDraft,
} from '@/lib/wifiForm';
import type { EapDraft, IpDraft, ProxyDraft } from '@/lib/wifiForm';

/**
 * The pieces Wi-Fi settings are edited with: the fields for a password, IP
 * settings, a proxy and an enterprise sign-in, each with its own draft and
 * validation, and the Add network dialog that puts them together. Modeled on
 * Android's: every option it has, nothing NetworkManager adds on top.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** A native select styled like Settings' others. */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  description,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={cn(
          'h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  error,
  inputMode,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** A password input with a show/hide toggle. */
export function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 pr-10"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-0 right-0 size-9 text-muted-foreground"
          aria-label={shown ? 'Hide password' : 'Show password'}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** A labelled switch row for use inside a form. */
export function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** A certificate file chosen with Din's file picker. */
function FileField({
  label,
  value,
  onChange,
  optional,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  optional?: boolean;
  error?: string | null;
}) {
  const { pickFile } = useFilePicker();
  const choose = async () => {
    const path = await pickFile({
      title: label,
      confirmLabel: 'Choose',
      extensions: ['.pem', '.crt', '.cer', '.der', '.p12', '.pfx', '.key'],
    });
    if (path) onChange(path);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-input px-3 text-sm',
            value ? 'text-foreground' : 'text-muted-foreground',
          )}
          title={value || undefined}
        >
          <FileKey className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate" dir={value ? 'rtl' : undefined}>
            {value || (optional ? 'None' : 'No file chosen')}
          </span>
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => void choose()}>
          Choose…
        </Button>
        {optional && value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            Clear
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export function IpFields({ draft, onChange }: { draft: IpDraft; onChange: (draft: IpDraft) => void }) {
  const errors = ipErrors(draft);
  const set = (patch: Partial<IpDraft>) => onChange({ ...draft, ...patch });
  // Only complain about a field once something's been typed in it.
  const shown = (key: keyof IpDraft) => (draft[key] ? errors[key] : null);
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="IP settings"
        value={draft.method}
        options={[
          { value: 'dhcp', label: 'DHCP' },
          { value: 'static', label: 'Static' },
        ]}
        onChange={(method) => set({ method })}
      />
      {draft.method === 'static' ? (
        <>
          <TextField label="IP address" value={draft.address} placeholder="192.168.1.128" inputMode="decimal" error={shown('address')} onChange={(address) => set({ address })} />
          <TextField label="Gateway" value={draft.gateway} placeholder="192.168.1.1" inputMode="decimal" error={shown('gateway')} onChange={(gateway) => set({ gateway })} />
          <TextField label="Network prefix length" value={draft.prefix} placeholder="24" inputMode="numeric" error={shown('prefix')} onChange={(prefix) => set({ prefix })} />
        </>
      ) : (
        <SelectField
          label="DNS"
          value={draft.dnsMode}
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'custom', label: 'Custom' },
          ]}
          onChange={(dnsMode) => set({ dnsMode })}
        />
      )}
      {(draft.method === 'static' || draft.dnsMode === 'custom') && (
        <>
          <TextField label="DNS 1" value={draft.dns1} placeholder="1.1.1.1" error={shown('dns1')} onChange={(dns1) => set({ dns1 })} />
          <TextField label="DNS 2" value={draft.dns2} placeholder="9.9.9.9" error={shown('dns2')} onChange={(dns2) => set({ dns2 })} />
        </>
      )}
    </div>
  );
}

export function ProxyFields({ draft, onChange }: { draft: ProxyDraft; onChange: (draft: ProxyDraft) => void }) {
  const errors = proxyErrors(draft);
  const set = (patch: Partial<ProxyDraft>) => onChange({ ...draft, ...patch });
  const shown = (key: keyof ProxyDraft) => (draft[key] ? errors[key] : null);
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="Proxy"
        value={draft.mode}
        options={[
          { value: 'none', label: 'None' },
          { value: 'manual', label: 'Manual' },
          { value: 'pac', label: 'Proxy Auto-Config' },
        ]}
        onChange={(mode) => set({ mode })}
      />
      {draft.mode === 'manual' && (
        <>
          <p className="text-xs text-muted-foreground">
            The HTTP proxy is used by the browser and Din's apps, but other apps might not use it.
          </p>
          <TextField label="Proxy hostname" value={draft.host} placeholder="proxy.example.com" error={shown('host')} onChange={(host) => set({ host })} />
          <TextField label="Proxy port" value={draft.port} placeholder="8080" inputMode="numeric" error={shown('port')} onChange={(port) => set({ port })} />
          <TextField label="Bypass proxy for" value={draft.bypass} placeholder="example.com,mycomp.test.com,localhost" error={shown('bypass')} onChange={(bypass) => set({ bypass })} />
        </>
      )}
      {draft.mode === 'pac' && (
        <TextField label="PAC URL" value={draft.pacUrl} placeholder="http://example.com/proxy.pac" error={shown('pacUrl')} onChange={(pacUrl) => set({ pacUrl })} />
      )}
    </div>
  );
}

/** One line describing a proxy. */
export function EapFields({
  draft,
  onChange,
  passwordPlaceholder,
}: {
  draft: EapDraft;
  onChange: (draft: EapDraft) => void;
  /** Shown in the password field; e.g. "(unchanged)" when editing. */
  passwordPlaceholder?: string;
}) {
  const set = (patch: Partial<EapDraft>) => onChange({ ...draft, ...patch });
  const phase2 = PHASE2_OPTIONS[draft.method];
  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="EAP method"
        value={draft.method}
        options={[
          { value: 'peap', label: 'PEAP' },
          { value: 'ttls', label: 'TTLS' },
          { value: 'tls', label: 'TLS' },
          { value: 'pwd', label: 'PWD' },
        ]}
        onChange={(method) =>
          set({ method, phase2: PHASE2_OPTIONS[method].some((o) => o.value === draft.phase2) ? draft.phase2 : PHASE2_OPTIONS[method][0]?.value ?? 'none' })
        }
      />
      {phase2.length > 0 && (
        <SelectField label="Phase 2 authentication" value={draft.phase2} options={phase2} onChange={(value) => set({ phase2: value })} />
      )}
      {draft.method !== 'pwd' && (
        <>
          <SelectField
            label="CA certificate"
            value={draft.caMode}
            options={[
              { value: 'system', label: 'Use system certificates' },
              { value: 'file', label: 'Use a certificate file' },
              { value: 'none', label: "Don't validate" },
            ]}
            onChange={(caMode) => set({ caMode })}
          />
          {draft.caMode === 'file' && (
            <FileField label="CA certificate file" value={draft.caCert} onChange={(caCert) => set({ caCert })} />
          )}
          {draft.caMode === 'none' ? (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              No certificate specified. Your connection won't be private.
            </p>
          ) : (
            <TextField label="Domain" value={draft.domain} placeholder="example.com" onChange={(domain) => set({ domain })} />
          )}
        </>
      )}
      {draft.method === 'tls' && (
        <>
          <FileField label="User certificate" value={draft.clientCert} onChange={(clientCert) => set({ clientCert })} />
          <FileField label="Private key (if not in the certificate file)" value={draft.privateKey === draft.clientCert ? '' : draft.privateKey} optional onChange={(privateKey) => set({ privateKey })} />
        </>
      )}
      <TextField label="Identity" value={draft.identity} onChange={(identity) => set({ identity })} />
      {(draft.method === 'peap' || draft.method === 'ttls') && (
        <TextField label="Anonymous identity" value={draft.anonymousIdentity} placeholder="Optional" onChange={(anonymousIdentity) => set({ anonymousIdentity })} />
      )}
      {draft.method === 'tls' ? (
        <PasswordField label="Private key password" value={draft.keyPassword} placeholder={passwordPlaceholder ?? 'Optional'} onChange={(keyPassword) => set({ keyPassword })} />
      ) : (
        <PasswordField label="Password" value={draft.password} placeholder={passwordPlaceholder} onChange={(password) => set({ password })} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add network
// ---------------------------------------------------------------------------

const SECURITY_OPTIONS = (Object.keys(SECURITY_LABELS) as WifiSecurity[]).map((value) => ({
  value,
  label: SECURITY_LABELS[value],
}));

/**
 * Add network: a network typed in by hand (a hidden one, say, or one with
 * settings of its own before the first join), and the full sign-in form a
 * work or school (802.1X) network needs. Saves it and tries to join.
 */
export function AddNetworkDialog({
  initial,
  onClose,
}: {
  initial: { ssid?: string; security?: WifiSecurity };
  onClose: () => void;
}) {
  const { add } = useWifiMutations();
  const { toast } = useToast();
  const fixedSsid = initial.ssid !== undefined;
  const [ssid, setSsid] = useState(initial.ssid ?? '');
  const [security, setSecurity] = useState<WifiSecurity>(initial.security ?? 'wpa-psk');
  const [password, setPassword] = useState('');
  const [eap, setEap] = useState<EapDraft>(() => eapDraftFrom(null));
  const [advanced, setAdvanced] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [metered, setMetered] = useState<WifiMetered>('auto');
  const [mac, setMac] = useState<Exclude<WifiMacMode, 'default'>>('device');
  const [ip, setIp] = useState<IpDraft>(() => ipDraftFrom(DEFAULT_IP));
  const [proxy, setProxy] = useState<ProxyDraft>(() => proxyDraftFrom(NO_PROXY));
  const [error, setError] = useState<string | null>(null);

  const ssidValid = ssid.length > 0 && new TextEncoder().encode(ssid).length <= 32;
  const needsPassword = security === 'wpa-psk' || security === 'sae' || security === 'wep';
  const pwError = needsPassword ? passwordError(security, password) : null;
  const eapResult = security === 'wpa-eap' ? eapFromDraft(eap, true) : null;
  const ipResult = ipFromDraft(ip);
  const proxyResult = proxyFromDraft(proxy);
  const valid =
    ssidValid && !pwError && (security !== 'wpa-eap' || eapResult !== null) && ipResult !== null && proxyResult !== null;

  const submit = () => {
    if (!valid || add.isPending || !ipResult || !proxyResult) return;
    setError(null);
    add.mutate(
      {
        ssid,
        security,
        hidden,
        metered,
        mac,
        ip: ipResult,
        proxy: proxyResult,
        ...(needsPassword ? { password } : {}),
        ...(eapResult ? { eap: eapResult.eap, password: eapResult.password, keyPassword: eapResult.keyPassword } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.connected) {
            toast({ title: `Connected to ${ssid}` });
          } else {
            toast({
              title: `Saved ${ssid}`,
              description: result.error
                ? `Couldn't connect: ${result.error}`
                : 'It isn’t in range now; this computer joins it when it is.',
            });
          }
          onClose();
        },
        onError: (e) => setError(cleanWifiError(e)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !add.isPending && onClose()}>
      <DialogContent className="max-h-[90%] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{fixedSsid ? `Join ${initial.ssid}` : 'Add network'}</DialogTitle>
          <DialogDescription>
            {fixedSsid
              ? 'This network asks you to sign in with an account.'
              : 'Join a hidden network, or one that needs settings of its own.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {!fixedSsid && (
            <TextField label="Network name" value={ssid} autoFocus placeholder="Enter the SSID" onChange={setSsid} error={ssid && !ssidValid ? 'At most 32 bytes' : null} />
          )}
          {!fixedSsid && (
            <SelectField label="Security" value={security} options={SECURITY_OPTIONS} onChange={setSecurity} />
          )}
          {needsPassword && (
            <PasswordField label="Password" value={password} autoFocus={fixedSsid} onChange={setPassword} error={password ? pwError : null} />
          )}
          {security === 'wpa-eap' && <EapFields draft={eap} onChange={setEap} />}

          <button
            type="button"
            className="flex items-center gap-1 self-start rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            <ChevronDown className={cn('size-4 transition-transform motion-reduce:transition-none', advanced && 'rotate-180')} aria-hidden />
            Advanced options
          </button>
          {advanced && (
            <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
              {!fixedSsid && (
                <SwitchField label="Hidden network" description="Look for this network even when it doesn't broadcast its name." checked={hidden} onChange={setHidden} />
              )}
              <SelectField label="Metered" value={metered} options={METERED_OPTIONS} onChange={setMetered} />
              <ProxyFields draft={proxy} onChange={setProxy} />
              <IpFields draft={ip} onChange={setIp} />
              <SelectField label="Privacy" value={mac} options={MAC_OPTIONS} onChange={setMac} />
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={add.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || add.isPending}>
              {add.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {fixedSsid ? 'Connect' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
