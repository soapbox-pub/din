import { useMemo, useState, type FormEvent } from 'react';
import { Camera, ChevronDown, Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pickFiles, fileTypes } from '@/shared/fileHandles';
import { toast } from '@/shared/toast';
import {
  ADDRESS_LABELS,
  EMAIL_LABELS,
  PHONE_LABELS,
  URL_LABELS,
  displayName,
  type Contact,
  type Labeled,
  type PostalAddress,
} from '@/shared/vcard';
import { Avatar } from './Avatar';
import { photoFromFile } from './photo';
import { labelText } from './format';

const field = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-[15px] outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive';
const CUSTOM = '\u0000custom';
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: 'long' }));
const EMAIL = /^[^\s@]+@[^\s@]+$/;

/** A field's label: Din's own, or one the user types. */
function LabelPicker({ value, options, onChange }: { value: string; options: readonly string[]; onChange: (label: string) => void }) {
  const [typing, setTyping] = useState(false);
  if (typing) {
    return (
      <input
        autoFocus
        aria-label="Label"
        defaultValue={options.includes(value) ? '' : value}
        placeholder="Label"
        onBlur={(e) => {
          if (e.target.value.trim()) onChange(e.target.value.trim());
          setTyping(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setTyping(false);
          }
        }}
        className={cn(field, 'w-28 shrink-0 text-sm')}
      />
    );
  }
  return (
    <span className="relative w-28 shrink-0">
      <select
        aria-label="Label"
        value={value}
        onChange={(e) => (e.target.value === CUSTOM ? setTyping(true) : onChange(e.target.value))}
        className={cn(field, 'appearance-none pr-6 text-sm text-primary')}
      >
        {options.map((o) => <option key={o} value={o}>{labelText(o)}</option>)}
        {!options.includes(value) && <option value={value}>{value}</option>}
        <option value={CUSTOM}>Custom…</option>
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-1.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </span>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-6 shrink-0 place-items-center rounded-full bg-destructive/90 text-white outline-none hover:bg-destructive focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Minus className="size-3.5" strokeWidth={3} />
    </button>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-2 rounded-md px-1 text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="grid size-6 place-items-center rounded-full bg-emerald-600 text-white"><Plus className="size-3.5" strokeWidth={3} /></span>
      {label}
    </button>
  );
}

