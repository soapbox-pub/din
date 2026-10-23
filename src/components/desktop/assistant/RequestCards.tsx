import { useId, useState } from 'react';
import { ExternalLink, Loader2, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { useReplyForm, useReplyPermission } from '@/hooks/useAssistant';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import {
  cleanAssistantError,
  describePermission,
  fieldVisible,
  type FormField,
  type FormInfo,
  type FormValue,
  type PermissionDecision,
  type PermissionRequest,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** The agent asking before it does something its rules say to ask about. */
export function PermissionCard({ request, className }: { request: PermissionRequest; className?: string }) {
  const reply = useReplyPermission();
  const { toast } = useToast();
  const [picked, setPicked] = useState<PermissionDecision | null>(null);
  const { title } = describePermission(request);
  const save = request.save ?? [];

  const answer = (decision: PermissionDecision) => {
    setPicked(decision);
    reply.mutate(
      { request, decision },
      {
        onError: (error) => {
          setPicked(null);
          toast({ title: 'Couldn’t answer', description: cleanAssistantError(error), variant: 'destructive' });
        },
      },
    );
  };

  return (
    <section
      aria-label="Permission request"
      className={cn('rounded-xl border border-primary/40 bg-primary/5 p-4 shadow-sm', className)}
    >
      <div className="flex items-start gap-3">
        <ShieldQuestion className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">Allow the assistant to {title.toLowerCase()}?</p>
          {request.message && <p className="mt-1 text-sm text-muted-foreground">{request.message}</p>}
          {request.resources.length > 0 && (
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
              {request.resources.map((resource) => (
                <li key={resource} className="break-all rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-foreground">
                  {resource}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={reply.isPending} onClick={() => answer('reject')}>
          {picked === 'reject' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Deny
        </Button>
        {save.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={reply.isPending}
            onClick={() => answer('always')}
            title={`Always allow ${save.join(', ')}`}
          >
            {picked === 'always' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Always allow
          </Button>
        )}
        <Button size="sm" disabled={reply.isPending} onClick={() => answer('once')} autoFocus>
          {picked === 'once' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Allow
        </Button>
      </div>
    </section>
  );
}

function initialAnswers(fields: FormField[]): Record<string, FormValue | undefined> {
  const answers: Record<string, FormValue | undefined> = {};
  for (const field of fields) {
    if (field.type === 'external') continue;
    if (field.default !== undefined) answers[field.key] = field.default;
    else if (field.type === 'boolean') answers[field.key] = false;
    else if (field.type === 'multiselect') answers[field.key] = [];
  }
  return answers;
}

function isEmpty(value: FormValue | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** A question the agent asked, as a form to fill in. */
export function FormCard({ form, className }: { form: FormInfo; className?: string }) {
  const reply = useReplyForm();
  const { toast } = useToast();
  const [answers, setAnswers] = useState(() => initialAnswers(form.fields));
  const visible = form.fields.filter((field) => fieldVisible(field, answers));
  const missing = visible.some((field) => field.type !== 'external' && field.required && isEmpty(answers[field.key]));

  const set = (key: string, value: FormValue | undefined) => setAnswers((current) => ({ ...current, [key]: value }));

  const send = (answer: Record<string, FormValue> | null) =>
    reply.mutate(
      { form, answer },
      {
        onError: (error) =>
          toast({ title: 'Couldn’t answer', description: cleanAssistantError(error), variant: 'destructive' }),
      },
    );

  const submit = () => {
    const answer: Record<string, FormValue> = {};
    for (const field of visible) {
      const value = answers[field.key];
      if (field.type !== 'external' && !isEmpty(value) && value !== undefined) answer[field.key] = value;
    }
    send(answer);
  };

  return (
    <section aria-label={form.title} className={cn('rounded-xl border border-primary/40 bg-primary/5 p-4 shadow-sm', className)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!missing) submit();
        }}
      >
        <div className="flex items-start gap-3">
          <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 space-y-4">
            <p className="font-medium text-foreground">{form.title}</p>
            {visible.map((field) => (
              <FormFieldInput key={field.key} field={field} value={answers[field.key]} onChange={(v) => set(field.key, v)} />
            ))}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={reply.isPending} onClick={() => send(null)}>
            Dismiss
          </Button>
          <Button type="submit" size="sm" disabled={reply.isPending || missing}>
            {reply.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Answer
          </Button>
        </div>
      </form>
    </section>
  );
}

function FormFieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: FormValue | undefined;
  onChange: (value: FormValue | undefined) => void;
}) {
  const id = useId();
  const openUrl = useOpenUrl();
  const label = field.title || field.key;
  const description = field.description && (
    <p id={`${id}-description`} className="text-xs text-muted-foreground">
      {field.description}
    </p>
  );

  if (field.type === 'external') {
    return (
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{label}</p>
        {description}
        <Button type="button" variant="outline" size="sm" onClick={() => openUrl(field.url)}>
          <ExternalLink className="size-3.5" aria-hidden /> Open
        </Button>
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor={id}>{label}</Label>
          {description}
        </div>
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(value) ? value : [];
    const toggle = (option: string, on: boolean) =>
      onChange(on ? [...selected, option] : selected.filter((v) => v !== option));
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{label}</legend>
        {description}
        {field.options.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-start gap-2 text-sm">
            <Checkbox
              checked={selected.includes(option.value)}
              onCheckedChange={(on) => toggle(option.value, on === true)}
              disabled={!selected.includes(option.value) && field.maxItems !== undefined && selected.length >= field.maxItems}
              className="mt-0.5"
            />
            <span>
              {option.label}
              {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
            </span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (field.type === 'string' && field.options && field.options.length > 0) {
    const known = field.options.some((o) => o.value === value);
    const other = field.custom && !known && typeof value === 'string';
    return (
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{label}</legend>
        {description}
        <RadioGroup
          value={other ? '__other' : typeof value === 'string' ? value : ''}
          onValueChange={(v) => onChange(v === '__other' ? '' : v)}
        >
          {field.options.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-start gap-2 text-sm">
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <span>
                {option.label}
                {option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}
              </span>
            </label>
          ))}
          {field.custom && (
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <RadioGroupItem value="__other" />
              <span>Something else</span>
            </label>
          )}
        </RadioGroup>
        {other && (
          <Input
            aria-label={`${label}: something else`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
          />
        )}
      </fieldset>
    );
  }

  const numeric = field.type === 'number' || field.type === 'integer';
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {field.required && <span className="text-destructive"> *</span>}
      </Label>
      {description}
      <Input
        id={id}
        type={numeric ? 'number' : 'text'}
        step={field.type === 'integer' ? 1 : undefined}
        min={numeric ? field.minimum : undefined}
        max={numeric ? field.maximum : undefined}
        placeholder={field.type === 'string' ? field.placeholder : undefined}
        value={value === undefined ? '' : String(value)}
        aria-describedby={field.description ? `${id}-description` : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          if (!numeric) onChange(raw);
          else onChange(raw === '' ? undefined : Number(raw));
        }}
      />
    </div>
  );
}
