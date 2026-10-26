import { useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getFsBridge, cleanFsError } from '@/lib/fs';
import { player, usePlayer } from '../engine';
import { EQ_BANDS, EQ_PRESETS, parseEqf, writeEqf, type EqPreset } from '../eq';
import { setPrefs } from '../prefs';
import { IconButton, Range } from './common';
import { askText } from './askText';

const PANES = ['Graphic Equalizer', 'Play Speed', 'Crossfading', 'Quiet Mode', 'Bass Boost', 'Balance'] as const;
type Pane = (typeof PANES)[number];

const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));
const CUSTOM_KEY = 'din:media-player:eq-presets';

function loadCustom(): EqPreset[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
    return Array.isArray(value) ? (value as EqPreset[]) : [];
  } catch {
    return [];
  }
}

function Equalizer() {
  const eqOn = usePlayer((s) => s.eqOn);
  const bands = usePlayer((s) => s.bands);
  const preamp = usePlayer((s) => s.preamp);
  const presetName = usePlayer((s) => s.eqPreset);
  const [custom, setCustom] = useState(loadCustom);
  const [message, setMessage] = useState<string | null>(null);
  const { pickFile, pickFiles } = useFilePicker();
  const all = [...EQ_PRESETS, ...custom];

  const saveCustom = (list: EqPreset[]) => {
    setCustom(list);
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  };

  const importEqf = async () => {
    const path = await pickFile({ title: 'Load Winamp Presets', extensions: ['.eqf', '.q1'] });
    const fs = getFsBridge();
    if (!path || !fs) return;
    try {
      const { data } = await fs.readFile(path);
      const presets = parseEqf(data);
      saveCustom([...custom.filter((c) => !presets.some((p) => p.name === c.name)), ...presets]);
      if (presets[0]) player.applyPreset(presets[0]);
      setMessage(`Loaded ${presets.length} preset${presets.length === 1 ? '' : 's'}.`);
    } catch (error) {
      setMessage(cleanFsError(error));
    }
  };

  const exportEqf = async () => {
    const result = await pickFiles({ mode: 'save', title: 'Save Preset', currentName: `${presetName ?? 'Custom'}.eqf`, extensions: ['.eqf'] });
    const fs = getFsBridge();
    if (!result || !fs) return;
    const path = result.paths[0].toLowerCase().endsWith('.eqf') ? result.paths[0] : `${result.paths[0]}.eqf`;
    try {
      await fs.writeFile(path, writeEqf([{ name: presetName ?? 'Custom', preamp, bands }]));
      setMessage('Saved.');
    } catch (error) {
      setMessage(cleanFsError(error));
    }
  };

  return (
    <div className="flex min-w-0 flex-1 items-stretch gap-4">
      <div className="flex w-44 shrink-0 flex-col gap-2">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={eqOn} onChange={(e) => player.setEqOn(e.target.checked)} className="accent-[var(--mp-accent)]" />
          Turn on
        </label>
        <select
          aria-label="Preset"
          value={presetName ?? ''}
          onChange={(e) => {
            const preset = all.find((p) => p.name === e.target.value);
            if (preset) player.applyPreset(preset);
          }}
          className="mp-input w-full"
        >
          {presetName === null && <option value="">Custom</option>}
          {all.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="mp-btn px-2 py-0.5 text-xs"
            onClick={async () => {
              const name = await askText('Save Preset', 'Name this equalizer preset.', presetName ?? 'My Preset', 'Save');
              if (name) {
                saveCustom([...custom.filter((c) => c.name !== name), { name, preamp, bands }]);
                player.applyPreset({ name, preamp, bands });
              }
            }}
          >
            Save…
          </button>
          <button type="button" className="mp-btn px-2 py-0.5 text-xs" onClick={() => void importEqf()}>
            Load .eqf…
          </button>
          <button type="button" className="mp-btn px-2 py-0.5 text-xs" onClick={() => void exportEqf()}>
            Export…
          </button>
          <button type="button" className="mp-btn px-2 py-0.5 text-xs" onClick={() => player.applyPreset(EQ_PRESETS[0])}>
            Reset
          </button>
        </div>
        {message && <p className="text-xs text-[var(--mp-ink-dim)]">{message}</p>}
      </div>
      <div className={cn('flex min-w-0 flex-1 items-end justify-between gap-1 overflow-x-auto', !eqOn && 'opacity-50')}>
        <EqSlider label="Preamp" value={preamp} onValue={(v) => player.setPreamp(v)} />
        <span className="mx-1 h-full w-px shrink-0 bg-[var(--mp-line)]" aria-hidden />
        {EQ_BANDS.map((hz, i) => (
          <EqSlider key={hz} label={bandLabel(hz)} value={bands[i]} onValue={(v) => player.setBand(i, v)} />
        ))}
      </div>
    </div>
  );
}

function EqSlider({ label, value, onValue }: { label: string; value: number; onValue: (v: number) => void }) {
  return (
    <div className="flex w-9 shrink-0 flex-col items-center gap-1">
      <span className="mp-lcd text-[10px]">{value > 0 ? '+' : ''}{value.toFixed(1)}</span>
      <Range
        vertical
        label={`${label} Hz`}
        min={-12}
        max={12}
        step={0.1}
        value={value}
        onValue={onValue}
        onDoubleClick={() => onValue(0)}
        aria-valuetext={`${value.toFixed(1)} decibels`}
        className="h-24 w-3"
      />
      <span className="text-[10px] text-[var(--mp-ink-dim)]">{label}</span>
    </div>
  );
}

function PlaySpeed() {
  const rate = usePlayer((s) => s.rate);
  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      <div className="flex items-center gap-3">
        {[0.5, 1, 1.4].map((r, i) => (
          <button key={r} type="button" className="mp-btn text-xs" data-primary={rate === r} onClick={() => player.setRate(r)}>
            {['Slow', 'Normal', 'Fast'][i]}
          </button>
        ))}
        <span className="mp-lcd ml-auto text-sm">{rate.toFixed(2)}×</span>
      </div>
      <Range label="Play speed" min={0.5} max={2} step={0.05} value={rate} onValue={(v) => player.setRate(v)} thumb="always" className="h-3 w-full max-w-md" />
      <p className="text-xs text-[var(--mp-ink-dim)]">Changes the speed without changing the pitch.</p>
    </div>
  );
}

