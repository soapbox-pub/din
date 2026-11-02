import { useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { MailAccount, MailServer } from '@/lib/mail';
import { useMail } from './api';
import { REMOTE_KEY } from './Reader';

function Server({ title, value, onChange }: { title: string; value: MailServer; onChange: (s: MailServer) => void }) {
  return (
    <fieldset className="grid grid-cols-[1fr_80px] gap-2 rounded-lg border border-border/70 p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{title}</legend>
      <Input aria-label={`${title} server`} value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value.trim() })} spellCheck={false} />
      <Input aria-label={`${title} port`} inputMode="numeric" value={String(value.port || '')} onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
      <Input aria-label={`${title} user name`} className="col-span-2" value={value.user} onChange={(e) => onChange({ ...value, user: e.target.value.trim() })} spellCheck={false} />
      <label className="col-span-2 flex items-center justify-between text-[13px]">
        TLS from the start
        <Switch checked={value.secure} onCheckedChange={(secure) => onChange({ ...value, secure })} />
      </label>
    </fieldset>
  );
}

function AccountForm({ account, onRemoved }: { account: MailAccount; onRemoved: () => void }) {
  const mail = useMail();
  const qc = useQueryClient();
  const [name, setName] = useState(account.name);
  const [fullName, setFullName] = useState(account.fullName);
  const [signature, setSignature] = useState(account.signature);
  const [imap, setImap] = useState(account.imap);
  const [smtp, setSmtp] = useState(account.smtp);
  const [password, setPassword] = useState('');
  const [servers, setServers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  const dirty =
    name !== account.name || fullName !== account.fullName || signature !== account.signature || password !== '' ||
    JSON.stringify(imap) !== JSON.stringify(account.imap) || JSON.stringify(smtp) !== JSON.stringify(account.smtp);

  const save = async () => {
    if (!mail) return;
    setBusy(true);
    setMessage(null);
    try {
      const serversChanged = JSON.stringify(imap) !== JSON.stringify(account.imap) || JSON.stringify(smtp) !== JSON.stringify(account.smtp);
      const updated = await mail.updateAccount(account.id, {
        name,
        fullName,
        signature,
        ...(password ? { password } : {}),
        ...(serversChanged ? { imap, smtp } : {}),
      });
      qc.setQueryData<MailAccount[]>(['mail', 'accounts'], (list) => list?.map((a) => (a.id === updated.id ? updated : a)));
      if (password || serversChanged) void qc.invalidateQueries({ queryKey: ['mail', 'mailboxes', account.id] });
      setPassword('');
      setMessage({ error: false, text: 'Saved.' });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!mail) return;
    await mail.removeAccount(account.id);
    qc.setQueryData<MailAccount[]>(['mail', 'accounts'], (list) => list?.filter((a) => a.id !== account.id));
    qc.removeQueries({ queryKey: ['mail', 'mailboxes', account.id] });
    onRemoved();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="acct-desc">Description</Label>
          <Input id="acct-desc" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="acct-email">Email Address</Label>
          <Input id="acct-email" value={account.email} readOnly className="text-muted-foreground" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="acct-name">Full Name</Label>
          <Input id="acct-name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="acct-sig">Signature</Label>
          <Textarea id="acct-sig" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Added below new messages" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="acct-pass">Password</Label>
          <Input id="acct-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Unchanged" autoComplete="off" />
        </div>
        {servers ? (
          <div className="space-y-3">
            <Server title="Incoming (IMAP)" value={imap} onChange={setImap} />
            <Server title="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
          </div>
        ) : (
          <button type="button" onClick={() => setServers(true)} className="text-[13px] text-primary hover:underline">
            Server Settings…
          </button>
        )}
        {message && (
          <p role={message.error ? 'alert' : 'status'} className={cn('text-[13px]', message.error ? 'text-destructive' : 'text-muted-foreground')}>
            {message.text}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-5 py-3">
        {confirm ? (
          <>
            <span className="flex-1 text-[13px]">Remove this account from Mail?</span>
            <DialogButton onClick={() => setConfirm(false)}>Cancel</DialogButton>
            <DialogButton variant="destructive" onClick={() => void remove()}>Remove</DialogButton>
          </>
        ) : (
          <>
            <DialogButton variant="destructive" onClick={() => setConfirm(true)} className="mr-auto">Remove Account</DialogButton>
            {busy && <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />}
            <DialogButton variant="primary" disabled={!dirty || busy} onClick={() => void save()}>Save</DialogButton>
          </>
        )}
      </div>
    </div>
  );
}

export function AccountSettings({ accounts, initial, onClose, onAdd }: { accounts: MailAccount[]; initial: string | null; onClose: () => void; onAdd: () => void }) {
  const [selected, setSelected] = useState<string | 'general'>(initial ?? accounts[0]?.id ?? 'general');
  const [remote, setRemote] = useState(() => localStorage.getItem(REMOTE_KEY) === 'always');
  const account = accounts.find((a) => a.id === selected);
  const mail = useMail();
  const qc = useQueryClient();
  const lookups = useQuery({ queryKey: ['mail', 'avatar-lookups'], queryFn: () => mail!.avatarLookups(), enabled: !!mail });

  return (
    <Overlay label="Mail settings" onClose={onClose} className="h-[560px] max-w-[720px]">
      <div className="flex h-11 shrink-0 items-center border-b border-border/60 px-4">
        <h2 className="flex-1 text-[13px] font-semibold">Settings</h2>
        <DialogButton onClick={onClose}>Done</DialogButton>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-52 shrink-0 flex-col border-r border-border/60 bg-muted/30 p-2">
          <button type="button" onClick={() => setSelected('general')} className={cn('rounded-md px-2 py-1.5 text-left text-[13px]', selected === 'general' ? 'bg-foreground/10 font-medium' : 'hover:bg-foreground/5')}>
            General
          </button>
          <div className="mt-3 mb-1 px-2 text-[11px] font-semibold text-muted-foreground">Accounts</div>
          <div className="min-h-0 flex-1 space-y-px overflow-y-auto">
            {accounts.map((a) => (
              <button key={a.id} type="button" onClick={() => setSelected(a.id)} className={cn('block w-full rounded-md px-2 py-1.5 text-left', selected === a.id ? 'bg-foreground/10' : 'hover:bg-foreground/5')}>
                <span className="block truncate text-[13px] font-medium">{a.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{a.email}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={onAdd} className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-primary hover:bg-foreground/5">
            <Plus className="size-4" /> Add Account…
          </button>
        </div>
        {account ? (
          <AccountForm key={account.id} account={account} onRemoved={() => setSelected('general')} />
        ) : (
          <div className="flex-1 space-y-4 p-5">
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-[13px] font-medium">Load remote content in messages</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">Pictures and styles from the web tell senders when you’ve read their mail. Off, each message asks first.</span>
              </span>
              <Switch
                checked={remote}
                onCheckedChange={(on) => {
                  setRemote(on);
                  if (on) localStorage.setItem(REMOTE_KEY, 'always');
                  else localStorage.removeItem(REMOTE_KEY);
                  window.dispatchEvent(new Event('din-mail-remote'));
                }}
              />
            </label>
            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-[13px] font-medium">Look up senders’ pictures</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  From the sender’s own domain (its Nostr profile or brand logo), only for senders your server checked, and never when you open a message. Their domain can see that it was asked.
                </span>
              </span>
              <Switch
                checked={lookups.data ?? true}
                disabled={!lookups.isSuccess}
                onCheckedChange={async (on) => {
                  qc.setQueryData(['mail', 'avatar-lookups'], on);
                  await mail?.setAvatarLookups(on);
                  void qc.invalidateQueries({ queryKey: ['mail', 'avatar'] });
                }}
              />
            </label>
          </div>
        )}
      </div>
    </Overlay>
  );
}
