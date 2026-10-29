import { useMemo, useState } from 'react';
import { Check, ChevronDown, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ManageProvidersDialog } from '@/shared/assistant/Providers';
import { ModelPrice, ProviderIcon } from '@/shared/assistant/ProviderIcon';
import { useAssistantIntegrations } from '@/hooks/useAssistant';
import { modelKey, type ModelInfo, type ModelRef } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** How many of a provider's models show before searching; the newest first. */
const PER_PROVIDER = 12;

/**
 * Which model a conversation uses: the connected providers' models, newest
 * first, searchable by name or id, each with its provider's icon and a
 * rough price. "Manage providers" at the bottom adds, edits and removes them.
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
  const [managing, setManaging] = useState(false);
  const [search, setSearch] = useState('');
  const { data: integrations } = useAssistantIntegrations();
  const selectedKey = value ? modelKey(value) : null;
  const selected = models.find((m) => modelKey(m) === selectedKey);
  const searching = search.trim().length > 0;

  const providerName = useMemo(() => {
    const names = new Map((integrations ?? []).map((i) => [i.id, i.name]));
    return (providerID: string) => names.get(providerID) ?? providerID;
  }, [integrations]);

  const recentModels = useMemo(() => {
    const byKey = new Map(models.map((m) => [modelKey(m), m]));
    return [...new Set(recent)].flatMap((key) => byKey.get(key) ?? []).slice(0, 5);
  }, [models, recent]);

  const groups = useMemo(() => {
    // Recent models show once, at the top, unless searching.
    const shown = new Set(searching ? [] : recentModels.map(modelKey));
    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of models) {
      if (shown.has(modelKey(model))) continue;
      const list = byProvider.get(model.providerID) ?? [];
      list.push(model);
      byProvider.set(model.providerID, list);
    }
    return [...byProvider.entries()]
      .map(([provider, list]) => {
        const sorted = [...list].sort((a, b) => b.time.released - a.time.released);
        return { provider, name: providerName(provider), models: searching ? sorted : sorted.slice(0, PER_PROVIDER) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [models, recentModels, searching, providerName]);

  const pick = (model: ModelInfo) => {
    onChange(model);
    setOpen(false);
  };

  const item = (model: ModelInfo, group: string) => (
    <CommandItem
      key={`${group}:${modelKey(model)}`}
      value={`${group}:${modelKey(model)} ${model.name}`}
      onSelect={() => pick(model)}
      className="cursor-pointer gap-2"
    >
      <Check className={cn('size-4 shrink-0', modelKey(model) === selectedKey ? 'opacity-100' : 'opacity-0')} aria-hidden />
      <ProviderIcon baseURL={model.settings?.baseURL} className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      <ModelPrice cost={model.cost} />
    </CommandItem>
  );

  return (
    <>
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
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            aria-label={`Model: ${selected?.name ?? value?.id ?? 'none'}`}
            className={cn(
              'h-8 min-w-0 max-w-64 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground',
              className,
            )}
          >
            <ProviderIcon baseURL={selected?.settings?.baseURL} />
            <span className="truncate">{selected?.name ?? value?.id ?? 'Choose a model'}</span>
            <ChevronDown className="size-3 shrink-0 opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 p-0">
          <Command>
            {models.length >= 5 && (
              <CommandInput placeholder="Search models…" value={search} onValueChange={setSearch} className="h-9" />
            )}
            <CommandList className="max-h-96">
              <CommandEmpty>
                <p className="py-2 text-sm text-muted-foreground">No models found.</p>
                <p className="text-xs text-muted-foreground">Add a provider for more.</p>
              </CommandEmpty>
              {recentModels.length > 0 && !searching && (
                <CommandGroup heading="Recently used">{recentModels.map((m) => item(m, 'recent'))}</CommandGroup>
              )}
              {groups.map(({ provider, name, models: list }, index) => (
                <div key={provider}>
                  {(index > 0 || (recentModels.length > 0 && !searching)) && <CommandSeparator />}
                  <CommandGroup heading={name}>{list.map((m) => item(m, provider))}</CommandGroup>
                </div>
              ))}
              <CommandSeparator alwaysRender />
              <CommandGroup forceMount>
                <CommandItem
                  value="__manage_providers__"
                  forceMount
                  onSelect={() => {
                    setOpen(false);
                    setManaging(true);
                  }}
                  className="cursor-pointer gap-2"
                >
                  <Settings className="size-4" aria-hidden />
                  Manage providers
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <ManageProvidersDialog open={managing} onOpenChange={setManaging} />
    </>
  );
}
