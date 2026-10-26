import { useCallback } from 'react';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { getFsBridge, joinPath } from '@/lib/fs';
import { extensionOf } from '@/lib/fileTypes';
import type { FileFilter } from '@/lib/fileFilters';
import { savePlaylist } from '../actions';
import type { Track } from '../engine';
import { PLAYLIST_EXTENSIONS } from '../playlists';
import { library } from '../library';

const SAVE_TYPES: FileFilter[] = [
  { name: 'M3U Playlist (UTF-8)', patterns: ['*.m3u8'], mimeTypes: [] },
  { name: 'Windows Media Playlist', patterns: ['*.wpl'], mimeTypes: [] },
  { name: 'Winamp Playlist', patterns: ['*.m3u'], mimeTypes: [] },
  { name: 'PLS Playlist', patterns: ['*.pls'], mimeTypes: [] },
  { name: 'XSPF Playlist', patterns: ['*.xspf'], mimeTypes: [] },
];

/** Ask where, then save songs as a playlist file (in Music/Playlists by default). */
export function useSavePlaylist(): (tracks: Track[]) => Promise<string | null> {
  const { pickFiles } = useFilePicker();
  return useCallback(
    async (tracks: Track[]) => {
      const fs = getFsBridge();
      if (!fs) return null;
      const dir = joinPath(await fs.homedir(), 'Music/Playlists');
      try {
        await fs.mkdir(dir);
      } catch {
        // Opens at home instead.
      }
      const result = await pickFiles({ mode: 'save', title: 'Save Playlist', initialPath: dir, currentName: 'Playlist.m3u8', filters: SAVE_TYPES });
      if (!result) return null;
      let path = result.paths[0];
      if (!PLAYLIST_EXTENSIONS.has(extensionOf(path))) path += SAVE_TYPES[result.filter ?? 0].patterns[0].slice(1);
      await savePlaylist(path, tracks);
      void library.scan();
      return path;
    },
    [pickFiles],
  );
}
