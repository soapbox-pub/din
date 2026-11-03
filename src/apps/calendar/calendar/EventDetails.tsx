import { Fragment, useMemo, type ReactNode } from 'react';
import { CalendarDays, Clock, Globe, Hash, Link as LinkIcon, Lock, MapPin, MoreHorizontal, Pencil, Repeat, Trash2, Users } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { describeWhen, RSVP_STATUSES, type RsvpStatus } from '@/shared/calendar';
import { locale, TIME_ZONE } from './dates';
import { eventMenu, RSVP_ICONS, RSVP_LABELS, type EventAction, type Shown } from './menu';
import { DropdownEntries } from './MenuEntries';
import { nameOf } from './model';
import { useAttendance, useProfiles } from './nostr';
import { Avatar } from './Person';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function isUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        window.open(href, '_blank');
      }}
      className={cn('break-all text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60', className)}
    >
      {children}
    </a>
  );
}

/** Plain text with its web links clickable. */
function Linkified({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    parts.push(text.slice(last, m.index));
    parts.push(<ExternalLink key={m.index} href={m[0]}>{m[0]}</ExternalLink>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

function Row({ icon: Icon, children, label }: { icon: typeof Clock; children: ReactNode; label: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label={label} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const STATUS_TEXT: Record<RsvpStatus, string> = { accepted: 'going', tentative: 'maybe', declined: 'not going' };

/** An event's details, in the popover over it. */
export function EventDetails({ shown, calendarTitle, pubkey, onAction }: { shown: Shown; calendarTitle: string; pubkey: string | null; onAction: (a: EventAction) => void }) {
  const { e } = shown;
  const nostr = shown.kind === 'nostr' ? shown.e : null;
  const attendance = useAttendance(nostr?.coord ?? null);
  const answers = attendance.data;
  const people = useMemo(() => {
    const invited = nostr?.participants.map((p) => p.pubkey) ?? [];
    const others = [...(answers?.keys() ?? [])].filter((pk) => !invited.includes(pk) && pk !== nostr?.pubkey);
    return { invited, others };
  }, [nostr, answers]);
  const profiles = useProfiles(useMemo(() => (nostr ? [nostr.pubkey, ...people.invited, ...people.others] : []), [nostr, people]));
  const counts = useMemo(() => {
    const c = { accepted: 0, tentative: 0, declined: 0 };
    for (const r of answers?.values() ?? []) c[r.status]++;
    return c;
  }, [answers]);

  const otherZone = e.tzid && e.tzid !== TIME_ZONE ? e.tzid : null;
  const zoned = otherZone
    ? new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: otherZone, timeZoneName: 'short' }).format(e.start)
    : null;
  const others = [...people.invited, ...people.others].filter((pk) => pk !== nostr?.pubkey);

  return (
    <div className="flex max-h-[min(36rem,80vh)] flex-col" style={{ '--ev': shown.color } as React.CSSProperties}>
      <div className="flex items-start gap-3 px-4 pt-4 pb-3">
        <span className="mt-1.5 size-3 shrink-0 rounded-full bg-(--ev)" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-snug font-semibold break-words">{e.title}</h2>
          {nostr?.summary && <p className="mt-0.5 text-sm text-muted-foreground">{nostr.summary}</p>}
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0">
          {shown.mine && (
            <>
              <IconButton label="Edit" onClick={() => onAction('edit')}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label="Delete" onClick={() => onAction('delete')}>
                <Trash2 className="size-4" />
              </IconButton>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label="More">
                <MoreHorizontal className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownEntries entries={eventMenu(shown, new Set<EventAction>(['open', 'edit', 'delete']))} onPick={onAction} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
        <Row icon={Clock} label="When">
          <p>{describeWhen(e, locale)}</p>
          {zoned && <p className="text-xs text-muted-foreground">{zoned} where it was made ({otherZone?.replace(/_/g, ' ')})</p>}
          {shown.kind === 'local' && shown.e.repeats && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Repeat className="size-3" aria-hidden /> It repeats; only its first time shows here for now.
            </p>
          )}
        </Row>
        <Row icon={CalendarDays} label="Calendar">
          <p>{calendarTitle}</p>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            {nostr ? <Globe className="size-3" aria-hidden /> : <Lock className="size-3" aria-hidden />}
            {nostr ? 'Public, on Nostr: anyone can see it' : 'Private, on this computer'}
          </p>
        </Row>
        {e.locations.length > 0 && (
          <Row icon={MapPin} label="Where">
            {e.locations.map((l) => (
              <p key={l} className="break-words">
                {isUrl(l) ? <ExternalLink href={l.trim()}>{l}</ExternalLink> : (
                  <>
                    {l}{' '}
                    <ExternalLink href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(l)}`} className="text-xs whitespace-nowrap">
                      Map
                    </ExternalLink>
                  </>
                )}
              </p>
            ))}
          </Row>
        )}
        {e.description.trim() && (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
            <Linkified text={e.description.trim()} />
          </p>
        )}
        {e.links.length > 0 && (
          <Row icon={LinkIcon} label="Links">
            {e.links.filter(isUrl).map((l) => (
              <p key={l}>
                <ExternalLink href={l}>{l.replace(/^https?:\/\//, '')}</ExternalLink>
              </p>
            ))}
          </Row>
        )}
        {e.hashtags.length > 0 && (
          <Row icon={Hash} label="Tags">
            <p className="text-muted-foreground">{e.hashtags.map((t) => `#${t}`).join(' ')}</p>
          </Row>
        )}

        {nostr && (
        <Row icon={Users} label="People">
          <ul className="space-y-1.5">
            <li className="flex items-center gap-2">
              <Avatar pubkey={nostr.pubkey} profile={profiles.get(nostr.pubkey)} className="size-6" />
              <span className="min-w-0 flex-1 truncate">{nostr.pubkey === pubkey ? 'You' : nameOf(nostr.pubkey, profiles.get(nostr.pubkey))}</span>
              <span className="text-xs text-muted-foreground">organizer</span>
            </li>
            {others.map((pk) => {
              const answer = answers?.get(pk);
              const role = nostr.participants.find((p) => p.pubkey === pk)?.role;
              return (
                <li key={pk} className="flex items-center gap-2">
                  <Avatar pubkey={pk} profile={profiles.get(pk)} className="size-6" />
                  <span className="min-w-0 flex-1 truncate">{pk === pubkey ? 'You' : nameOf(pk, profiles.get(pk))}</span>
                  <span className={cn('text-xs', answer?.status === 'accepted' ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
                    {answer ? STATUS_TEXT[answer.status] : role || (people.invited.includes(pk) ? 'invited' : '')}
                  </span>
                </li>
              );
            })}
          </ul>
          {(counts.accepted > 0 || counts.tentative > 0 || counts.declined > 0) && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {[counts.accepted && `${counts.accepted} going`, counts.tentative && `${counts.tentative} maybe`, counts.declined && `${counts.declined} not going`].filter(Boolean).join(' · ')}
            </p>
          )}
        </Row>
        )}
      </div>

      {nostr && !shown.mine && (
        <div className="flex items-center gap-2 border-t border-border/60 px-4 py-3">
          <span className="mr-auto text-sm text-muted-foreground">Going?</span>
          {RSVP_STATUSES.map((status) => {
            const Icon = RSVP_ICONS[status];
            const on = shown.rsvp === status;
            return (
              <button
                key={status}
                type="button"
                aria-pressed={on}
                onClick={() => onAction(`rsvp:${status}`)}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  on ? 'border-transparent bg-(--ev) text-white' : 'border-border hover:bg-foreground/[0.06]',
                )}
              >
                <Icon className="size-3.5" /> {RSVP_LABELS[status]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function IconButton({ label, children, ...props }: React.ComponentProps<'button'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className="grid size-8 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
    </button>
  );
}
