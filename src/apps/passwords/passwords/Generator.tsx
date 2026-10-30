import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { GenerateOptions } from '@/lib/passwords';
import { useBridge } from './vault';

/** A button that opens the password generator, and hands back the password chosen. */
export function GeneratorButton({ onUse }: { onUse: (password: string) => void }) {
  const bridge = useBridge();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Required<GenerateOptions>>({
    style: 'apple',
    length: 20,
    numbers: true,
    symbols: true,
  });
  const [password, setPassword] = useState('');

  const regenerate = useCallback(() => {
    void bridge?.generate(options).then(setPassword);
  }, [bridge, options]);

  useEffect(() => {
    if (open) regenerate();
  }, [open, regenerate]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" aria-label="Generate a password" title="Generate a password">
          <Wand2 className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <output aria-live="polite" className="min-w-0 flex-1 break-all font-mono text-sm">
            {password}
          </output>
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Another password" onClick={regenerate}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          value={options.style}
          onValueChange={(style) => style && setOptions((o) => ({ ...o, style: style as 'apple' | 'random' }))}
          className="w-full"
        >
          <ToggleGroupItem value="apple" className="flex-1">
            Easy to type
          </ToggleGroupItem>
          <ToggleGroupItem value="random" className="flex-1">
            Random
          </ToggleGroupItem>
        </ToggleGroup>
        {options.style === 'random' && (
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="generator-length">Length</Label>
                <span className="text-sm tabular-nums text-muted-foreground">{options.length}</span>
              </div>
              <Slider
                id="generator-length"
                min={8}
                max={64}
                step={1}
                value={[options.length]}
                onValueChange={([length]) => setOptions((o) => ({ ...o, length }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="generator-numbers">Numbers</Label>
              <Switch id="generator-numbers" checked={options.numbers} onCheckedChange={(numbers) => setOptions((o) => ({ ...o, numbers }))} />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="generator-symbols">Symbols</Label>
              <Switch id="generator-symbols" checked={options.symbols} onCheckedChange={(symbols) => setOptions((o) => ({ ...o, symbols }))} />
            </div>
          </div>
        )}
        <Button
          type="button"
          className="w-full"
          disabled={!password}
          onClick={() => {
            onUse(password);
            setOpen(false);
          }}
        >
          Use This Password
        </Button>
      </PopoverContent>
    </Popover>
  );
}