function Crossfading() {
  const crossfade = usePlayer((s) => s.crossfade);
  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={crossfade > 0} onChange={(e) => player.setCrossfade(e.target.checked ? 5 : 0)} className="accent-[var(--mp-accent)]" />
        Turn on crossfading
      </label>
      <div className="flex max-w-md items-center gap-3">
        <Range label="Crossfade length" min={0} max={10} step={1} value={crossfade} onValue={(v) => player.setCrossfade(v)} thumb="always" className="h-3 flex-1" />
        <span className="mp-lcd w-20 text-right text-sm">{crossfade} seconds</span>
      </div>
      <p className="text-xs text-[var(--mp-ink-dim)]">Each song fades into the next.</p>
    </div>
  );
}

function QuietMode() {
  const quiet = usePlayer((s) => s.quiet);
  return (
    <div className="flex flex-1 flex-col justify-center gap-2">
      <label className="flex items-center gap-2 font-medium">
        <input type="radio" name="mp-quiet" checked={!quiet} onChange={() => player.setQuiet(false)} className="accent-[var(--mp-accent)]" />
        No difference
      </label>
      <label className="flex items-center gap-2 font-medium">
        <input type="radio" name="mp-quiet" checked={quiet} onChange={() => player.setQuiet(true)} className="accent-[var(--mp-accent)]" />
        Even out loud and soft passages
      </label>
      <p className="text-xs text-[var(--mp-ink-dim)]">Good for late nights: loud parts get softer and soft parts louder.</p>
    </div>
  );
}

function BassBoost() {
  const bass = usePlayer((s) => s.bassBoost);
  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      <div className="flex max-w-md items-center gap-3">
        <Range label="Bass boost" min={0} max={12} step={0.5} value={bass} onValue={(v) => player.setBassBoost(v)} thumb="always" className="h-3 flex-1" />
        <span className="mp-lcd w-16 text-right text-sm">+{bass.toFixed(1)} dB</span>
      </div>
      <p className="text-xs text-[var(--mp-ink-dim)]">Deeper bass for small speakers and headphones.</p>
    </div>
  );
}

function Balance() {
  const balance = usePlayer((s) => s.balance);
  return (
    <div className="flex flex-1 flex-col justify-center gap-3">
      <div className="flex max-w-md items-center gap-3 text-xs text-[var(--mp-ink-dim)]">
        Left
        <Range label="Balance" min={-1} max={1} step={0.02} value={balance} onValue={(v) => player.setBalance(v)} onDoubleClick={() => player.setBalance(0)} thumb="always" className="h-3 flex-1" />
        Right
      </div>
      <p className="mp-lcd text-sm">{balance === 0 ? 'Center' : `${Math.round(Math.abs(balance) * 100)}% ${balance < 0 ? 'left' : 'right'}`}</p>
    </div>
  );
}

/** WMP's Enhancements pane: the equalizer and its neighbors, one at a time. */
export function Enhancements() {
  const [pane, setPane] = useState<Pane>('Graphic Equalizer');
  const index = PANES.indexOf(pane);
  const step = (d: number) => setPane(PANES[(index + d + PANES.length) % PANES.length]);
  return (
    <section aria-label="Enhancements" className="mp-pane flex h-48 shrink-0 flex-col border-x-0 border-b-0 motion-safe:animate-in motion-safe:slide-in-from-bottom-2">
      <header className="flex items-center gap-1 border-b border-[var(--mp-line)] px-2 py-1">
        <IconButton label="Previous enhancement" onClick={() => step(-1)} className="size-6">
          <ChevronLeft className="size-4" />
        </IconButton>
        <select aria-label="Enhancement" value={pane} onChange={(e) => setPane(e.target.value as Pane)} className="mp-input py-0.5 font-semibold">
          {PANES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <IconButton label="Next enhancement" onClick={() => step(1)} className="size-6">
          <ChevronRight className="size-4" />
        </IconButton>
        <span className="flex-1" />
        <IconButton label="Close enhancements" onClick={() => setPrefs({ showEnhancements: false })} className="size-6">
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 px-4 py-2">
        {pane === 'Graphic Equalizer' && <Equalizer />}
        {pane === 'Play Speed' && <PlaySpeed />}
        {pane === 'Crossfading' && <Crossfading />}
        {pane === 'Quiet Mode' && <QuietMode />}
        {pane === 'Bass Boost' && <BassBoost />}
        {pane === 'Balance' && <Balance />}
      </div>
    </section>
  );
}
