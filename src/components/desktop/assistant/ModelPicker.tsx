import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { modelKey, type ModelInfo, type ModelRef } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** How many of a provider's models show before searching; the newest first. */
const PER_PROVIDER = 12;

/**
 * Which model a conversation uses: the connected providers' models, newest
 * first, searchable by name or id.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  recent = [],
  disabled,
  className,
}: {
  models: ModelInfo[];
  value: ModelRef | null | undefined;
  onChange: (model: ModelInfo) => void;
  /** Models used lately, shown first. */
  recent?: string[];
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selectedKey = value ? modelKey(value) : null;
  const selected = models.find((m) => modelKey(m) === selectedKey);

  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = byProvider.get(model.providerID) ?? [];
      list.push(model);
      byProvider.set(model.providerID, list);
    }
    const searching = search.trim().length > 0;
    return [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, list]) => {
        const sorted = [...list].sort((a, b) => b.time.released - a.time.released);
        return { provider, models: searching ? sorted : sorted.slice(0, PER_PROVIDER) };
      });
  }, [models, search]);

  const recentModels = useMemo(() => {
    const byKey = new Map(models.map((m) => [modelKey(m), m]));
    return [...new Set(recent)].flatMap((key) => byKey.get(key) ?? []).slice(0, 5);
  }, [models, recent]);

  const pick = (model: ModelInfo) => {
    onChange(model);
    setOpen(false);
  };

  const item = (model: ModelInfo, group: string) => (
    <CommandItem
      key={`${group}:${modelKey(model)}`}
      value={`${group}:${modelKey(model)} ${model.name}`}
      onSelect={() => pick(model)}
      className="gap-2"
    >
      <Check className={cn('size-4 shrink-0', modelKey(model) === selectedKey ? 'opacity-100' : 'opacity-0')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{model.providerID}</span>
    </CommandItem>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || models.length === 0}
          aria-label={`Model: ${selected?.name ?? value?.id ?? 'none'}`}
          className={cn('h-8 max-w-56 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground', className)}
        >
          <Sparkles className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{selected?.name ?? value?.id ?? 'Choose a model'}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Search models…" value={search} onValueChange={setSearch} />
          <CommandList className="max-h-80">
            <CommandEmpty>No model matches.</CommandEmpty>
            {recentModels.length > 0 && !search && (
              <CommandGroup heading="Recent">{recentModels.map((m) => item(m, 'recent'))}</CommandGroup>
            )}
            {groups.map(({ provider, models: list }) => (
              <CommandGroup key={provider} heading={provider}>
                {list.map((m) => item(m, provider))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
