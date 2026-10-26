import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Palette, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { cleanFsError, getFsBridge, joinPath } from '@/lib/fs';
import { skinKindOf, skinsDir } from '../actions';
import { setPrefs, usePrefs, type SkinChoice } from '../prefs';
import { winampPreview } from '../winamp/skin';
import { wmpPreview } from '../wmp/preview';
import type { Commands } from '../useCommands';

interface SkinEntry {
  id: string;
  name: string;
  choice: SkinChoice;
  kind: 'din' | 'winamp' | 'wmp';
  removable: boolean;
}

const BUILT_IN: SkinEntry[] = [
  { id: 'din', name: 'Din', choice: { kind: 'din' }, kind: 'din', removable: false },
  { id: 'din-classic', name: 'Din Classic', choice: { kind: 'winamp', path: '' }, kind: 'winamp', removable: false },
];

async function listSkins(): Promise<SkinEntry[]> {
  const fs = getFsBridge();
  const dir = await skinsDir();
  if (!fs || !dir) return BUILT_IN;
  let entries: { name: string; kind: string }[] = [];
  try {
    entries = (await fs.readdir(dir)).entries;
  } catch {
    // No skins yet.
  }
  const installed = entries
    .filter((e) => e.kind === 'file' && skinKindOf(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e): SkinEntry => {
      const path = joinPath(dir, e.name);
      const kind = skinKindOf(e.name)!;
      return { id: path, name: e.name.replace(/\.[^.]+$/, '').replace(/_/g, ' '), choice: { kind, path }, kind, removable: true };
    });
  return [...BUILT_IN, ...installed];
}

const sameChoice = (a: SkinChoice, b: SkinChoice) => a.kind === b.kind && (a.kind === 'din' || (b.kind !== 'din' && a.path === b.path));

function Preview({ entry }: { entry: SkinEntry }) {
  const query = useQuery({
    queryKey: ['music', 'skin-preview', entry.id],
    queryFn: async () => {
      if (entry.choice.kind === 'din') return '/icons/apps/media-player.png';
      if (!entry.choice.path) return winampPreview(null);
      const { data } = await getFsBridge()!.readFile(entry.choice.path, 32 * 1024 * 1024);
      return entry.kind === 'winamp' ? winampPreview(data) : wmpPreview(data);
    },
    staleTime: Infinity,
  });
  if (query.isLoading) return <Skeleton className="size-full bg-foreground/10" />;
  if (!query.data) return <div className="grid size-full place-items-center text-[var(--mp-ink-faint)]"><Palette className="size-10" /></div>;
  return <img src={query.data} alt="" className={cn('size-full object-contain', entry.kind !== 'din' && '[image-rendering:pixelated]')} />;
}

/** WMP's Skin Chooser: every skin Din has, previewed, one click to wear. */
export function SkinChooser({ commands }: { commands: Commands }) {
  const current = usePrefs((p) => p.skin);
  const queryClient = useQueryClient();
  const openUrl = useOpenUrl();
  const skins = useQuery({ queryKey: ['music', 'skins'], queryFn: listSkins });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = skins.data ?? BUILT_IN;
  const selected = list.find((s) => s.id === selectedId) ?? list.find((s) => sameChoice(s.choice, current)) ?? list[0];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="mp-pane flex w-64 shrink-0 flex-col border-y-0 border-l-0">
        <div className="flex items-center gap-1 border-b border-[var(--mp-line)] p-2">
          <button
            type="button"
            className="mp-btn flex-1"
            onClick={async () => {
              await commands.loadSkin();
              void queryClient.invalidateQueries({ queryKey: ['music', 'skins'] });
            }}
          >
            <Plus className="size-4" /> Add Skin…
          </button>
          {selected?.removable && (
            <button
              type="button"
              className="mp-icon-btn size-8"
              aria-label={`Delete ${selected.name}`}
              title="Delete skin"
              onClick={async () => {
                if (selected.choice.kind === 'din') return;
                try {
                  await getFsBridge()!.trash(selected.choice.path);
                  if (sameChoice(selected.choice, current)) setPrefs({ skin: { kind: 'din' } });
                  setSelectedId(null);
                  void queryClient.invalidateQueries({ queryKey: ['music', 'skins'] });
                } catch (e) {
                  setError(cleanFsError(e));
                }
              }}
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
        <ul role="listbox" aria-label="Skins" className="mp-scroll min-h-0 flex-1 overflow-y-auto p-1">
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={s.id === selected?.id}
                onClick={() => setSelectedId(s.id)}
                onDoubleClick={() => setPrefs({ skin: s.choice })}
                className={cn(
                  'mp-row flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--mp-ink-faint)]">
                  {s.kind === 'din' ? 'Din' : s.kind === 'winamp' ? 'Winamp' : 'WMP'}
                </span>
                {sameChoice(s.choice, current) && <Check className="size-3.5 text-[var(--mp-accent)]" aria-label="In use" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t border-[var(--mp-line)] p-2 text-xs">
          <button type="button" className="flex items-center gap-1 text-[var(--mp-ink-dim)] hover:text-[var(--mp-ink)]" onClick={() => openUrl('https://skins.webamp.org/')}>
            <ExternalLink className="size-3" /> Winamp Skin Museum
          </button>
          <button type="button" className="flex items-center gap-1 text-[var(--mp-ink-dim)] hover:text-[var(--mp-ink)]" onClick={() => openUrl('https://archive.org/search?query=windows+media+player+skins')}>
            <ExternalLink className="size-3" /> Windows Media Player skins
          </button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6">
        {selected && (
          <>
            <div className="flex h-64 w-full max-w-lg items-center justify-center overflow-hidden rounded-xl bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-4 ring-1 ring-foreground/10">
              <Preview key={selected.id} entry={selected} />
            </div>
            <div className="text-center">
              <h2 className="text-xl font-semibold">{selected.name}</h2>
              <p className="text-[var(--mp-ink-dim)]">
                {selected.kind === 'din'
                  ? 'Din’s own look, after Windows Media Player 10.'
                  : selected.kind === 'winamp'
                    ? 'A classic Winamp skin: main window, equalizer and playlist editor.'
                    : 'A Windows Media Player skin.'}
              </p>
            </div>
            <button type="button" className="mp-btn px-6 py-2 text-base" data-primary disabled={sameChoice(selected.choice, current)} onClick={() => setPrefs({ skin: selected.choice })}>
              {sameChoice(selected.choice, current) ? 'In Use' : 'Apply Skin'}
            </button>
            {(error ?? commands.message) && <p role="alert" className="text-sm text-amber-700 dark:text-amber-200">{error ?? commands.message}</p>}
            <p className="max-w-md text-center text-xs text-[var(--mp-ink-faint)]">
              Open a .wsz or .wmz file from Files to add it here. Whatever the skin, View › Skin in the menu bar, Ctrl+1, or right-clicking Media Player in the Dock brings back Din’s own.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
