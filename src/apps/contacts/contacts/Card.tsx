import { Cake, Copy, ExternalLink, Mail, MapPin, MessageCircle, MoreHorizontal, Pencil, UserPlus, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ToolButton } from '@/shared/appChrome';
import { displayName, type Contact, type PostalAddress } from '@/shared/vcard';
import { Avatar } from './Avatar';
import { addressLines, describeBirthday, labelText } from './format';
import type { ContactAction, MenuEntry } from './menu';
import { DropdownEntries } from './MenuEntries';

export interface FieldActions {
  /** Text a phone number, in Messages; absent when there's no phone to text from. */
  message?: (number: string) => void;
  email: (address: string) => void;
  openUrl: (url: string) => void;
  map: (address: PostalAddress) => void;
  copy: (text: string, what: string) => void;
}

/** A contact's card: who they are, and each way to reach them. */
export function ContactCard({
  contact,
  menu,
  onAction,
  fields,
  readOnly,
}: {
  contact: Contact;
  menu: MenuEntry[];
  onAction: (a: ContactAction) => void;
  fields: FieldActions;
  /** A phone's contact: `from` names the phone, and whether it's in the address book already. */
  readOnly?: { from: string; inBook: boolean };
}) {
  const c = contact;
  const name = displayName(c) || 'No Name';
  const role = [c.title, c.department, c.organization !== name ? c.organization : ''].filter(Boolean).join(' · ');
  const address = addressLines;
  const message = fields.message;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-xl px-6 pt-8 pb-10">
        <header className="flex flex-col items-center text-center">
          <Avatar contact={c} className="size-28 text-4xl shadow-sm" />
          <h2 className="mt-4 font-[family-name:var(--font-title)] text-[28px] leading-tight font-semibold break-words">{name}</h2>
          {c.nickname && displayName(c) !== c.nickname && <p className="mt-0.5 text-[15px] text-muted-foreground">“{c.nickname}”</p>}
          {role && <p className="mt-1 text-[15px] text-muted-foreground">{role}</p>}
          {readOnly && <p className="mt-2 rounded-full bg-foreground/[0.06] px-3 py-1 text-xs text-muted-foreground">From {readOnly.from}</p>}

          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {readOnly ? (
              <QuickAction icon={readOnly.inBook ? UserRound : UserPlus} label={readOnly.inBook ? 'Show Contact' : 'Add to Contacts'} onClick={() => onAction(readOnly.inBook ? 'show' : 'add')} />
            ) : (
              <QuickAction icon={Pencil} label="Edit" onClick={() => onAction('edit')} />
            )}
            {message && c.phones[0] && <QuickAction icon={MessageCircle} label="Message" onClick={() => message(c.phones[0].value)} />}
            {c.emails[0] && <QuickAction icon={Mail} label="Email" onClick={() => fields.email(c.emails[0].value)} />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="More"
                  title="More"
                  className="flex h-14 w-16 flex-col items-center justify-center gap-1 rounded-xl bg-foreground/[0.05] text-xs text-foreground/80 outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <MoreHorizontal className="size-5 text-primary" />
                  More
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownEntries entries={menu} onPick={onAction} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="mt-8 space-y-3">
          {c.phones.length > 0 && (
            <Section>
              {c.phones.map((p, i) => (
                <Field
                  key={`p${i}`}
                  label={labelText(p.label)}
                  value={p.value}
                  primary={message ? { icon: MessageCircle, label: 'Send Message', run: () => message(p.value) } : undefined}
                  onCopy={() => fields.copy(p.value, 'Number')}
                  mono
                />
              ))}
            </Section>
          )}
          {c.emails.length > 0 && (
            <Section>
              {c.emails.map((e, i) => (
                <Field key={`e${i}`} label={labelText(e.label)} value={e.value} primary={{ icon: Mail, label: 'Send Email', run: () => fields.email(e.value) }} onCopy={() => fields.copy(e.value, 'Email address')} />
              ))}
            </Section>
          )}
          {c.addresses.length > 0 && (
            <Section>
              {c.addresses.map((a, i) => (
                <Field key={`a${i}`} label={labelText(a.label)} value={address(a)} primary={{ icon: MapPin, label: 'Show on Map', run: () => fields.map(a) }} onCopy={() => fields.copy(address(a), 'Address')} />
              ))}
            </Section>
          )}
          {c.urls.length > 0 && (
            <Section>
              {c.urls.map((u, i) => (
                <Field key={`u${i}`} label={labelText(u.label)} value={u.value} primary={{ icon: ExternalLink, label: 'Open Link', run: () => fields.openUrl(u.value) }} onCopy={() => fields.copy(u.value, 'Link')} />
              ))}
            </Section>
          )}
          {c.birthday && (
            <Section>
              <Field label="Birthday" value={describeBirthday(c.birthday)} icon={Cake} onCopy={() => fields.copy(describeBirthday(c.birthday), 'Birthday')} />
            </Section>
          )}
          {c.groups.length > 0 && (
            <Section>
              <div className="px-4 py-2.5">
                <div className="text-xs text-muted-foreground">Groups</div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.groups.map((g) => (
                    <span key={g} className="rounded-full bg-primary/10 px-2.5 py-0.5 text-sm text-primary">{g}</span>
                  ))}
                </div>
              </div>
            </Section>
          )}
          {c.note && (
            <Section>
              <div className="px-4 py-2.5">
                <div className="text-xs text-muted-foreground">Notes</div>
                <p className="mt-0.5 text-[15px] break-words whitespace-pre-wrap select-text">{c.note}</p>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-14 min-w-16 flex-col items-center justify-center gap-1 rounded-xl bg-foreground/[0.05] px-3 text-xs text-foreground/80 outline-none hover:bg-foreground/[0.09] focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Icon className="size-5 text-primary" />
      {label}
    </button>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border/60 overflow-hidden rounded-xl bg-foreground/[0.035]">{children}</div>;
}

function Field({
  label,
  value,
  primary,
  onCopy,
  icon: Icon,
  mono,
}: {
  label: string;
  value: string;
  primary?: { icon: LucideIcon; label: string; run: () => void };
  onCopy: () => void;
  icon?: LucideIcon;
  mono?: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">{label}</div>
            {primary ? (
              <button
                type="button"
                onClick={primary.run}
                title={primary.label}
                className={cn('max-w-full text-left text-[15px] break-words whitespace-pre-line text-primary outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/60', mono && 'tabular-nums')}
              >
                {value}
              </button>
            ) : (
              <div className="flex items-center gap-1.5 text-[15px] select-text">
                {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />} {value}
              </div>
            )}
          </div>
          <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none">
            {primary && <IconButton icon={primary.icon} label={primary.label} onClick={primary.run} />}
            <IconButton icon={Copy} label={`Copy ${label}`} onClick={onCopy} />
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        {primary && (
          <ContextMenuItem onSelect={primary.run}>
            <primary.icon /> {primary.label}
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onCopy}>
          <Copy /> Copy
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function IconButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <ToolButton size="sm" label={label} onClick={onClick}>
      <Icon className="size-4" />
    </ToolButton>
  );
}
