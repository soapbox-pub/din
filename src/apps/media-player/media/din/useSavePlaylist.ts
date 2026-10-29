import { useCallback } from 'react';
import { getFsBridge, joinPath } from '@/lib/fs';
import type { FileTypeFilter } from '@/sdk';
import { pickSavePath } from '../host';
import { savePlaylist } from '../actions';
import type { Track } from '../engine';
import { library } from '../library';

const SAVE_TYPES: FileTypeFilter[] = [
  { description: 'M3U Playlist (UTF-8)', extensions: ['.m3u8'] },
  { description: 'Windows Media Playlist', extensions: ['.wpl'] },
  { description: 'Winamp Playlist', extensions: ['.m3u'] },
  { description: 'PLS Playlist', extensions: ['.pls'] },
  { description: 'XSPF Playlist', extensions: ['.xspf'] },
];

/** Ask where, then save songs as a playlist file (in Music/Playlists by default). */
export function useSavePlaylist(): (tracks: Track[]) => Promise<string | null> {
  return useCallback(
    async (tracks: Track[]) => {
      const fs = getFsBridge();
      if (!fs) return null;
      const dir = joinPath(await fs.homedir(), 'Music/Playlists');
      await fs.mkdir(dir).catch(() => {});
      const startIn = await window.din?.files.fromPath(dir).catch(() => undefined);
      const path = await pickSavePath({ title: 'Save Playlist', startIn: startIn ?? 'music', suggestedName: 'Playlist.m3u8', types: SAVE_TYPES });
      if (!path) return null;
      await savePlaylist(path, tracks);
      void library.scan();
      return path;
    },
    [],
  );
}
