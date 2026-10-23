import { useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  MessageCircleQuestion,
  ShieldQuestion,
} from 'lucide-react';
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

function isMissing(field: FormField, answers: Record<string, FormValue | undefined>): boolean {
  return field.type !== 'external' && field.required === true && isEmpty(answers[field.key]);
}

/**
 * A question the agent asked, as a form to fill in. Several questions are
 * asked one at a time, with Back and Next, so a long form never outgrows the
 * window it's shown in.
 */
export function FormCard({ form, className }: { form: FormInfo; className?: string }) {
  const reply = useReplyForm();
  const { toast } = useToast();
  const [answers, setAnswers] = useState(() => initialAnswers(form.fields));
  const [step, setStep] = useState(0);
  const stepRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const visible = form.fields.filter((field) => fieldVisible(field, answers));
  const missing = visible.some((field) => isMissing(field, answers));
  const paged = visible.length > 1;
  const index = Math.min(step, visible.length - 1);
  const current = visible[index];
  const last = index >= visible.length - 1;
  const currentMissing = current !== undefined && isMissing(current, answers);

  // The step's controls unmount when it changes, so keep focus in the card.
  useEffect(() => {
    if (moved.current) stepRef.current?.focus();
  }, [index]);

  const go = (to: number) => {
    moved.current = true;
    setStep(Math.max(0, Math.min(to, visible.length - 1)));
  };

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
          if (!last) {
            if (!currentMissing) go(index + 1);
          } else if (missing) {
            go(visible.findIndex((field) => isMissing(field, answers)));
          } else {
            submit();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium text-foreground">{form.title}</p>
              {paged && (
                <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {index + 1} of {visible.length}
                </p>
              )}
            </div>
            {paged && (
              <nav aria-label="Questions" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
                {visible.map((field, i) => {
                  const done = field.type !== 'external' && !isEmpty(answers[field.key]);
                  return (
                    <button
                      key={field.key}
                      type="button"
                      aria-current={i === index ? 'step' : undefined}
                      onClick={() => go(i)}
                      className={cn(
                        'flex max-w-40 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        i === index
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {done && <Check className="size-3 shrink-0" aria-label="Answered" />}
                      <span className="truncate">{field.title || field.key}</span>
                    </button>
                  );
                })}
              </nav>
            )}
            {current && (
              <div ref={stepRef} tabIndex={-1} className="outline-none">
                <FormFieldInput
                  key={current.key}
                  field={current}
                  value={answers[current.key]}
                  onChange={(v) => set(current.key, v)}
                  onPick={paged && !last ? () => go(index + 1) : undefined}
                />
              </div>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={reply.isPending} onClick={() => send(null)}>
            Dismiss
          </Button>
          {paged && index > 0 && (
            <Button type="button" variant="outline" size="sm" disabled={reply.isPending} onClick={() => go(index - 1)}>
              <ChevronLeft className="size-3.5" aria-hidden />
              Back
            </Button>
          )}
          {last ? (
            <Button type="submit" size="sm" disabled={reply.isPending || (paged ? currentMissing : missing)}>
              {reply.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Answer
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={currentMissing}>
              Next
              <ChevronRight className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function FormFieldInput({
  field,
  value,
  onChange,
  onPick,
}: {
  field: FormField;
  value: FormValue | undefined;
  onChange: (value: FormValue | undefined) => void;
  /** Called after one of a single-choice field's own options is chosen. */
  onPick?: () => void;
}) {
  const id = useId();
  const openUrl = useOpenUrl();
  const pointer = useRef(false);
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
          onValueChange={(v) => {
            onChange(v === '__other' ? '' : v);
            if (v !== '__other' && pointer.current) onPick?.();
          }}
          // Only a click moves on: arrow keys select each option they pass.
          onPointerDown={() => (pointer.current = true)}
          onKeyDown={() => (pointer.current = false)}
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
