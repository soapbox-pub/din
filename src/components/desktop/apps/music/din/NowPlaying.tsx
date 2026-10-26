import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Mic2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { player, usePlayer, type Track } from '../engine';
import { trackInfo } from '../metadata';
import { setPrefs, usePrefs } from '../prefs';
import { VISUALIZATIONS } from '../visualizations';
import { IconButton, VisCanvas } from './common';
import { useCover } from './useCover';
import { Enhancements } from './Enhancements';
import { ListPane } from './ListPane';

const VIS_IDS = ['art', ...VISUALIZATIONS.map((v) => v.id)];

function visName(id: string) {
  return id === 'art' ? 'Album Art' : (VISUALIZATIONS.find((v) => v.id === id)?.name ?? id);
}

function VideoStage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? player.attachVideo(ref.current) : undefined), []);
  return <div ref={ref} className="absolute inset-0 bg-black" onClick={() => player.toggle()} />;
}

function AlbumArtStage({ location }: { location: string | null }) {
  const cover = useCover(location);
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden">
      {cover && <img src={cover} alt="" aria-hidden className="absolute inset-0 size-full scale-125 object-cover opacity-40 blur-3xl" />}
      <div className="relative aspect-square h-[70%] max-h-[420px] overflow-hidden rounded-lg bg-[linear-gradient(135deg,hsl(var(--mp-hue)_50%_24%),hsl(var(--mp-hue)_55%_8%))] shadow-[0_20px_60px_rgb(0_0_0/0.6)] ring-1 ring-white/10">
        {cover ? (
          <img src={cover} alt="Album art" className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-6xl text-[var(--mp-ink-faint)]" aria-hidden>♫</div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(160deg,rgb(255_255_255/0.18),transparent_40%)]" />
      </div>
    </div>
  );
}

function Lyrics({ location }: { location: string }) {
  const [lyrics, setLyrics] = useState<{ location: string; text: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void trackInfo(location).then((info) => live && setLyrics({ location, text: info.lyrics ?? null }));
    return () => {
      live = false;
    };
  }, [location]);
  const text = lyrics?.location === location ? lyrics.text : null;
  return (
    <div className="mp-scroll absolute inset-x-0 bottom-12 top-16 overflow-y-auto px-8 text-center">
      <p className="mx-auto max-w-lg whitespace-pre-line text-lg leading-relaxed text-white drop-shadow-[0_2px_4px_rgb(0_0_0/0.9)]">
        {text ?? 'No lyrics in this song’s tags.'}
      </p>
    </div>
  );
}

/** Title, artist and album, faded in over the stage when the song changes. */
function InfoOverlay() {
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  return track ? <TrackInfo key={track.key} track={track} /> : null;
}

function TrackInfo({ track }: { track: Track }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setShown(false), 6000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div
      className={cn(
        'pointer-events-none absolute left-4 top-3 max-w-[70%] transition-opacity duration-700 group-hover:opacity-100',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <p className="truncate text-xl font-semibold text-white drop-shadow-[0_1px_3px_rgb(0_0_0/0.9)]">{track.title}</p>
      {track.artist && <p className="truncate text-sm text-white/80 drop-shadow-[0_1px_3px_rgb(0_0_0/0.9)]">{track.artist}</p>}
      {track.album && <p className="truncate text-sm text-white/60 drop-shadow-[0_1px_3px_rgb(0_0_0/0.9)]">{track.album}</p>}
    </div>
  );
}

function VisPicker() {
  const vis = usePrefs((p) => p.vis);
  const groups = [...new Set(VISUALIZATIONS.map((v) => v.group))];
  const index = Math.max(0, VIS_IDS.indexOf(vis));
  const step = (d: number) => setPrefs({ vis: VIS_IDS[(index + d + VIS_IDS.length) % VIS_IDS.length] });
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-black/50 px-1 py-0.5 backdrop-blur">
      <IconButton label="Previous visualization" onClick={() => step(-1)} className="size-6">
        <ChevronLeft className="size-4" />
      </IconButton>
      <DropdownMenu>
        <DropdownMenuTrigger className="max-w-40 truncate rounded px-1 text-xs text-[var(--mp-ink-dim)] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]">
          {visName(vis)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuRadioGroup value={vis} onValueChange={(v) => setPrefs({ vis: v })}>
            <DropdownMenuRadioItem value="art">Album Art</DropdownMenuRadioItem>
            {groups.map((g) => (
              <div key={g}>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">{g}</DropdownMenuLabel>
                {VISUALIZATIONS.filter((v) => v.group === g).map((v) => (
                  <DropdownMenuRadioItem key={v.id} value={v.id}>
                    {v.name}
                  </DropdownMenuRadioItem>
                ))}
              </div>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton label="Next visualization" onClick={() => step(1)} className="size-6">
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}

export function NowPlaying() {
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const vis = usePrefs((p) => p.vis);
  const showList = usePrefs((p) => p.showList);
  const showEnhancements = usePrefs((p) => p.showEnhancements);
  const lyrics = usePrefs((p) => p.lyrics);
  const video = !!track?.video;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="group relative min-h-0 flex-1 overflow-hidden bg-black" onDoubleClick={() => !video && setPrefs({ vis: VIS_IDS[(VIS_IDS.indexOf(vis) + 1) % VIS_IDS.length] })}>
          {video ? <VideoStage /> : vis === 'art' ? <AlbumArtStage location={track?.location ?? null} /> : <VisCanvas vis={vis} className="absolute inset-0" />}
          {!video && <InfoOverlay />}
          {lyrics && track && !video && <Lyrics location={track.location} />}
          {!video && (
            <div className="absolute bottom-2 right-2 flex items-center gap-2 opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <IconButton label={lyrics ? 'Hide lyrics' : 'Show lyrics'} aria-pressed={lyrics} onClick={() => setPrefs({ lyrics: !lyrics })} className="size-7 bg-black/50 backdrop-blur">
                <Mic2 className="size-3.5" />
              </IconButton>
              <VisPicker />
            </div>
          )}
        </div>
        {showEnhancements && <Enhancements />}
      </div>
      {showList && <ListPane />}
    </div>
  );
}
