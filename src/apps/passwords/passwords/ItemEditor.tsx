import { useState, type FormEvent, type ReactNode } from 'react';
import { Eye, EyeOff, LoaderCircle, Lock, LockOpen, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cleanPasswordsError, type PasswordField, type PasswordItem, type PasswordItemInput, type PasswordList } from '@/lib/passwords';
import { parseTotp } from '@/shared/totp';
import { GeneratorButton } from './Generator';
import { ItemIcon } from './ItemIcon';
import { useBridge, type BlankItem } from './vault';

function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-3 @xl/passwords:grid-cols-[8rem_1fr] @xl/passwords:items-center @xl/passwords:gap-4">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground @xl/passwords:text-sm">
        {label}
      </Label>
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  );
}

/** An item being written: a new one, or an edit. */
export function ItemEditor({
  initial,
  list,
  onCancel,
  onSaved,
}: {
  initial: PasswordItem | BlankItem;
  list: PasswordList;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const bridge = useBridge();
  const [draft, setDraft] = useState<PasswordItemInput>(() => ({
    id: initial.id,
    groupId: initial.groupId,
    title: initial.title,
    username: initial.username,
    password: initial.password,
    url: initial.url,
    notes: initial.notes,
    otpUri: initial.otpUri,
    fields: initial.fields.map((f) => ({ ...f })),
    favorite: initial.favorite,
  }));
  const [showPassword, setShowPassword] = useState(!initial.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = initial.kind;
  const set = <K extends keyof PasswordItemInput>(key: K, value: PasswordItemInput[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setField = (index: number, patch: Partial<PasswordField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) }));
  const badOtp = !!draft.otpUri.trim() && !parseTotp(draft.otpUri);
  const names = draft.fields.map((f) => f.name.trim());
  const badField = names.some((n, i) => !n || names.indexOf(n) !== i);
  const folders = list.groups.filter((g) => !g.trash);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bridge || busy || badOtp || badField) return;
    setBusy(true);
    setError(null);
    const title = draft.title.trim() || (kind === 'note' ? 'Untitled Note' : '');
    bridge.save({ ...draft, title, fields: draft.fields.map((f) => ({ ...f, name: f.name.trim() })) }).then(onSaved, (err: unknown) => {
      setError(cleanPasswordsError(err));
      setBusy(false);
    });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8 @3xl/passwords:px-10"
    >
      <header className="flex items-center gap-4">
        <ItemIcon item={{ title: draft.title, url: draft.url, kind }} size="lg" />
        <Input
          aria-label="Title"
          placeholder={kind === 'note' ? 'Note title' : 'Title (like the site’s name)'}
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          autoFocus
          className="h-11 min-w-0 flex-1 text-xl font-semibold md:text-xl"
        />
      </header>

      {kind === 'login' && (
        <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-card/60">
          <Row label="Username" htmlFor="edit-username">
            <Input id="edit-username" autoComplete="off" value={draft.username} onChange={(e) => set('username', e.target.value)} />
          </Row>
          <Row label="Password" htmlFor="edit-password">
            <Input
              id="edit-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              spellCheck={false}
              value={draft.password}
              onChange={(e) => set('password', e.target.value)}
              className="font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={showPassword ? 'Hide the password' : 'Show the password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
            <GeneratorButton
              onUse={(password) => {
                set('password', password);
                setShowPassword(true);
              }}
            />
          </Row>
          <Row label="Website" htmlFor="edit-url">
            <Input id="edit-url" type="url" inputMode="url" placeholder="example.com" value={draft.url} onChange={(e) => set('url', e.target.value)} />
          </Row>
          <Row label="Verification" htmlFor="edit-otp">
            <div className="w-full space-y-1">
              <Input
                id="edit-otp"
                placeholder="Setup key or otpauth:// link"
                spellCheck={false}
                value={draft.otpUri}
                onChange={(e) => set('otpUri', e.target.value)}
                aria-invalid={badOtp}
                aria-describedby="edit-otp-help"
                className="font-mono"
              />
              <p id="edit-otp-help" className={badOtp ? 'text-xs text-destructive' : 'sr-only'}>
                {badOtp ? 'That isn’t a setup key. Paste the key a site shows next to its QR code.' : 'The key a site shows when you set up two-factor authentication.'}
              </p>
            </div>
          </Row>
        </div>
      )}

      <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-card/60">
        {draft.fields.map((field, index) => (
          <div key={index} className="flex items-center gap-1 px-4 py-3">
            <Input
              aria-label="Field name"
              placeholder="Name"
              value={field.name}
              onChange={(e) => setField(index, { name: e.target.value })}
              aria-invalid={!field.name.trim() || names.indexOf(field.name.trim()) !== index}
              className="w-36 shrink-0"
            />
            <Input
              aria-label={`${field.name || 'Field'} value`}
              placeholder="Value"
              type={field.protected ? 'password' : 'text'}
              autoComplete="off"
              value={field.value}
              onChange={(e) => setField(index, { value: e.target.value })}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={field.protected ? 'Don’t hide this field' : 'Hide this field, like a password'}
              aria-pressed={field.protected}
              title={field.protected ? 'Hidden like a password' : 'Shown'}
              onClick={() => setField(index, { protected: !field.protected })}
            >
              {field.protected ? <Lock className="size-4" /> : <LockOpen className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label={`Remove ${field.name || 'this field'}`}
              onClick={() => setDraft((d) => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))}
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setDraft((d) => ({ ...d, fields: [...d.fields, { name: '', value: '', protected: false }] }))}
          className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-sm text-primary hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" aria-hidden />
          Add Field
        </button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-notes" className="px-1 text-xs text-muted-foreground">
          Notes
        </Label>
        <Textarea
          id="edit-notes"
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={kind === 'note' ? 12 : 4}
          className="bg-card/60"
        />
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="edit-folder" className="text-xs text-muted-foreground">
          Folder
        </Label>
        <Select value={draft.groupId ?? list.rootId} onValueChange={(groupId) => set('groupId', groupId)}>
          <SelectTrigger id="edit-folder" className="h-8 w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={list.rootId}>No Folder</SelectItem>
            {folders.map((folder) => (
              <SelectItem key={folder.id} value={folder.id}>
                <span style={{ paddingLeft: folder.depth * 12 }}>{folder.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="sticky bottom-0 -mx-2 flex justify-end gap-2 bg-gradient-to-t from-background via-background/90 to-transparent px-2 pt-4 pb-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || badOtp || badField}>
          {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          {initial.id ? 'Save' : kind === 'note' ? 'Save Note' : 'Save Password'}
        </Button>
      </div>
    </form>
  );
}
