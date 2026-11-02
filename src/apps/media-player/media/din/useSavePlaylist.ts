import { useCallback } from 'react';
import { getFsBridge, joinPath } from '@/lib/fs';
import { writeFile, type FileTypeFilter } from '@/shared/fileHandles';
import { pickSave, startFolder } from '../host';
import { playlistText } from '../actions';
import type { Track } from '../engine';
import { grantsReady, homeDir } from '../grants';
import { library } from '../library';
import { rememberPlaylist } from '../keep';

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
      await grantsReady();
      const home = homeDir();
      const dir = home ? joinPath(home, 'Music/Playlists') : null;
      if (dir) await getFsBridge()?.mkdir(dir).catch(() => {});
      const target = await pickSave({
        title: 'Save Playlist',
        startIn: dir ? await startFolder(dir, 'music') : 'music',
        suggestedName: 'Playlist.m3u8',
        types: SAVE_TYPES,
      });
      if (!target) return null;
      const path = window.din!.files.path(target);
      await writeFile(target, playlistText(path, tracks));
      rememberPlaylist(path, tracks.map((t) => t.location));
      void library.scan();
      return path;
    },
    [],
  );
}