/** Phones, emails or links: a label and a value each, any number of them. */
function LabeledList({
  title,
  items,
  labels,
  type,
  placeholder,
  onChange,
  invalid,
}: {
  title: string;
  items: Labeled[];
  labels: readonly string[];
  type: 'tel' | 'email' | 'url';
  placeholder: string;
  onChange: (items: Labeled[]) => void;
  invalid?: (value: string) => boolean;
}) {
  const set = (i: number, patch: Partial<Labeled>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const nextLabel = labels.find((l) => !items.some((x) => x.label === l)) ?? labels[labels.length - 1];
  return (
    <fieldset className="space-y-2">
      <legend className="sr-only">{title}</legend>
      {items.map((x, i) => (
        <div key={i} className="flex items-center gap-2">
          <RemoveButton label={`Remove ${labelText(x.label).toLowerCase()} ${type === 'tel' ? 'number' : type === 'email' ? 'email' : 'link'}`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          <LabelPicker value={x.label} options={labels} onChange={(label) => set(i, { label })} />
          <input
            type={type}
            value={x.value}
            placeholder={placeholder}
            aria-label={`${labelText(x.label)} ${title.toLowerCase()}`}
            aria-invalid={!!x.value && invalid?.(x.value)}
            onChange={(e) => set(i, { value: e.target.value })}
            className={field}
          />
        </div>
      ))}
      <AddButton label={`Add ${title.toLowerCase()}`} onClick={() => onChange([...items, { label: nextLabel, value: '' }])} />
    </fieldset>
  );
}

function AddressList({ items, onChange }: { items: PostalAddress[]; onChange: (items: PostalAddress[]) => void }) {
  const set = (i: number, patch: Partial<PostalAddress>) => onChange(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const nextLabel = ADDRESS_LABELS.find((l) => !items.some((x) => x.label === l)) ?? 'other';
  return (
    <fieldset className="space-y-3">
      <legend className="sr-only">Addresses</legend>
      {items.map((a, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex h-9 shrink-0 items-center gap-2">
            <RemoveButton label={`Remove ${labelText(a.label).toLowerCase()} address`} onClick={() => onChange(items.filter((_, j) => j !== i))} />
            <LabelPicker value={a.label} options={ADDRESS_LABELS} onChange={(label) => set(i, { label })} />
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
            <textarea
              value={a.street}
              rows={2}
              placeholder="Street"
              aria-label="Street"
              onChange={(e) => set(i, { street: e.target.value })}
              className={cn(field, 'col-span-2 h-auto resize-none py-1.5')}
            />
            <input value={a.city} placeholder="City" aria-label="City" onChange={(e) => set(i, { city: e.target.value })} className={field} />
            <input value={a.region} placeholder="State or region" aria-label="State or region" onChange={(e) => set(i, { region: e.target.value })} className={field} />
            <input value={a.postcode} placeholder="Postal code" aria-label="Postal code" onChange={(e) => set(i, { postcode: e.target.value })} className={field} />
            <input value={a.country} placeholder="Country" aria-label="Country" onChange={(e) => set(i, { country: e.target.value })} className={field} />
          </div>
        </div>
      ))}
      <AddButton label="Add address" onClick={() => onChange([...items, { label: nextLabel, street: '', city: '', region: '', postcode: '', country: '' }])} />
    </fieldset>
  );
}

/** A birthday's month, day and (optional) year. */
function BirthdayField({ value, onChange }: { value: string; onChange: (birthday: string) => void }) {
  const m = /^(\d{4}|--)-?(\d{2})-(\d{2})$/.exec(value);
  const [year, setYear] = useState(m && m[1] !== '--' ? m[1] : '');
  const month = m ? Number(m[2]) : 0;
  const day = m ? Number(m[3]) : 0;
  const emit = (mo: number, d: number, y: string) => {
    if (!mo || !d) return onChange('');
    const date = `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    onChange(/^\d{4}$/.test(y) ? `${y}-${date}` : `--${date}`);
  };
  const days = new Date(/^\d{4}$/.test(year) ? Number(year) : 2000, month || 1, 0).getDate();
  return (
    <div className="flex items-center gap-2">
      <select aria-label="Birthday month" value={month || ''} onChange={(e) => emit(Number(e.target.value), day || 1, year)} className={cn(field, 'flex-[2]')}>
        <option value="">Month</option>
        {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
      </select>
      <select aria-label="Birthday day" value={day || ''} onChange={(e) => emit(month || 1, Number(e.target.value), year)} className={cn(field, 'flex-1')}>
        <option value="">Day</option>
        {Array.from({ length: days }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
      </select>
      <input
        aria-label="Birthday year (optional)"
        inputMode="numeric"
        placeholder="Year"
        value={year}
        maxLength={4}
        onChange={(e) => {
          const y = e.target.value.replace(/\D/g, '');
          setYear(y);
          if (month && day) emit(month, day, y);
        }}
        className={cn(field, 'flex-1')}
      />
      {value && (
        <button type="button" aria-label="Remove birthday" title="Remove birthday" onClick={() => { setYear(''); onChange(''); }} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-start gap-3 max-[520px]:grid-cols-1 max-[520px]:gap-1">
      <div className="pt-2 text-right text-sm text-muted-foreground max-[520px]:pt-0 max-[520px]:text-left">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Adding someone, or changing what their card says. */
export function ContactEditor({
  initial,
  isNew,
  groups,
  saving,
  onSave,
  onCancel,
}: {
  initial: Contact;
  isNew: boolean;
  groups: readonly string[];
  saving: boolean;
  onSave: (c: Contact) => void;
  onCancel: () => void;
}) {
  const [c, setC] = useState(initial);
  const [more, setMore] = useState(() => !!(initial.prefix || initial.middle || initial.suffix || initial.nickname || initial.department));
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));
  const allGroups = useMemo(() => [...new Set([...groups, ...initial.groups])], [groups, initial.groups]);
  const named = !!displayName({ ...c, formatted: c.formatted });
  const badEmail = c.emails.some((e) => e.value.trim() && !EMAIL.test(e.value.trim()));

  const choosePhoto = async () => {
    const [handle] = await pickFiles({
      types: fileTypes([{ description: 'Pictures', extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif', '.bmp'] }]),
      mode: 'read',
      startIn: 'pictures',
      title: 'Choose a Picture',
      confirmLabel: 'Choose',
    });
    if (!handle) return;
    try {
      set({ photo: await photoFromFile(await handle.getFile()) });
    } catch {
      toast('Couldn’t use that picture', { body: 'It isn’t a picture Din can read.', destructive: true });
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!named || badEmail || saving) return;
    const trimmed = <T extends { value: string }>(list: T[]) => list.map((x) => ({ ...x, value: x.value.trim() })).filter((x) => x.value);
    const named5 = [c.prefix, c.given, c.middle, c.family, c.suffix].map((s) => s.trim());
    onSave({
      ...c,
      prefix: named5[0], given: named5[1], middle: named5[2], family: named5[3], suffix: named5[4],
      // A card with a name of its own says it that way; one that came with only FN keeps it until then.
      formatted: named5.some(Boolean) ? '' : c.formatted.trim(),
      nickname: c.nickname.trim(),
      organization: c.organization.trim(),
      department: c.department.trim(),
      title: c.title.trim(),
      phones: trimmed(c.phones),
      emails: trimmed(c.emails),
      urls: trimmed(c.urls),
      addresses: c.addresses
        .map((a) => ({ ...a, street: a.street.trim(), city: a.city.trim(), region: a.region.trim(), postcode: a.postcode.trim(), country: a.country.trim() }))
        .filter((a) => a.street || a.city || a.region || a.postcode || a.country),
      note: c.note.trim(),
    });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
          submit(e);
        }
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-label={isNew ? 'New contact' : `Edit ${displayName(initial) || 'contact'}`}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-xl space-y-5 px-6 pt-6 pb-8">
          <div className="flex items-center gap-4">
            <div className="relative">
              <button
                type="button"
                onClick={() => void choosePhoto()}
                aria-label={c.photo ? 'Change picture' : 'Add picture'}
                title={c.photo ? 'Change picture' : 'Add picture'}
                className="group relative block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
              >
                <Avatar contact={c} className="size-24 text-3xl" />
                <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                  <Camera className="size-6" />
                </span>
              </button>
              {c.photo && (
                <button
                  type="button"
                  onClick={() => set({ photo: '' })}
                  className="mt-1 block w-full text-center text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="grid min-w-0 flex-1 grid-cols-2 gap-2">
              {more && <input value={c.prefix} placeholder="Prefix" aria-label="Prefix" onChange={(e) => set({ prefix: e.target.value })} className={field} />}
              <input autoFocus={isNew} value={c.given} placeholder="First name" aria-label="First name" onChange={(e) => set({ given: e.target.value })} className={cn(field, more && 'col-start-1')} />
              {more && <input value={c.middle} placeholder="Middle name" aria-label="Middle name" onChange={(e) => set({ middle: e.target.value })} className={field} />}
              <input value={c.family} placeholder="Last name" aria-label="Last name" onChange={(e) => set({ family: e.target.value })} className={field} />
              {more && <input value={c.suffix} placeholder="Suffix" aria-label="Suffix" onChange={(e) => set({ suffix: e.target.value })} className={field} />}
              {more && <input value={c.nickname} placeholder="Nickname" aria-label="Nickname" onChange={(e) => set({ nickname: e.target.value })} className={field} />}
              <input value={c.organization} placeholder="Company" aria-label="Company" onChange={(e) => set({ organization: e.target.value })} className={field} />
              <input value={c.title} placeholder="Job title" aria-label="Job title" onChange={(e) => set({ title: e.target.value })} className={field} />
              {more && <input value={c.department} placeholder="Department" aria-label="Department" onChange={(e) => set({ department: e.target.value })} className={field} />}
              {!more && (
                <button type="button" onClick={() => setMore(true)} className="col-span-2 justify-self-start text-sm text-primary outline-none hover:underline focus-visible:underline">
                  More name fields
                </button>
              )}
            </div>
          </div>

          {!c.given && !c.family && c.formatted && (
            <Row label="Name">
              <input value={c.formatted} aria-label="Name as written" onChange={(e) => set({ formatted: e.target.value })} className={field} />
            </Row>
          )}
          <Row label="Phone">
            <LabeledList title="Phone" items={c.phones} labels={PHONE_LABELS} type="tel" placeholder="Phone number" onChange={(phones) => set({ phones })} />
          </Row>
          <Row label="Email">
            <LabeledList title="Email" items={c.emails} labels={EMAIL_LABELS} type="email" placeholder="name@example.com" onChange={(emails) => set({ emails })} invalid={(v) => !EMAIL.test(v.trim())} />
          </Row>
          <Row label="Address">
            <AddressList items={c.addresses} onChange={(addresses) => set({ addresses })} />
          </Row>
          <Row label="Website">
            <LabeledList title="Website" items={c.urls} labels={URL_LABELS} type="url" placeholder="https://" onChange={(urls) => set({ urls })} />
          </Row>
          <Row label="Birthday">
            <BirthdayField value={c.birthday} onChange={(birthday) => set({ birthday })} />
          </Row>
          {allGroups.length > 0 && (
            <Row label="Groups">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {allGroups.map((g) => {
                  const on = c.groups.includes(g);
                  return (
                    <button
                      key={g}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => set({ groups: on ? c.groups.filter((x) => x !== g) : [...c.groups, g] })}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground/80 hover:bg-foreground/[0.05]',
                      )}
                    >
                      {g}
                    </button>
                  );
                })}
              </div>
            </Row>
          )}
          <Row label="Notes">
            <textarea value={c.note} rows={4} aria-label="Notes" onChange={(e) => set({ note: e.target.value })} className={cn(field, 'h-auto resize-y py-1.5')} />
          </Row>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
        {!named && <p className="mr-auto text-sm text-muted-foreground">Give them a name, a company, an email or a number.</p>}
        <button type="button" onClick={onCancel} className="h-8 rounded-md px-3 text-sm font-medium text-foreground/80 outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Cancel
        </button>
        <button
          type="submit"
          disabled={!named || badEmail || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {saving && <Loader2 className="size-3.5 motion-safe:animate-spin" />}
          {isNew ? 'Add Contact' : 'Save'}
        </button>
      </div>
    </form>
  );
}
