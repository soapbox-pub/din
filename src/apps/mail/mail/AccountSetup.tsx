import { useState, type FormEvent } from 'react';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Overlay, DialogButton } from '@/shared/dialogs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { MailAccount, MailServer, MailSettings } from '@/lib/mail';
import { useMail } from './api';
import { EMAIL } from './format';

type Provider = NonNullable<MailSettings['provider']> | 'other';

const PROVIDERS: { id: Provider; label: string; className: string }[] = [
  { id: 'icloud', label: 'iCloud', className: 'font-semibold tracking-tight text-sky-600 dark:text-sky-400' },
  { id: 'gmail', label: 'Google', className: 'font-semibold tracking-tight' },
  { id: 'outlook', label: 'Outlook', className: 'font-semibold text-[#0a64c8] dark:text-[#4aa0f0]' },
  { id: 'yahoo', label: 'Yahoo!', className: 'font-extrabold italic text-[#6001d2] dark:text-[#a46bff]' },
  { id: 'aol', label: 'Aol.', className: 'font-bold text-foreground' },
  { id: 'fastmail', label: 'Fastmail', className: 'font-semibold text-[#0067b9] dark:text-[#5aa8f0]' },
  { id: 'proton', label: 'Proton Mail', className: 'font-semibold text-[#6d4aff] dark:text-[#9b85ff]' },
  { id: 'other', label: 'Other Mail Account…', className: 'text-sm font-medium text-foreground' },
];

const NAMES: Record<Provider, string> = {
  icloud: 'iCloud',
  gmail: 'Google',
  outlook: 'Outlook',
  yahoo: 'Yahoo!',
  aol: 'AOL',
  fastmail: 'Fastmail',
  proton: 'Proton Mail',
  other: '',
};

/** What the password field needs, for providers that don't take the account's own password. */
const HINTS: Partial<Record<Provider, string>> = {
  icloud: 'iCloud needs an app-specific password: make one at account.apple.com, under Sign-In and Security.',
  gmail: 'Google needs an app password: turn on 2-Step Verification, then make one at myaccount.google.com/apppasswords.',
  outlook: 'Microsoft lets mail apps sign in with a password only where IMAP and app passwords are turned on. Many Outlook.com accounts can’t connect this way yet.',
  yahoo: 'Yahoo needs an app password: make one under Account Security, Generate app password.',
  aol: 'AOL needs an app password: make one under Account Security, Generate app password.',
  fastmail: 'Fastmail needs an app password: make one in Settings, Privacy & Security, App passwords.',
  proton: 'Proton Mail works through Proton Mail Bridge on this computer. Start Bridge, then use the address and password it shows.',
};

const GOOGLE = [['G', '#4285f4'], ['o', '#ea4335'], ['o', '#fbbc05'], ['g', '#4285f4'], ['l', '#34a853'], ['e', '#ea4335']] as const;

function GoogleWordmark() {
  return (
    <span aria-label="Google">
      {GOOGLE.map(([letter, color], i) => (
        <span key={i} aria-hidden style={{ color }}>
          {letter}
        </span>
      ))}
    </span>
  );
}

function ServerFields({ title, value, onChange }: { title: string; value: MailServer; onChange: (s: MailServer) => void }) {
  const id = title.toLowerCase().replace(/\s+/g, '-');
  return (
    <fieldset className="space-y-2 rounded-xl bg-card clay p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{title}</legend>
      <div className="grid grid-cols-[1fr_88px] gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-host`} className="text-xs">Server</Label>
          <Input id={`${id}-host`} value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} placeholder="mail.example.com" spellCheck={false} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-port`} className="text-xs">Port</Label>
          <Input id={`${id}-port`} inputMode="numeric" value={String(value.port || '')} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-user`} className="text-xs">User Name</Label>
        <Input id={`${id}-user`} value={value.user} onChange={(e) => onChange({ ...value, user: e.target.value.trim() })} spellCheck={false} autoComplete="off" />
      </div>
      <label className="flex items-center justify-between gap-3 pt-1 text-[13px]">
        <span>Use TLS from the start <span className="text-muted-foreground">(otherwise STARTTLS)</span></span>
        <Switch checked={value.secure} onCheckedChange={(secure) => onChange({ ...value, secure })} />
      </label>
    </fieldset>
  );
}

