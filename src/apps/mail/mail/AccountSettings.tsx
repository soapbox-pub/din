import { useState } from 'react';
import { AtSign, ListFilter, Loader2, Plus, Settings2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DialogButton } from '@/shared/dialogs';
import { ContentPane, SidebarHeading, SidebarRow, SidebarTitle, SidebarTitleIcon } from '@/shared/appChrome';
import { sidebarWidthClass } from '@/shared/appChromeStyles';
import { useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { CATEGORY_NAMES, MAIL_CATEGORIES, type InboxTabs, type MailAccount, type MailServer } from '@/lib/mail';
import { announceSettings, useAccounts, useInboxTabs, useLiveUpdates, useMail, useSetAccountColor, useSetFillCodes, useSetInboxTabs, useSettingsChanges } from './api';
import { AccountSetup } from './AccountSetup';
import { RulesSettings } from './RulesSettings';
import { accountColor, accountDot } from './accounts';
import { ColorPicker } from './LabelDialogs';
import { REMOTE_KEY } from './Reader';
import { TAB_ICONS } from './tabs';

const TAB_HINTS: Record<InboxTabs['tabs'][number], string> = {
  promotions: 'Deals, offers and newsletters',
  social: 'Social networks and media sites',
};

/** Which inbox tabs are shown, and which new mail notifies (Settings → General). */
function InboxTabsSettings() {
  const query = useInboxTabs();
  const set = useSetInboxTabs();
  const prefs = query.data;
  const others = MAIL_CATEGORIES.filter((c): c is InboxTabs['tabs'][number] => c !== 'primary');
  return (
    <div className="space-y-3">
      <div>
        <span className="block text-[13px] font-medium">Inbox tabs</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          The inbox is split up the way Gmail’s is: by Gmail itself on Gmail, and from each message’s headers elsewhere. Mail for a tab you don’t show stays in Primary. Move a sender to another tab from a message’s menu.
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-2.5 rounded-lg border border-border/70 p-2.5 text-[13px] text-muted-foreground">
          <Checkbox checked disabled aria-label="Primary" className="mt-0.5" />
          <span>
            <span className="flex items-center gap-1.5 font-medium text-foreground"><TAB_ICONS.primary className="size-3.5" /> Primary</span>
            <span className="block text-xs">Mail from people, receipts, notifications, mailing lists, and anything else</span>
          </span>
        </label>
        {others.map((c) => {
          const Icon = TAB_ICONS[c];
          return (
            <label key={c} className="flex items-start gap-2.5 rounded-lg border border-border/70 p-2.5 text-[13px]">
              <Checkbox
                className="mt-0.5"
                checked={!!prefs?.tabs.includes(c)}
                disabled={!prefs}
                onCheckedChange={(on) => void set({ tabs: on === true ? [...(prefs?.tabs ?? []), c] : (prefs?.tabs ?? []).filter((t) => t !== c) })}
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium"><Icon className="size-3.5" /> {CATEGORY_NAMES[c]}</span>
                <span className="block text-xs text-muted-foreground">{TAB_HINTS[c]}</span>
              </span>
            </label>
          );
        })}
      </div>
      <label className="flex items-start justify-between gap-4">
        <span>
          <span className="block text-[13px] font-medium">Notify only for Primary</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">New mail in the other tabs comes in quietly, and isn’t counted on Mail’s icon in the Dock.</span>
        </span>
        <Switch
          checked={prefs ? prefs.notify === 'primary' && prefs.tabs.length > 0 : true}
          disabled={!prefs || !prefs.tabs.length}
          onCheckedChange={(on) => void set({ notify: on ? 'primary' : 'all' })}
        />
      </label>
    </div>
  );
}

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

function AccountForm({ account, accounts, onRemoved }: { account: MailAccount; accounts: MailAccount[]; onRemoved: () => void }) {
  const setAccountColor = useSetAccountColor();
  const setFillCodes = useSetFillCodes();
  const mail = useMail();
  const qc = useQueryClient();
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
    fullName !== account.fullName || signature !== account.signature || password !== '' ||
    JSON.stringify(imap) !== JSON.stringify(account.imap) || JSON.stringify(smtp) !== JSON.stringify(account.smtp);

  const save = async () => {
    if (!mail) return;
    setBusy(true);
    setMessage(null);
    try {
      const serversChanged = JSON.stringify(imap) !== JSON.stringify(account.imap) || JSON.stringify(smtp) !== JSON.stringify(account.smtp);
      const updated = await mail.updateAccount(account.id, {
        fullName,
        signature,
        ...(password ? { password } : {}),
        ...(serversChanged ? { imap, smtp } : {}),
      });
      qc.setQueryData<MailAccount[]>(['mail', 'accounts'], (list) => list?.map((a) => (a.id === updated.id ? updated : a)));
      if (password || serversChanged) void qc.invalidateQueries({ queryKey: ['mail', 'mailboxes', account.id] });
      announceSettings({ kind: 'account', accountId: account.id });
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
    announceSettings({ kind: 'account', accountId: account.id });
    onRemoved();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="grid gap-1.5">
          <Label htmlFor="acct-email">Email Address</Label>
          <Input id="acct-email" value={account.email} readOnly className="text-muted-foreground" />
        </div>
        {accounts.length > 1 && (
          <div className="grid gap-1.5">
            <span className="text-sm leading-none font-medium">Color</span>
            <ColorPicker
              value={accountColor(accounts, account.id)}
              onChange={(c) => void setAccountColor(account.id, c).catch((error: unknown) => setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }))}
            />
            <p className="text-xs text-muted-foreground">Marks its mail in All Inboxes, and its address in the sidebar.</p>
          </div>
        )}
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
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Fill in verification codes</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              A sign-in code in new mail to this address is offered in web pages’ code fields for 10 minutes, and its notification can copy it. It stays on this computer.
            </span>
          </span>
          <Switch
            checked={account.fillCodes !== false}
            onCheckedChange={(on) => void setFillCodes(account.id, on).catch((error: unknown) => setMessage({ error: true, text: error instanceof Error ? error.message : String(error) }))}
          />
        </label>
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

/**
 * Mail's settings, in a window of their own (launched with `{ window:
 * 'settings', account?, section? }`, see openMailSettings): General, the
 * Rules and blocked senders, then each account, down the side. What's changed here reaches Mail's other windows
 * (announceSettings).
 */
export function SettingsWindow({ initial, section = null }: { initial: string | null; section?: 'rules' | null }) {
  useSettingsChanges();
  useLiveUpdates();
  useWindowTitle('Mail Settings');
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const [selected, setSelected] = useState<string | 'general' | 'rules'>(section ?? initial ?? 'general');
  const [adding, setAdding] = useState(false);
  const [remote, setRemote] = useState(() => localStorage.getItem(REMOTE_KEY) === 'always');
  const account = accounts.find((a) => a.id === selected);
  const mail = useMail();
  const qc = useQueryClient();
  const lookups = useQuery({ queryKey: ['mail', 'avatar-lookups'], queryFn: () => mail!.avatarLookups(), enabled: !!mail });

  return (
    <div className="flex h-full w-full text-foreground">
      <aside className={cn('flex shrink-0 flex-col', sidebarWidthClass)}>
        <SidebarTitle icon={<SidebarTitleIcon src="/icons/apps/mail.png" />} title="Settings" />
        <nav aria-label="Settings" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pt-1 pb-4">
          <SidebarRow icon={Settings2} label="General" selected={selected === 'general'} onClick={() => setSelected('general')} />
          <SidebarRow icon={ListFilter} label="Rules" selected={selected === 'rules'} onClick={() => setSelected('rules')} />
          <SidebarHeading className="mt-3">Accounts</SidebarHeading>
          {accounts.map((a) => (
            <SidebarRow
              key={a.id}
              icon={AtSign}
              label={a.email}
              title={a.email}
              selected={selected === a.id}
              onClick={() => setSelected(a.id)}
              trailing={accounts.length > 1 ? <span aria-hidden className={cn('size-2 shrink-0 rounded-full', accountDot(accounts, a.id))} /> : undefined}
            />
          ))}
          <SidebarRow icon={Plus} label="Add Account…" onClick={() => setAdding(true)} />
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <WindowDragRegion className="flex h-12 shrink-0 items-center justify-end px-3">
          <WindowControls />
        </WindowDragRegion>
        <ContentPane>
          {selected === 'rules' ? (
            <RulesSettings accounts={accounts} initial={initial} />
          ) : account ? (
            <AccountForm key={account.id} account={account} accounts={accounts} onRemoved={() => setSelected('general')} />
          ) : (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <InboxTabsSettings />
              <label className="flex items-start justify-between gap-4">
                <span>
                  <span className="block text-[13px] font-medium">Load remote content in messages</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">Pictures and styles from the web tell senders when you’ve read their mail. Off, each message asks first.</span>
                </span>
                <Switch
                  checked={remote}
                  onCheckedChange={(on) => {
                    setRemote(on);
                    // Mail's other windows hear it as a storage event.
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
                    announceSettings({ kind: 'avatars' });
                  }}
                />
              </label>
            </div>
          )}
        </ContentPane>
      </div>
      {adding && (
        <AccountSetup
          first={false}
          onClose={() => setAdding(false)}
          onAdded={(a) => {
            setAdding(false);
            setSelected(a.id);
            announceSettings({ kind: 'account', accountId: a.id });
          }}
        />
      )}
    </div>
  );
}
