import { useState } from 'react';
import { Play, Plus, Radio, Trash2 } from 'lucide-react';
import { makeTrack, player, usePlayer } from '../engine';
import { setPrefs, usePrefs } from '../prefs';

/** Stations to start from: SomaFM's listener-supported channels. */
const FEATURED = [
  { name: 'Groove Salad', genre: 'Ambient / Downtempo', id: 'groovesalad' },
  { name: 'Drone Zone', genre: 'Ambient', id: 'dronezone' },
  { name: 'Secret Agent', genre: 'Lounge', id: 'secretagent' },
  { name: 'Lush', genre: 'Electronica / Vocals', id: 'lush' },
  { name: 'Indie Pop Rocks!', genre: 'Indie', id: 'indiepop' },
  { name: 'Beat Blender', genre: 'Deep House', id: 'beatblender' },
  { name: 'Deep Space One', genre: 'Space Ambient', id: 'deepspaceone' },
  { name: 'Underground 80s', genre: '80s / New Wave', id: 'u80s' },
  { name: 'Left Coast 70s', genre: '70s Rock', id: 'seventies' },
  { name: 'Boot Liquor', genre: 'Americana', id: 'bootliquor' },
  { name: 'Folk Forward', genre: 'Folk', id: 'folkfwd' },
  { name: 'DEF CON Radio', genre: 'Electronic', id: 'defcon' },
  { name: 'PopTron', genre: 'Electropop', id: 'poptron' },
  { name: 'Fluid', genre: 'Instrumental Hip-Hop', id: 'fluid' },
  { name: 'Sonic Universe', genre: 'Jazz', id: 'sonicuniverse' },
].map((s) => ({ name: s.name, genre: s.genre, url: `https://ice1.somafm.com/${s.id}-128-mp3` }));

function tune(name: string, url: string) {
  player.setQueue([makeTrack(url, { title: name, artist: 'Internet Radio' })], 0, true);
}

/** WMP's Radio Tuner: internet radio stations, featured and your own. */
export function RadioView() {
  const stations = usePrefs((p) => p.stations);
  const playing = usePlayer((s) => (s.status === 'playing' ? s.queue[s.current]?.location : null));
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const valid = /^https?:\/\/\S+$/i.test(url.trim());

  const row = (s: { name: string; url: string; genre?: string }, mine: boolean) => (
    <li key={s.url} className="mp-row group flex items-center gap-3 rounded-md px-3 py-2" data-current={playing === s.url}>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--mp-pane-2)] text-[var(--mp-ink-dim)]">
        <Radio className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{s.name}</span>
        <span className="block truncate text-xs text-[var(--mp-ink-faint)]">{s.genre ?? s.url}</span>
      </span>
      {mine && (
        <button
          type="button"
          className="mp-icon-btn size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Remove ${s.name}`}
          title="Remove"
          onClick={() => setPrefs((p) => ({ stations: p.stations.filter((x) => x.url !== s.url) }))}
        >
          <Trash2 className="size-4" />
        </button>
      )}
      <button type="button" className="mp-btn" data-primary={playing === s.url} onClick={() => tune(s.name, s.url)}>
        <Play className="size-3.5 fill-current" /> {playing === s.url ? 'Playing' : 'Listen'}
      </button>
    </li>
  );

  return (
    <div className="mp-scroll min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl p-6">
        <h2 className="text-2xl font-bold">Radio Tuner</h2>
        <p className="mb-6 text-[var(--mp-ink-dim)]">Internet radio, live. Add any station that streams over HTTP.</p>

        <form
          className="mp-pane mb-6 flex flex-wrap items-end gap-2 rounded-lg p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const station = { name: name.trim() || url.trim(), url: url.trim() };
            setPrefs((p) => ({ stations: [...p.stations.filter((s) => s.url !== station.url), station] }));
            tune(station.name, station.url);
            setUrl('');
            setName('');
          }}
        >
          <label className="flex min-w-56 flex-[2] flex-col gap-1 text-xs text-[var(--mp-ink-dim)]">
            Stream URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="mp-input text-sm" />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-[var(--mp-ink-dim)]">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Station" className="mp-input text-sm" />
          </label>
          <button type="submit" className="mp-btn" disabled={!valid}>
            <Plus className="size-4" /> Add and Listen
          </button>
        </form>

        {stations.length > 0 && (
          <>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">My Stations</h3>
            <ul className="mb-6 space-y-1">{stations.map((s) => row(s, true))}</ul>
          </>
        )}
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--mp-ink-faint)]">Featured · SomaFM</h3>
        <ul className="space-y-1">{FEATURED.map((s) => row(s, false))}</ul>
      </div>
    </div>
  );
}