export function AccountSetup({ onClose, onAdded, first }: { onClose: () => void; onAdded: (a: MailAccount) => void; first: boolean }) {
  const mail = useMail();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<Provider | null>(null);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [description, setDescription] = useState('');
  const [servers, setServers] = useState<{ imap: MailServer; smtp: MailServer } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mail || busy) return;
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setError('Enter your email address.');
      return;
    }
    setError(null);
    try {
      let settings = servers;
      let found: MailSettings | null = null;
      if (!settings) {
        setBusy('Finding the account’s servers…');
        found = await mail.discover(address);
        settings = { imap: found.imap, smtp: found.smtp };
      }
      setBusy('Signing in…');
      const name = description.trim() || (provider && provider !== 'other' ? NAMES[provider] : '') || (found?.provider ? NAMES[found.provider] : '') || address.split('@')[1];
      const account = await mail.addAccount({ name, fullName: fullName.trim(), email: address, password, imap: settings.imap, smtp: settings.smtp });
      qc.setQueryData<MailAccount[]>(['mail', 'accounts'], (list) => [...(list ?? []), account]);
      onAdded(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Show what was tried, to fix by hand.
      if (!servers) {
        const guess = await mail.discover(address).catch(() => null);
        if (guess) setServers({ imap: guess.imap, smtp: guess.smtp });
      }
    } finally {
      setBusy(null);
    }
  };

  const hint = provider ? HINTS[provider] : undefined;

  return (
    <Overlay label="Add a mail account" onClose={busy ? () => {} : onClose} className="max-w-[440px]">
      {!provider ? (
        <div className="p-6">
          <h2 className="text-center text-[15px] font-semibold">Choose a Mail account provider…</h2>
          {first && <p className="mt-1 text-center text-[13px] text-muted-foreground">Mail reads and sends email from any account that has IMAP.</p>}
          <ul className="mt-5 space-y-1.5">
            {PROVIDERS.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setProvider(p.id);
                    if (p.id === 'proton') setServers({ imap: { host: '127.0.0.1', port: 1143, secure: false, user: '' }, smtp: { host: '127.0.0.1', port: 1025, secure: false, user: '' } });
                  }}
                  className="flex h-12 w-full items-center justify-center rounded-xl bg-card clay text-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <span className={p.className}>{p.id === 'gmail' ? <GoogleWordmark /> : p.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex justify-end">
            <DialogButton onClick={onClose}>{first ? 'Not Now' : 'Cancel'}</DialogButton>
          </div>
        </div>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-col">
          <div className="min-h-0 space-y-4 overflow-y-auto p-6">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Back" onClick={() => { setProvider(null); setServers(null); setError(null); }} disabled={!!busy} className="grid size-7 place-items-center rounded-md hover:bg-accent">
                <ChevronLeft className="size-4" />
              </button>
              <h2 className="text-[15px] font-semibold">{provider === 'other' ? 'Add a Mail Account' : `Sign in to ${NAMES[provider]}`}</h2>
            </div>
            {hint && <p className="rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">{hint}</p>}
            {error && (
              <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] break-words text-destructive">
                {error}
              </p>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="mail-name">Name</Label>
              <Input id="mail-name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name, as people see it" autoComplete="name" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-email">Email Address</Label>
              <Input
                id="mail-email"
                type="email"
                autoFocus
                value={email}
                onChange={(e) => {
                  const v = e.target.value;
                  setEmail(v);
                  if (servers && provider !== 'proton') setServers(null);
                  if (provider === 'proton') setServers((s) => s && { imap: { ...s.imap, user: v.trim() }, smtp: { ...s.smtp, user: v.trim() } });
                }}
                placeholder="name@example.com"
                autoComplete="email"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mail-password">Password</Label>
              <Input id="mail-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
            </div>
            {(servers || provider === 'other') && (
              <div className="space-y-1.5">
                <Label htmlFor="mail-description">Description</Label>
                <Input id="mail-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={email.split('@')[1] || 'Work, Personal…'} />
              </div>
            )}
            {servers && (
              <div className="space-y-3">
                <ServerFields title="Incoming Mail (IMAP)" value={servers.imap} onChange={(imap) => setServers({ ...servers, imap })} />
                <ServerFields title="Outgoing Mail (SMTP)" value={servers.smtp} onChange={(smtp) => setServers({ ...servers, smtp })} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border/60 px-6 py-3">
            {busy ? (
              <span className="flex flex-1 items-center gap-2 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> {busy}
              </span>
            ) : (
              <button type="button" onClick={() => setServers((s) => s ?? { imap: { host: '', port: 993, secure: true, user: email.trim() }, smtp: { host: '', port: 465, secure: true, user: email.trim() } })} className={cn('flex-1 text-left text-[13px] text-ink-accent hover:underline', servers && 'invisible')}>
                Server settings…
              </button>
            )}
            <DialogButton type="button" onClick={onClose} disabled={!!busy}>Cancel</DialogButton>
            <DialogButton type="submit" variant="primary" disabled={!!busy || !email || !password}>Sign In</DialogButton>
          </div>
        </form>
      )}
    </Overlay>
  );
}
