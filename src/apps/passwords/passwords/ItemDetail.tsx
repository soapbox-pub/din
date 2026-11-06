import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, Eye, EyeOff, Folder, KeySquare, MoreHorizontal, Pencil, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { CopyField, PasswordItem, PasswordList } from '@/lib/passwords';
import { parseTotp, totpCode } from '@/shared/totp';
import { ItemIcon } from './ItemIcon';
import { ItemMenuItems, type ItemActions } from './ItemActions';
import { displayTitle, openableUrl, siteHost, useBridge, useVaultItem } from './vault';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/** A field's row: its label over its value, copied on a click. */
function FieldRow({
  label,
  children,
  onCopy,
  extra,
  copyLabel,
}: {
  label: string;
  children: ReactNode;
  onCopy?: () => Promise<void> | void;
  extra?: ReactNode;
  copyLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    if (!onCopy) return;
    void Promise.resolve(onCopy()).then(() => setCopied(true));
  };
  return (
    <div className="group flex items-center gap-2 px-4 py-2.5">
      <button
        type="button"
        onClick={copy}
        disabled={!onCopy}
        aria-label={copyLabel}
        className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default"
      >
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block min-w-0 truncate text-sm">{children}</span>
      </button>
      {extra}
      {onCopy && (
        <button
          type="button"
          onClick={copy}
          tabIndex={-1}
          title="Copy"
          aria-label={copyLabel}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-opacity hover:bg-foreground/[0.07] hover:text-foreground',
            copied ? 'text-ink-accent opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <span aria-live="polite">
            {copied ? <Check className="size-4.5" strokeWidth={1.75} aria-label="Copied" /> : <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />}
          </span>
        </button>
      )}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className={settingsGroup}>{children}</div>;
}

/** The current verification code, with the time left on it. */
function Code({ uri }: { uri: string }) {
  const params = useMemo(() => parseTotp(uri), [uri]);
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const step = params ? Math.floor(now / 1000 / params.period) : 0;
  useEffect(() => {
    if (params) void totpCode(params, step * params.period * 1000).then(setCode);
  }, [params, step]);
  if (!params) return <span className="text-muted-foreground">Not a valid setup key</span>;
  const left = params.period - (Math.floor(now / 1000) % params.period);
  const half = Math.ceil(code.length / 2);
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-base tracking-wider tabular-nums">
        {code.slice(0, half)} {code.slice(half)}
      </span>
      <svg viewBox="0 0 20 20" className="size-4 -rotate-90" aria-label={`${left} seconds left`}>
        <circle cx="10" cy="10" r="8" fill="none" strokeWidth="3" className="stroke-muted" />
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          strokeWidth="3"
          strokeDasharray={2 * Math.PI * 8}
          strokeDashoffset={2 * Math.PI * 8 * (1 - left / params.period)}
          className={cn('transition-[stroke-dashoffset] duration-1000 ease-linear', left <= 5 ? 'stroke-destructive' : 'stroke-primary')}
        />
      </svg>
    </span>
  );
}

