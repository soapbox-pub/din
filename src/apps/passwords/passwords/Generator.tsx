import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/shared/appChrome';
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
          <Wand2 className="size-4.5" strokeWidth={1.75} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        <div className="flex items-center gap-2 rounded-xl bg-foreground/[0.06] py-2 pr-1.5 pl-3">
          <output aria-live="polite" className="min-w-0 flex-1 break-all font-mono text-sm">
            {password}
          </output>
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Another password" onClick={regenerate}>
            <RefreshCw className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
        <SegmentedControl
          label="Kind of password"
          size="md"
          value={options.style}
          options={[
            { value: 'apple', label: 'Easy to type' },
            { value: 'random', label: 'Random' },
          ]}
          onValueChange={(style) => setOptions((o) => ({ ...o, style }))}
          className="mx-auto"
        />
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