function Secret({ value, shown }: { value: string; shown: boolean }) {
  if (!value) return <span className="text-muted-foreground">None</span>;
  return shown ? <span className="break-all font-mono">{value}</span> : <span aria-label="Hidden">{'•'.repeat(Math.min(16, Math.max(8, value.length)))}</span>;
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center gap-4">
        <Skeleton className="size-16 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

function date(ms: number): string {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** One item, as it reads: copy what you need, open its site, edit it. */
export function ItemDetail({
  id,
  list,
  actions,
  onEdit,
}: {
  id: string;
  list: PasswordList;
  actions: ItemActions;
  onEdit: (item: PasswordItem) => void;
}) {
  const bridge = useBridge();
  const { data: item, isLoading, error } = useVaultItem(id);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const summary = list.items.find((i) => i.id === id);

  if (isLoading) return <DetailSkeleton />;
  if (error || !item || !summary) {
    return <p className="p-8 text-sm text-muted-foreground">This item is gone.</p>;
  }

  const copy = (field: CopyField) => () => bridge?.copy(item.id, field);
  const toggle = (key: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const reveal = (key: string, label: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0 text-muted-foreground"
      aria-label={shown.has(key) ? `Hide ${label}` : `Show ${label}`}
      aria-pressed={shown.has(key)}
      onClick={() => toggle(key)}
    >
      {shown.has(key) ? <EyeOff className="size-4.5" strokeWidth={1.75} /> : <Eye className="size-4.5" strokeWidth={1.75} />}
    </Button>
  );
  const url = openableUrl(item.url);
  const folder = list.groups.find((g) => g.id === item.groupId);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-8 @3xl/passwords:px-10">
      <header className="flex items-start gap-4">
        <ItemIcon item={item} size="lg" />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="flex items-center gap-2 truncate text-2xl font-semibold tracking-tight">
            <span className="truncate">{displayTitle(item)}</span>
            {item.favorite && <Star className="size-4 shrink-0 fill-amber-400 text-amber-400" aria-label="Favorite" />}
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            {item.trashed ? 'In Recently Deleted' : `Edited ${new Date(item.modified).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!item.trashed && (
            <Button type="button" variant="secondary" size="sm" onClick={() => onEdit(item)}>
              <Pencil className="size-4" strokeWidth={1.75} aria-hidden />
              Edit
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="size-8" aria-label="More">
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <ItemMenuItems kind="dropdown" item={summary} list={list} actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      {item.kind === 'login' && (
        <Card>
          <FieldRow label="Username" copyLabel={`Copy the username, ${item.username}`} onCopy={item.username ? copy('username') : undefined}>
            {item.username || <span className="text-muted-foreground">None</span>}
          </FieldRow>
          {(item.password || !item.passkeyDetails) && (
            <FieldRow
              label="Password"
              copyLabel="Copy the password"
              onCopy={item.password ? copy('password') : undefined}
              extra={item.password ? reveal('password', 'the password') : undefined}
            >
              <Secret value={item.password} shown={shown.has('password')} />
            </FieldRow>
          )}
          {item.passkeyDetails && (
            <div className="flex items-center gap-3 px-4 py-2.5">
              <KeySquare className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
              <div className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">Passkey</span>
                <span className="block truncate text-sm">
                  {item.passkeyDetails.username || 'Your account'} on {item.passkeyDetails.rpId}
                </span>
              </div>
              {!item.trashed && (
                <Button type="button" variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => actions.removePasskey(item.id)}>
                  Remove…
                </Button>
              )}
            </div>
          )}
          {item.otpUri && (
            <FieldRow label="Verification code" copyLabel="Copy the verification code" onCopy={copy('otp')}>
              <Code uri={item.otpUri} />
            </FieldRow>
          )}
          {item.url && (
            <FieldRow
              label="Website"
              copyLabel={`Copy the website, ${item.url}`}
              onCopy={copy('url')}
              extra={
                url && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={`Open ${siteHost(item.url)}`}
                    title={`Open ${siteHost(item.url)}`}
                    onClick={() => window.open(url)}
                  >
                    <ExternalLink className="size-4.5" strokeWidth={1.75} />
                  </Button>
                )
              }
            >
              {siteHost(item.url)}
            </FieldRow>
          )}
        </Card>
      )}

      {item.fields.length > 0 && (
        <Card>
          {item.fields.map((field) => (
            <FieldRow
              key={field.name}
              label={field.name}
              copyLabel={`Copy ${field.name}`}
              onCopy={field.value ? copy({ field: field.name }) : undefined}
              extra={field.protected && field.value ? reveal(`field:${field.name}`, field.name) : undefined}
            >
              {field.protected ? <Secret value={field.value} shown={shown.has(`field:${field.name}`)} /> : field.value}
            </FieldRow>
          ))}
        </Card>
      )}

      {item.notes && (
        <section aria-label="Notes" className="space-y-2">
          <h3 className="px-1 text-xs font-medium text-muted-foreground">Notes</h3>
          <div className="whitespace-pre-wrap break-words rounded-xl bg-card clay px-4 py-3 text-sm select-text">
            {item.notes}
          </div>
        </section>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        {folder && !folder.trash && (
          <>
            <dt>Folder</dt>
            <dd className="flex items-center gap-1">
              <Folder className="size-3" aria-hidden />
              {folder.name}
            </dd>
          </>
        )}
        <dt>Created</dt>
        <dd>{date(item.created)}</dd>
        <dt>Modified</dt>
        <dd>{date(item.modified)}</dd>
      </dl>
    </div>
  );
}
